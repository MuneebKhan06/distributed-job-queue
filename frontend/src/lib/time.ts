const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", with the exact timestamp left for a title attribute. */
// How far ahead of the browser a timestamp may be and still count as now.
// Server and browser clocks rarely agree to the second, and with the server
// ahead, a job submitted a moment ago used to read "in 2 seconds".
const SKEW_SECONDS = 300;

export function timeAgo(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    // RelativeTimeFormat throws on NaN, which would take the page down.
    return "unknown time";
  }
  let seconds = Math.round((time - now) / 1000);
  if (seconds > 0 && seconds <= SKEW_SECONDS) {
    seconds = 0;
  }
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return relative.format(Math.round(seconds / size), unit);
    }
  }
  return iso;
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Elapsed time between two timestamps, for queue wait and run time. */
export function formatDuration(fromIso: string, toIso: string): string {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 59_950) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  // Rounded to whole seconds before splitting, so 119.6 s reads 2 m 0 s
  // rather than 1 m 60 s. A replayed job keeps its first submission time, so
  // gaps of hours or days are normal on its timeline and get their own unit.
  const total = Math.round(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) {
    return `${days} d ${hours} h`;
  }
  if (hours > 0) {
    return `${hours} h ${minutes} m`;
  }
  return `${minutes} m ${seconds} s`;
}
