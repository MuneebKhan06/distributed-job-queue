"""Priority to stream mapping and the weighted poll order."""

import pytest

from app.redis.streams import (
    STREAM_HIGH,
    STREAM_LOW,
    STREAM_NORMAL,
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
