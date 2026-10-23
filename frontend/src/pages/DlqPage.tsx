import { useCallback, useState } from "react";

import { api } from "../api/client";
import type { DLQEntry } from "../api/types";
import Pager from "../components/Pager";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";

const POLL_MS = 5000;
const PAGE_SIZE = 25;

// dlq_jobs has no unique job_id: a job that is replayed and dies again gets a
// second row. The failure time tells two rows for one job apart.
export function entryKey(entry: DLQEntry): string {
  return `${entry.job_id}:${entry.failed_at}`;
}

export default function DlqPage() {
  const [page, setPage] = useState(0);

  // Same trick as the jobs table: one extra row says whether an older page
  // exists, since the endpoint returns no total.
  const fetchEntries = useCallback(
    () => api.listDlq(PAGE_SIZE + 1, page * PAGE_SIZE),
    [page],
  );
  const { data, error, loading } = usePolling(fetchEntries, POLL_MS);
  const entries = data ? data.slice(0, PAGE_SIZE) : null;
  const hasNext = data !== null && data.length > PAGE_SIZE;

  if (loading) {
    return <p className="muted">Loading the dead letter queue</p>;
  }

  return (
    <>
      <section className="card table-card">
        {error && <p className="error">Could not refresh: {error.message}</p>}
        {entries && entries.length === 0 ? (
          <p className="muted empty">
            Nothing has run out of retries. Jobs land here after their last attempt fails.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Type</th>
                  <th>Error</th>
                  <th>Attempts</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {entries?.map((entry) => (
                  <tr key={entryKey(entry)}>
                    <td className="mono" title={entry.job_id}>
                      <a href={`#/jobs/${entry.job_id}`}>{entry.job_id.slice(0, 8)}</a>
                    </td>
                    <td className="mono">{entry.job_type ?? "unknown"}</td>
                    <td className="error-cell" title={entry.error_reason}>
                      {entry.error_reason}
                    </td>
                    <td>{entry.attempt_count}</td>
                    <td title={formatTimestamp(entry.failed_at)}>{timeAgo(entry.failed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        shown={entries?.length ?? 0}
        hasNext={hasNext}
        onPage={setPage}
      />
    </>
  );
}
