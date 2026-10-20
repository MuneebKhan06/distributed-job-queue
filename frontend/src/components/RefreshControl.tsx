import { useEffect, useState } from "react";

import { timeAgo } from "../lib/time";

interface RefreshControlProps {
  live: boolean;
  updatedAt: number | null;
  onToggle: () => void;
  onRefresh: () => void;
}

/**
 * Shows how fresh the rows are, and lets them be frozen.
 *
 * Pausing is for reading: a live table reorders under the cursor as new jobs
 * arrive, which makes it hard to follow one row.
 */
export default function RefreshControl({
  live,
  updatedAt,
  onToggle,
  onRefresh,
}: RefreshControlProps) {
  // Re-render once a second so "5 seconds ago" keeps counting while paused.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="refresh">
      <span className="muted">
        {updatedAt ? `Updated ${timeAgo(new Date(updatedAt).toISOString(), now)}` : "Not loaded"}
      </span>
      {!live && (
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      )}
      <button type="button" aria-pressed={live} onClick={onToggle}>
        {live ? "Pause" : "Resume"}
      </button>
    </div>
  );
}
