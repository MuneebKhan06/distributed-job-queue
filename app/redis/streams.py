"""Stream and consumer group names, in one place.

Producer and consumer have to agree on these exactly. A typo in a stream name
does not raise anything: XADD happily creates a new stream and the workers sit
reading an empty one, so the constant is the safeguard.
"""

import os
import socket

from app.schemas.jobs import JobPriority

# One stream per priority. Redis delivers a stream in arrival order and offers
# no way to sort by a field inside a message, so priority cannot be a field on a
# single stream: it has to be the stream itself.
STREAM_HIGH = "jobs.high"
STREAM_NORMAL = "jobs.normal"
STREAM_LOW = "jobs.low"
STREAM_DLQ = "jobs.dlq"

# Retries wait here until they come due. A sorted set rather than a stream,
# because a stream cannot express "readable at time T".
RETRY_ZSET = "jobs.retry"

CONSUMER_GROUP = "job-workers"

STREAM_BY_PRIORITY: dict[JobPriority, str] = {
    JobPriority.HIGH: STREAM_HIGH,
    JobPriority.NORMAL: STREAM_NORMAL,
    JobPriority.LOW: STREAM_LOW,
}

# Highest priority first. Workers walk this order, so position here is what
# actually decides which stream gets drained first.
WORK_STREAMS: tuple[str, ...] = (STREAM_HIGH, STREAM_NORMAL, STREAM_LOW)

# Every stream a consumer group has to exist on before workers start, including
# the DLQ so replay can read from it.
ALL_STREAMS: tuple[str, ...] = (*WORK_STREAMS, STREAM_DLQ)


def stream_for(priority: JobPriority | str) -> str:
    """Map a priority to its stream, rejecting anything unrecognised.

    Falling back to the normal stream on an unknown value would silently
    downgrade a job's priority, which is worse than failing the submission.
    """
    key = JobPriority(priority) if isinstance(priority, str) else priority
    return STREAM_BY_PRIORITY[key]


def build_worker_name() -> str:
    """Identity of this worker inside the consumer group.

    Has to be unique per process: XCLAIM reclaims messages by consumer name, so
    two workers sharing one name makes a crashed worker's pending messages
    indistinguishable from a live one's.
    """
    return f"worker-{socket.gethostname()}-{os.getpid()}"


def poll_order(high_priority_weight: int) -> tuple[str, ...]:
    """Stream visit order for one worker loop.

    The high stream appears `high_priority_weight` times for each appearance of
    the others, so high priority work is favoured without starving the rest.
    Strict priority ordering (drain high, then normal, then low) would let a
    steady stream of high priority jobs block low priority ones indefinitely.
    """
    if high_priority_weight < 1:
        raise ValueError("high_priority_weight must be at least 1")
    return (*(STREAM_HIGH,) * high_priority_weight, STREAM_NORMAL, STREAM_LOW)


class WeightedStreamCycle:
    """Rotating cursor over the weighted stream order.

    poll_order on its own describes the ratio but does not produce it. Reading
    the streams in a fixed priority order and stopping at the first one with
    work means that while the high stream has anything on it, the normal and
    low streams are never reached at all. That is the starvation the weighting
    was meant to prevent, not an approximation of fairness.

    Rotating the starting position one step per call is what turns the ratio
    into behaviour: with a weight of 3, three passes in five begin at the high
    stream, one at normal, one at low. High priority still gets most of the
    capacity, and the other two are always reached.
    """

    def __init__(self, high_priority_weight: int) -> None:
        self._weighted = poll_order(high_priority_weight)
        self._position = 0

    def next_order(self) -> tuple[str, ...]:
        rotated = self._weighted[self._position :] + self._weighted[: self._position]
        self._position = (self._position + 1) % len(self._weighted)

        # Deduplicated, because within a single pass the repeats are pure cost:
        # probing a stream that was empty a microsecond ago costs a round trip
        # to be told the same thing. The weighting lives in the starting
        # position, not in how many times one pass asks.
        seen: set[str] = set()
        order: list[str] = []
        for stream in rotated:
            if stream not in seen:
                seen.add(stream)
                order.append(stream)
        return tuple(order)
