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


@dataclass(frozen=True)
class PoisonMessage:
    """A message that could not be decoded, carried out for disposal.

    Dropping one silently is worse than it sounds. It is never acknowledged, so
    it stays in the pending list, the stale sweep reclaims it, it fails to
    decode again, and the cycle repeats for the life of the system. Returning
    it lets the caller acknowledge it and record it, which ends the loop.
    """

    stream: str
    message_id: str
    fields: dict[str, str]
    error: str


@dataclass(frozen=True)
class Batch:
    """What one read returned: what can be executed, and what cannot."""

    messages: list[JobMessage]
    poison: list[PoisonMessage]

    def __len__(self) -> int:
        return len(self.messages)


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
) -> Batch:
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
        batch = _flatten(response)
        if batch.messages or batch.poison:
            return batch

    response = await client.xreadgroup(
        groupname=CONSUMER_GROUP,
        consumername=worker_name,
        streams=dict.fromkeys(WORK_STREAMS, ">"),
        count=count,
        block=block_ms,
    )
    return _flatten(response)


def _flatten(response: Any) -> Batch:
    """Turn redis-py's [(stream, [(id, fields), ...]), ...] into a Batch.

    A message that will not decode is separated out rather than raising, so one
    bad message cannot stall the rest of the batch, and is returned rather than
    dropped, so the caller can acknowledge it instead of leaving it to be
    reclaimed and re-failed forever.
    """
    messages: list[JobMessage] = []
    poison: list[PoisonMessage] = []
    for stream, entries in response or []:
        for message_id, fields in entries:
            try:
                messages.append(decode_message(stream, message_id, fields))
            except MalformedMessage as exc:
                logger.error("Undecodable message: %s", exc)
                poison.append(PoisonMessage(stream, message_id, fields, str(exc)))
    return Batch(messages=messages, poison=poison)


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
) -> Batch:
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
    batch = _flatten([(stream, entries)])
    if batch.messages:
        logger.info("Reclaimed %d stale messages from %s", len(batch.messages), stream)
    return batch
