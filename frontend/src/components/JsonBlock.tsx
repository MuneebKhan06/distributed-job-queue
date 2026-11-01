import { useState } from "react";

import CopyButton from "./CopyButton";

interface JsonBlockProps {
  title: string;
  value: unknown;
}

// A big result rendered in full made the job page slow to draw and buried
// the timeline under it. Past this many lines only the start is shown.
const PREVIEW_LINES = 60;

export default function JsonBlock({ title, value }: JsonBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const text = JSON.stringify(value, null, 2);
  const lines = text.split("\n");
  const long = lines.length > PREVIEW_LINES;
  const shown = long && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : text;

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
        <CopyButton text={text} label={`Copy ${title.toLowerCase()}`} />
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
