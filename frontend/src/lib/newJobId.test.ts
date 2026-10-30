import { describe, expect, it } from "vitest";

import { isJobId } from "./jobId";
import { newJobId } from "./newJobId";

describe("newJobId", () => {
  it("makes IDs the job page accepts", () => {
    expect(isJobId(newJobId())).toBe(true);
  });

  it("still works where randomUUID is missing, as on a plain http LAN address", () => {
    const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(crypto), "randomUUID");
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const id = newJobId();
      expect(isJobId(id)).toBe(true);
      // Version 4, RFC 4122 variant.
      expect(id[14]).toBe("4");
      expect("89ab").toContain(id[19]);
    } finally {
      delete (crypto as { randomUUID?: unknown }).randomUUID;
      expect(typeof crypto.randomUUID).toBe(original ? "function" : "undefined");
    }
  });
});
