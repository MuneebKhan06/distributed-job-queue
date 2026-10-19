import type {
  DLQEntry,
  Health,
  JobAccepted,
  JobDetail,
  JobFilters,
  JobSubmission,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

/** A non 2xx response, carrying FastAPI's detail message when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// FastAPI reports a 404 or 409 as a string detail, and a 422 as a list of
// validation errors. Both are flattened to one readable line.
function describeDetail(detail: unknown): string | null {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc.slice(1).join(".") : "";
        return field ? `${field}: ${item?.msg}` : String(item?.msg);
      })
      .join("; ");
  }
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = describeDetail(body?.detail) ?? message;
    } catch {
      // Not JSON, most likely a proxy error page. The status line will do.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
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

  listJobs: (filters: JobFilters = {}) =>
    request<JobDetail[]>(`/jobs${toQuery(filters)}`),

  getJob: (jobId: string) => request<JobDetail>(`/jobs/${jobId}`),

  submitJob: (submission: JobSubmission) =>
    request<JobAccepted>("/jobs", {
      method: "POST",
      body: JSON.stringify(submission),
    }),

  listDlq: (limit = 50, offset = 0) =>
    request<DLQEntry[]>(`/dlq${toQuery({ limit, offset })}`),

  replayDlq: (jobId: string) =>
    request<{ job_id: string; status: string }>(`/dlq/${jobId}/replay`, {
      method: "POST",
    }),
};
