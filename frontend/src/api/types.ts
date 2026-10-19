// Mirrors app/schemas/jobs.py. The Pydantic models are the wire contract, so
// when one of them changes this file changes with it.

export type JobPriority = "high" | "normal" | "low";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "dead";

export const JOB_STATUSES: JobStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "dead",
];

export const JOB_PRIORITIES: JobPriority[] = ["high", "normal", "low"];

// The API rejects any job_type whose prefix no handler is registered under.
export const KNOWN_JOB_TYPE_PREFIXES = ["transform", "validate", "compute"];

export type Payload = Record<string, unknown>;

export interface JobSubmission {
  job_id?: string;
  job_type: string;
  priority?: JobPriority;
  payload: Payload;
  max_attempts?: number;
}

export interface JobAccepted {
  job_id: string;
  status: JobStatus;
  stream_message_id: string;
}

export interface JobDetail {
  job_id: string;
  job_type: string;
  priority: JobPriority;
  status: JobStatus;
  attempt: number;
  max_attempts: number;
  payload: Payload;
  result: Payload | null;
  error_message: string | null;
  submitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  worker_id: string | null;
}

export interface DLQEntry {
  job_id: string;
  job_type: string | null;
  original_payload: Payload | null;
  error_reason: string;
  attempt_count: number;
  failed_at: string;
}

export interface Health {
  status: "healthy" | "degraded";
  redis: "connected" | "unavailable";
  database: "connected" | "unavailable";
  workers_active: number;
}

export interface JobFilters {
  status?: JobStatus;
  job_type?: string;
  priority?: JobPriority;
  limit?: number;
  offset?: number;
}
