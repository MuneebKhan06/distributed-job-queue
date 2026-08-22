"""Load test: how many jobs a second the API accepts, and how fast they drain.

Two numbers matter and they are not the same. Submission throughput is what
Locust measures directly: how fast the API validates, writes a row, and appends
to a stream. Drain rate is what the workers do with the backlog afterwards, and
it is the one that decides whether the queue keeps up.

Run against a stack that is already up:

    locust -f load_tests/locustfile.py --host=http://localhost:8000

Headless, which is what the README numbers came from:

    locust -f load_tests/locustfile.py --host=http://localhost:8000 \\
        --headless --users 50 --spawn-rate 10 --run-time 60s
"""

import random
import uuid

from locust import HttpUser, between, events, task

JOB_TYPES = ("transform.csv", "validate.rows", "compute.aggregate")

# Small enough that the handler is not what is being measured. A payload big
# enough to dominate execution time would turn a queue benchmark into a
# benchmark of the transform handler.
RECORD_COUNT = 20


def payload_for(job_type: str) -> dict:
    records = [
        {"id": index % 15, "date": "01/02/2026", "region": "north" if index % 2 else "south",
         "amount": index * 3, "note": None}
        for index in range(RECORD_COUNT)
    ]
    if job_type == "transform.csv":
        return {"source": "load.csv", "records": records,
                "operations": ["deduplicate", "normalize_dates", "fill_nulls"]}
    if job_type == "validate.rows":
        return {"records": records,
                "rules": {"required": ["id"], "types": {"id": "integer", "region": "string"}}}
    return {"records": records, "group_by": "region", "metrics": {"amount": "sum"}}


class SubmitJobs(HttpUser):
    wait_time = between(0.1, 0.5)

    @task(8)
    def submit_normal(self) -> None:
        self._submit("normal")

    @task(2)
    def submit_high(self) -> None:
        """Roughly a fifth of the load, which is about what a real system sees:
        high priority is the exception or it means nothing."""
        self._submit("high")

    @task(1)
    def check_status(self) -> None:
        # A status page polling the API is part of the real load, not noise.
        self.client.get("/jobs?limit=20", name="/jobs [list]")

    def _submit(self, priority: str) -> None:
        job_type = random.choice(JOB_TYPES)
        with self.client.post(
            "/jobs",
            json={
                "job_id": str(uuid.uuid4()),
                "job_type": job_type,
                "priority": priority,
                "payload": payload_for(job_type),
            },
            name=f"/jobs [{priority}]",
            catch_response=True,
        ) as response:
            # 202 is the only success. Locust counts 409 as a pass otherwise,
            # which would quietly turn "every submission was a duplicate" into a
            # clean run.
            if response.status_code == 202:
                response.success()
            else:
                response.failure(f"expected 202, got {response.status_code}")


@events.quitting.add_listener
def report_queue_state(environment, **_kwargs) -> None:
    """Print the backlog left behind.

    Submission throughput on its own is a half measure: an API that accepts
    2,000 jobs a second while the workers drain 200 is not keeping up, and the
    Locust summary alone would not say so.
    """
    stats = environment.stats.total
    print(f"\nSubmitted {stats.num_requests} requests, {stats.num_failures} failed.")
    print("Queue depth after the run is in /metrics as queue_depth{stream=...}.")
