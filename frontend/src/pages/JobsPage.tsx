import { useCallback, useState } from "react";

import { api } from "../api/client";
import type { JobDetail } from "../api/types";
import { PriorityBadge, StatusBadge } from "../components/Badge";
import JobFilterBar, { EMPTY_FILTERS, type JobFilterValues } from "../components/JobFilterBar";
import Pager from "../components/Pager";
import { useDebounced } from "../hooks/useDebounced";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";

const POLL_MS = 3000;
const PAGE_SIZE = 50;

export default function JobsPage() {
  const [filters, setFilters] = useState<JobFilterValues>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  // Typing in the job type box should not send a request per keystroke.
  const jobType = useDebounced(filters.jobType.trim(), 300);

  // The API matches job_type exactly, so a partial name finds nothing. That
  // is left as is rather than faked with client side matching over one page.
  //
  // GET /jobs returns no total count, so one extra row is requested: if it
  // comes back there is an older page, and it is dropped before rendering.
  const fetchJobs = useCallback(
    () =>
      api.listJobs({
        status: filters.status || undefined,
        priority: filters.priority || undefined,
        job_type: jobType || undefined,
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      }),
    [filters.status, filters.priority, jobType, page],
  );
  const { data, error, loading } = usePolling(fetchJobs, POLL_MS);
  const jobs = data ? data.slice(0, PAGE_SIZE) : null;
  const hasNext = data !== null && data.length > PAGE_SIZE;

  // Page 3 of one filter means nothing under another, so a new filter always
  // starts again from the newest jobs.
  const changeFilters = (next: JobFilterValues) => {
    setFilters(next);
    setPage(0);
  };

  return (
    <>
      <JobFilterBar value={filters} onChange={changeFilters} />
      {loading ? (
        <p className="muted">Loading jobs</p>
      ) : (
        <>
          <JobsTable jobs={jobs} error={error} />
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            shown={jobs?.length ?? 0}
            hasNext={hasNext}
            onPage={setPage}
          />
        </>
      )}
    </>
  );
}

function JobsTable({ jobs, error }: { jobs: JobDetail[] | null; error: Error | null }) {
  return (
    <section className="card table-card">
      {error && <p className="error">Could not refresh: {error.message}</p>}
      {jobs && jobs.length === 0 ? (
        <p className="muted empty">No jobs match. Submit one, or loosen the filters.</p>
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
