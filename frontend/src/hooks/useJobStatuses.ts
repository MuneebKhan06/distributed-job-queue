import { useCallback, useRef } from "react";

import { ApiError, api } from "../api/client";
import type { JobStatus } from "../api/types";
import { usePolling } from "./usePolling";

// "missing" is a job the API does not know: the DLQ row outlived its job row.
export type CurrentStatus = JobStatus | "missing";

/**
 * Current status of each job ID, polled together.
 *
 * There is no batch endpoint, so this is one GET per ID. Callers pass a page's
 * worth, not an unbounded list, and duplicates are fetched once.
 *
 * A check that fails keeps that job's last known status. Before, a single
 * dropped request turned the row back to "Checking" and disabled its Replay
 * button until the next poll, so a flaky connection made the DLQ table
 * flicker between states it had already settled.
 */
export function useJobStatuses(jobIds: string[], intervalMs: number) {
  const key = [...new Set(jobIds)].sort().join(",");
  const lastKnown = useRef(new Map<string, CurrentStatus>());

  const fetchStatuses = useCallback(async () => {
    const statuses = new Map<string, CurrentStatus>();
    if (!key) {
      return statuses;
    }
    const ids = key.split(",");
    await Promise.all(
      ids.map(async (id) => {
        try {
          statuses.set(id, (await api.getJob(id)).status);
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404) {
            statuses.set(id, "missing");
            return;
          }
          // Any other failure keeps what was known, and the next poll tries
          // again. An ID never answered for stays out, shown as unknown.
          const known = lastKnown.current.get(id);
          if (known) {
            statuses.set(id, known);
          }
        }
      }),
    );
    // Only this page's IDs are remembered, so paging does not pile them up.
    lastKnown.current = new Map(statuses);
    return statuses;
  }, [key]);

  return usePolling(fetchStatuses, intervalMs);
}
