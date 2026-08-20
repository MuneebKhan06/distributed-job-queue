"""Dead letter routing and replay.

Shared by the worker, which puts jobs here, and the API, which takes them back
out. Both sides need the same notion of what a dead job is, so neither owns it.
"""

import logging
from typing import Any
from uuid import UUID

from app.db.connection import session_scope
from app.db.repository import JobRepository
from app.redis.producer import enqueue_dlq, enqueue_job

logger = logging.getLogger(__name__)


async def send_to_dlq(
    job_id: UUID,
    job_type: str,
    payload: dict[str, Any],
    error_reason: str,
    attempt_count: int,
) -> None:
    """Record a permanently failed job in both PostgreSQL and the DLQ stream.

    PostgreSQL first. The row is what an operator queries and what replay reads,
    so if only one of the two writes can succeed, that is the one worth having.
    The stream entry is a durable audit trail of the failure, not the record of
    record, which is why a failure to write it is logged rather than raised: the
    job is already dead, and turning a DLQ write error into an exception would
    send the worker down the retry path for a job that has no retries left.
    """
    async with session_scope() as session:
        await JobRepository(session).add_to_dlq(
            job_id=job_id,
            job_type=job_type,
            original_payload=payload,
            error_reason=error_reason,
            attempt_count=attempt_count,
        )

    try:
        await enqueue_dlq(
            job_id=job_id,
            job_type=job_type,
            payload=payload,
            error_reason=error_reason,
            attempt_count=attempt_count,
        )
    except Exception:
        logger.error("Job %s recorded in dlq_jobs but not on the DLQ stream", job_id, exc_info=True)


async def replay_job(job_id: UUID) -> bool:
    """Put a dead job back on its priority stream. False if it is not in the DLQ.

    The job row is reset to queued before the message is enqueued, in the same
    order as a fresh submission and for the same reason: a worker must never see
    a message whose row still says the job is dead, or the executor's
    idempotency check will refuse to run it.
    """
    async with session_scope() as session:
        repository = JobRepository(session)

        entry = await repository.get_dlq_entry(job_id)
        if entry is None:
            return False

        job = await repository.get_job(job_id)
        if job is None:
            # In the DLQ but no longer in jobs. Nothing to reset and no priority
            # to enqueue under, so this needs a human rather than a guess.
            logger.error("DLQ entry for %s has no matching job row", job_id)
            return False

        await repository.reset_for_replay(job_id)
        job_type, priority, payload, max_attempts = (
            job.job_type,
            job.priority,
            job.payload,
            job.max_attempts,
        )

    await enqueue_job(
        job_id=job_id,
        job_type=job_type,
        priority=priority,
        payload=payload,
        max_attempts=max_attempts,
        attempt=0,
    )
    logger.info("Replayed job %s from the DLQ", job_id)
    return True
