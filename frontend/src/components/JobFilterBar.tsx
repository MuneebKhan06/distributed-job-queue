import { JOB_PRIORITIES, JOB_STATUSES, type JobPriority, type JobStatus } from "../api/types";

export interface JobFilterValues {
  status: JobStatus | "";
  priority: JobPriority | "";
  jobType: string;
}

export const EMPTY_FILTERS: JobFilterValues = { status: "", priority: "", jobType: "" };

interface JobFilterBarProps {
  value: JobFilterValues;
  onChange: (next: JobFilterValues) => void;
}

export default function JobFilterBar({ value, onChange }: JobFilterBarProps) {
  const isFiltered = value.status !== "" || value.priority !== "" || value.jobType !== "";

  return (
    <div className="filters">
      <label>
        Status
        <select
          value={value.status}
          onChange={(event) => onChange({ ...value, status: event.target.value as JobStatus | "" })}
        >
          <option value="">Any</option>
          {JOB_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label>
        Priority
        <select
          value={value.priority}
          onChange={(event) =>
            onChange({ ...value, priority: event.target.value as JobPriority | "" })
          }
        >
          <option value="">Any</option>
          {JOB_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </label>
      <label>
        Job type
        <input
          type="search"
          placeholder="transform.csv"
          value={value.jobType}
          onChange={(event) => onChange({ ...value, jobType: event.target.value })}
        />
      </label>
      {isFiltered && (
        <button type="button" className="link-button" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );
}
