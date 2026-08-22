"""Metric wiring for the API and the workers."""

from unittest.mock import AsyncMock, patch

from prometheus_client import REGISTRY

from app.core.metrics import refresh_queue_depths
from app.redis.streams import (
    CONSUMER_GROUP,
    RETRY_ZSET,
    STREAM_DLQ,
    STREAM_HIGH,
    WORK_STREAMS,
)


class FakeRedis:
    def __init__(self, lengths=None, lags=None, pending=None, zcard=0, fail=False):
        self.lengths = lengths or {}
        self.lags = lags or {}
        self.pending = pending or {}
        self._zcard = zcard
        self.fail = fail

    async def xlen(self, stream):
        if self.fail:
            raise ConnectionError("redis is down")
        return self.lengths.get(stream, 0)

    async def xinfo_groups(self, stream):
        if self.fail:
            raise ConnectionError("redis is down")
        return [
            {
                "name": CONSUMER_GROUP,
                "lag": self.lags.get(stream, 0),
                "pending": self.pending.get(stream, 0),
            }
        ]

    async def zcard(self, key):
        assert key == RETRY_ZSET
        return self._zcard


def gauge(name, **labels):
    return REGISTRY.get_sample_value(name, labels)


async def test_backlog_is_the_group_lag_not_the_stream_length():
    """The regression this guards against: acknowledging a message leaves it in
    the stream, so XLEN counts every job ever submitted. A fully drained queue
    reported a backlog of thousands, which is worse than no gauge at all
    because the number looks plausible."""
    fake = FakeRedis(lengths={STREAM_HIGH: 3300}, lags={STREAM_HIGH: 0}, pending={STREAM_HIGH: 0})

    with patch("app.core.metrics.get_redis", return_value=fake):
        await refresh_queue_depths()

    assert gauge("queue_depth", stream=STREAM_HIGH) == 0
    assert gauge("stream_length", stream=STREAM_HIGH) == 3300


async def test_in_flight_work_is_reported_separately():
    """Lag is work nobody started. Pending is work a worker took and has not
    acknowledged, and a pending count that never moves is a dead worker."""
    fake = FakeRedis(lengths={STREAM_HIGH: 10}, lags={STREAM_HIGH: 4}, pending={STREAM_HIGH: 6})

    with patch("app.core.metrics.get_redis", return_value=fake):
        await refresh_queue_depths()

    assert gauge("queue_depth", stream=STREAM_HIGH) == 4
    assert gauge("queue_pending", stream=STREAM_HIGH) == 6


async def test_queue_depths_are_read_from_redis():
    fake = FakeRedis(lengths={STREAM_HIGH: 7}, lags={STREAM_HIGH: 7}, zcard=3)

    with patch("app.core.metrics.get_redis", return_value=fake):
        await refresh_queue_depths()

    assert gauge("queue_depth", stream=STREAM_HIGH) == 7
    assert gauge("retry_queue_depth") == 3


async def test_every_stream_including_the_dlq_is_reported():
    streams = (*WORK_STREAMS, STREAM_DLQ)
    fake = FakeRedis(lengths=dict.fromkeys(streams, 1), lags=dict.fromkeys(streams, 1), zcard=0)

    with patch("app.core.metrics.get_redis", return_value=fake):
        await refresh_queue_depths()

    for stream in streams:
        assert gauge("queue_depth", stream=stream) == 1


async def test_a_redis_failure_does_not_break_the_scrape():
    """Prometheus asking for numbers must not fail because Redis blinked. The
    gauges keep their last known values instead."""
    with patch("app.core.metrics.get_redis", return_value=FakeRedis(fail=True)):
        await refresh_queue_depths()

    assert gauge("queue_depth", stream=STREAM_HIGH) is not None


def test_metrics_endpoint_serves_the_prometheus_format():
    from fastapi.testclient import TestClient

    from app.main import app

    with patch("app.api.routes.metrics.refresh_queue_depths", new=AsyncMock()):
        response = TestClient(app).get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "jobs_submitted_total" in response.text


def test_worker_keeps_running_when_the_metrics_port_is_taken():
    """Losing observability is bad. Refusing to process jobs because of it is
    worse, so a bind failure is logged and swallowed."""
    from worker.metrics import start_metrics_server

    with patch("worker.metrics.start_http_server", side_effect=OSError("in use")):
        start_metrics_server(9100, "worker-test-1")

    assert gauge("worker_up", worker_id="worker-test-1") is None
