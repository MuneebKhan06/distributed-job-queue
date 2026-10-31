import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NoAnswerError, api } from "./client";

function answer(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("api client errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("turns a 422 into field errors keyed by wire name", async () => {
    answer(
      422,
      JSON.stringify({
        detail: [
          {
            loc: ["body", "job_type"],
            msg: "Value error, job_type must start with one of: transform",
          },
          { loc: ["body", "payload", "n"], msg: "Field required" },
        ],
      }),
    );
    const error = await api.submitJob({ job_type: "x", payload: {} }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(422);
    expect(error.fieldErrors).toEqual({
      job_type: "job_type must start with one of: transform",
      payload: "Field required",
    });
    expect(error.message).toContain("payload.n: Field required");
  });

  it("uses a string detail as the message", async () => {
    answer(409, JSON.stringify({ detail: "Job abc has already been submitted" }));
    await expect(api.getJob("abc")).rejects.toThrow("Job abc has already been submitted");
  });

  it("falls back to the status line for a proxy error page", async () => {
    answer(502, "<html>Bad Gateway</html>");
    const error = await api.health().catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
  });

  it("reports a failed connection as no answer, not a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = await api.health().catch((caught) => caught);
    expect(error).toBeInstanceOf(NoAnswerError);
    expect(error.timedOut).toBe(false);
  });
});
