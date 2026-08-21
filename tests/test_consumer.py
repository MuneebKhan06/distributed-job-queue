"""Message decoding, consumer group reads, and stale message reclaim."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.redis.consumer import (
    MalformedMessage,
    acknowledge,
    claim_stale,
    decode_message,
    read_batch,
)
from app.redis.streams import CONSUMER_GROUP, STREAM_HIGH, STREAM_LOW, STREAM_NORMAL


def fields(**overrides):
    base = {
        "job_id": str(uuid4()),
        "job_type": "transform.csv",
        "priority": "normal",
        "payload": '{"records": []}',
        "attempt": "0",
        "max_attempts": "5",
    }
    base.update(overrides)
    return base


def test_decode_parses_every_field():
    message = decode_message(STREAM_HIGH, "1-0", fields(attempt="2"))
    assert message.stream == STREAM_HIGH
    assert message.message_id == "1-0"
    assert message.payload == {"records": []}
    assert message.attempt == 2


@pytest.mark.parametrize(
    "bad",
    [
        {"job_id": "not-a-uuid"},
        {"payload": "{not json"},
        {"attempt": "many"},
    ],
)
def test_undecodable_messages_raise_malformed(bad):
    """Kept distinct from a job that fails while running: retrying a message
    that cannot be parsed can never succeed."""
    with pytest.raises(MalformedMessage):
        decode_message(STREAM_HIGH, "1-0", fields(**bad))


def test_missing_field_raises_malformed():
    incomplete = fields()
    del incomplete["job_type"]
    with pytest.raises(MalformedMessage):
        decode_message(STREAM_HIGH, "1-0", incomplete)


async def test_higher_priority_stream_is_drained_first():
    client = AsyncMock()
    client.xreadgroup.return_value = [(STREAM_HIGH, [("1-0", fields())])]
    batch = await read_batch("worker-1", (STREAM_HIGH, STREAM_NORMAL, STREAM_LOW),
                             client=client)
    assert len(batch.messages) == 1
    assert client.xreadgroup.await_args.kwargs["streams"] == {STREAM_HIGH: ">"}


async def test_empty_streams_fall_through_to_a_blocking_read_on_all():
    """Blocking on one stream would leave a worker asleep on the low priority
    stream while high priority work arrived elsewhere."""
    client = AsyncMock()
    client.xreadgroup.return_value = []
    await read_batch("worker-1", (STREAM_HIGH, STREAM_NORMAL, STREAM_LOW), block_ms=1000,
                     client=client)
    final = client.xreadgroup.await_args.kwargs
    assert set(final["streams"]) == {STREAM_HIGH, STREAM_NORMAL, STREAM_LOW}
    assert final["block"] == 1000


async def test_one_bad_message_does_not_discard_the_batch():
    client = AsyncMock()
    client.xreadgroup.return_value = [
        (STREAM_NORMAL, [("1-0", {"job_id": "broken"}), ("2-0", fields())])
    ]
    batch = await read_batch("worker-1", (STREAM_NORMAL,), client=client)
    assert len(batch.messages) == 1
    assert batch.messages[0].message_id == "2-0"


async def test_an_undecodable_message_is_returned_rather_than_dropped():
    """Dropping it means it is never acknowledged, so it stays pending, gets
    reclaimed by the stale sweep, fails to decode again, and repeats forever."""
    client = AsyncMock()
    client.xreadgroup.return_value = [(STREAM_NORMAL, [("1-0", {"job_id": "broken"})])]

    batch = await read_batch("worker-1", (STREAM_NORMAL,), client=client)

    assert batch.messages == []
    assert len(batch.poison) == 1
    assert batch.poison[0].message_id == "1-0"
    assert batch.poison[0].fields == {"job_id": "broken"}


async def test_a_batch_of_only_poison_is_still_returned_immediately():
    """Returning nothing would fall through to the blocking read and leave the
    bad message sitting pending for another whole cycle."""
    client = AsyncMock()
    client.xreadgroup.return_value = [(STREAM_HIGH, [("1-0", {})])]

    batch = await read_batch("worker-1", (STREAM_HIGH, STREAM_NORMAL), client=client)

    assert len(batch.poison) == 1
    assert client.xreadgroup.await_count == 1


async def test_acknowledge_targets_the_group():
    client = AsyncMock()
    await acknowledge(STREAM_NORMAL, "3-0", client=client)
    client.xack.assert_awaited_once_with(STREAM_NORMAL, CONSUMER_GROUP, "3-0")


async def test_claim_stale_reassigns_pending_messages():
    """A crashed worker's messages sit in the PEL forever, because nothing else
    will ever acknowledge them."""
    client = AsyncMock()
    client.xautoclaim.return_value = ("0-0", [("1-0", fields())], [])
    claimed = await claim_stale("worker-2", STREAM_NORMAL, min_idle_ms=30_000, client=client)
    assert len(claimed.messages) == 1
    assert client.xautoclaim.await_args.kwargs["consumername"] == "worker-2"
    assert client.xautoclaim.await_args.kwargs["min_idle_time"] == 30_000
