"""A delay queue for retries, backed by a Redis sorted set.

Redis Streams have no delayed delivery: anything appended with XADD is readable
immediately. That leaves three ways to make a retry wait, and only one of them
survives a worker dying while the retry is pending.

Sleeping in the worker before re-enqueueing blocks that worker for the whole
delay, and a crash during the sleep loses the job outright, because the
original message was already acknowledged. Re-enqueueing immediately with a
"not before" field makes every worker spin re-reading jobs that are not due.

A sorted set scored by the due timestamp has neither problem. The entry is in
Redis, so a worker crash costs nothing, and finding what is due is a range
query rather than a scan.
"""

import json
import logging
import time
from typing import Any
from uuid import UUID

from redis.asyncio import Redis

from app.redis.client import get_redis
from app.redis.streams import RETRY_ZSET

logger = logging.getLogger(__name__)


async def schedule_retry(
    job_id: UUID,
    job_type: str,
    priority: str,
    payload: dict[str, Any],
    attempt: int,
    max_attempts: int,
    delay_seconds: float,
    client: Redis | None = None,
    now: float | None = None,
) -> float:
    """Park a job until `delay_seconds` from now. Returns the due timestamp.

    The attempt number is part of the member, so the same job scheduled twice
    for different attempts is two entries rather than one silently overwriting
    the other.
    """
    client = client or get_redis()
    due_at = (now if now is not None else time.time()) + delay_seconds
    member = json.dumps(
        {
            "job_id": str(job_id),
            "job_type": job_type,
            "priority": priority,
            "payload": payload,
            "attempt": attempt,
            "max_attempts": max_attempts,
        },
        sort_keys=True,
    )
    await client.zadd(RETRY_ZSET, {member: due_at})
    logger.info("Job %s retry %d scheduled in %.2fs", job_id, attempt, delay_seconds)
    return due_at


async def pop_due_retries(
    limit: int = 10,
    client: Redis | None = None,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """Remove and return the retries that have come due.

    ZPOPMIN pops the earliest entry atomically, so two workers sweeping at the
    same moment cannot both take the same one. An entry that turns out not to
    be due yet is put straight back, and the sweep stops there: the set is
    ordered, so nothing after it can be due either.
    """
    client = client or get_redis()
    now = now if now is not None else time.time()
    due: list[dict[str, Any]] = []

    for _ in range(limit):
        popped = await client.zpopmin(RETRY_ZSET, 1)
        if not popped:
            break
        member, score = popped[0]
        if score > now:
            await client.zadd(RETRY_ZSET, {member: score})
            break
        try:
            due.append(json.loads(member))
        except json.JSONDecodeError:
            # Dropped rather than put back: an entry that will not parse would
            # otherwise be popped and requeued forever, blocking everything
            # scheduled behind it.
            logger.error("Discarded unparseable retry entry: %r", member)
    return due


async def retry_queue_depth(client: Redis | None = None) -> int:
    """How many retries are parked. Reported as a metric, because a number that
    climbs steadily means jobs are failing faster than they are succeeding."""
    client = client or get_redis()
    return int(await client.zcard(RETRY_ZSET))
