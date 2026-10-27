import { describe, expect, it } from "vitest";

import { formatDuration, timeAgo } from "./time";

describe("formatDuration", () => {
  it("picks a unit that suits the size of the gap", () => {
    expect(formatDuration("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.007Z")).toBe("7 ms");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:00:04.25Z")).toBe("4.3 s");
    expect(formatDuration("2026-01-01T00:00:00Z", "2026-01-01T00:05:39Z")).toBe("5 m 39 s");
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
});
