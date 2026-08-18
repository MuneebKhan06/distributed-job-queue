"""XADD side of the queue.

The stream carries enough of the job to execute it without a database read on
the happy path. PostgreSQL stays the source of truth for state, but a worker
that had to fetch the payload before starting would put a read on the hot path
of every single job.
"""

import json
import logging
from typing import Any
from uuid import UUID

from redis.asyncio import Redis

from app.redis.client import get_redis
from app.redis.streams import STREAM_DLQ, stream_for
from app.schemas.jobs import JobPriority

logger = logging.getLogger(__name__)


def _encode(job_id: UUID, job_type: str, priority: str, payload: dict[str, Any],
            attempt: int, max_attempts: int) -> dict[str, str]:
    """Redis stream fields are flat strings, so the payload is JSON encoded.

    Everything else is stringified rather than left to redis-py, to keep the
    wire format explicit: the consumer parses exactly these six fields.
    """
    return {
        "job_id": str(job_id),
        "job_type": job_type,
        "priority": str(priority),
        "payload": json.dumps(payload),
        "attempt": str(attempt),
        "max_attempts": str(max_attempts),
    }


async def enqueue_job(
    job_id: UUID,
    job_type: str,
    priority: JobPriority | str,
    payload: dict[str, Any],
    max_attempts: int = 5,
    attempt: int = 0,
    client: Redis | None = None,
) -> str:
    """Append a job to the stream for its priority, returning the message ID.

    Called after the row is committed to PostgreSQL. Doing it the other way
    round would let a worker pick up a job whose row does not exist yet.
    """
    client = client or get_redis()
    stream = stream_for(priority)
    message_id = await client.xadd(
        stream,
        _encode(job_id, job_type, str(priority), payload, attempt, max_attempts),
    )
    logger.info("Enqueued job %s on %s as %s", job_id, stream, message_id)
    return message_id


async def enqueue_dlq(
    job_id: UUID,
    job_type: str,
    payload: dict[str, Any],
    error_reason: str,
    attempt_count: int,
    client: Redis | None = None,
) -> str:
    """Append a permanently failed job to the DLQ stream.

    The DLQ row in PostgreSQL is what an operator reads. This stream exists so
    the failure is also durable in Redis, which is what makes replay possible
    without reconstructing the message from the database.
    """
    client = client or get_redis()
    message_id = await client.xadd(
        STREAM_DLQ,
        {
            "job_id": str(job_id),
            "job_type": job_type,
            "payload": json.dumps(payload),
            "error_reason": error_reason,
            "attempt_count": str(attempt_count),
        },
    )
    logger.warning("Job %s sent to DLQ after %d attempts: %s", job_id, attempt_count, error_reason)
    return message_id


async def queue_depth(stream: str, client: Redis | None = None) -> int:
    """XLEN for one stream. Used by metrics and by the health endpoint."""
    client = client or get_redis()
    return int(await client.xlen(stream))
