import { useCallback } from "react";

import { ApiError, api } from "../api/client";
import { PriorityBadge, StatusBadge } from "../components/Badge";
import JobTimeline from "../components/JobTimeline";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp } from "../lib/time";

const POLL_MS = 2000;

export default function JobDetailPage({ jobId }: { jobId: string }) {
  const fetchJob = useCallback(() => api.getJob(jobId), [jobId]);
  const { data: job, error, loading } = usePolling(fetchJob, POLL_MS);

  if (loading) {
    return <p className="muted">Loading job</p>;
  }

  // A 404 is an answer, not a hiccup: the job does not exist, so there are no
  // stale details worth keeping on screen beside the message.
  if (error instanceof ApiError && error.status === 404) {
    return (
      <section className="card">
        <p>No job with ID <span className="mono">{jobId}</span>.</p>
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
      <JobTimeline job={job} />
    </div>
  );
}
