import { type ReactNode, useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  busy?: boolean;
  // Styles the confirm button as a warning, for actions with a side effect
  // the user may not expect.
  caution?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}

/**
 * A modal built on the native dialog element, which brings focus trapping,
 * Escape to close and a backdrop with it rather than reimplementing them.
 */
export default function ConfirmDialog({
  open,
  title,
  confirmLabel,
  busy = false,
  caution = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      // Escape fires cancel. It is handed back to the parent so the open prop
      // stays the only source of truth, and blocked mid request so a replay
      // cannot be dismissed while its outcome is still unknown.
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          onCancel();
        }
      }}
    >
      <h2 className="dialog-title">{title}</h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={caution ? "caution-button" : "primary-button"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? "Working" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
