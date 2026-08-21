"""Prometheus metrics shared by the API and the workers.

Definitions live here rather than next to their call sites so that a metric has
one name and one label set across both processes. Two modules each defining
their own jobs_total with different labels is how a dashboard ends up unable to
sum across them.
"""

import logging

from prometheus_client import Counter, Gauge, Histogram

from app.redis.client import get_redis
from app.redis.streams import RETRY_ZSET, STREAM_DLQ, WORK_STREAMS

logger = logging.getLogger(__name__)

JOBS_SUBMITTED = Counter(
    "jobs_submitted_total",
    "Jobs accepted by the API and written to a stream",
    ["job_type", "priority"],
)

JOBS_COMPLETED = Counter(
    "jobs_completed_total",
    "Jobs that finished successfully",
    ["job_type"],
)

JOBS_FAILED = Counter(
    "jobs_failed_total",
    "Job attempts that failed and will be retried",
    ["job_type"],
)

JOBS_DEAD = Counter(
    "jobs_dead_total",
    "Jobs routed to the dead letter queue",
    # Separating a permanent failure from an exhausted retry budget is the
    # difference between "the input is wrong" and "a dependency is down".
    ["job_type", "reason"],
)

JOB_DURATION = Histogram(
    "job_duration_seconds",
    "Handler execution time",
    ["job_type"],
    # Tuned to the handlers in this project, which finish in milliseconds. The
    # library defaults top out at 10s and would put almost every job in the
    # first bucket, making the histogram useless for spotting a slow one.
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

QUEUE_DEPTH = Gauge(
    "queue_depth",
    "Messages waiting on each stream",
    ["stream"],
)

RETRY_QUEUE_DEPTH = Gauge(
    "retry_queue_depth",
    "Jobs parked in the delay queue waiting to come due",
)


async def refresh_queue_depths() -> None:
    """Read the current depths into the gauges.

    Called at scrape time rather than tracked incrementally. A counter that the
    API increments and workers decrement drifts the moment either restarts,
    whereas XLEN is the truth and costs one round trip.
    """
    client = get_redis()
    try:
        for stream in (*WORK_STREAMS, STREAM_DLQ):
            QUEUE_DEPTH.labels(stream=stream).set(await client.xlen(stream))
        RETRY_QUEUE_DEPTH.set(await client.zcard(RETRY_ZSET))
    except Exception:
        # A scrape must not fail because Redis blinked. The gauges keep their
        # previous values, and the Redis exporter is what reports Redis itself
        # being down.
        logger.warning("Could not refresh queue depth gauges", exc_info=True)
