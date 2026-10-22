import { useCallback, useRef } from "react";

import { ApiError, api } from "../api/client";
import type { JobStatus } from "../api/types";
import type { RecentSubmission } from "../hooks/useRecentSubmissions";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";
import { StatusBadge } from "./Badge";

const POLL_MS = 3000;
const SETTLED: JobStatus[] = ["completed", "dead"];

// "missing" covers a job the API no longer knows, for example after the
// database was reset while this tab still remembered it.
type KnownStatus = JobStatus | "missing";

interface RecentSubmissionsProps {
  entries: RecentSubmission[];
  onClear: () => void;
}

export default function RecentSubmissions({ entries, onClear }: RecentSubmissionsProps) {
  // Statuses already known to be final are kept here and not asked for again,
  // so ten finished jobs cost no requests at all. The price is that a later
  // replay is not noticed here. The job's own page does notice, and that is
  // where anyone following a replayed job would be looking.
  const settled = useRef(new Map<string, KnownStatus>());

  const ids = entries.map((entry) => entry.jobId).join(",");
  const fetchStatuses = useCallback(async () => {
    const statuses = new Map(settled.current);
    const pending = ids ? ids.split(",").filter((id) => !settled.current.has(id)) : [];
    await Promise.all(
      pending.map(async (id) => {
        try {
          const job = await api.getJob(id);
          statuses.set(id, job.status);
          if (SETTLED.includes(job.status)) {
            settled.current.set(id, job.status);
          }
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404) {
            statuses.set(id, "missing");
            settled.current.set(id, "missing");
          }
          // Anything else leaves the status unknown until the next poll.
        }
      }),
    );
    return statuses;
  }, [ids]);

  const { data: statuses } = usePolling(fetchStatuses, POLL_MS);

  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">Submitted from this tab</h2>
        <button type="button" className="small-button" onClick={onClear}>
          Clear
        </button>
      </div>
      <ul className="recent">
        {entries.map((entry) => {
          const status = statuses?.get(entry.jobId);
          return (
            <li key={entry.jobId}>
              <a href={`#/jobs/${entry.jobId}`} className="mono">
                {entry.jobId.slice(0, 8)}
              </a>
              <span className="mono muted">{entry.jobType}</span>
              <span className="muted" title={formatTimestamp(entry.submittedAt)}>
                {timeAgo(entry.submittedAt)}
              </span>
              {status === "missing" ? (
                <span className="muted">No longer exists</span>
              ) : status ? (
                <StatusBadge status={status} />
              ) : (
                <span className="muted">Checking</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
