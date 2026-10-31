import { useState } from "react";

interface JsonBlockProps {
  title: string;
  value: unknown;
}

const COPIED_MS = 1500;
// A big result rendered in full made the job page slow to draw and buried
// the timeline under it. Past this many lines only the start is shown.
const PREVIEW_LINES = 60;

export default function JsonBlock({ title, value }: JsonBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const text = JSON.stringify(value, null, 2);
  const lines = text.split("\n");
  const long = lines.length > PREVIEW_LINES;
  const shown = long && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : text;

  // The clipboard API is only there on secure origins. localhost counts, but
  // a dashboard opened over plain HTTP on a LAN address does not, so the
  // button is hidden there rather than shown and left to fail.
  const canCopy = typeof navigator !== "undefined" && Boolean(navigator.clipboard);

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
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
        {canCopy && (
          <button type="button" className="small-button" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <pre className="json">{shown}</pre>
      {/* Copy always takes the whole value, collapsed or not. */}
      {long && (
        <button type="button" className="link-button" onClick={() => setExpanded(!expanded)}>
          {expanded
            ? "Show less"
            : `Show all ${lines.length} lines (${lines.length - PREVIEW_LINES} more)`}
        </button>
      )}
    </section>
  );
}
