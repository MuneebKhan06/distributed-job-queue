import type { DLQEntry } from "../api/types";

export interface Arrivals {
  total: number;
  permanent: number;
  exhausted: number;
  undecodable: number;
  // True when the fetched page was full of recent rows, so there may be more.
  capped: boolean;
}

/**
 * DLQ arrivals since `sinceMs`, split by the reason the worker recorded.
 *
 * Counted from dlq_jobs rather than from jobs_dead_total in Prometheus. That
 * counter's series only appear on their first increment, so the first job of
 * each type to die is never seen as an increase, and with job types being
 * free text there is no fixed set of series to create at startup instead.
 * The table has a row per arrival with its time, which is the answer itself.
 *
 * `entries` must be newest first, which is how GET /dlq returns them, and
 * `limit` is the page size they were fetched with.
 */
export function countArrivals(entries: DLQEntry[], sinceMs: number, limit: number): Arrivals {
  const recent = entries.filter((entry) => Date.parse(entry.failed_at) >= sinceMs);
  const startsWith = (prefix: string) =>
    recent.filter((entry) => entry.error_reason.startsWith(prefix)).length;
  return {
    total: recent.length,
    // Prefixes written by _record_dead in worker/executor.py and _discard in
    // worker/main.py.
    permanent: startsWith("permanent failure"),
    exhausted: startsWith("retries exhausted"),
    undecodable: startsWith("undecodable message"),
    capped: entries.length >= limit && recent.length === entries.length,
  };
}
