import { describe, expect, it } from "vitest";

import { formatDuration, timeAgo } from "./time";

describe("formatDuration", () => {
  it("picks a unit that suits the size of the gap", () => {
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.007Z")).toBe("7 ms");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:04.25Z")).toBe("4.3 s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:05:39Z")).toBe("5 m 39 s");
  });

  it("never shows sixty seconds", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:01:59.6Z")).toBe("2 m 0 s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:59.97Z")).toBe("1 m 0 s");
  });

  it("switches to hours and days for long gaps, as on a replayed job", () => {
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T02:30:10Z")).toBe("2 h 30 m");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-04T05:00:00Z")).toBe("3 d 5 h");
  });
});

describe("timeAgo", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");

  it("describes the past relative to now", () => {
    expect(timeAgo("2026-01-01T11:57:00Z", now)).toMatch(/3 minutes ago/);
    expect(timeAgo("2026-01-01T09:00:00Z", now)).toMatch(/3 hours ago/);
  });

  it("reads timestamps with an explicit UTC offset, as the API sends them", () => {
    expect(timeAgo("2026-01-01T11:59:29.680175Z", now)).toMatch(/30 seconds ago/);
  });

  it("reads a timestamp slightly ahead of the browser's clock as now", () => {
    expect(timeAgo("2026-01-01T12:00:02Z", now)).toBe(timeAgo("2026-01-01T12:00:00Z", now));
    expect(timeAgo("2026-01-01T12:00:02Z", now)).not.toMatch(/^in /);
  });

  it("still shows a timestamp far in the future as one", () => {
    expect(timeAgo("2026-01-01T15:00:00Z", now)).toMatch(/3 hours/);
  });

  it("does not throw on a timestamp it cannot read", () => {
    expect(timeAgo("not a date", now)).toBe("unknown time");
  });
});
