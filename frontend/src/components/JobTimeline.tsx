import type { JobDetail } from "../api/types";
import { formatDuration, formatTimestamp } from "../lib/time";

type StepState = "done" | "current" | "pending" | "failed";

interface Step {
  label: string;
  at: string | null;
  state: StepState;
  note?: string;
}

// The worker overwrites started_at on every attempt and only sets
// completed_at once the job is finished for good, completed or dead. So on a
// retried job the middle step is the latest attempt, and the wait before it
// includes every earlier attempt and backoff, not just time on the stream.
function buildSteps(job: JobDetail): Step[] {
  const retried = job.attempt > 1;
  const waitLabel = retried ? "Waited, including earlier attempts" : "Waited in queue";
  const steps: Step[] = [{ label: "Submitted", at: job.submitted_at, state: "done" }];

  steps.push({
    label: retried ? `Attempt ${job.attempt} started` : "Started",
    at: job.started_at,
    state: job.started_at ? (job.status === "running" ? "current" : "done") : "pending",
    note: job.started_at
      ? `${waitLabel} ${formatDuration(job.submitted_at, job.started_at)}`
      : undefined,
  });

  if (job.status === "dead") {
    steps.push({
      label: "Gave up",
      at: job.completed_at,
      state: "failed",
      note: "Retries exhausted, moved to the dead letter queue",
    });
  } else if (job.status === "failed") {
    steps.push({
      label: "Waiting to retry",
      at: null,
      state: "failed",
      note: `Attempt ${job.attempt} failed, ${job.max_attempts - job.attempt} left`,
    });
  } else {
    steps.push({
      label: "Completed",
      at: job.completed_at,
      state: job.completed_at ? "done" : "pending",
      note:
        job.started_at && job.completed_at
          ? `Ran for ${formatDuration(job.started_at, job.completed_at)}`
          : undefined,
    });
  }

  return steps;
}

export default function JobTimeline({ job }: { job: JobDetail }) {
  return (
    <section className="card">
      <h2 className="card-title">Timeline</h2>
      <ol className="timeline">
        {buildSteps(job).map((step) => (
          <li key={step.label} className={`timeline-step step-${step.state}`}>
            <span className="timeline-marker" aria-hidden="true" />
            <div>
              <div className="timeline-label">{step.label}</div>
              <div className="muted timeline-meta">
                {step.at ? formatTimestamp(step.at) : "Not yet"}
                {step.note && ` · ${step.note}`}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
