# Build Log

Chronological notes on how this project was built, and the problems worth
remembering. Kept factual: the intent is that a future reader (including me)
can see why things are the way they are, and what the mistakes cost.

---

## Pass 1: Foundations

Dependencies and tooling, then settings, schemas, and the persistence layer.

- `app/config.py` uses pydantic-settings, so every value is overridable by
  environment variable with sane defaults. `DATABASE_URL` and `REDIS_URL` are
  derived from the component fields rather than defined alongside them, which
  is the mistake Project 1 made and had to undo: two sources of truth for one
  connection string drift apart the first time someone edits one of them.
- `get_settings()` is cached and called on use, not at import. Importing a
  module should not read the environment.
- Schema design followed the plan: JSONB payload, unique `job_id` as the
  idempotency key, and a separate `dlq_jobs` table.
- Three timestamps (`submitted_at`, `started_at`, `completed_at`) rather than
  one `updated_at`. Queue wait and execution time are both derivable from
  those three, and a single mutable column overwrites the history that makes
  them derivable.

**Gotcha:** the scaffold committed every file as an empty placeholder,
including `alembic/versions/0001_*.py`. Alembic refuses to load a version file
with no `revision` declared, so `alembic history` failed until the two empty
migration stubs were deleted. Worth checking the rest of a scaffold when one
entry turns out to be wrong.

---

## Pass 2: Queue mechanics

The producer, the consumer group reader, and the API.

- The stream carries enough of the job to execute it without a database read
  on the happy path. PostgreSQL is still the source of truth for state, but a
  worker that had to fetch the payload before starting would put a read on the
  hot path of every job.
- `MalformedMessage` is deliberately separate from a job that fails at
  runtime. Retrying an unparseable message burns the retry budget on something
  that can never succeed.
- The consumer tries each stream without blocking in priority order, and only
  blocks on all of them at once when every stream is empty. Blocking on a
  single stream would leave a worker asleep on `jobs.low` while high priority
  work arrived elsewhere.

---

## Pass 3: The worker

Handlers, executor, graceful shutdown.

- The failure taxonomy (`PermanentJobError` vs `TransientJobError`) is what
  lets the executor skip the retry budget entirely for malformed input while
  still retrying a timeout. An unclassified exception is treated as transient:
  an unexpected bug is more often a passing condition than a permanent
  property of the input, and the attempt cap bounds the cost of guessing
  wrong.
- Shutdown checks its flag per message rather than per batch. A batch of ten
  slow jobs should not delay SIGTERM by ten job durations.
- `loop.add_signal_handler` rather than `signal.signal`, which raises inside
  whatever coroutine happens to be running and interrupts a job halfway.

---

## Pass 4: Retries and the dead letter queue

**The interesting problem of the week.** The backoff formula had nowhere to
happen. Redis Streams have no delayed delivery: anything appended with XADD is
readable by the next XREADGROUP, and the worker was re-enqueueing failures
immediately, so computing a delay would have changed nothing at all.

Three options, and only one survives a crash:

- Sleep in the worker before re-enqueueing. Blocks that worker for the whole
  delay, and a crash during the sleep loses the job outright, because the
  original message was already acknowledged.
- Re-enqueue immediately with a "not before" field and let workers skip what
  is not due. Every worker then spins re-reading the same messages.
- A sorted set scored by due timestamp. The entry lives in Redis, so a worker
  crash costs nothing, and finding what is due is a range query.

The sorted set won. Workers pop due entries with ZPOPMIN before polling the
streams, which is atomic, so no separate scheduler process is needed and two
workers sweeping at once cannot release the same retry twice.

Ordering that turned out to be load bearing, all of it now covered by tests:
the retry is scheduled **before** the ACK, so a crash in between leaves the
original in the PEL to be reclaimed; `send_to_dlq` writes PostgreSQL **before**
the stream, and a stream failure is logged rather than raised, because the job
is already dead and raising would push the worker back down the retry path;
`replay_job` resets the row **before** enqueueing, or a worker would see the
message while the row still said `dead` and the executor's completion check
would refuse to run it.

---

## Pass 5: Observability and infrastructure

Metrics, Docker Compose, and four fixes to earlier code. The fixes are the
interesting part, because three of them were real defects that the tests as
written could never have caught.

**The submit endpoint enqueued before committing.** `get_session` commits
during FastAPI's dependency teardown, which runs *after* the handler returns.
The message therefore hit the stream while the row was still uncommitted,
exactly reversing the ordering the docstring claimed. A worker reading it
would find no row to mark running, and its completion write would update zero
rows. Fixed with an explicit commit before the enqueue. The regression test
was verified by removing only the fix and watching it fail.

**Weighted polling did not weight anything.** `poll_order` returned
`(high, high, high, normal, low)`, but the reader stopped at the first stream
with work, so while `jobs.high` had anything on it, normal and low were never
reached. That is precisely the starvation Decision 5 claims to prevent. The
ratio was described but never produced. `WeightedStreamCycle` rotates the
starting position one step per call, so three passes in five start at high and
the other two are always reached. It also deduplicates within a pass, since
probing the same empty stream three times costs two round trips to be told the
same thing.

