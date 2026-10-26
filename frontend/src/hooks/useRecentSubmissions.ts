import { useCallback, useState } from "react";

export interface RecentSubmission {
  jobId: string;
  jobType: string;
  submittedAt: string;
}

const STORAGE_KEY = "recent-submissions";
const LIMIT = 10;

// Session storage rather than local: the list is "what I just sent from this
// tab", and a week old list greeting the next visit would be noise. Storage
// can be missing or refused (private windows, blocked site data), so every
// access is guarded and the list simply starts empty when it is.
function load(): RecentSubmission[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as RecentSubmission[]).slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function save(entries: RecentSubmission[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Not persisted. The in memory list still works for this page view.
  }
}

export function useRecentSubmissions() {
  const [entries, setEntries] = useState<RecentSubmission[]>(load);

  const add = useCallback((entry: RecentSubmission) => {
    setEntries((current) => {
      const next = [entry, ...current.filter((item) => item.jobId !== entry.jobId)].slice(0, LIMIT);
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    save([]);
    setEntries([]);
  }, []);

  return { entries, add, clear };
}
