import { api } from "../api/client";
import { usePolling } from "../hooks/usePolling";

const POLL_MS = 5000;

type Tone = "ok" | "warn" | "bad";

function Dot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="health-item">
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function HealthIndicator() {
  const { data, error, loading } = usePolling(api.health, POLL_MS);

  if (loading) {
    return <div className="health muted">Checking health</div>;
  }

  // The endpoint always answers 200 while the API is up, so an error here
  // means the API itself is unreachable rather than one of its dependencies.
  if (error || !data) {
    return (
      <div className="health" title={error?.message}>
        <Dot tone="bad" label="API unreachable" />
      </div>
    );
  }

  const workers = data.workers_active;
  return (
    <div className="health">
      <Dot tone={data.redis === "connected" ? "ok" : "bad"} label="Redis" />
      <Dot tone={data.database === "connected" ? "ok" : "bad"} label="PostgreSQL" />
      <Dot
        tone={workers > 0 ? "ok" : "warn"}
        label={`${workers} ${workers === 1 ? "worker" : "workers"}`}
      />
    </div>
  );
}
