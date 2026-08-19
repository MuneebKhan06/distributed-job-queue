"""Worker entry point.

One process, one consumer in the group, looping until told to stop. Scaling out
means running more of these: Redis assigns each message to exactly one consumer
in the group, so no coordination between workers is needed or wanted.
"""

import asyncio
import logging
import signal

from app.config import get_settings
from app.db.connection import dispose_engine
from app.redis.client import close_redis, ensure_consumer_groups
from app.redis.consumer import JobMessage, acknowledge, claim_stale, read_batch
from app.redis.producer import enqueue_job
from app.redis.streams import WORK_STREAMS, build_worker_name, poll_order
from worker.executor import JobOutcome, execute

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
    result = await execute(message, worker_name)

    if result.outcome in (JobOutcome.COMPLETED, JobOutcome.SKIPPED):
        # ACK only after PostgreSQL has confirmed the job is finished. This
        # ordering is what makes a crash mid-job a redelivery rather than a
        # silently lost job.
        await acknowledge(message.stream, message.message_id)
        return

    if result.outcome == JobOutcome.RETRY:
        # Redis Streams has no delayed delivery, so a retry is a new message
        # carrying an incremented attempt count. The original is acknowledged
        # so it does not also sit in the PEL waiting to be reclaimed.
        await enqueue_job(
            job_id=message.job_id,
            job_type=message.job_type,
            priority=message.priority,
            payload=message.payload,
            max_attempts=message.max_attempts,
            attempt=message.attempt + 1,
        )
        await acknowledge(message.stream, message.message_id)
        return

    # Dead. The job is marked in PostgreSQL and the message is acknowledged so
    # it stops being redelivered.
    await acknowledge(message.stream, message.message_id)


async def _sweep_stale(worker_name: str) -> list[JobMessage]:
    """Reclaim messages left pending by a worker that died mid-job."""
    reclaimed: list[JobMessage] = []
    for stream in WORK_STREAMS:
        reclaimed.extend(await claim_stale(worker_name, stream, min_idle_ms=STALE_AFTER_MS))
    return reclaimed


async def run() -> None:
    worker_name = build_worker_name()
    streams = poll_order(settings.high_priority_weight)

    await ensure_consumer_groups()
    logger.info("Worker %s started, polling %s", worker_name, streams)

    try:
        while not _shutdown.is_set():
            for message in await _sweep_stale(worker_name):
                await _handle(message, worker_name)

            messages = await read_batch(
                worker_name=worker_name,
                poll_streams=streams,
                count=settings.worker_batch_size,
                block_ms=settings.worker_block_ms,
            )
            for message in messages:
                # Checked per message, not just per batch: a batch of ten slow
                # jobs should not delay shutdown by ten job durations.
                if _shutdown.is_set():
                    logger.info("Shutting down, leaving %s for another worker", message.message_id)
                    break
                await _handle(message, worker_name)
    finally:
        # Unacknowledged messages stay in the PEL and are reclaimed by another
        # worker, so stopping here loses nothing.
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