**Acknowledged jobs never left memory.** XACK removes a message from the
pending list, not from the stream, so every job ever submitted stayed in Redis
until something evicted it. Both producers now pass `maxlen` with
`approximate=True`.

**Undecodable messages were immortal.** They were logged and dropped, which
meant they were never acknowledged, stayed pending, got reclaimed by the stale
sweep, failed to decode again, and repeated for the life of the system. The
reader now returns them separately and the worker records each in the DLQ and
acknowledges it.

**Gotcha:** the first `docker compose up` ran the whole stack green and then
every one of the 40 submitted jobs died. The cause was not the queue: the bulk
submit script sent `rows`/`aggregate` while the handlers require
`records`/`metrics`. Mock-based tests cannot catch a payload contract mismatch,
because the mock accepts whatever it is given. This is the entire argument for
having an integration pass.

---

## Pass 6: Proving it works

Correlation IDs, CI, integration tests, real data, and the load test.

- Correlation IDs travel on the message, not just through the request. A job
  queue is asynchronous, so the caller's request has long since returned by the
  time anything interesting happens. Without the ID on the message there is
  nothing linking a worker's log line back to the client that submitted the
  job. Project 1 declined to do this because it would have changed the Kafka
  event schema; a Redis stream field is cheap enough that the tradeoff goes the
  other way here.
- CI runs unit tests on 3.10 and 3.11, and integration tests in a separate job
  with real Redis and PostgreSQL service containers. Left in the same job, the
  integration tests would fail on a missing Redis rather than on anything about
  the code.
- `scripts/ingest_weather.py` feeds the queue from Open-Meteo. Everything else
  that puts work on this queue makes the work up; real feeds have null readings
  and repeated timestamps, and the handlers should meet them somewhere other
  than production.

**Gotcha:** the integration tests failed in a way that looked like flaky
infrastructure. The engine and the Redis client are module level singletons
bound to the loop that created them, and pytest-asyncio gives each test its own
loop, so a module scoped fixture handed loop A's connections to loop B. Fixed
by making the fixture per test and disposing both. A second, separate ordering
bug: cleanup deleted only two of the four streams, so a message left on
`jobs.low` by the replay test surfaced in a later test that never touched that
stream, because the reader falls through to a blocking read across all streams.

**Gotcha, and the most embarrassing one:** `queue_depth` was XLEN. Acknowledging
a message leaves it in the stream, so a fully drained queue reported a backlog
of 3,300. This was only noticed while measuring drain time for the README, when
the number refused to fall. It is worse than having no gauge at all, because it
looks plausible. Depth is now the consumer group's `lag`, with `pending`
(in flight) and `stream_length` (retention) reported separately, since they
answer three different questions.

---

## What the tests do and do not prove

97 tests. The mock-based ones prove the logic: backoff windows, priority
rotation, DLQ routing, the ACK ordering. They proved nothing about the wiring,
and two of the four Pass 5 defects lived happily underneath a green suite.

The integration tests are the ones that would have caught them. They run
against real Redis and PostgreSQL and assert the things a mock will agree to
regardless: that a payload survives JSON encoding onto a flat stream field,
that a consumer group really does deliver each message to exactly one
consumer, that the unique constraint behind `ON CONFLICT DO NOTHING` exists,
and that the timestamps come from the database clock rather than the worker's.

---

## Frontend Pass 1: Shell and API contract

A dashboard for submitting, watching, and replaying jobs, built in `frontend/`
with Vite, React and TypeScript.

- No CORS middleware was added to the API. The Vite dev server proxies `/api`
  to FastAPI instead, so the browser only ever sees one origin. Opening the API
  to cross origin requests is a production decision, and it should not be made
  as a side effect of wanting hot reload.
- `src/api/types.ts` is a hand written mirror of the Pydantic models. It could
  be generated from the OpenAPI schema, but for five models the generator would
  be more machinery than the types it saves.
- Routing is on the URL hash. Deep links then work from any static file host
  with no rewrite rule, which matters more here than tidy URLs.
- The health indicator treats a failed request as the API being down, because
  `/health` deliberately returns 200 with `degraded` in the body when Redis or
  PostgreSQL is the problem.

**Gotcha:** port 8000 on this machine was already taken by an unrelated
service, which answered `/health` with an HTML page. The proxy target is
configurable through `VITE_API_TARGET` for exactly this reason.

---

## Frontend Pass 2: Jobs list

The jobs screen: a live table with filters, paging, and a URL that describes
the view.

- `GET /jobs` has no total count. Rather than add one to the API, and with it
  a `COUNT(*)` over a table that grows without bound, the dashboard asks for
  one row more than a page. If it arrives there is an older page. The cost is
  that the pager cannot say "page 2 of 40", which nobody watching a queue
  actually needs.
