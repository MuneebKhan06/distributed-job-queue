"""Outcome of executing one message, and the state written for each."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from app.redis.consumer import JobMessage
from worker.executor import JobOutcome, execute


@pytest.fixture
def repository():
    return AsyncMock()


@pytest.fixture(autouse=True)
def fake_database(repository):
    @asynccontextmanager
    async def scope():
        yield MagicMock()

    with patch("worker.executor.session_scope", scope), patch(
        "worker.executor.JobRepository", return_value=repository
    ):
        repository.is_completed.return_value = False
        yield


def message(job_type="transform.csv", payload=None, attempt=0, max_attempts=5):
    return JobMessage(
        stream="jobs.normal",
        message_id="1-0",
        job_id=uuid4(),
        job_type=job_type,
        priority="normal",
        payload={"records": [], "operations": []} if payload is None else payload,
        attempt=attempt,
        max_attempts=max_attempts,
    )


async def test_successful_job_is_marked_completed(repository):
    result = await execute(message(), "worker-1")
    assert result.outcome is JobOutcome.COMPLETED
    repository.mark_completed.assert_awaited_once()


async def test_running_state_records_the_worker_and_attempt(repository):
    await execute(message(attempt=2), "worker-7")
    _job_id, worker_id, attempt = repository.mark_running.await_args[0]
    assert worker_id == "worker-7"
    assert attempt == 3


async def test_already_completed_job_is_skipped(repository):
    """The idempotency check that makes at-least-once delivery safe: a message
    redelivered after a crash between the completion write and the ACK must not
    run the job a second time."""
    repository.is_completed.return_value = True
    result = await execute(message(), "worker-1")
    assert result.outcome is JobOutcome.SKIPPED
    repository.mark_running.assert_not_awaited()
    repository.mark_completed.assert_not_awaited()


async def test_permanent_failure_goes_straight_to_dead(repository):
    """Retrying malformed input just delays the inevitable, so the attempt
    budget is skipped entirely."""
    result = await execute(message(payload={"records": [], "operations": ["explode"]}), "worker-1")
    assert result.outcome is JobOutcome.DEAD
    assert "permanent failure" in result.error
    repository.mark_dead.assert_awaited_once()


async def test_missing_payload_fields_are_permanent(repository):
    result = await execute(message(payload={"wrong": 1}), "worker-1")
    assert result.outcome is JobOutcome.DEAD
    assert "missing required fields" in result.error


async def test_transient_failure_with_budget_left_asks_for_retry(repository):
    with patch("worker.executor.get_handler") as get_handler:
        get_handler.return_value.run = AsyncMock(side_effect=TimeoutError("upstream slow"))
        result = await execute(message(attempt=0, max_attempts=5), "worker-1")
    assert result.outcome is JobOutcome.RETRY
    repository.mark_failed.assert_awaited_once()
    repository.mark_dead.assert_not_awaited()


async def test_transient_failure_on_the_last_attempt_is_dead(repository):
    with patch("worker.executor.get_handler") as get_handler:
        get_handler.return_value.run = AsyncMock(side_effect=TimeoutError("upstream slow"))
        result = await execute(message(attempt=4, max_attempts=5), "worker-1")
    assert result.outcome is JobOutcome.DEAD
    assert "retries exhausted" in result.error


async def test_unclassified_exception_is_treated_as_transient(repository):
    """An unclassified bug is more often a passing condition than a permanent
    property of the input, and the attempt cap bounds the cost of being wrong."""
    with patch("worker.executor.get_handler") as get_handler:
        get_handler.return_value.run = AsyncMock(side_effect=RuntimeError("unexpected"))
        result = await execute(message(attempt=0, max_attempts=5), "worker-1")
    assert result.outcome is JobOutcome.RETRY


async def test_unknown_job_type_is_permanent(repository):
    result = await execute(message(job_type="delete.everything"), "worker-1")
    assert result.outcome is JobOutcome.DEAD
    assert "no handler registered" in result.error
