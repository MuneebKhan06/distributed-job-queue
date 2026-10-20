import type { JobPriority, JobStatus } from "../api/types";

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

export function PriorityBadge({ priority }: { priority: JobPriority }) {
  return <span className={`badge priority-${priority}`}>{priority}</span>;
}
