"""Worker entry point.

One process, one consumer in the group, looping until told to stop. Scaling out
means running more of these: Redis assigns each message to exactly one consumer
in the group, so no coordination between workers is needed or wanted.
"""

import asyncio
import logging
import signal
from uuid import UUID, uuid4

from app.config import get_settings
from app.core.dlq import send_to_dlq
from app.db.connection import dispose_engine
from app.redis.client import close_redis, ensure_consumer_groups
from app.redis.consumer import (
    Batch,
    JobMessage,
    PoisonMessage,
    acknowledge,
    claim_stale,
    read_batch,
)
from app.redis.delayed import pop_due_retries, schedule_retry
from app.redis.producer import enqueue_job
from app.redis.streams import WORK_STREAMS, WeightedStreamCycle, build_worker_name
from worker.executor import JobOutcome, execute
from worker.metrics import JOBS_IN_FLIGHT, mark_stopped, start_metrics_server
from worker.retry import compute_delay

settings = get_settings()

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(levelname)-5.5s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)

# How long a message sits unacknowledged before another worker may take it
# over. Long enough that a slow job is not stolen from a healthy worker, short
# enough that a crashed worker's jobs do not sit idle for minutes.
STALE_AFTER_MS = 60_000

_shutdown = asyncio.Event()


def _request_shutdown(signum: int, _frame: object = None) -> None:
    logger.info("Received %s, finishing current batch then stopping", signal.Signals(signum).name)
    _shutdown.set()


async def _handle(message: JobMessage, worker_name: str) -> None:
    """Execute one message and decide what happens to it on the stream."""
    JOBS_IN_FLIGHT.labels(worker_id=worker_name).inc()
    try:
        result = await execute(message, worker_name)
    finally:
        # In a finally, so a raised exception cannot leave the gauge stuck
        # above zero for the life of the process.
        JOBS_IN_FLIGHT.labels(worker_id=worker_name).dec()

    if result.outcome in (JobOutcome.COMPLETED, JobOutcome.SKIPPED):
        # ACK only after PostgreSQL has confirmed the job is finished. This
        # ordering is what makes a crash mid-job a redelivery rather than a
        # silently lost job.
        await acknowledge(message.stream, message.message_id)
        return

    if result.outcome == JobOutcome.RETRY:
        # Parked in the delay queue rather than put straight back on the
        # stream. Scheduling happens before the ACK, so a crash in between
        # leaves the original in the PEL to be reclaimed instead of dropping
        # the retry on the floor.
        attempt = message.attempt + 1
        delay = compute_delay(
            attempt=attempt,
            base_delay=settings.retry_base_delay_seconds,
            max_delay=settings.retry_max_delay_seconds,
        )
        await schedule_retry(
            job_id=message.job_id,
            job_type=message.job_type,
            priority=message.priority,
            payload=message.payload,
            attempt=attempt,
            max_attempts=message.max_attempts,
            delay_seconds=delay,
        )
        await acknowledge(message.stream, message.message_id)
        return

    # Dead. The job is marked in PostgreSQL and the message is acknowledged so
    # it stops being redelivered.
    await acknowledge(message.stream, message.message_id)


async def _release_due_retries() -> int:
    """Move retries that have come due back onto their priority stream.

    Every worker sweeps, and ZPOPMIN guarantees each entry goes to exactly one
    of them, so this needs no separate scheduler process to run correctly.
    """
    released = 0
    for entry in await pop_due_retries(limit=settings.worker_batch_size):
        await enqueue_job(
            job_id=UUID(entry["job_id"]),
            job_type=entry["job_type"],
            priority=entry["priority"],
            payload=entry["payload"],
            max_attempts=entry["max_attempts"],
            attempt=entry["attempt"],
        )
        released += 1
    if released:
        logger.info("Released %d due retries back onto the queue", released)
    return released


async def _discard(poison: PoisonMessage) -> None:
    """Record an undecodable message and take it off the stream.

    Without the acknowledgement this message is immortal: it never leaves the
    pending list, the stale sweep reclaims it, it fails to decode again, and
    the worker spends part of every cycle re-failing the same message. The DLQ
    row is what makes the discard auditable rather than silent.
    """
    logger.error("Discarding undecodable message %s: %s", poison.message_id, poison.error)
    await send_to_dlq(
        job_id=_poison_job_id(poison),
        job_type=poison.fields.get("job_type", "unknown"),
        payload={"raw_fields": poison.fields},
        error_reason=f"undecodable message: {poison.error}",
        attempt_count=0,
    )
    await acknowledge(poison.stream, poison.message_id)


def _poison_job_id(poison: PoisonMessage) -> UUID:
    """The job's own ID if it survived, otherwise a generated one.

    The DLQ row needs a UUID, and the reason a message is undecodable is often
    that this very field is malformed. A generated ID keeps the failure
    recorded instead of discarding the evidence for want of a key.
    """
    try:
        return UUID(poison.fields["job_id"])
    except (KeyError, ValueError):
        return uuid4()


async def _sweep_stale(worker_name: str) -> Batch:
    """Reclaim messages left pending by a worker that died mid-job."""
    messages: list[JobMessage] = []
    poison: list[PoisonMessage] = []
    for stream in WORK_STREAMS:
        batch = await claim_stale(worker_name, stream, min_idle_ms=STALE_AFTER_MS)
        messages.extend(batch.messages)
        poison.extend(batch.poison)
    return Batch(messages=messages, poison=poison)


async def run() -> None:
    worker_name = build_worker_name()
    cycle = WeightedStreamCycle(settings.high_priority_weight)

    await ensure_consumer_groups()
    start_metrics_server(settings.worker_metrics_port, worker_name)
    logger.info("Worker %s started, weight %d", worker_name, settings.high_priority_weight)

    try:
        while not _shutdown.is_set():
            await _release_due_retries()

            reclaimed = await _sweep_stale(worker_name)
            for poison in reclaimed.poison:
                await _discard(poison)
            for message in reclaimed.messages:
                await _handle(message, worker_name)

            batch = await read_batch(
                worker_name=worker_name,
                poll_streams=cycle.next_order(),
                count=settings.worker_batch_size,
                block_ms=settings.worker_block_ms,
            )
            for poison in batch.poison:
                await _discard(poison)
            for message in batch.messages:
                # Checked per message, not just per batch: a batch of ten slow
                # jobs should not delay shutdown by ten job durations.
                if _shutdown.is_set():
                    logger.info("Shutting down, leaving %s for another worker", message.message_id)
                    break
                await _handle(message, worker_name)
    finally:
        # Unacknowledged messages stay in the PEL and are reclaimed by another
        # worker, so stopping here loses nothing.
        mark_stopped(worker_name)
        await close_redis()
        await dispose_engine()
        logger.info("Worker %s stopped cleanly", worker_name)


def main() -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        # add_signal_handler rather than signal.signal: the default handler
        # raises inside whatever coroutine happens to be running, which is how
        # a job gets interrupted halfway through instead of finishing.
        loop.add_signal_handler(sig, _request_shutdown, sig)
    try:
        loop.run_until_complete(run())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
