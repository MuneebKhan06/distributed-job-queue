import { type FormEvent, useState } from "react";

import { api } from "../api/client";
import { JOB_PRIORITIES, type JobAccepted, type JobPriority } from "../api/types";
import { formatPayload, JOB_PRESETS } from "../lib/presets";
import { checkDraft } from "../lib/validateSubmission";

const DEFAULT_MAX_ATTEMPTS = 5;

export default function SubmitPage() {
  const [jobType, setJobType] = useState(JOB_PRESETS[0].jobType);
  const [priority, setPriority] = useState<JobPriority>("normal");
  const [maxAttempts, setMaxAttempts] = useState(String(DEFAULT_MAX_ATTEMPTS));
  const [payloadText, setPayloadText] = useState(formatPayload(JOB_PRESETS[0].payload));

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<JobAccepted | null>(null);
  // Errors stay hidden until the first submit, so the form does not open by
  // scolding someone who has not finished typing.
  const [attempted, setAttempted] = useState(false);

  const check = checkDraft({ jobType, maxAttempts, payloadText });
  const shown = attempted ? check.errors : {};
  const isValid = Object.keys(check.errors).length === 0;

  const applyPreset = (index: number) => {
    const preset = JOB_PRESETS[index];
    setJobType(preset.jobType);
    setPayloadText(formatPayload(preset.payload));
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setAccepted(null);
    setAttempted(true);

    const { payload } = check;
    if (!isValid || !payload) {
      return;
    }

    setSubmitting(true);
    try {
      setAccepted(
        await api.submitJob({
          job_type: jobType.trim(),
          priority,
          max_attempts: Number(maxAttempts),
          payload,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="detail">
      <section className="card">
        <h2 className="card-title">Start from an example</h2>
        <div className="presets">
          {JOB_PRESETS.map((preset, index) => (
            <button
              key={preset.jobType}
              type="button"
              className={`preset${preset.jobType === jobType ? " preset-active" : ""}`}
              onClick={() => applyPreset(index)}
            >
              <strong>{preset.label}</strong>
              <span className="muted">{preset.description}</span>
            </button>
          ))}
        </div>
      </section>

      <form className="card form" onSubmit={submit}>
        <div className="form-row">
          <label>
            Job type
            <input
              value={jobType}
              aria-invalid={Boolean(shown.jobType)}
              onChange={(event) => setJobType(event.target.value)}
            />
            {shown.jobType && <span className="field-error">{shown.jobType}</span>}
          </label>
          <label>
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as JobPriority)}
            >
              {JOB_PRIORITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max attempts
            <input
              type="number"
              min={1}
              max={20}
              value={maxAttempts}
              aria-invalid={Boolean(shown.maxAttempts)}
              onChange={(event) => setMaxAttempts(event.target.value)}
            />
            {shown.maxAttempts && <span className="field-error">{shown.maxAttempts}</span>}
          </label>
        </div>
        <label>
          Payload
          <textarea
            className="payload-editor"
            spellCheck={false}
            rows={16}
            value={payloadText}
            aria-invalid={Boolean(shown.payloadText)}
            onChange={(event) => setPayloadText(event.target.value)}
          />
          {shown.payloadText && <span className="field-error">{shown.payloadText}</span>}
        </label>

        {check.warnings.map((warning) => (
          <p key={warning} className="warning">
            {warning}
          </p>
        ))}

        {error && <p className="error">{error}</p>}

        <div className="form-actions">
          <button
            type="submit"
            className="primary-button"
            disabled={submitting || (attempted && !isValid)}
          >
            {submitting ? "Submitting" : "Submit job"}
          </button>
        </div>
      </form>

      {accepted && (
        <section className="card success-card">
          <h2 className="card-title">Job queued</h2>
          <p>
            <a href={`#/jobs/${accepted.job_id}`} className="mono">
              {accepted.job_id}
            </a>{" "}
            is on the stream as message <span className="mono">{accepted.stream_message_id}</span>.
          </p>
        </section>
      )}
    </div>
  );
}
