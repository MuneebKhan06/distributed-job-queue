import type { DLQEntry, Health, JobAccepted, JobDetail, JobFilters, JobSubmission } from "./types";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

/** A non 2xx response, carrying FastAPI's detail message when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // For a 422, each body field's message keyed by its wire name, such as
    // job_type or payload. Empty for every other status.
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ValidationIssue {
  loc?: unknown[];
  msg?: string;
}

// FastAPI reports a 404 or 409 as a string detail, and a 422 as a list of
// validation errors. Both are flattened to one readable line.
function describeDetail(detail: unknown): string | null {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item: ValidationIssue) => {
        const field = Array.isArray(item?.loc) ? item.loc.slice(1).join(".") : "";
        return field ? `${field}: ${item?.msg}` : String(item?.msg);
      })
      .join("; ");
  }
  return null;
}

// loc is ["body", field, ...] for a problem inside the request body. Only the
// top level field is kept, since that is what a form can point at.
function fieldErrorsFrom(detail: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!Array.isArray(detail)) {
    return errors;
  }
  for (const item of detail as ValidationIssue[]) {
    const loc = Array.isArray(item?.loc) ? item.loc : [];
    if (loc[0] === "body" && typeof loc[1] === "string" && item.msg && !errors[loc[1]]) {
      // Pydantic prefixes validator messages with "Value error, ".
      errors[loc[1]] = item.msg.replace(/^Value error, /, "");
    }
  }
  return errors;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await send(path, init);
  return (await response.json()) as T;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    let fieldErrors: Record<string, string> = {};
    try {
      const body = await response.json();
      message = describeDetail(body?.detail) ?? message;
      fieldErrors = fieldErrorsFrom(body?.detail);
    } catch {
      // Not JSON, most likely a proxy error page. The status line will do.
    }
    throw new ApiError(response.status, message, fieldErrors);
  }

  return response;
}

function toQuery(filters: JobFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const api = {
  health: () => request<Health>("/health"),

  // Prometheus text, not JSON. Parsed by lib/promText.
  metricsText: async () => (await send("/metrics")).text(),

  listJobs: (filters: JobFilters = {}) => request<JobDetail[]>(`/jobs${toQuery(filters)}`),

  getJob: (jobId: string) => request<JobDetail>(`/jobs/${jobId}`),

  submitJob: (submission: JobSubmission) =>
    request<JobAccepted>("/jobs", {
      method: "POST",
      body: JSON.stringify(submission),
    }),

  listDlq: (limit = 50, offset = 0) => request<DLQEntry[]>(`/dlq${toQuery({ limit, offset })}`),

  replayDlq: (jobId: string) =>
    request<{ job_id: string; status: string }>(`/dlq/${jobId}/replay`, {
      method: "POST",
    }),
};
