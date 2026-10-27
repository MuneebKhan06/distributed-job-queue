import { describe, expect, it } from "vitest";

import { byLabel, parsePromText, single } from "./promText";

// Trimmed from real prometheus_client output for this project's metrics, so
// the parser is tested against the format it actually receives.
const SAMPLE = `# HELP queue_depth Messages not yet delivered to any worker
# TYPE queue_depth gauge
queue_depth{stream="jobs.high"} 12.0
queue_depth{stream="jobs.normal"} 0.0
# HELP retry_queue_depth Jobs parked in the delay queue waiting to come due
# TYPE retry_queue_depth gauge
retry_queue_depth 1.0
job_duration_seconds_bucket{job_type="compute.aggregate",le="+Inf"} 1.0
jobs_submitted_created{job_type="transform.clean",priority="high"} 1.7929037178463802e+09
`;

describe("parsePromText", () => {
  it("reads labelled and unlabelled samples and skips comments", () => {
    const samples = parsePromText(SAMPLE);
    expect(samples).toHaveLength(5);
    expect(byLabel(samples, "queue_depth", "stream")).toEqual(
      new Map([
        ["jobs.high", 12],
        ["jobs.normal", 0],
      ]),
    );
    expect(single(samples, "retry_queue_depth")).toBe(1);
  });

  it("keeps an infinite bucket bound as a label and reads exponent notation", () => {
    const samples = parsePromText(SAMPLE);
    expect(byLabel(samples, "job_duration_seconds_bucket", "le").get("+Inf")).toBe(1);
    expect(single(samples, "jobs_submitted_created")).toBeCloseTo(1792903717.85);
  });

  it("handles commas, escaped quotes and equals signs inside label values", () => {
    const [sample] = parsePromText('m{a="x,\\"y\\"=z",b="q\\\\r"} 3\n');
    expect(sample.labels).toEqual({ a: 'x,"y"=z', b: "q\\r" });
  });

  it("understands NaN and infinite values", () => {
    const samples = parsePromText("a NaN\nb +Inf\nc -Inf\n");
    expect(samples[0].value).toBeNaN();
    expect(samples[1].value).toBe(Number.POSITIVE_INFINITY);
    expect(samples[2].value).toBe(Number.NEGATIVE_INFINITY);
  });

  it("returns null for a metric that is not exposed", () => {
    expect(single(parsePromText(SAMPLE), "worker_up")).toBeNull();
  });
});
