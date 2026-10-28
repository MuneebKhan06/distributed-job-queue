import { describe, expect, it } from "vitest";

import { isJobId } from "./jobId";

describe("isJobId", () => {
  it("accepts a UUID in either case", () => {
    expect(isJobId("3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b")).toBe(true);
    expect(isJobId("3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B")).toBe(true);
  });

  it("rejects the eight character prefix the tables show", () => {
    expect(isJobId("3f2b8c1e")).toBe(false);
  });

  it("rejects a UUID with stray characters around it", () => {
    expect(isJobId(" 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b")).toBe(false);
    expect(isJobId("3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0bx")).toBe(false);
  });
});
