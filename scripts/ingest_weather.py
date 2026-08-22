#!/usr/bin/env python3
"""Feed the queue from a live public weather API.

Everything else that puts work on this queue makes the work up. This pulls real
hourly observations from Open-Meteo, which needs no API key, and submits them as
the three job types the workers actually implement:

    transform.weather  deduplicate the hours, normalise the timestamps, fill the
                       gaps the API leaves as null
    validate.weather   assert every reading has the type and range it should
    compute.weather    aggregate per city into min, max, and average

The point is that the payloads are not synthetic. Real feeds have null readings
and repeated timestamps, and the handlers meet them here rather than in
production.

Examples:

    python scripts/ingest_weather.py
    python scripts/ingest_weather.py --cities Lahore Tokyo --priority high
    python scripts/ingest_weather.py --forecast-days 3 --wait
"""

import argparse
import asyncio
import sys
from uuid import uuid4

import httpx

API = "https://api.open-meteo.com/v1/forecast"

# lat, lon. A spread of climates, so the aggregates are visibly different.
CITIES: dict[str, tuple[float, float]] = {
    "Islamabad": (33.6844, 73.0479),
    "Karachi": (24.8607, 67.0011),
    "Lahore": (31.5204, 74.3587),
    "London": (51.5074, -0.1278),
    "Tokyo": (35.6762, 139.6503),
    "Reykjavik": (64.1466, -21.9426),
}

MEASUREMENTS = ("temperature_2m", "relative_humidity_2m", "wind_speed_10m")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="http://localhost:8000", help="API base URL")
    parser.add_argument(
        "--cities",
        nargs="+",
        choices=sorted(CITIES),
        default=sorted(CITIES),
        help="Which cities to pull (default: all)",
    )
    parser.add_argument("--forecast-days", type=int, default=2, help="Days of hourly data")
    parser.add_argument("--priority", choices=("high", "normal", "low"), default="normal")
    parser.add_argument(
        "--wait",
        action="store_true",
        help="Poll until every submitted job reaches a terminal state, then report",
    )
    return parser.parse_args(argv)


async def fetch_city(client: httpx.AsyncClient, city: str, days: int) -> list[dict]:
    """Pull one city and turn the API's columnar arrays into records.

    Open-Meteo returns parallel lists (time[], temperature_2m[], ...) rather
    than a list of objects, so this is the reshape the handlers expect. A gap in
    a series comes back as null and is passed through as such: inventing a value
    here would hide exactly what the fill_nulls operation exists to handle.
    """
    latitude, longitude = CITIES[city]
    response = await client.get(
        API,
        params={
            "latitude": latitude,
            "longitude": longitude,
            "hourly": ",".join(MEASUREMENTS),
            "forecast_days": days,
        },
    )
    response.raise_for_status()
    hourly = response.json()["hourly"]

    return [
        {
            "city": city,
            "time": hourly["time"][index],
            **{name: hourly[name][index] for name in MEASUREMENTS},
        }
        for index in range(len(hourly["time"]))
    ]


def build_jobs(city: str, records: list[dict], priority: str) -> list[dict]:
    """Three jobs over the same real records, one per handler."""
    return [
        {
            "job_id": str(uuid4()),
            "job_type": "transform.weather",
            "priority": priority,
            "payload": {
                "source": f"open-meteo/{city}",
                "records": records,
                "operations": ["deduplicate", "normalize_dates", "fill_nulls"],
            },
        },
        {
            "job_id": str(uuid4()),
            "job_type": "validate.weather",
            "priority": priority,
            "payload": {
                "records": records,
                "rules": {
                    "required": ["city", "time", "temperature_2m"],
                    "types": {
                        "city": "string",
                        # "number", not "float": a reading that lands exactly on
                        # a whole degree comes back from the API as an int, and
                        # a float-only rule would fail every one of them.
                        "temperature_2m": "number",
                        "relative_humidity_2m": "integer",
                    },
                },
            },
        },
        {
            "job_id": str(uuid4()),
            "job_type": "compute.weather",
            "priority": priority,
            "payload": {
                "records": records,
                "group_by": "city",
                "metrics": {
                    "temperature_2m": "avg",
                    "relative_humidity_2m": "max",
                    "wind_speed_10m": "min",
                },
            },
        },
    ]


async def submit(client: httpx.AsyncClient, job: dict) -> str | None:
    response = await client.post("/jobs", json=job)
    if response.status_code != 202:
        print(f"  rejected {job['job_type']}: {response.status_code} {response.text[:120]}",
              file=sys.stderr)
        return None
    return job["job_id"]


async def wait_for(client: httpx.AsyncClient, job_ids: list[str], timeout: float = 60.0) -> None:
    """Poll until nothing is left queued or running.

    Polling rather than a subscription because the API has no push channel, and
    adding one for a demonstration script would be the tail wagging the dog.
    """
    terminal = {"completed", "dead"}
    deadline = asyncio.get_running_loop().time() + timeout

    while asyncio.get_running_loop().time() < deadline:
        states = []
        for job_id in job_ids:
            response = await client.get(f"/jobs/{job_id}")
            states.append(response.json() if response.status_code == 200 else {"status": "missing"})

        if all(state["status"] in terminal for state in states):
            report(states)
            return
        await asyncio.sleep(1.0)

    print("Timed out waiting for jobs to finish.", file=sys.stderr)


def report(states: list[dict]) -> None:
    completed = [state for state in states if state["status"] == "completed"]
    print(f"\n{len(completed)} of {len(states)} jobs completed.\n")

    for state in completed:
        result = state.get("result") or {}
        if state["job_type"].startswith("transform"):
            print(f"  transform  {result.get('records_in')} in -> "
                  f"{result.get('records_out')} out, applied {result.get('operations_applied')}")
        elif state["job_type"].startswith("validate"):
            print(f"  validate   {result.get('valid')} valid, {result.get('invalid')} invalid "
                  f"of {result.get('records_checked')}")
        else:
            for group, metrics in (result.get("results") or {}).items():
                readable = ", ".join(f"{k}={v}" for k, v in metrics.items())
                print(f"  compute    {group}: {readable}")

    for state in states:
        if state["status"] == "dead":
            print(f"  DEAD       {state.get('job_type')}: {state.get('error_message')}")


async def run(args: argparse.Namespace) -> int:
    submitted: list[str] = []

    async with httpx.AsyncClient(timeout=30.0) as upstream:
        async with httpx.AsyncClient(base_url=args.host, timeout=30.0) as api:
            for city in args.cities:
                try:
                    records = await fetch_city(upstream, city, args.forecast_days)
                except httpx.HTTPError as exc:
                    print(f"Could not fetch {city}: {exc}", file=sys.stderr)
                    continue

                nulls = sum(
                    1 for record in records if any(record[name] is None for name in MEASUREMENTS)
                )
                print(f"{city}: {len(records)} hourly records"
                      f"{f', {nulls} with a null reading' if nulls else ''}")

                for job in build_jobs(city, records, args.priority):
                    job_id = await submit(api, job)
                    if job_id:
                        submitted.append(job_id)

            print(f"\nSubmitted {len(submitted)} jobs at {args.priority} priority.")

            if args.wait and submitted:
                await wait_for(api, submitted)

    return 0 if submitted else 1


def main() -> None:
    raise SystemExit(asyncio.run(run(parse_args())))


if __name__ == "__main__":
    main()
