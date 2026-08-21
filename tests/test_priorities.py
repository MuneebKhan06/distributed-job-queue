"""Priority to stream mapping and the weighted poll order."""

import pytest

from app.redis.streams import (
    STREAM_HIGH,
    STREAM_LOW,
    STREAM_NORMAL,
    WeightedStreamCycle,
    build_worker_name,
    poll_order,
    stream_for,
)
from app.schemas.jobs import JobPriority


def test_each_priority_maps_to_its_own_stream():
    streams = {stream_for(p) for p in JobPriority}
    assert streams == {STREAM_HIGH, STREAM_NORMAL, STREAM_LOW}


def test_stream_for_accepts_enum_and_string():
    assert stream_for(JobPriority.HIGH) == stream_for("high") == STREAM_HIGH


def test_unknown_priority_is_rejected_rather_than_defaulted():
    """Falling back to the normal stream would silently downgrade the job,
    which is a worse outcome than refusing the submission."""
    with pytest.raises(ValueError):
        stream_for("urgent")


def test_poll_order_favours_high_priority_by_the_weight():
    order = poll_order(3)
    assert order.count(STREAM_HIGH) == 3
    assert order.count(STREAM_NORMAL) == 1
    assert order.count(STREAM_LOW) == 1


def test_poll_order_still_reaches_low_priority():
    """The whole point of weighting rather than strict ordering: a flood of
    high priority work must not starve the low priority stream forever."""
    for weight in (1, 5, 25):
        assert STREAM_LOW in poll_order(weight)


def test_high_priority_is_visited_first():
    assert poll_order(2)[0] == STREAM_HIGH


def test_weight_below_one_is_rejected():
    with pytest.raises(ValueError):
        poll_order(0)


def test_worker_names_are_unique_per_process():
    """XCLAIM targets a consumer by name, so two workers sharing a name makes a
    crashed worker's pending messages indistinguishable from a live one's."""
    name = build_worker_name()
    assert name.startswith("worker-")
    assert name.split("-")[-1].isdigit()


def test_cycle_starts_at_high_in_proportion_to_the_weight():
    cycle = WeightedStreamCycle(3)

    starts = [cycle.next_order()[0] for _ in range(5)]

    assert starts.count(STREAM_HIGH) == 3
    assert starts.count(STREAM_NORMAL) == 1
    assert starts.count(STREAM_LOW) == 1


def test_every_stream_is_reached_within_one_cycle():
    """The regression this guards: reading in fixed priority order and stopping
    at the first stream with work means normal and low are never reached while
    high has anything on it, which is the starvation the weighting exists to
    prevent."""
    cycle = WeightedStreamCycle(3)

    starts = {cycle.next_order()[0] for _ in range(5)}

    assert starts == {STREAM_HIGH, STREAM_NORMAL, STREAM_LOW}


def test_a_pass_never_probes_the_same_stream_twice():
    """Repeats within one pass cost a round trip to be told what the previous
    probe already said."""
    cycle = WeightedStreamCycle(5)

    for _ in range(12):
        order = cycle.next_order()
        assert len(order) == len(set(order)) == 3


def test_a_weight_of_one_is_plain_round_robin():
    cycle = WeightedStreamCycle(1)

    starts = [cycle.next_order()[0] for _ in range(6)]

    assert starts == [STREAM_HIGH, STREAM_NORMAL, STREAM_LOW] * 2


def test_cycle_rejects_a_weight_below_one():
    with pytest.raises(ValueError):
        WeightedStreamCycle(0)
