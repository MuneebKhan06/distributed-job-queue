import { useState } from "react";

import { api } from "../api/client";
import type { CurrentStatus } from "../hooks/useJobStatuses";
import ConfirmDialog from "./ConfirmDialog";

interface ReplayButtonProps {
  jobId: string;
  status: CurrentStatus | undefined;
  onReplayed?: () => void;
}

/**
 * Replay one job from the DLQ, after saying what that will do.
 *
 * replay_job in app/core/dlq.py resets the job row to queued whatever state it
 * is in, as long as a DLQ row exists, and the endpoint is deliberately not
 * idempotent. So the dialog has to describe the job's current state: replaying
 * a dead job is the normal case, but replaying one that was already replayed
 * runs it again.
 */
export default function ReplayButton({ jobId, status, onReplayed }: ReplayButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  // A DLQ row without a job row is refused by the API with a 404, since there
  // is no priority or payload to enqueue from.
  if (status === "missing") {
    return (
      <span className="muted" title="The DLQ row has no job row to replay from">
        Cannot replay
      </span>
    );
  }

  const confirm = async () => {
    setBusy(true);
    try {
      await api.replayDlq(jobId);
      setOutcome({ ok: true, message: "Queued again" });
      onReplayed?.();
    } catch (caught) {
      setOutcome({
        ok: false,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const alreadyBack = status !== undefined && status !== "dead";

  return (
    <span className="replay">
      <button
        type="button"
        className="small-button"
        disabled={status === undefined || busy}
        onClick={() => {
          setOutcome(null);
          setOpen(true);
        }}
      >
        Replay
      </button>
      {outcome && (
        <span className={outcome.ok ? "replay-ok" : "field-error"}>{outcome.message}</span>
      )}
      <ConfirmDialog
        open={open}
        title={alreadyBack ? "Replay this job again?" : "Replay this job?"}
        confirmLabel={alreadyBack ? "Replay anyway" : "Replay"}
        caution={alreadyBack}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      >
        <p>
          <span className="mono">{jobId}</span> goes back on its priority stream with its
          attempt count reset to zero, so it gets its full retry budget again.
        </p>
        {status === "completed" && (
          <p className="warning">
            This job was already replayed and has completed since. Replaying it now runs it a
            second time.
          </p>
        )}
        {(status === "queued" || status === "running" || status === "failed") && (
          <p className="warning">
            This job was already replayed and is {status} right now. Replaying again resets it
            and puts a second copy on the stream.
          </p>
        )}
      </ConfirmDialog>
    </span>
  );
}
