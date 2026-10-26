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
// retried job the middle step is the latest attempt, and the gap before it
// includes every earlier attempt and backoff, not just time on the stream.
//
// A replay muddies it further. It resets the attempt counter but keeps the
// original submitted_at, so a job replayed after an hour dead looks like a
// first attempt that queued for an hour. The job row cannot tell those apart,
// so the gap is stated as what it is, time since submission, rather than
// labelled as queue wait.
function buildSteps(job: JobDetail): Step[] {
  const retried = job.attempt > 1;
  const steps: Step[] = [{ label: "Submitted", at: job.submitted_at, state: "done" }];

  steps.push({
    label: retried ? `Attempt ${job.attempt} started` : "Started",
    at: job.started_at,
    state: job.started_at ? (job.status === "running" ? "current" : "done") : "pending",
    note: job.started_at
      ? `${formatDuration(job.submitted_at, job.started_at)} after submission${
          retried ? ", including earlier attempts" : ""
        }`
      : undefined,
  });

  if (job.status === "dead") {
    steps.push({
      label: "Gave up",
      at: job.completed_at,
      state: "failed",
      note: deadReason(job),
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

// _record_dead in worker/executor.py prefixes the error with one of these two
// reasons. They need telling apart: a permanent failure stops on its first
// attempt with retries left unused, and calling that "retries exhausted" sends
// the reader looking for a flaky dependency when the payload is the problem.
function deadReason(job: JobDetail): string {
  if (job.error_message?.startsWith("permanent failure")) {
    return `Failed permanently on attempt ${job.attempt}, moved to the dead letter queue`;
  }
  return "Retries exhausted, moved to the dead letter queue";
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
