import { describe, expect, it } from "vitest";

import { formatPayload, JOB_PRESETS } from "./presets";
import { checkDraft } from "./validateSubmission";

const draft = (overrides: Partial<Parameters<typeof checkDraft>[0]> = {}) => ({
  jobId: "",
  jobType: "compute.aggregate",
  maxAttempts: "5",
  payloadText: '{"records": [], "metrics": {}}',
  ...overrides,
});

describe("checkDraft", () => {
  it("accepts every preset as shipped", () => {
    for (const preset of JOB_PRESETS) {
      const check = checkDraft(
        draft({ jobType: preset.jobType, payloadText: formatPayload(preset.payload) }),
      );
      expect(check.errors, preset.jobType).toEqual({});
      expect(check.warnings, preset.jobType).toEqual([]);
    }
  });

  it("rejects a job type no handler is registered under", () => {
    expect(checkDraft(draft({ jobType: "email.send" })).errors.jobType).toMatch(/must start/i);
  });

  it("holds max attempts to the API's range of whole numbers", () => {
    for (const value of ["0", "21", "2.5", "", "abc"]) {
      expect(checkDraft(draft({ maxAttempts: value })).errors.maxAttempts, value).toBeDefined();
    }
    expect(checkDraft(draft({ maxAttempts: "20" })).errors.maxAttempts).toBeUndefined();
  });

  it("requires the payload to be a JSON object", () => {
    expect(checkDraft(draft({ payloadText: "[1, 2]" })).errors.payloadText).toMatch(/object/);
    expect(checkDraft(draft({ payloadText: "null" })).errors.payloadText).toMatch(/object/);
    expect(checkDraft(draft({ payloadText: '{"a": }' })).errors.payloadText).toBeDefined();
  });

  it("accepts an empty job ID and rejects one that is not a UUID", () => {
    expect(checkDraft(draft({ jobId: "" })).errors.jobId).toBeUndefined();
    expect(checkDraft(draft({ jobId: "job-42" })).errors.jobId).toBeDefined();
    expect(
      checkDraft(draft({ jobId: "5ffa3985-18f9-4d00-9b0b-1b91d067536a" })).errors.jobId,
    ).toBeUndefined();
  });

  it("warns, without blocking, when the handler's required fields are missing", () => {
    const check = checkDraft(draft({ payloadText: '{"records": []}' }));
    expect(check.errors).toEqual({});
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toMatch(/metrics/);
  });
});
