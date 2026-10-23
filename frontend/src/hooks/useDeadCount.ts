import { useCallback } from "react";

import { api } from "../api/client";
import { usePolling } from "./usePolling";

const POLL_MS = 10000;
// Past this the exact number stops mattering: something is badly wrong either
// way, and fetching every dead row's payload to count it would be wasteful.
const CAP = 50;

/**
 * Jobs whose status is dead right now, as a short label, or null for none.
 *
 * Counted from the jobs table rather than the DLQ. DLQ rows outlive a replay,
 * so their count only ever grows, and a badge that never goes down stops
 * being read.
 */
export function useDeadCount(): string | null {
  const fetchDead = useCallback(() => api.listJobs({ status: "dead", limit: CAP + 1 }), []);
  const { data } = usePolling(fetchDead, POLL_MS);

  if (!data || data.length === 0) {
    return null;
  }
  return data.length > CAP ? `${CAP}+` : String(data.length);
}
