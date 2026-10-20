import { useCallback } from "react";

import { api } from "../api/client";
import { PriorityBadge, StatusBadge } from "../components/Badge";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";

const POLL_MS = 3000;

export default function JobsPage() {
  const fetchJobs = useCallback(() => api.listJobs({ limit: 50 }), []);
  const { data: jobs, error, loading } = usePolling(fetchJobs, POLL_MS);

  if (loading) {
    return <p className="muted">Loading jobs</p>;
  }

  return (
    <section className="card table-card">
      {error && <p className="error">Could not refresh: {error.message}</p>}
      {jobs && jobs.length === 0 ? (
        <p className="muted empty">No jobs yet. Submit one to see it here.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Type</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Worker</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {jobs?.map((job) => (
                <tr key={job.job_id}>
                  <td className="mono" title={job.job_id}>
                    {job.job_id.slice(0, 8)}
                  </td>
                  <td className="mono">{job.job_type}</td>
                  <td>
                    <PriorityBadge priority={job.priority} />
                  </td>
                  <td>
                    <StatusBadge status={job.status} />
                  </td>
                  <td>
                    {job.attempt} / {job.max_attempts}
                  </td>
                  <td className="mono muted">{job.worker_id ?? "none"}</td>
                  <td title={formatTimestamp(job.submitted_at)}>{timeAgo(job.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
