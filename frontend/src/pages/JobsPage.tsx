import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api/client";
import {
  JOB_PRIORITIES,
  JOB_STATUSES,
  type JobDetail,
  type JobPriority,
  type JobStatus,
} from "../api/types";
import { PriorityBadge, StatusBadge } from "../components/Badge";
import JobFilterBar, { type JobFilterValues } from "../components/JobFilterBar";
import Pager from "../components/Pager";
import RefreshControl from "../components/RefreshControl";
import { useDebounced } from "../hooks/useDebounced";
import { pushHash, replaceHash } from "../hooks/useHashRoute";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";

const POLL_MS = 3000;
const PAGE_SIZE = 50;

interface JobsQuery {
  status: JobStatus | "";
  priority: JobPriority | "";
  jobType: string;
  page: number;
}

// The URL is user editable, so anything it carries is checked against the
// known values rather than passed straight to the API to be rejected there.
function readQuery(params: URLSearchParams): JobsQuery {
  const status = params.get("status") ?? "";
  const priority = params.get("priority") ?? "";
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    status: (JOB_STATUSES as string[]).includes(status) ? (status as JobStatus) : "",
    priority: (JOB_PRIORITIES as string[]).includes(priority) ? (priority as JobPriority) : "",
    jobType: params.get("type") ?? "",
    page: Number.isFinite(page) && page > 1 ? page - 1 : 0,
  };
}

function writeQuery(query: JobsQuery, mode: "push" | "replace"): void {
  const params = {
    status: query.status || undefined,
    priority: query.priority || undefined,
    type: query.jobType || undefined,
    // Shown to people, so one based.
    page: query.page > 0 ? String(query.page + 1) : undefined,
  };
  (mode === "push" ? pushHash : replaceHash)("/jobs", params);
}

/**
 * Filters and page live in the URL, so a view can be bookmarked or pasted to
 * someone. The only local state is the job type box while it is being typed in.
 */
export default function JobsPage({ params }: { params: URLSearchParams }) {
  const query = readQuery(params);
  const { status, priority, jobType, page } = query;

  const [typeDraft, setTypeDraft] = useState(jobType);
  const [live, setLive] = useState(true);
  // Typing in the job type box should not send a request per keystroke.
  const settledType = useDebounced(typeDraft.trim(), 300);
  const lastWrittenType = useRef(jobType);

  useEffect(() => {
    if (settledType !== lastWrittenType.current) {
      lastWrittenType.current = settledType;
      writeQuery({ status, priority, jobType: settledType, page: 0 }, "replace");
    }
  }, [settledType, status, priority]);

  // The URL can also change from outside, for example the sidebar link
  // clearing every filter. Copying that into the box is skipped when it is
  // the value this page wrote itself, or a half typed draft would be cut off.
  useEffect(() => {
    if (jobType !== lastWrittenType.current) {
      lastWrittenType.current = jobType;
      setTypeDraft(jobType);
    }
  }, [jobType]);

  // The API matches job_type exactly, so a partial name finds nothing. That
  // is left as is rather than faked with client side matching over one page.
  //
  // GET /jobs returns no total count, so one extra row is requested: if it
  // comes back there is an older page, and it is dropped before rendering.
  const fetchJobs = useCallback(
    () =>
      api.listJobs({
        status: status || undefined,
        priority: priority || undefined,
        job_type: jobType || undefined,
        limit: PAGE_SIZE + 1,
        offset: page * PAGE_SIZE,
      }),
    [status, priority, jobType, page],
  );
  const { data, error, loading, updatedAt, refresh } = usePolling(fetchJobs, POLL_MS, live);
  const jobs = data ? data.slice(0, PAGE_SIZE) : null;
  const hasNext = data !== null && data.length > PAGE_SIZE;

  // Page 3 of one filter means nothing under another, so a new filter always
  // starts again from the newest jobs.
  const changeFilters = (next: JobFilterValues) => {
    if (next.status !== status || next.priority !== priority) {
      const nextType = next.jobType.trim();
      lastWrittenType.current = nextType;
      setTypeDraft(next.jobType);
      writeQuery(
        { status: next.status, priority: next.priority, jobType: nextType, page: 0 },
        "replace",
      );
    } else {
      setTypeDraft(next.jobType);
    }
  };

  // Paging leaves a history entry, so Back returns to the page before.
  const changePage = (next: number) => writeQuery({ ...query, page: next }, "push");

  return (
    <>
      <div className="toolbar">
        <JobFilterBar value={{ status, priority, jobType: typeDraft }} onChange={changeFilters} />
        <RefreshControl
          live={live}
          updatedAt={updatedAt}
          onToggle={() => setLive((current) => !current)}
          onRefresh={refresh}
        />
      </div>
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
            onPage={changePage}
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
                    <a href={`#/jobs/${job.job_id}`}>{job.job_id.slice(0, 8)}</a>
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
