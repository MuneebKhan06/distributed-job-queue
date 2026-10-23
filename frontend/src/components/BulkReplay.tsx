import { useState } from "react";

import { api } from "../api/client";
import ConfirmDialog from "./ConfirmDialog";

interface BulkReplayProps {
  jobIds: string[];
  onDone: () => void;
}

interface Failure {
  jobId: string;
  message: string;
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
  const [summary, setSummary] = useState<{ replayed: number; failures: Failure[] } | null>(
    null,
  );

  const run = async () => {
    const failures: Failure[] = [];
    let replayed = 0;
    setProgress(0);
    for (const [index, jobId] of jobIds.entries()) {
      try {
        await api.replayDlq(jobId);
        replayed += 1;
      } catch (caught) {
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
    setSummary({ replayed, failures });
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
        <span className={summary.failures.length ? "field-error" : "replay-ok"}>
          {summary.replayed} replayed
          {summary.failures.length > 0 &&
            `, ${summary.failures.length} refused: ${summary.failures
              .map((failure) => `${failure.jobId.slice(0, 8)} (${failure.message})`)
              .join(", ")}`}
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
          Each goes back on its priority stream with its attempt count reset to zero. Only jobs
          that are still dead can be selected, so none of these will run twice.
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
