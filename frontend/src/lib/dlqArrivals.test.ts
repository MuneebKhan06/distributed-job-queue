import { describe, expect, it } from "vitest";

import type { DLQEntry } from "../api/types";
import { countArrivals } from "./dlqArrivals";

const entry = (failedAt: string, reason: string): DLQEntry => ({
  job_id: "5ffa3985-18f9-4d00-9b0b-1b91d067536a",
  job_type: "compute.aggregate",
  original_payload: {},
  error_reason: reason,
  attempt_count: 1,
  failed_at: failedAt,
});

const since = Date.parse("2026-01-01T11:00:00Z");

describe("countArrivals", () => {
  it("counts only rows inside the window, split by recorded reason", () => {
    const counts = countArrivals(
      [
        entry("2026-01-01T11:59:00Z", "permanent failure: unsupported operation: explode"),
        entry("2026-01-01T11:30:00Z", "retries exhausted: TimeoutError: upstream"),
        entry("2026-01-01T11:10:00Z", "undecodable message: bad job_id"),
        entry("2026-01-01T10:59:59Z", "permanent failure: too old to count"),
      ],
      since,
      100,
    );
    expect(counts).toEqual({
      total: 3,
      permanent: 1,
      exhausted: 1,
      undecodable: 1,
      capped: false,
    });
  });

  it("flags a full page of recent rows as possibly incomplete", () => {
    const rows = [
      entry("2026-01-01T11:59:00Z", "permanent failure: a"),
      entry("2026-01-01T11:58:00Z", "permanent failure: b"),
    ];
    expect(countArrivals(rows, since, 2).capped).toBe(true);
    expect(countArrivals(rows, since, 3).capped).toBe(false);
  });
});
