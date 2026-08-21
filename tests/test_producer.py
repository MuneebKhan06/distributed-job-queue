"""XADD encoding and stream routing."""

import json
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.redis.producer import enqueue_dlq, enqueue_job, queue_depth
from app.redis.streams import STREAM_DLQ, STREAM_HIGH, STREAM_LOW, STREAM_NORMAL
from app.schemas.jobs import JobPriority


@pytest.fixture
def client():
    fake = AsyncMock()
    fake.xadd.return_value = "1699999999-0"
    return fake


async def test_job_goes_to_the_stream_for_its_priority(client):
    for priority, expected in (
        ("high", STREAM_HIGH),
        ("normal", STREAM_NORMAL),
        ("low", STREAM_LOW),
    ):
        await enqueue_job(uuid4(), "transform.csv", priority, {}, client=client)
        assert client.xadd.await_args[0][0] == expected


async def test_payload_is_json_encoded(client):
    """Stream fields are flat strings, so a nested payload has to survive the
    round trip as JSON rather than being stringified by redis-py."""
    payload = {"records": [{"a": 1}], "nested": {"deep": [1, 2]}}
    await enqueue_job(uuid4(), "transform.csv", "normal", payload, client=client)
    fields = client.xadd.await_args[0][1]
    assert json.loads(fields["payload"]) == payload


async def test_all_fields_are_strings(client):
    """redis-py will not encode an int, and a worker reading these expects
    every field to be a string it parses itself."""
    await enqueue_job(uuid4(), "transform.csv", "normal", {}, max_attempts=3, attempt=2,
                      client=client)
    fields = client.xadd.await_args[0][1]
    assert all(isinstance(value, str) for value in fields.values())
    assert fields["attempt"] == "2"
    assert fields["max_attempts"] == "3"


async def test_message_id_is_returned(client):
    assert await enqueue_job(uuid4(), "transform.csv", "normal", {}, client=client) == (
        "1699999999-0"
    )


async def test_dlq_message_carries_the_failure_reason(client):
    job_id = uuid4()
    await enqueue_dlq(job_id, "transform.csv", {"a": 1}, "boom", 5, client=client)
    stream, fields = client.xadd.await_args[0]
    assert stream == STREAM_DLQ
    assert fields["error_reason"] == "boom"
    assert fields["attempt_count"] == "5"
    assert fields["job_id"] == str(job_id)


async def test_queue_depth_reads_xlen(client):
    client.xlen.return_value = 42
    assert await queue_depth(STREAM_HIGH, client=client) == 42
    client.xlen.assert_awaited_once_with(STREAM_HIGH)


async def test_job_streams_are_trimmed_so_they_do_not_grow_forever():
    """XACK takes a message out of the pending list, not out of the stream, so
    without a maxlen every job ever submitted stays in Redis memory."""
    client = AsyncMock()
    client.xadd.return_value = "1-0"

    await enqueue_job(uuid4(), "transform.csv", JobPriority.NORMAL, {}, client=client)

    kwargs = client.xadd.await_args.kwargs
    assert kwargs["maxlen"] > 0
    # Approximate, so Redis drops whole nodes rather than walking to an exact
    # length on every single append.
    assert kwargs["approximate"] is True


async def test_the_dlq_stream_is_trimmed_too():
    client = AsyncMock()
    client.xadd.return_value = "1-0"

    await enqueue_dlq(uuid4(), "compute.sum", {}, "boom", 5, client=client)

    assert client.xadd.await_args.kwargs["approximate"] is True
