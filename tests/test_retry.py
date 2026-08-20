"""Backoff timing and the sorted set delay queue."""

import random
from uuid import uuid4

import pytest

from app.redis.delayed import pop_due_retries, retry_queue_depth, schedule_retry
from app.redis.streams import RETRY_ZSET
from worker.retry import compute_delay, should_retry


class FakeSortedSet:
    """Enough of a Redis sorted set to exercise the pop and put back ordering.

    A real Redis would be an integration test. What matters here is the logic
    around ZPOPMIN, not that redis-py can talk to a server.
    """

    def __init__(self):
        self.entries: dict[str, float] = {}

    async def zadd(self, key, mapping):
        assert key == RETRY_ZSET
        self.entries.update(mapping)

    async def zpopmin(self, key, count):
        if not self.entries:
            return []
        member = min(self.entries, key=lambda m: self.entries[m])
        return [(member, self.entries.pop(member))]

    async def zcard(self, key):
        return len(self.entries)


@pytest.fixture
def zset():
    return FakeSortedSet()


def test_delay_grows_exponentially_until_it_is_clamped():
    rng = random.Random(1)
    # Sampled repeatedly because the jitter makes any single value uninformative.
    for attempt, expected_window in [(0, 1), (1, 2), (2, 4), (3, 8), (10, 60), (50, 60)]:
        for _ in range(200):
            delay = compute_delay(attempt, base_delay=1.0, max_delay=60.0, rng=rng)
            assert expected_window * 0.5 <= delay <= expected_window


def test_jitter_actually_varies():
    rng = random.Random(99)
    samples = {compute_delay(3, 1.0, 60.0, rng) for _ in range(50)}
    # Without jitter every sample would be identical, which is the thundering
    # herd this is meant to prevent.
    assert len(samples) > 40


def test_equal_jitter_never_collapses_to_no_delay():
    rng = random.Random(5)
    assert min(compute_delay(0, 1.0, 60.0, rng) for _ in range(500)) >= 0.5


@pytest.mark.parametrize(
    "attempt,base,maximum",
    [(-1, 1.0, 60.0), (0, 0.0, 60.0), (0, -1.0, 60.0), (0, 10.0, 5.0)],
)
def test_nonsense_parameters_are_rejected(attempt, base, maximum):
    with pytest.raises(ValueError):
        compute_delay(attempt, base, maximum)


def test_should_retry_compares_against_the_budget():
    assert should_retry(0, 5)
    assert should_retry(4, 5)
    assert not should_retry(5, 5)
    assert not should_retry(6, 5)


async def test_scheduled_retry_is_not_returned_before_it_is_due(zset):
    await schedule_retry(
        uuid4(), "transform.csv", "normal", {}, 1, 5, delay_seconds=30, client=zset, now=1000
    )
    assert await pop_due_retries(client=zset, now=1010) == []
    assert await retry_queue_depth(client=zset) == 1


async def test_due_retry_is_returned_with_its_attempt_count(zset):
    job_id = uuid4()
    await schedule_retry(
        job_id, "compute.sum", "high", {"rows": [1]}, 3, 5, delay_seconds=5, client=zset, now=1000
    )
    due = await pop_due_retries(client=zset, now=1006)
    assert len(due) == 1
    assert due[0]["job_id"] == str(job_id)
    assert due[0]["attempt"] == 3
    assert due[0]["payload"] == {"rows": [1]}
    assert await retry_queue_depth(client=zset) == 0


async def test_sweep_stops_at_the_first_entry_that_is_not_due(zset):
    await schedule_retry(
        uuid4(), "a.one", "low", {}, 1, 5, delay_seconds=1, client=zset, now=1000
    )
    await schedule_retry(
        uuid4(), "b.two", "low", {}, 1, 5, delay_seconds=900, client=zset, now=1000
    )
    due = await pop_due_retries(client=zset, now=1002)
    # The far future entry must be put back, not consumed and dropped.
    assert [entry["job_type"] for entry in due] == ["a.one"]
    assert await retry_queue_depth(client=zset) == 1


async def test_same_job_at_different_attempts_is_two_entries(zset):
    job_id = uuid4()
    await schedule_retry(job_id, "t.csv", "normal", {}, 1, 5, delay_seconds=1, client=zset, now=0)
    await schedule_retry(job_id, "t.csv", "normal", {}, 2, 5, delay_seconds=1, client=zset, now=0)
    # Collapsing these would silently lose a retry.
    assert await retry_queue_depth(client=zset) == 2


async def test_limit_caps_how_many_are_released_at_once(zset):
    for index in range(10):
        await schedule_retry(
            uuid4(), f"j.{index}", "normal", {}, 1, 5, delay_seconds=1, client=zset, now=0
        )
    due = await pop_due_retries(limit=4, client=zset, now=100)
    assert len(due) == 4
    assert await retry_queue_depth(client=zset) == 6
