# Distributed Job Queue & Pipeline Orchestrator

A production-grade distributed job queue built on Redis Streams from scratch.
Accepts jobs via a FastAPI REST API, routes them through Redis Streams consumer
groups, executes them across parallel workers, and tracks every state transition
in PostgreSQL. No Celery. No RQ. The internals are built by hand.

> **Domain:** Data transformation and processing jobs
> **Stack:** FastAPI · Redis Streams · PostgreSQL · Docker Compose · Locust
> **Focus:** Backend + Data Engineering
> **Builds on:** Project 1 (FastAPI, async Python, Docker Compose patterns)

---

## Table of Contents

- [System Overview](#system-overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Architecture & Design Decisions](#architecture--design-decisions)
- [Getting Started](#getting-started)
- [API Reference](#api-reference)
- [Development](#development)
- [Load Test Results](#load-test-results)
- [How I Would Scale This](#how-i-would-scale-this)
- [What I Would Do Differently](#what-i-would-do-differently)

---

## System Overview

```
Client
  |
  | HTTP POST /jobs
  v
FastAPI (Job Submission API)
  |
  | Validate + persist job (PostgreSQL: status = queued)
  | XADD to Redis Stream
  v
Redis Stream: jobs.queue
  |
  | Consumer Group: job-workers
  | Multiple worker instances read in parallel
  v
Worker Pool (N workers, each in own process)
  |
  | Execute job (transform, validate, compute)
  | Update PostgreSQL (status = running -> completed / failed)
  | ACK message on success
  v
PostgreSQL (jobs table: full state history)
  |
  | On failure after retries:
  v
Dead Letter Queue (jobs.dlq stream + dlq_jobs table)
```

---

## Architecture

### Components

| Component | Role |
|---|---|
| FastAPI | REST API: submit jobs, query status, inspect DLQ |
| Redis Streams | Durable job queue with consumer group coordination |
| Consumer Group | Coordinates parallel workers, prevents double-processing |
| Worker Pool | N worker processes, each claims and executes jobs |
| PostgreSQL | Source of truth for job state and full history |
| Dead Letter Queue | Captures permanently failed jobs for inspection and replay |
| Prometheus | Metrics: queue depth, worker throughput, failure rates |
| Locust | Load testing: jobs/sec at 1, 4, 8 workers |

---

## Project Structure

```
distributed-job-queue/
|
|-- .github/
|   |-- workflows/
|       |-- ci.yml                   # Lint, unit tests on 3.10 and 3.11, integration job
|
|-- app/
|   |-- __init__.py
|   |-- main.py                      # FastAPI app entry point + lifespan
|   |-- config.py                    # pydantic-settings config
|   |
|   |-- api/
|   |   |-- __init__.py
|   |   |-- routes/
|   |       |-- __init__.py
|   |       |-- jobs.py              # POST /jobs, GET /jobs/{id}, GET /jobs
|   |       |-- dlq.py              # GET /dlq, POST /dlq/{id}/replay
|   |       |-- health.py           # GET /health
|   |       |-- metrics.py          # GET /metrics (Prometheus)
|   |   |-- middleware.py           # Request correlation IDs
|   |
|   |-- schemas/
|   |   |-- __init__.py
|   |   |-- jobs.py                 # Pydantic models for job validation
|   |
|   |-- redis/
|   |   |-- __init__.py
|   |   |-- client.py               # Redis connection pool
|   |   |-- producer.py             # XADD to jobs.queue stream
|   |   |-- consumer.py             # XREADGROUP consumer loop
|   |   |-- delayed.py              # Sorted set delay queue for retries
|   |   |-- streams.py              # Stream names, and the weighted poll cycle
|   |
|   |-- db/
|   |   |-- __init__.py
|   |   |-- connection.py           # Async SQLAlchemy engine + session
|   |   |-- models.py               # Job, DLQJob SQLAlchemy models
|   |   |-- repository.py           # All DB queries (insert, update, get)
|   |
|   |-- core/
|       |-- __init__.py
|       |-- dlq.py                  # DLQ routing and replay
|       |-- metrics.py              # Prometheus counters and gauges
|
|-- worker/
|   |-- __init__.py
|   |-- main.py                     # Worker entry point + graceful shutdown
|   |-- executor.py                 # Job execution logic (runs the handler)
|   |-- handlers/
|   |   |-- __init__.py
|   |   |-- base.py                 # BaseJobHandler interface
|   |   |-- transform.py            # Data transformation job handler
|   |   |-- validate.py             # Data validation job handler
|   |   |-- compute.py              # Compute/aggregation job handler
|   |-- retry.py                    # Exponential backoff with jitter
|   |-- metrics.py                  # Worker-side Prometheus counters
|
|-- alembic/
|   |-- env.py
|   |-- versions/
|       |-- 0001_create_jobs_table.py
|       |-- 0002_create_dlq_table.py
|
|-- tests/
|   |-- __init__.py
|   |-- test_api.py                 # Job submission and query endpoints
|   |-- test_producer.py            # Redis XADD producer tests
|   |-- test_consumer.py            # Consumer group + ACK logic tests
|   |-- test_executor.py            # Job handler execution tests
|   |-- test_retry.py               # Exponential backoff tests
|   |-- test_dlq.py                 # DLQ routing and replay tests
|   |-- test_priorities.py          # Priority queue ordering tests
|   |-- test_metrics.py             # Prometheus counter tests
|   |-- test_schemas.py             # Pydantic validation tests
|   |-- test_integration.py         # End-to-end vs real Redis + PostgreSQL
|
|-- load_tests/
|   |-- locustfile.py               # Jobs/sec benchmark at 1, 4, 8 workers
|
|-- scripts/
|   |-- ingest_weather.py          # Feed the queue from a live public weather API
|   |-- submit_jobs.py              # CLI to submit test jobs in bulk
|   |-- replay_dlq.py               # CLI to replay failed jobs from DLQ
|
|-- docker/
|   |-- Dockerfile.api              # FastAPI image
|   |-- Dockerfile.worker           # Worker image
|
|-- docker-compose.yml              # Full local stack
|-- docker-compose.test.yml         # Infra-only for integration tests
|-- .env.example
|-- alembic.ini
|-- pyproject.toml                  # Ruff config
|-- pytest.ini
|-- requirements.txt
|-- requirements-dev.txt
|-- DEVLOG.md
|-- README.md
```

---

## Architecture & Design Decisions

### Decision 1: Why Redis Streams over Celery, RQ, or Kafka

**Context:** A distributed job queue needs a reliable broker. The obvious
choices are an existing library (Celery, RQ) or the Kafka broker already
familiar from Project 1.

**Options considered:**

- Option A: Celery with Redis backend (most common in Python ecosystem)
- Option B: RQ (Redis Queue) - simpler than Celery
- Option C: Kafka (already used in Project 1)
- Option D: Redis Streams with a hand-built consumer (this project)

**Decision:** Redis Streams (Option D)

**Reasoning:**
Celery and RQ are the right answer for most production systems - they are
battle-tested and well-documented. However, building on top of them hides the
internals: you never understand consumer groups, message acknowledgment, or
exactly-once semantics by configuring a library.

Redis Streams (introduced in Redis 5.0) is a first-class data structure designed
for exactly this use case. It has Kafka-like semantics (consumer groups, message
IDs, acknowledgment, PEL tracking) with far lower operational overhead. A single
Redis instance handles millions of messages per second with sub-millisecond
latency, making it the right choice at this scale.

Kafka would be over-engineered here. Kafka's value is multi-consumer fan-out,
log retention, and replay at massive scale. A job queue does not need any of
these. The operational cost (Zookeeper, broker, topic management) is not
justified for a workload that fits comfortably in Redis.

**Tradeoffs accepted:**

- Redis Streams has no schema enforcement (unlike Kafka with Schema Registry)
- Redis memory is finite - extremely large job backlogs need monitoring
- Less ecosystem tooling than Celery for monitoring and scheduling

---

### Decision 2: Consumer group design for parallel workers

**Context:** Multiple worker processes need to consume from the same stream
without processing the same job twice.

**Options considered:**

- Option A: Each worker reads the full stream independently (fan-out, every
  worker processes every job - wrong for a job queue)
- Option B: Single consumer, single worker (no parallelism)
- Option C: Redis Streams consumer group (each message delivered to exactly
  one worker in the group)

**Decision:** Redis Streams consumer group (Option C)

**Reasoning:**
A consumer group is the fundamental primitive for competing consumers in Redis
Streams. When a worker calls XREADGROUP, Redis atomically delivers each message
to exactly one consumer in the group and tracks it in the Pending Entries List
(PEL). No two workers can receive the same message in normal operation.

Worker names follow the pattern `worker-{hostname}-{pid}` so each worker has a
unique identity within the group. This matters for XCLAIM (reclaiming stuck
messages from a crashed worker) - you need to know which consumer to target.

Consumer count matches partition count logic from Project 1: adding more workers
beyond the stream's throughput capacity wastes memory (each has its own PEL
tracking).

**Tradeoffs accepted:**

- Consumer group must be created before workers start (handled in lifespan)
- Dead consumers accumulate in the group until explicitly deleted
- A consumer crash leaves messages in PEL until reclaimed by another worker

---

### Decision 3: At-least-once delivery and the ACK strategy

**Context:** Redis Streams tracks unacknowledged messages in the PEL. A worker
must ACK (XACK) after successfully processing a message. What is the correct
ACK timing?

**Options considered:**

- Option A: ACK immediately on receive (at-most-once - risk of job loss on crash)
- Option B: ACK after job execution completes (at-least-once - risk of duplicate
  execution on crash after completion but before ACK)
- Option C: ACK after PostgreSQL update confirms job is marked complete
  (strongest guarantee without distributed transactions)

**Decision:** Option C - ACK only after PostgreSQL confirms completion

**Reasoning:**
The sequence is: execute job, update PostgreSQL status to 'completed', then
XACK. If the worker crashes after PostgreSQL update but before XACK, the job
will be reclaimed and re-executed. However, the job handler checks PostgreSQL
status at the start and skips already-completed jobs, making re-execution safe.

This is idempotency by database check, the same pattern used in Project 1 for
Kafka consumers. The job_id is the idempotency key.

Option A loses jobs on crash. Option B can execute a job twice with no
detection mechanism. Option C is the safest trade at the cost of one extra DB
read on reclaimed jobs.

**Tradeoffs accepted:**

- Rare duplicate execution is possible (crash between PG update and XACK)
- One DB read per reclaimed job to check completion status
- Slightly more complex worker code

---

### Decision 4: Exponential backoff with jitter on failure

**Context:** A job fails during execution. Should it be retried immediately,
with a fixed delay, or with exponential backoff?

**Options considered:**

- Option A: Immediate retry (hammers the failing resource)
- Option B: Fixed delay between retries (thundering herd on recovery)
- Option C: Exponential backoff (2^attempt seconds)
- Option D: Exponential backoff with jitter (randomised within a range)

**Decision:** Exponential backoff with jitter (Option D)

**Formula:**
```
delay = min(base * (2 ** attempt), max_delay) * (0.5 + random() * 0.5)
```

**Defaults:**
- base: 1 second
- max_delay: 60 seconds
- max_attempts: 5

**Reasoning:**
Exponential backoff prevents hammering a failing downstream service. Jitter
prevents the thundering herd problem: if 100 jobs fail at the same time and
all retry at t+2s, t+4s, t+8s simultaneously, you create coordinated load
spikes on recovery. Random jitter spreads retries across a window, smoothing
the recovery curve.

Full jitter (0 to max) versus equal jitter (half max to max): equal jitter is
chosen here because zero delay on the first retry would make the jitter range
indistinguishable from no-delay for the first attempt.

**Where the delay actually happens:**

Redis Streams have no delayed delivery. Anything appended with XADD is readable
by the next XREADGROUP, so the backoff formula needs somewhere to hold a job
until it comes due. Three options, and only one of them survives a crash:

- Sleep in the worker before re-enqueueing. Blocks that worker for the whole
  delay, and a crash during the sleep loses the job, because the original
  message has already been acknowledged.
- Re-enqueue immediately with a "not before" field and let workers skip jobs
  that are not due. Every worker then spins re-reading the same messages.
- A sorted set (`jobs.retry`) scored by due timestamp. The entry lives in
  Redis, so a worker crash costs nothing, and finding what is due is a range
  query rather than a scan.

The sorted set is what this project uses. Each worker pops due entries with
ZPOPMIN before polling the streams, which is atomic, so no separate scheduler
process is needed and two workers sweeping at once cannot release the same
retry twice.

**Tradeoffs accepted:**

- Longer total time to exhaust retries vs immediate retry
- Non-deterministic retry timing (harder to test without mocking random)
- max_attempts is configurable but not per-job-type in this version
- A retry lives in the sorted set rather than the stream, so queue depth is two
  numbers (XLEN plus ZCARD) instead of one

---

### Decision 5: Priority queue implementation

**Context:** Some jobs are more urgent than others. How to implement job
priority without a separate queue per priority level?

**Options considered:**

- Option A: Multiple Redis streams (jobs.high, jobs.normal, jobs.low) with
  workers polling in priority order
- Option B: Single stream with priority field, workers sort by priority
- Option C: PostgreSQL-based priority queue (SELECT ... ORDER BY priority FOR
  UPDATE SKIP LOCKED) with Redis as notification only

**Decision:** Multiple streams with weighted polling (Option A)

**Reasoning:**
A single stream with a priority field does not work with XREADGROUP - Redis
delivers messages in arrival order, not sorted order. You cannot sort a stream
by a field inside a message.

Multiple streams with weighted polling means workers check jobs.high first,
then jobs.normal, then jobs.low. The weighting is: for every 1 job processed
from jobs.normal, process 3 from jobs.high. This prevents low-priority starvation
(a flood of high-priority jobs would otherwise block all normal jobs forever).

Option C (PostgreSQL SKIP LOCKED) is a valid pattern and simpler to reason
about. Redis is used as notification and PostgreSQL as the queue. This was
rejected here because it puts the queue in the database, coupling throughput
to PostgreSQL performance. At high job submission rates this becomes the
bottleneck. Redis Streams is the right primitive for the queue layer.

**Tradeoffs accepted:**

- Workers must poll 3 streams, increasing Redis round trips per worker loop
- Starvation prevention is approximate (weighted, not mathematically fair)
- 3 consumer groups to create and manage instead of 1

---

### Decision 6: PostgreSQL schema design for jobs

**Context:** Jobs have a lifecycle (queued, running, completed, failed, dead).
How to model this for efficient status queries and history?

**Schema decided:**

```sql
CREATE TABLE jobs (
    id              BIGSERIAL PRIMARY KEY,
    job_id          UUID        NOT NULL UNIQUE,
    job_type        VARCHAR(50) NOT NULL,
    priority        VARCHAR(10) NOT NULL DEFAULT 'normal',
    payload         JSONB       NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'queued',
    attempt         INT         NOT NULL DEFAULT 0,
    max_attempts    INT         NOT NULL DEFAULT 5,
    result          JSONB,
    error_message   TEXT,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    worker_id       VARCHAR(100)
);

CREATE INDEX idx_jobs_status      ON jobs (status);
CREATE INDEX idx_jobs_job_type    ON jobs (job_type);
CREATE INDEX idx_jobs_submitted   ON jobs (submitted_at DESC);
CREATE INDEX idx_jobs_worker      ON jobs (worker_id) WHERE worker_id IS NOT NULL;

CREATE TABLE dlq_jobs (
    id              BIGSERIAL PRIMARY KEY,
    job_id          UUID        NOT NULL,
    job_type        VARCHAR(50),
    original_payload JSONB,
    error_reason    TEXT        NOT NULL,
    attempt_count   INT         NOT NULL,
    failed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Reasoning:**
Separate timestamp columns (submitted_at, started_at, completed_at) allow
precise duration calculation: time in queue (started - submitted), execution
time (completed - started), and total time (completed - submitted). A single
updated_at column loses this history.

The `worker_id` column tracks which worker ran each job. This is essential for
debugging: if one worker is consistently failing jobs, you can identify it.
The partial index (`WHERE worker_id IS NOT NULL`) only indexes assigned jobs,
keeping index size small.

`result` as JSONB allows any shape of job output without schema migrations as
new job types are added.

---

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Python 3.11+
- Git

### 1. Clone the repository

```bash
git clone https://github.com/MuneebKhan06/distributed-job-queue.git
cd distributed-job-queue
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

### 3. Start the full stack

```bash
docker-compose up -d
```

This starts: Redis, PostgreSQL, FastAPI API, 2 worker instances, Prometheus.
Alembic migrations run automatically before the API starts.

### 4. Verify everything is running

```bash
docker-compose ps
curl http://localhost:8000/health
```

### 5. Submit a test job

```bash
curl -X POST http://localhost:8000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "job_id": "550e8400-e29b-41d4-a716-446655440000",
    "job_type": "transform.csv",
    "priority": "normal",
    "payload": {
      "source": "sales_2024.csv",
      "operations": ["deduplicate", "normalize_dates", "fill_nulls"]
    }
  }'
```

### 6. Check job status

```bash
curl http://localhost:8000/jobs/550e8400-e29b-41d4-a716-446655440000
```

### 7. Run bulk test jobs

```bash
python scripts/submit_jobs.py --count 100 --priority normal
python scripts/submit_jobs.py --count 20 --priority high
```

### 8. Run tests

```bash
pip install -r requirements-dev.txt
pytest tests/ -v
```

### 9. Run load tests

```bash
locust -f load_tests/locustfile.py --host=http://localhost:8000
```

---

## API Reference

### POST /jobs

Submit a new job.

**Request body:**

```json
{
  "job_id": "uuid-v4",
  "job_type": "transform.csv",
  "priority": "high | normal | low",
  "payload": {},
  "max_attempts": 5
}
```

**Responses:**

- `202 Accepted`: job queued in Redis Stream
- `409 Conflict`: duplicate job_id
- `422 Unprocessable Entity`: validation error

---

### GET /jobs/{job_id}

Get job status and result.

**Response:**

```json
{
  "job_id": "uuid",
  "job_type": "transform.csv",
  "priority": "normal",
  "status": "completed",
  "attempt": 1,
  "result": {},
  "error_message": null,
  "submitted_at": "2026-01-01T00:00:00Z",
  "started_at": "2026-01-01T00:00:01Z",
  "completed_at": "2026-01-01T00:00:03Z",
  "worker_id": "worker-host-12345"
}
```

---

### GET /jobs

List jobs with filtering.

**Query parameters:** `status`, `job_type`, `priority`, `limit` (default 50), `offset`

---

### POST /dlq/{job_id}/replay

Replay a failed job from the DLQ back onto the queue.

**Response:**

- `202 Accepted`: job re-queued
- `404 Not Found`: job not in DLQ

---

### GET /health

```json
{
  "status": "healthy",
  "redis": "connected",
  "database": "connected",
  "workers_active": 2
}
```

---

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest tests/
ruff check app/ worker/ tests/
```

### Integration tests

The test stack binds non-default ports (6380 and 5433) so running the tests
cannot touch a development stack that happens to be up on the usual ones. That
is also why the connection settings have to be passed in.

```bash
docker compose -f docker-compose.test.yml up -d

REDIS_HOST=localhost REDIS_PORT=6380 \
POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_DB=jobqueue_test \
pytest tests/ -m integration

docker compose -f docker-compose.test.yml down -v
```

---

## Load Test Results

> Measured on: 8 core x86_64, 31 GB RAM, Linux 6.8, Docker 24.0.9.
> Single node Docker Compose, Locust on the same machine.
> 50 concurrent users, 0.1 to 0.5s think time, 45 second runs.
> Reproduce with `load_tests/locustfile.py` and the commands in Development.

### Submission throughput

| Workers | Requests | Req/sec | Avg latency | P50 | P95 | Errors |
|---|---|---|---|---|---|---|
| 1 | 2,814 | 62.9 | 454 ms | 460 ms | 820 ms | 0 |
| 4 | 2,875 | 64.4 | 439 ms | 420 ms | 750 ms | 0 |
| 8 | 3,393 | 75.8 | 332 ms | 300 ms | 640 ms | 0 |

**Submission throughput barely moves with worker count, and it should not.**
Workers do not serve HTTP. A submission is validated, written to PostgreSQL,
and appended to a stream, all by the API process, so adding workers cannot make
that path faster. Publishing a table where this number scales with workers
would mean the benchmark was measuring something other than what it claims.

The modest gain at 8 workers is not the workers either. These runs share one
machine with Redis, PostgreSQL, the API, and Locust itself, so the numbers move
with whatever else the box is doing. Treating a 20 percent difference here as a
real effect would be reading noise as signal.

The honest limit in these runs is the load generator, not the server. With 50
users, a 0.3s average think time, and a 450ms average response, arithmetic caps
the offered load near 66 requests a second, which is roughly what was measured.
Finding the API's actual ceiling needs more users than one Locust process on a
contended machine can usefully drive.

### Drain rate

This is the number worker count actually changes: the backlog left when the
submission run stops, and how long the workers take to clear it.

| Workers | Backlog at end of run | Drain time | Effective jobs/sec |
|---|---|---|---|
| 1 | ~2,800 | 14.9 s | ~190 |
| 4 | ~2,900 | 0.7 s | ~4,100 |
| 8 | ~3,400 | 0.6 s | ~5,600 |

Going from 1 to 4 workers cuts drain time by about 20x, which is more than the
4x the worker count would suggest. The single worker is not merely doing a
quarter of the work: it spends the whole submission run falling behind, so it
finishes with a full backlog, while four workers keep pace during the run and
have almost nothing left at the end.

From 4 to 8 there is nothing left to win. The backlog is already near zero when
the run ends, so drain time measures the polling interval rather than
throughput. **Past the point where workers keep up with submissions, adding more
does nothing**, which is the real lesson: the queue was never the bottleneck at
this scale, and the way to find out is to measure the backlog rather than the
request rate.

These handlers are deliberately cheap, tens of milliseconds of in-memory work
on 20 records. Real jobs that call a database or an external API would shift the
balance entirely, and the drain numbers here should be read as a measure of the
queue machinery, not of any particular workload.

### Queue depth under sustained load

| Submission rate | Workers | Depth at steady state | Drain time |
|---|---|---|---|
| ~63 jobs/sec | 1 | grows without bound | 14.9 s after stop |
| ~64 jobs/sec | 4 | ~0 | 0.7 s after stop |
| ~76 jobs/sec | 8 | ~0 | 0.6 s after stop |

Depth here is the consumer group's lag, not `XLEN`. Acknowledging a message
leaves it in the stream, so stream length counts every job ever submitted and
says nothing about backlog. That distinction cost an afternoon: the first
version of this table could not be produced because the gauge being watched
never fell, and the fix is why `queue_depth`, `queue_pending`, and
`stream_length` are now three separate metrics.

---

## How I Would Scale This

**Current:** Single Redis instance, 2 workers, single PostgreSQL node.

**To 10x throughput:**

- Scale workers horizontally: 8 workers consume from the same consumer group
  with no configuration change needed. Redis Streams consumer groups handle
  coordination automatically.
- Add Redis Cluster if memory becomes the constraint (streams grow with backlog)
- Reason: worker count is the only bottleneck at this scale

**To 100x throughput:**

- Redis Cluster with streams sharded across nodes
- Workers autoscaled via Kubernetes HPA on a custom metric: queue depth
  (XLEN jobs.queue). When queue depth exceeds threshold, scale up. When it
  drains, scale down.
- PostgreSQL: switch job status updates to batch writes (buffer N updates,
  flush every 100ms) to reduce write amplification
- Separate read replicas for GET /jobs queries (status checks should not
  contend with worker writes)

**Identified bottleneck at scale:**
PostgreSQL write throughput as worker count grows. Every job completion is a
PostgreSQL UPDATE. At 1000 completions/sec, this becomes a write bottleneck.
The fix is either batching or moving job state to Redis (with PostgreSQL as
async sink for history only).

---

## What I Would Do Differently

The priority queue implementation using multiple streams with weighted polling
works but is operationally awkward: three streams to monitor, three consumer
groups to manage, and the weighting logic lives in the worker poll loop where
it is easy to get wrong. If starting over, I would evaluate PostgreSQL
SKIP LOCKED as the queue primitive with Redis used only for real-time
notification (PUBLISH/SUBSCRIBE to wake workers immediately when a job arrives).
This trades Redis complexity for PostgreSQL simplicity, and at the scale this
project targets, PostgreSQL SKIP LOCKED handles hundreds of workers cleanly.
The right choice depends on whether you need Redis Streams specifically (for
the learning value, which this project has) or just a reliable job queue
(where PostgreSQL SKIP LOCKED is often the better production answer).
