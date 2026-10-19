import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Calls fetcher now and then every intervalMs, keeping the last good result.
 *
 * The previous data is kept when a poll fails, so one dropped request shows an
 * error beside stale numbers instead of blanking the screen. Polling pauses
 * while the tab is hidden, since nobody is looking and the API has better
 * things to do.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void run();
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [run, intervalMs]);

  return { data, error, loading, refresh: run };
}
