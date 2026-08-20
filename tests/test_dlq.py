"""Dead letter routing and replay."""

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from app.core.dlq import replay_job, send_to_dlq


@pytest.fixture
def repository():
    return AsyncMock()


@pytest.fixture(autouse=True)
def fake_database(repository):
    @asynccontextmanager
    async def scope():
        yield MagicMock()

    with patch("app.core.dlq.session_scope", scope), patch(
        "app.core.dlq.JobRepository", return_value=repository
    ):
        yield


@pytest.fixture
def enqueue():
    with patch("app.core.dlq.enqueue_job", new=AsyncMock(return_value="1-0")) as mock:
        yield mock


@pytest.fixture
def enqueue_to_dlq():
    with patch("app.core.dlq.enqueue_dlq", new=AsyncMock(return_value="1-0")) as mock:
        yield mock


def job_row(priority="normal", job_type="transform.csv", max_attempts=5):
    row = MagicMock()
    row.job_type = job_type
    row.priority = priority
    row.payload = {"source": "sales.csv"}
    row.max_attempts = max_attempts
    return row


async def test_dead_job_is_recorded_in_postgres_and_on_the_stream(repository, enqueue_to_dlq):
    job_id = uuid4()
    await send_to_dlq(job_id, "transform.csv", {"source": "s.csv"}, "boom", 5)

    repository.add_to_dlq.assert_awaited_once()
    assert repository.add_to_dlq.await_args.kwargs["job_id"] == job_id
    assert repository.add_to_dlq.await_args.kwargs["attempt_count"] == 5
    enqueue_to_dlq.assert_awaited_once()


async def test_stream_failure_does_not_lose_the_database_record(repository):
    """The row is what replay reads, so a stream write failure must not undo it,
    and must not raise into the worker's retry path for an already dead job."""
    with patch("app.core.dlq.enqueue_dlq", new=AsyncMock(side_effect=ConnectionError("redis"))):
        await send_to_dlq(uuid4(), "compute.sum", {}, "boom", 5)

    repository.add_to_dlq.assert_awaited_once()


async def test_replay_of_a_job_not_in_the_dlq_reports_missing(repository, enqueue):
    repository.get_dlq_entry.return_value = None

    assert await replay_job(uuid4()) is False
    enqueue.assert_not_awaited()
    repository.reset_for_replay.assert_not_awaited()


async def test_replay_resets_the_row_before_enqueueing(repository, enqueue):
    job_id = uuid4()
    repository.get_dlq_entry.return_value = MagicMock()
    repository.get_job.return_value = job_row(priority="high")

    assert await replay_job(job_id) is True

    repository.reset_for_replay.assert_awaited_once_with(job_id)
    # A worker that saw the message while the row still said "dead" would have
    # its completion check refuse to run the job.
    assert enqueue.await_args.kwargs["priority"] == "high"
    assert enqueue.await_args.kwargs["attempt"] == 0


async def test_replay_keeps_the_original_payload_and_budget(repository, enqueue):
    repository.get_dlq_entry.return_value = MagicMock()
    repository.get_job.return_value = job_row(max_attempts=3)

    await replay_job(uuid4())

    assert enqueue.await_args.kwargs["payload"] == {"source": "sales.csv"}
    assert enqueue.await_args.kwargs["max_attempts"] == 3


async def test_dlq_entry_without_a_job_row_is_not_replayed(repository, enqueue):
    """Nothing to reset and no priority to enqueue under, so this needs a human
    rather than a guess at the missing values."""
    repository.get_dlq_entry.return_value = MagicMock()
    repository.get_job.return_value = None

    assert await replay_job(uuid4()) is False
    enqueue.assert_not_awaited()
