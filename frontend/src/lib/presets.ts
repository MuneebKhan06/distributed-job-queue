import type { Payload } from "../api/types";

export interface JobPreset {
  jobType: string;
  label: string;
  description: string;
  payload: Payload;
}

// Each payload is shaped for its handler in worker/handlers. A preset that the
// handler rejects would teach the wrong contract, so these are kept to fields
// the handlers actually read.
export const JOB_PRESETS: JobPreset[] = [
  {
    jobType: "transform.clean",
    label: "Transform",
    description: "Deduplicate records, normalise dates to ISO 8601 and fill nulls.",
    payload: {
      records: [
        { id: 1, name: "Ada", joined: "10/12/2024", team: null },
        { id: 1, name: "Ada", joined: "10/12/2024", team: null },
        { id: 2, name: "Grace", joined: "03-15-2025", team: "platform" },
      ],
      operations: ["deduplicate", "normalize_dates", "fill_nulls"],
      date_fields: ["joined"],
      defaults: { team: "unassigned" },
    },
  },
  {
    jobType: "validate.schema",
    label: "Validate",
    description: "Check required fields and types, reporting every bad record.",
    payload: {
      records: [
        { id: 1, email: "ada@example.com", age: 36 },
        { id: 2, email: null, age: "forty" },
        { id: 3, email: "grace@example.com", age: true },
      ],
      rules: {
        required: ["id", "email"],
        types: { id: "integer", email: "string", age: "integer" },
      },
    },
  },
  {
    jobType: "compute.aggregate",
    label: "Compute",
    description: "Sum, average or count fields, optionally grouped by a column.",
    payload: {
      records: [
        { region: "north", sales: 120, units: 4 },
        { region: "south", sales: 80, units: 2 },
        { region: "north", sales: 200, units: 7 },
      ],
      group_by: "region",
      metrics: { sales: "sum", units: "avg" },
    },
  },
];

export function formatPayload(payload: Payload): string {
  return JSON.stringify(payload, null, 2);
}
