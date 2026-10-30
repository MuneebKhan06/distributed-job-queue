import { useState } from "react";

import { NoAnswerError, api } from "../api/client";
import ConfirmDialog from "./ConfirmDialog";

interface BulkReplayProps {
  jobIds: string[];
  onDone: () => void;
}

interface Failure {
  jobId: string;
  message: string;
}

interface Summary {
  replayed: number;
  failures: Failure[];
  // Set when the API stopped answering: the job whose replay got no answer,
  // and how many after it were never tried.
  stoppedAt?: string;
  skipped: number;
}

/**
 * Replay a selection of dead jobs, one request at a time.
 *
 * Sequential on purpose. Twenty five parallel replays would put twenty five
 * jobs on the stream in whatever order the requests happened to land, and
 * make a partial failure harder to read. One at a time keeps the order the
 * operator chose and gives an honest progress count.
 */
export default function BulkReplay({ jobIds, onDone }: BulkReplayProps) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  const run = async () => {
    const failures: Failure[] = [];
    let replayed = 0;
    let stoppedAt: string | undefined;
    setProgress(0);
    for (const [index, jobId] of jobIds.entries()) {
      try {
        await api.replayDlq(jobId);
        replayed += 1;
      } catch (caught) {
        // No answer is different from a refusal. The API is down or stuck,
        // so carrying on would only wait out the timeout once per job, and
        // the replay that got no answer may have happened.
        if (caught instanceof NoAnswerError) {
          stoppedAt = jobId;
          setProgress(index + 1);
          break;
        }
        // One refusal does not stop the rest. Each replay stands alone, and
        // halting halfway would leave a selection that is neither done nor not.
        failures.push({
          jobId,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
      setProgress(index + 1);
    }
    setProgress(null);
    setOpen(false);
    const skipped = stoppedAt ? jobIds.length - jobIds.indexOf(stoppedAt) - 1 : 0;
    setSummary({ replayed, failures, stoppedAt, skipped });
    onDone();
  };

  const busy = progress !== null;

  return (
    <div className="bulk-bar">
      <button
        type="button"
        className="primary-button"
        disabled={jobIds.length === 0 || busy}
        onClick={() => {
          setSummary(null);
          setOpen(true);
        }}
      >
        {jobIds.length === 0 ? "Select dead jobs to replay" : `Replay ${jobIds.length} selected`}
      </button>
      {summary && (
        <span
          className={summary.failures.length || summary.stoppedAt ? "field-error" : "replay-ok"}
        >
          {summary.replayed} replayed
          {summary.failures.length > 0 &&
            `, ${summary.failures.length} refused: ${summary.failures
              .map((failure) => `${failure.jobId.slice(0, 8)} (${failure.message})`)
              .join(", ")}`}
          {summary.stoppedAt &&
            `. Stopped because the API stopped answering: ${summary.stoppedAt.slice(0, 8)} may or may not have been replayed${
              summary.skipped ? `, and ${summary.skipped} more were not tried` : ""
            }. Check the Now column before trying again.`}
        </span>
      )}
      <ConfirmDialog
        open={open}
        title={`Replay ${jobIds.length} ${jobIds.length === 1 ? "job" : "jobs"}?`}
        confirmLabel="Replay all"
        busy={busy}
        onConfirm={run}
        onCancel={() => setOpen(false)}
      >
        <p>
          Each goes back on its priority stream with its attempt count reset to zero. Only jobs that
          are still dead can be selected, so none of these will run twice.
        </p>
        {busy && (
          <p className="muted">
            Replayed {progress} of {jobIds.length}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
