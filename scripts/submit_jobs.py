#!/usr/bin/env python3
"""Submit test jobs in bulk against a running API.

Used to fill the queue for load testing and to watch the priority weighting do
something visible. Talks to the API over HTTP rather than writing to Redis
directly, so the jobs go through the same validation and persistence path a
real client would.

Examples:

    # 100 normal priority transform jobs
    python scripts/submit_jobs.py --count 100

    # a burst of high priority work to watch it overtake the normal stream
    python scripts/submit_jobs.py --count 20 --priority high

    # jobs that are guaranteed to fail, to exercise retries and the DLQ
    python scripts/submit_jobs.py --count 5 --job-type validate.rows --failing
"""

import argparse
import asyncio
import random
import sys
from uuid import uuid4

import httpx

JOB_TYPES = ("transform.csv", "validate.rows", "compute.aggregate")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="http://localhost:8000", help="API base URL")
    parser.add_argument("--count", type=int, default=10, help="How many jobs to submit")
    parser.add_argument(
        "--priority",
        choices=("high", "normal", "low"),
        default="normal",
    )
    parser.add_argument(
        "--job-type",
        choices=JOB_TYPES,
        help="Fixed job type. Omit to spread evenly across all three.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=10,
        help="Submissions in flight at once (default: 10)",
    )
    parser.add_argument(
        "--failing",
        action="store_true",
        help="Send payloads the handlers reject, to exercise retries and the DLQ",
    )
    return parser.parse_args(argv)


def build_payload(job_type: str, failing: bool) -> dict:
    if failing:
        # Missing the field each handler requires, which is a permanent failure
        # rather than a transient one, so it lands in the DLQ immediately.
        return {"deliberately": "invalid"}
    if job_type == "transform.csv":
        return {
            "source": f"sales_{random.randint(1, 999)}.csv",
            "records": [
                {"id": index % 4, "date": "01/02/2026", "note": None} for index in range(6)
            ],
            "operations": ["deduplicate", "normalize_dates", "fill_nulls"],
        }
    if job_type == "validate.rows":
        return {
            "records": [
                {"id": index, "email": f"user{index}@example.com"} for index in range(5)
            ],
            "rules": {"required": ["id", "email"], "types": {"id": "integer", "email": "string"}},
        }
    return {
        "records": [
            {"region": "north" if index % 2 else "south", "amount": index * 10}
            for index in range(6)
        ],
        "group_by": "region",
        "metrics": {"amount": "sum"},
    }


async def submit_one(client: httpx.AsyncClient, args: argparse.Namespace) -> int:
    job_type = args.job_type or random.choice(JOB_TYPES)
    response = await client.post(
        "/jobs",
        json={
            "job_id": str(uuid4()),
            "job_type": job_type,
            "priority": args.priority,
            "payload": build_payload(job_type, args.failing),
        },
    )
    return response.status_code


async def run(args: argparse.Namespace) -> int:
    # Bounded, not one task per job. Firing 10,000 concurrent requests measures
    # how fast the client falls over, not how fast the queue accepts work.
    semaphore = asyncio.Semaphore(args.concurrency)

    async with httpx.AsyncClient(base_url=args.host, timeout=10.0) as client:

        async def one() -> int:
            async with semaphore:
                try:
                    return await submit_one(client, args)
                except httpx.HTTPError as exc:
                    print(f"Request failed: {exc}", file=sys.stderr)
                    return 0

        codes = await asyncio.gather(*(one() for _ in range(args.count)))

    accepted = sum(1 for code in codes if code == 202)
    print(f"Submitted {accepted} of {args.count} jobs at {args.priority} priority.")

    rejected = {code: codes.count(code) for code in set(codes) if code != 202}
    for code, count in sorted(rejected.items()):
        print(f"  {count} rejected with {code or 'connection error'}")

    return 0 if accepted == args.count else 1


def main() -> None:
    raise SystemExit(asyncio.run(run(parse_args())))


if __name__ == "__main__":
    main()
