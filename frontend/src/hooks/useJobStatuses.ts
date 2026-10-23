import { useCallback } from "react";

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
 */
export function useJobStatuses(jobIds: string[], intervalMs: number) {
  const key = [...new Set(jobIds)].sort().join(",");

  const fetchStatuses = useCallback(async () => {
    const statuses = new Map<string, CurrentStatus>();
    if (!key) {
      return statuses;
    }
    await Promise.all(
      key.split(",").map(async (id) => {
        try {
          statuses.set(id, (await api.getJob(id)).status);
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 404) {
            statuses.set(id, "missing");
          }
          // Any other failure leaves the ID out, shown as unknown, until the
          // next poll tries again.
        }
      }),
    );
    return statuses;
  }, [key]);

  return usePolling(fetchStatuses, intervalMs);
}