- Filters, page and job type live in the hash query. Filter edits use
  `replaceState` and paging uses a normal hash change, so Back steps through
  pages and not keystrokes. `replaceState` fires no `hashchange`, so the
  router listens for a small custom event as well.
- The job type filter is an exact match, because that is what the repository
  does. Faking a contains search on the client would only search the 50 rows
  already loaded and quietly miss everything else.
- The table can be paused. A live table reorders under the cursor as jobs
  arrive, which makes it hard to follow a single row.

**Gotcha:** making `usePolling` refetch when the filter changed exposed a race.
Two requests in flight, one for the old filter and one for the new, could
resolve in either order, and when the old one landed last the table showed
rows the user had just filtered out. Each call is now numbered and only the
latest is allowed to set state.

---

## Frontend Pass 3: Job detail

One page per job at `#/jobs/<id>`: the fields, a timeline, the error, and the
payload and result as JSON.

- The timeline is built from the three timestamps the schema design kept
  separate in Pass 1, and it is the first place they pay off visibly: queue
  wait is `started_at - submitted_at` and run time is
  `completed_at - started_at`, with no extra columns needed.
- `mark_running` overwrites `started_at` on every attempt. On a retried job the
  "wait" therefore includes every earlier attempt and its backoff, and the
  page says so rather than presenting it as time spent on the stream. Keeping
  per attempt history would need an attempts table, which is a backend change
  and out of scope for a dashboard.
- The error card sits above the timeline. A failing job should explain itself
  before anything else on the page.
- Finished jobs poll every 15 seconds instead of every 2. Stopping entirely
  looks tempting but would be wrong: a replay sends a dead job back to
  `queued`, and a page that had stopped polling would go on showing it as dead.

**Gotcha:** the clipboard API only exists on secure origins. `localhost`
qualifies, but the same build opened over plain HTTP on a LAN address has no
`navigator.clipboard`, so the copy button is hidden there instead of failing.

---

## Frontend Pass 4: Submit form

A form for sending jobs, starting from one example payload per handler.

- The presets only use fields their handlers read, and they contain the
  problems each handler exists to deal with: a duplicate row, mixed date
  formats, a boolean where an integer belongs. Running them shows the result
  doing something, which an all valid example would not.
- The browser checks the same rules as `JobSubmission` before sending, but the
  API stays the authority. A 422 is split by `loc` and each message is shown
  under its field, so anything the client missed still lands in the right
  place. Pydantic prefixes custom validator messages with "Value error, ",
  which is stripped.
- The API never looks inside the payload, so a transform job without
  `operations` is accepted with a 202 and then sent straight to the DLQ by
  `require()` on the worker, with no retries. The form warns about that case
  but does not block it, because submitting a bad job on purpose is a fair
  way to test the DLQ.
- The optional job ID is the idempotency key. A 409 is reported as "already
  accepted, nothing queued twice", which is what it means, and links to the
  existing job.

**Gotcha:** `frontend/src/lib/time.ts` had never been committed. The root
`.gitignore` came from the Python template, and its `lib/` rule also matched
the dashboard's `src/lib/`. Every build passed locally because the file was on
disk, and the badges, table and timeline that import it would have failed from
a fresh clone. Found only because a new file in the same directory refused to
stage. The frontend ignore file now re-includes `src/lib/`, and builds are
checked from a clean clone of the commit rather than the working tree.

---

## Frontend Pass 5: Dead letter queue

Listing, inspecting and replaying jobs that ran out of retries.

- A DLQ row records a failure, not a job's present state. `replay_job` leaves
  the row in place, and a job that dies again gets a second one, so the list
  alone cannot tell a stuck job from one that completed an hour ago. Each row
  now shows its job's current status, and older failures of a job that died
  more than once are marked as earlier so only the latest carries a status
  and a Replay button.
- Replay resets the job to `queued` whatever state it is in, as long as a DLQ
  row exists. Replaying a job that has since completed runs it again, and
  replaying one that is queued or running puts a second copy on the stream.
  The single row dialog says so in each case. Bulk replay sidesteps the
  question by only accepting jobs that are still dead.
- Bulk replays run one request at a time. Parallel requests would enqueue in
  whatever order they landed, and a progress count would be a guess.
- The sidebar badge counts jobs with status `dead`, not DLQ rows. Rows only
  ever accumulate, and a number that never goes down stops being looked at.
  It stops counting at 50 rather than fetching every dead job's payload.
- Undecodable messages reach the DLQ from `worker/main.py` with zero attempts,
  the raw stream fields standing in for a payload, and usually a generated job
  ID with no job row behind it. They are shown as discarded rather than
  failed, and cannot be replayed, since the API has nothing to enqueue from.

**Gotcha:** the first version of the details panel claimed in a comment that a
missing payload meant the worker could not decode the message. Reading
`_discard` showed the opposite: it always writes a payload, just a different
one. Checked before committing, but it was a reminder that the DLQ has two
writers with different shapes.
