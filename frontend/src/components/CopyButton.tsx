import { useState } from "react";

const COPIED_MS = 1500;

interface CopyButtonProps {
  text: string;
  // Read out in place of "Copy" when the button alone does not say what it
  // copies, such as beside a job ID.
  label?: string;
}

/**
 * Copies text to the clipboard and says so for a moment.
 *
 * The clipboard API is only there on secure origins. localhost counts, but a
 * dashboard opened over plain HTTP on a LAN address does not, so the button
 * is left out there rather than shown and left to fail.
 */
export default function CopyButton({ text, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return null;
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Permission refused. Nothing useful to do beyond not claiming success.
    }
  };

  return (
    <button type="button" className="small-button" aria-label={label} onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
