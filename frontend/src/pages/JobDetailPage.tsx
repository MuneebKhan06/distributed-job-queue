import { useCallback, useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { JobStatus } from "../api/types";
import { PriorityBadge, StatusBadge } from "../components/Badge";
import JobTimeline from "../components/JobTimeline";
import JsonBlock from "../components/JsonBlock";
import ReplayButton from "../components/ReplayButton";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp } from "../lib/time";

const ACTIVE_POLL_MS = 2000;
const SETTLED_POLL_MS = 15000;

// Completed and dead are the only states a job does not leave on its own.
const SETTLED: JobStatus[] = ["completed", "dead"];

export default function JobDetailPage({ jobId }: { jobId: string }) {
  const fetchJob = useCallback(() => api.getJob(jobId), [jobId]);

  // A finished job is polled slowly rather than not at all. Replaying a dead
  // job from the DLQ screen, or from the CLI, sends it back to queued, and a
  // page that had stopped polling would go on showing it as dead.
  const [settled, setSettled] = useState(false);
  const {
    data: job,
    error,
    loading,
    refresh,
  } = usePolling(fetchJob, settled ? SETTLED_POLL_MS : ACTIVE_POLL_MS);
  const isSettled = job ? SETTLED.includes(job.status) : false;
  useEffect(() => setSettled(isSettled), [isSettled]);

  if (loading) {
    return <p className="muted">Loading job</p>;
  }

  // A 404 is an answer, not a hiccup: the job does not exist, so there are no
  // stale details worth keeping on screen beside the message.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <section className="card">
        <p>
          No job with ID <span className="mono">{jobId}</span>.
        </p>
        <a href="#/jobs">Back to all jobs</a>
      </section>
    );
  }

  if (!job) {
    return <p className="error">Could not load the job: {error?.message}</p>;
  }

  return (
    <div className="detail">
      <a href="#/jobs" className="back-link">
        All jobs
      </a>
      {error && <p className="error">Could not refresh: {error.message}</p>}
      <section className="card">
        <div className="detail-heading">
          <span className="mono">{job.job_id}</span>
          <StatusBadge status={job.status} />
          {/* Only offered while dead. The DLQ screen is where a job that has
              already been replayed can be replayed again, with the warning
              that goes with it. A replay resets the job to queued, and the
              refresh moves this page back to fast polling to follow it. */}
          {job.status === "dead" && (
            <span className="heading-actions">
              <ReplayButton jobId={job.job_id} status="dead" onReplayed={refresh} />
              <a href="#/dlq">Dead letter queue</a>
            </span>
          )}
        </div>
        <dl className="fields">
          <div>
            <dt>Type</dt>
            <dd className="mono">{job.job_type}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              <PriorityBadge priority={job.priority} />
            </dd>
          </div>
          <div>
            <dt>Attempt</dt>
            <dd>
              {job.attempt} of {job.max_attempts}
            </dd>
          </div>
          <div>
            <dt>Worker</dt>
            <dd className="mono">{job.worker_id ?? "Not claimed yet"}</dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{formatTimestamp(job.submitted_at)}</dd>
          </div>
        </dl>
      </section>
      {/* On a failed job this is the last attempt's error, which may be
          replaced on the next one. Completing clears it. */}
      {job.error_message && (
        <section className="card error-card">
          <h2 className="card-title">{job.status === "dead" ? "Final error" : "Last error"}</h2>
          <p className="error-text">{job.error_message}</p>
        </section>
      )}
      <JobTimeline job={job} />
      {job.result && <JsonBlock title="Result" value={job.result} />}
      <JsonBlock title="Payload" value={job.payload} />
    </div>
  );
}
