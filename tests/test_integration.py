"""End to end against real Redis and PostgreSQL.

Everything else in this suite is mock based, which proves the logic and nothing
about the wiring. A mock agrees to whatever it is told: it will happily accept
an XADD with a misspelled field name, an ON CONFLICT clause against a column
with no unique constraint, or a timestamp the database was supposed to set.
These tests exist for exactly that class of bug.

Run them against the infrastructure in docker-compose.test.yml:

    docker compose -f docker-compose.test.yml up -d
    REDIS_HOST=localhost REDIS_PORT=6380 \\
    POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_DB=jobqueue_test \\
    pytest tests/ -m integration
"""

import time
from uuid import uuid4

import pytest

from app.db.connection import dispose_engine, get_engine, session_scope
from app.db.models import Base
from app.db.repository import JobRepository
from app.redis.client import close_redis, ensure_consumer_groups, get_redis
from app.redis.consumer import acknowledge, claim_stale, read_batch
from app.redis.delayed import pop_due_retries, schedule_retry
from app.redis.producer import enqueue_job, queue_depth
from app.redis.streams import (
    ALL_STREAMS,
    CONSUMER_GROUP,
    RETRY_ZSET,
    STREAM_HIGH,
    STREAM_NORMAL,
)
from app.schemas.jobs import JobPriority

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
async def infrastructure():
    """Real tables and empty streams, per test.

    Per test rather than per module for a reason that is easy to get wrong: the
    engine and the Redis client are module level singletons bound to the event
    loop that created them, and pytest-asyncio gives each test its own loop.
    Reusing them across tests hands loop A's connections to loop B, which fails
    in ways that look like infrastructure flakiness rather than a fixture bug.

    create_all rather than `alembic upgrade head` because CI runs the
    migrations against this same database before the suite starts, so they are
    already proven. Doing both here would test Alembic twice and the wiring
    once.
    """
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    client = get_redis()
    # Every stream, not just the ones a given test writes to. read_batch falls
    # through to a blocking read across all of them when the priority probes
    # come back empty, so a message left on jobs.low by an earlier test turns
    # up in a later test that never touched it.
    await client.delete(*ALL_STREAMS, RETRY_ZSET)
    await ensure_consumer_groups()

    yield

    await close_redis()
    await dispose_engine()


async def test_a_job_survives_the_round_trip_through_redis():
    job_id = uuid4()

    await enqueue_job(job_id, "transform.csv", JobPriority.HIGH, {"records": [{"id": 1}]})
    batch = await read_batch("worker-int-1", (STREAM_HIGH,), count=10, block_ms=100)

    assert len(batch.messages) == 1
    message = batch.messages[0]
    # The payload is JSON encoded onto a flat string field and decoded back. A
    # mock never exercises that, so this is where an encoding bug would show.
    assert message.job_id == job_id
    assert message.payload == {"records": [{"id": 1}]}
    assert message.job_type == "transform.csv"


async def test_a_message_goes_to_exactly_one_consumer_in_the_group():
    """The property the whole design rests on. If this were false, every job
    would run on every worker."""
    for _ in range(6):
        await enqueue_job(uuid4(), "compute.sum", JobPriority.NORMAL, {})

    first = await read_batch("worker-int-a", (STREAM_NORMAL,), count=10, block_ms=100)
    second = await read_batch("worker-int-b", (STREAM_NORMAL,), count=10, block_ms=100)

    assert len(first.messages) == 6
    assert second.messages == []


async def test_acknowledging_clears_the_pending_entry():
    await enqueue_job(uuid4(), "compute.sum", JobPriority.NORMAL, {})
    batch = await read_batch("worker-int-1", (STREAM_NORMAL,), count=10, block_ms=100)
    message = batch.messages[0]

    client = get_redis()
    assert (await client.xpending(STREAM_NORMAL, CONSUMER_GROUP))["pending"] == 1

    await acknowledge(message.stream, message.message_id)

    assert (await client.xpending(STREAM_NORMAL, CONSUMER_GROUP))["pending"] == 0


async def test_an_unacknowledged_message_can_be_reclaimed_by_another_worker():
    """A crashed worker's messages are otherwise stranded: nothing else will
    ever acknowledge them."""
    await enqueue_job(uuid4(), "compute.sum", JobPriority.NORMAL, {})
    await read_batch("worker-int-dead", (STREAM_NORMAL,), count=10, block_ms=100)

    # Idle time of zero, rather than waiting out a real timeout in a test.
    reclaimed = await claim_stale("worker-int-alive", STREAM_NORMAL, min_idle_ms=0)

    assert len(reclaimed.messages) == 1


async def test_queue_depth_reports_the_real_stream_length():
    for _ in range(4):
        await enqueue_job(uuid4(), "compute.sum", JobPriority.NORMAL, {})

    assert await queue_depth(STREAM_NORMAL) == 4


async def test_the_delay_queue_holds_a_retry_until_it_is_due():
    job_id = uuid4()
    await schedule_retry(job_id, "transform.csv", "normal", {"a": 1}, 2, 5, delay_seconds=30)

    assert await pop_due_retries(limit=10) == []

    # Same entry, asked for at a wall clock time past its due timestamp. The
    # scores are epoch seconds, so the loop's monotonic clock is the wrong one.
    due = await pop_due_retries(limit=10, now=time.time() + 3600)
    assert len(due) == 1
    assert due[0]["job_id"] == str(job_id)
    assert due[0]["attempt"] == 2


async def test_duplicate_job_ids_are_refused_by_the_database():
    """The unique constraint is the real protection. ON CONFLICT DO NOTHING is
    only correct if that constraint actually exists on the column, which is the
    kind of thing a mock cannot tell you."""
    job_id = uuid4()

    async with session_scope() as session:
        assert await JobRepository(session).create_job(job_id, "transform.csv", "normal", {}, 5)

    async with session_scope() as session:
        assert not await JobRepository(session).create_job(job_id, "transform.csv", "normal", {}, 5)


async def test_the_database_sets_the_timestamps():
    """Worker clocks drift. These columns are supposed to come from func.now(),
    and only a real database can confirm they do."""
    job_id = uuid4()

    async with session_scope() as session:
        repository = JobRepository(session)
        await repository.create_job(job_id, "compute.sum", "normal", {}, 5)

    async with session_scope() as session:
        repository = JobRepository(session)
        await repository.mark_running(job_id, "worker-int-1", 1)

    async with session_scope() as session:
        job = await JobRepository(session).get_job(job_id)

    assert job.submitted_at is not None
    assert job.started_at is not None
    assert job.started_at >= job.submitted_at


async def test_a_dead_job_is_recorded_and_can_be_replayed():
    from app.core.dlq import replay_job, send_to_dlq

    job_id = uuid4()
    async with session_scope() as session:
        await JobRepository(session).create_job(job_id, "validate.rows", "low", {"x": 1}, 5)
    async with session_scope() as session:
        await JobRepository(session).mark_dead(job_id, "retries exhausted")

    await send_to_dlq(job_id, "validate.rows", {"x": 1}, "retries exhausted", 5)

    async with session_scope() as session:
        entry = await JobRepository(session).get_dlq_entry(job_id)
    assert entry is not None
    assert entry.attempt_count == 5

    assert await replay_job(job_id) is True

    async with session_scope() as session:
        job = await JobRepository(session).get_job(job_id)
    # Reset to queued with a fresh budget, and the message is back on the low
    # priority stream it came from.
    assert job.status == "queued"
    assert job.attempt == 0
    assert job.worker_id is None
