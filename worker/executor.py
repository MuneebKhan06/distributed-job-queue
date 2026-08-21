"""Runs one job and records what happened.

Deciding what to do next (retry, or give up and route to the DLQ) is not done
here. This module answers "what was the outcome", and the worker loop acts on
it, which keeps the retry policy in one place instead of spread through the
execution path.
"""

import logging
import time
from enum import Enum
from typing import Any

from app.core.dlq import send_to_dlq
from app.core.metrics import JOB_DURATION, JOBS_COMPLETED, JOBS_DEAD, JOBS_FAILED
from app.db.connection import session_scope
from app.db.repository import JobRepository
from app.redis.consumer import JobMessage
from worker.handlers import PermanentJobError, get_handler

logger = logging.getLogger(__name__)


class JobOutcome(str, Enum):
    COMPLETED = "completed"
    RETRY = "retry"
    #: Failed in a way retrying cannot fix, or ran out of attempts.
    DEAD = "dead"
    #: Already finished by an earlier delivery of the same message. The message
    #: still needs acknowledging, but nothing was executed.
    SKIPPED = "skipped"


class ExecutionResult:
    def __init__(
        self,
        outcome: JobOutcome,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        self.outcome = outcome
        self.result = result
        self.error = error

    def __repr__(self) -> str:
        return f"<ExecutionResult {self.outcome.value} error={self.error!r}>"


async def execute(message: JobMessage, worker_id: str) -> ExecutionResult:
    """Execute one message, updating job state in PostgreSQL as it goes."""
    attempt = message.attempt + 1

    # Two short transactions rather than one spanning the whole job. A handler
    # can run for seconds, and holding a transaction open across it pins a
    # pooled connection for the entire duration for no benefit.
    async with session_scope() as session:
        repository = JobRepository(session)
        # The idempotency check that makes at-least-once delivery safe. A
        # message redelivered after a crash between the completion write and
        # the ACK lands here, and must not run the job a second time.
        if await repository.is_completed(message.job_id):
            logger.info("Job %s already completed, skipping re-execution", message.job_id)
            return ExecutionResult(JobOutcome.SKIPPED)
        await repository.mark_running(message.job_id, worker_id, attempt)

    started = time.perf_counter()
    try:
        handler = get_handler(message.job_type)
        result = await handler.run(message.job_type, message.payload)
    except PermanentJobError as exc:
        return await _record_dead(message, str(exc), permanent=True)
    except Exception as exc:
        # Anything not explicitly permanent is treated as transient. An
        # unclassified exception is more often a passing condition than a
        # permanent property of the input, and the attempt cap bounds the cost
        # of being wrong about that.
        error = f"{type(exc).__name__}: {exc}"
        if attempt >= message.max_attempts:
            logger.error("Job %s exhausted %d attempts: %s", message.job_id, attempt, error)
            return await _record_dead(message, error, permanent=False)
        logger.warning("Job %s attempt %d failed: %s", message.job_id, attempt, error)
        JOBS_FAILED.labels(job_type=message.job_type).inc()
        async with session_scope() as session:
            await JobRepository(session).mark_failed(message.job_id, error)
        return ExecutionResult(JobOutcome.RETRY, error=error)

    # Measured around the handler only. Including the database writes would
    # blur "this job type is slow" into "PostgreSQL is slow", which are two
    # different problems with two different fixes.
    JOB_DURATION.labels(job_type=message.job_type).observe(time.perf_counter() - started)

    async with session_scope() as session:
        await JobRepository(session).mark_completed(message.job_id, result)
    JOBS_COMPLETED.labels(job_type=message.job_type).inc()
    logger.info("Job %s completed on attempt %d", message.job_id, attempt)
    return ExecutionResult(JobOutcome.COMPLETED, result=result)


async def _record_dead(message: JobMessage, error: str, permanent: bool) -> ExecutionResult:
    reason = "permanent failure" if permanent else "retries exhausted"
    detail = f"{reason}: {error}"

    JOBS_DEAD.labels(
        job_type=message.job_type,
        reason="permanent" if permanent else "exhausted",
    ).inc()

    async with session_scope() as session:
        await JobRepository(session).mark_dead(message.job_id, detail)

    # Routed to the DLQ after the job row is marked, so a dead job is never
    # visible in the DLQ while the jobs table still claims it is running.
    await send_to_dlq(
        job_id=message.job_id,
        job_type=message.job_type,
        payload=message.payload,
        error_reason=detail,
        attempt_count=message.attempt + 1,
    )
    return ExecutionResult(JobOutcome.DEAD, error=detail)
