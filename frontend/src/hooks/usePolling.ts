import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Calls fetcher now and then every intervalMs, keeping the last good result.
 *
 * The previous data is kept when a poll fails, so one dropped request shows an
 * error beside stale numbers instead of blanking the screen. Polling pauses
 * while the tab is hidden, since nobody is looking and the API has better
 * things to do.
 *
 * A new fetcher identity starts over immediately, which is how a filter change
 * reaches the API without waiting for the next tick. Callers memoise it. Each
 * call is numbered, and a response is dropped if a newer call has started
 * since, otherwise a slow reply for the old filter could land after the new
 * one and overwrite it.
 *
 * With enabled false the interval stops, but a new fetcher still fetches once,
 * so changing a filter on a paused screen still shows the matching rows.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const latestCall = useRef(0);

  const run = useCallback(async () => {
    const call = ++latestCall.current;
    try {
      const result = await fetcher();
      if (call === latestCall.current) {
        setData(result);
        setError(null);
        setUpdatedAt(Date.now());
      }
    } catch (caught) {
      if (call === latestCall.current) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      if (call === latestCall.current) {
        setLoading(false);
      }
    }
  }, [fetcher]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void run();
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [run, intervalMs, enabled]);

  return { data, error, loading, updatedAt, refresh: run };
}
