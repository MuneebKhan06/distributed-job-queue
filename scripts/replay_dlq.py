#!/usr/bin/env python3
"""Replay failed jobs from the DLQ back onto their priority streams.

The dlq_jobs table keeps the original payload precisely so a batch of failures
can be re-run once the underlying bug is fixed. This is that step.

Jobs go back on the stream they came from, so the usual rules apply: the
executor checks the job's status before running, and a job that did eventually
complete is skipped rather than executed twice.

Examples:

    # see what would be replayed, without enqueueing anything
    python scripts/replay_dlq.py --dry-run

    # replay one specific job
    python scripts/replay_dlq.py --job-id 550e8400-e29b-41d4-a716-446655440000

    # replay the first 20 failures of one job type
    python scripts/replay_dlq.py --job-type transform.csv --limit 20
"""

import argparse
import asyncio
import sys
from pathlib import Path
from uuid import UUID

# Running this file directly puts scripts/ on sys.path rather than the repo
# root, so `app` would not be importable without adding it here.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.dlq import replay_job  # noqa: E402
from app.db.connection import dispose_engine, session_scope  # noqa: E402
from app.db.repository import JobRepository  # noqa: E402
from app.redis.client import close_redis  # noqa: E402


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--job-id", type=UUID, help="Replay a single job by ID")
    parser.add_argument("--job-type", help="Only replay failures of this job type")
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Most failures to replay in one run (default: 50)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be replayed and exit without enqueueing",
    )
    return parser.parse_args(argv)


async def _candidates(job_type: str | None, limit: int) -> list[tuple[UUID, str, str]]:
    """The DLQ entries this run would act on, newest first.

    Filtering happens here rather than in SQL because list_dlq is the shared
    query used by the API too, and adding a job_type filter to it for the sake
    of one script would be the wrong place to put it.
    """
    async with session_scope() as session:
        entries = await JobRepository(session).list_dlq(limit=limit * 4)
        selected = [
            (entry.job_id, entry.job_type or "unknown", entry.error_reason)
            for entry in entries
            if job_type is None or entry.job_type == job_type
        ]
    return selected[:limit]


async def run(args: argparse.Namespace) -> int:
    if args.job_id is not None:
        targets = [(args.job_id, "requested directly", "")]
    else:
        targets = await _candidates(args.job_type, args.limit)

    if not targets:
        print("Nothing to replay.")
        return 0

    if args.dry_run:
        print(f"Would replay {len(targets)} job(s):")
        for job_id, job_type, reason in targets:
            print(f"  {job_id}  {job_type}  {reason[:60]}")
        return 0

    replayed = 0
    for job_id, job_type, _reason in targets:
        if await replay_job(job_id):
            replayed += 1
            print(f"Replayed {job_id} ({job_type})")
        else:
            # Not a failure of the run: an operator can pass a job_id that was
            # already replayed and cleared, and the rest should still go.
            print(f"Skipped {job_id}: not in the DLQ")

    print(f"Replayed {replayed} of {len(targets)} job(s).")
    return 0 if replayed else 1


async def main_async(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return await run(args)
    finally:
        await close_redis()
        await dispose_engine()


def main() -> None:
    raise SystemExit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
