"""XREADGROUP side of the queue.

A consumer group is what makes competing workers safe: Redis hands each message
to exactly one consumer in the group and tracks it in the Pending Entries List
until that consumer acknowledges it. Nothing here has to coordinate with the
other workers, because Redis already did.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from redis.asyncio import Redis

from app.redis.client import get_redis
from app.redis.streams import CONSUMER_GROUP, WORK_STREAMS

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobMessage:
    """One message read off a stream, decoded into the shape a worker wants."""

    stream: str
    message_id: str
    job_id: UUID
    job_type: str
    priority: str
    payload: dict[str, Any]
    attempt: int
    max_attempts: int


class MalformedMessage(Exception):
    """A message that cannot be decoded.

    Kept distinct from a job that fails while running: retrying an unparseable
    message just burns the retry budget on something that can never succeed.
    """


def decode_message(stream: str, message_id: str, fields: dict[str, str]) -> JobMessage:
    try:
        return JobMessage(
            stream=stream,
            message_id=message_id,
            job_id=UUID(fields["job_id"]),
            job_type=fields["job_type"],
            priority=fields["priority"],
            payload=json.loads(fields["payload"]),
            attempt=int(fields["attempt"]),
            max_attempts=int(fields["max_attempts"]),
        )
    except (KeyError, ValueError, json.JSONDecodeError) as exc:
        raise MalformedMessage(f"{message_id} on {stream}: {exc}") from exc


async def read_batch(
    worker_name: str,
    poll_streams: tuple[str, ...],
    count: int = 10,
    block_ms: int = 5000,
    client: Redis | None = None,
) -> list[JobMessage]:
    """Read the next batch, honouring the weighted priority order.

    Each stream is tried without blocking, in the order given, so a high
    priority job waiting anywhere is taken before a normal one. Only when every
    stream is empty does it block, and then on all of them at once: blocking on
    a single stream would leave a worker asleep on the low priority stream while
    high priority work arrived elsewhere.
    """
    client = client or get_redis()

    for stream in poll_streams:
        response = await client.xreadgroup(
            groupname=CONSUMER_GROUP,
            consumername=worker_name,
            streams={stream: ">"},
            count=count,
            block=None,
        )
        messages = _flatten(response)
        if messages:
            return messages

    response = await client.xreadgroup(
        groupname=CONSUMER_GROUP,
        consumername=worker_name,
        streams=dict.fromkeys(WORK_STREAMS, ">"),
        count=count,
        block=block_ms,
    )
    return _flatten(response)


def _flatten(response: Any) -> list[JobMessage]:
    """Turn redis-py's [(stream, [(id, fields), ...]), ...] into JobMessages.

    A message that will not decode is dropped here with a log rather than
    raising, so one bad message cannot stall the whole batch. It stays in the
    PEL and is picked up by the stale message sweep, which routes it to the DLQ.
    """
    messages: list[JobMessage] = []
    for stream, entries in response or []:
        for message_id, fields in entries:
            try:
                messages.append(decode_message(stream, message_id, fields))
            except MalformedMessage as exc:
                logger.error("Skipping undecodable message: %s", exc)
    return messages


async def acknowledge(stream: str, message_id: str, client: Redis | None = None) -> None:
    """Remove a message from the PEL.

    Called only after PostgreSQL confirms the job is finished. Acknowledging any
    earlier turns a worker crash into a lost job.
    """
    client = client or get_redis()
    await client.xack(stream, CONSUMER_GROUP, message_id)


async def claim_stale(
    worker_name: str,
    stream: str,
    min_idle_ms: int = 60_000,
    count: int = 10,
    client: Redis | None = None,
) -> list[JobMessage]:
    """Take over messages a dead worker left pending.

    When a worker crashes mid-job its messages stay in the PEL forever, since
    nothing else will ever acknowledge them. XAUTOCLAIM reassigns anything idle
    longer than min_idle_ms to this worker. Re-execution is safe because the
    executor checks the job's status in PostgreSQL before running it.
    """
    client = client or get_redis()
    _cursor, entries, _deleted = await client.xautoclaim(
        name=stream,
        groupname=CONSUMER_GROUP,
        consumername=worker_name,
        min_idle_time=min_idle_ms,
        count=count,
    )
    claimed: list[JobMessage] = []
    for message_id, fields in entries:
        try:
            claimed.append(decode_message(stream, message_id, fields))
        except MalformedMessage as exc:
            logger.error("Claimed a message that will not decode: %s", exc)
    if claimed:
        logger.info("Reclaimed %d stale messages from %s", len(claimed), stream)
    return claimed
