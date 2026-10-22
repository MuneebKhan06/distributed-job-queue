import { KNOWN_JOB_TYPE_PREFIXES, type Payload } from "../api/types";

export interface SubmissionDraft {
  jobId: string;
  jobType: string;
  maxAttempts: string;
  payloadText: string;
}

export type FieldErrors = Partial<Record<keyof SubmissionDraft, string>>;

export interface DraftCheck {
  errors: FieldErrors;
  // Problems the API will accept but the worker will not. Shown, not enforced.
  warnings: string[];
  payload: Payload | null;
}

// Wire field names, as they appear in a 422's loc, mapped to the form fields.
export const WIRE_FIELDS: Record<string, keyof SubmissionDraft> = {
  job_id: "jobId",
  job_type: "jobType",
  max_attempts: "maxAttempts",
  payload: "payloadText",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The API does not look inside the payload, so a missing field is only found
// when a worker raises PermanentJobError and the job goes straight to the DLQ.
// Mirrors the require() call at the top of each handler's run().
const REQUIRED_PAYLOAD_KEYS: Record<string, string[]> = {
  transform: ["records", "operations"],
  validate: ["records", "rules"],
  compute: ["records", "metrics"],
};

/**
 * The same rules JobSubmission enforces in app/schemas/jobs.py, checked before
 * the round trip. The API stays the authority: anything missed here still
 * comes back as a 422 and is shown against its field.
 */
export function checkDraft(draft: SubmissionDraft): DraftCheck {
  const errors: FieldErrors = {};
  const warnings: string[] = [];

  const jobId = draft.jobId.trim();
  if (jobId && !UUID.test(jobId)) {
    errors.jobId = "Must be a UUID, or left empty to generate one.";
  }

  const jobType = draft.jobType.trim();
  const prefix = jobType.split(".", 1)[0];
  if (jobType.length === 0) {
    errors.jobType = "Required.";
  } else if (jobType.length > 50) {
    errors.jobType = "At most 50 characters.";
  } else if (!KNOWN_JOB_TYPE_PREFIXES.includes(prefix)) {
    errors.jobType = `Must start with ${KNOWN_JOB_TYPE_PREFIXES.join(", ")}.`;
  }

  const attempts = Number(draft.maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    errors.maxAttempts = "A whole number from 1 to 20.";
  }

  let payload: Payload | null = null;
  try {
    const parsed: unknown = JSON.parse(draft.payloadText);
    // The schema types it as a dict, so an array or a bare value is a 422.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.payloadText = "Must be a JSON object, in curly braces.";
    } else {
      payload = parsed as Payload;
    }
  } catch (caught) {
    // The engine's own message names the position, which is the useful part.
    errors.payloadText = caught instanceof SyntaxError ? caught.message : "Not valid JSON.";
  }

  if (payload && !errors.jobType) {
    const missing = (REQUIRED_PAYLOAD_KEYS[prefix] ?? []).filter((key) => !(key in payload));
    if (missing.length > 0) {
      warnings.push(
        `${prefix} jobs need ${missing.join(" and ")} in the payload. ` +
          "The API will accept it, but the worker will fail it straight to the DLQ.",
      );
    }
  }

  return { errors, warnings, payload };
}
