import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TimeoutError, fetchWithTimeout } from "./fetchWithTimeout";

// A server that accepts the request and never answers: the promise only
// settles if the caller aborts it.
function silentServer(_input: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });
}

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up on a server that never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(silentServer));
    const pending = fetchWithTimeout("/api/health", {}, 5000);
    const outcome = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await outcome;
  });

  it("passes a prompt answer straight through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const response = await fetchWithTimeout("/api/health", {}, 5000);
    expect(await response.text()).toBe("ok");
  });

  it("leaves other network failures as they were", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchWithTimeout("/api/health")).rejects.toThrow("Failed to fetch");
  });

  it("does not leave a timer behind after an answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok")),
    );
    await fetchWithTimeout("/api/health", {}, 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
