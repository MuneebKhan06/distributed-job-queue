import { Fragment, useCallback, useState } from "react";

import { api } from "../api/client";
import type { DLQEntry } from "../api/types";
import { StatusBadge } from "../components/Badge";
import BulkReplay from "../components/BulkReplay";
import JsonBlock from "../components/JsonBlock";
import Pager from "../components/Pager";
import ReplayButton from "../components/ReplayButton";
import { type CurrentStatus, useJobStatuses } from "../hooks/useJobStatuses";
import { usePolling } from "../hooks/usePolling";
import { formatTimestamp, timeAgo } from "../lib/time";

const POLL_MS = 5000;
const PAGE_SIZE = 25;
const COLUMNS = 9;

// dlq_jobs has no unique job_id: a job that is replayed and dies again gets a
// second row. The failure time tells two rows for one job apart.
export function entryKey(entry: DLQEntry): string {
  return `${entry.job_id}:${entry.failed_at}`;
}

export default function DlqPage() {
  const [page, setPage] = useState(0);
  const changePage = (next: number) => {
    // A selection on one page is invisible from the next, and replaying jobs
    // nobody can see is not a good default.
    setSelected(new Set());
    setPage(next);
  };
  // Keyed by entryKey so an open row stays open across polls, and so opening
  // one failure of a job does not open its other failures too.
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });

  // Same trick as the jobs table: one extra row says whether an older page
  // exists, since the endpoint returns no total.
  const fetchEntries = useCallback(() => api.listDlq(PAGE_SIZE + 1, page * PAGE_SIZE), [page]);
  const { data, error, loading } = usePolling(fetchEntries, POLL_MS);
  const entries = data ? data.slice(0, PAGE_SIZE) : null;
  const hasNext = data !== null && data.length > PAGE_SIZE;

  // A DLQ row is a record of a failure, not of the job's present state. The
  // row stays after a replay, so without this a job that has since completed
  // looks exactly like one that is still dead.
  const { data: statuses, refresh: refreshStatuses } = useJobStatuses(
    entries?.map((entry) => entry.job_id) ?? [],
    POLL_MS,
  );
  const earlier = earlierFailures(entries ?? []);

  // Bulk replay only takes jobs that are still dead, on their latest row. A
  // job already replayed would run twice, and that deserves the single row
  // dialog that says so, not a line in a batch.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const eligible = new Set(
    (entries ?? [])
      .filter((entry) => !earlier.has(entryKey(entry)) && statuses?.get(entry.job_id) === "dead")
      .map((entry) => entry.job_id),
  );
  // Selection is intersected with what is eligible right now rather than
  // pruned in an effect, so a job replayed elsewhere drops out of the batch
  // the moment its status changes.
  const chosen = [...selected].filter((id) => eligible.has(id));
  const allChosen = eligible.size > 0 && chosen.length === eligible.size;

  const toggleSelected = (jobId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(jobId)) {
        next.add(jobId);
      }
      return next;
    });

  if (loading) {
    return <p className="muted">Loading the dead letter queue</p>;
  }

  return (
    <>
      {entries && entries.length > 0 && (
        <BulkReplay
          jobIds={chosen}
          onDone={() => {
            setSelected(new Set());
            refreshStatuses();
          }}
        />
      )}
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
                  <th>
                    <input
                      type="checkbox"
                      className="select-box"
                      aria-label="Select every dead job on this page"
                      checked={allChosen}
                      disabled={eligible.size === 0}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(eligible))}
                    />
                  </th>
                  <th aria-label="Details" />
                  <th>Job</th>
                  <th>Type</th>
                  <th>Error</th>
                  <th>Attempts</th>
                  <th>Failed</th>
                  <th>Now</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {entries?.map((entry) => {
                  const key = entryKey(entry);
                  const isOpen = open.has(key);
                  return (
                    <Fragment key={key}>
                      <tr className={isOpen ? "row-open" : undefined}>
                        <td>
                          {!earlier.has(key) && (
                            <input
                              type="checkbox"
                              className="select-box"
                              aria-label={`Select ${entry.job_id}`}
                              checked={chosen.includes(entry.job_id)}
                              disabled={!eligible.has(entry.job_id)}
                              onChange={() => toggleSelected(entry.job_id)}
                            />
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="expand-button"
                            aria-expanded={isOpen}
                            aria-label={isOpen ? "Hide details" : "Show details"}
                            onClick={() => toggle(key)}
                          >
                            {isOpen ? "\u25BE" : "\u25B8"}
                          </button>
                        </td>
                        <td className="mono" title={entry.job_id}>
                          <a href={`#/jobs/${entry.job_id}`}>{entry.job_id.slice(0, 8)}</a>
                        </td>
                        <td className="mono">{entry.job_type ?? "unknown"}</td>
                        <td className="error-cell" title={entry.error_reason}>
                          {entry.error_reason}
                        </td>
                        <td>{entry.attempt_count}</td>
                        <td title={formatTimestamp(entry.failed_at)}>{timeAgo(entry.failed_at)}</td>
                        <td>
                          {earlier.has(key) ? (
                            <span className="muted">Earlier failure</span>
                          ) : (
                            <CurrentStatusCell status={statuses?.get(entry.job_id)} />
                          )}
                        </td>
                        <td>
                          {/* One button per job, on its latest failure. Two
                              buttons for the same job would be two ways to
                              queue it twice. */}
                          {!earlier.has(key) && (
                            <ReplayButton
                              jobId={entry.job_id}
                              status={statuses?.get(entry.job_id)}
                              onReplayed={refreshStatuses}
                            />
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="row-details">
                          <td colSpan={COLUMNS}>
                            <EntryDetails entry={entry} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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
        onPage={changePage}
      />
    </>
  );
}

/**
 * Rows for a job that also has a newer row on this page.
 *
 * Entries arrive newest first, so the first row seen for a job is its latest
 * failure and only that one is worth a current status. Limited to the page:
 * an older failure whose newer row is on an earlier page still shows a status,
 * which is the same status and so is not wrong, only repeated.
 */
function earlierFailures(entries: DLQEntry[]): Set<string> {
  const seen = new Set<string>();
  const earlier = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.job_id)) {
      earlier.add(entryKey(entry));
    }
    seen.add(entry.job_id);
  }
  return earlier;
}

function CurrentStatusCell({ status }: { status: CurrentStatus | undefined }) {
  if (status === undefined) {
    return <span className="muted">Checking</span>;
  }
  if (status === "missing") {
    return <span className="muted">Job row gone</span>;
  }
  if (status === "dead") {
    return <StatusBadge status="dead" />;
  }
  // Anything else means it was replayed and has moved on since.
  return (
    <span className="replayed">
      <span className="muted">Replayed,</span> <StatusBadge status={status} />
    </span>
  );
}

/**
 * A message the worker could not decode at all.
 *
 * worker/main.py records these with zero attempts and the stream's raw fields
 * in place of a payload, because there was no job to run. Its job ID is often
 * generated, with no job row behind it, which is why such entries show the
 * job row as gone.
 */
function isPoison(entry: DLQEntry): boolean {
  return (
    entry.attempt_count === 0 &&
    entry.original_payload !== null &&
    "raw_fields" in entry.original_payload
  );
}

function EntryDetails({ entry }: { entry: DLQEntry }) {
  return (
    <div className="entry-details">
      <div>
        <h3 className="card-title">Error</h3>
        <p className="error-text">{entry.error_reason}</p>
        <p className="muted entry-meta">
          {isPoison(entry)
            ? `Discarded ${formatTimestamp(entry.failed_at)} without running, because the message could not be decoded.`
            : `Failed ${formatTimestamp(entry.failed_at)} after ${entry.attempt_count} ${
                entry.attempt_count === 1 ? "attempt" : "attempts"
              }.`}{" "}
          <a href={`#/jobs/${entry.job_id}`}>Open the job</a>
        </p>
      </div>
      {entry.original_payload ? (
        <JsonBlock
          title={isPoison(entry) ? "Raw stream fields" : "Original payload"}
          value={isPoison(entry) ? entry.original_payload.raw_fields : entry.original_payload}
        />
      ) : (
        <p className="muted">No payload was recorded for this failure.</p>
      )}
    </div>
  );
}
