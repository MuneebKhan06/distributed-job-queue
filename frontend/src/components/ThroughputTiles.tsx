import { useCallback } from "react";

import { prometheus, PrometheusError, type InstantSample } from "../api/prometheus";
import { usePolling } from "../hooks/usePolling";
import { formatCount } from "../lib/format";
import StatTile from "./StatTile";

// Matches Prometheus's 10s scrape: polling faster would only repeat answers.
const POLL_MS = 10000;
const WORKER_JOB = 'job="job-queue-workers"';

// A five minute window smooths over the 10s scrape without hiding a change
// for long. Multiplied to per minute, because at this project's volumes a per
// second rate is mostly digits after the decimal point.
const QUERIES = {
  completed: "sum(rate(jobs_completed_total[5m])) * 60",
  failed: "sum(rate(jobs_failed_total[5m])) * 60",
  dead: "sum by (reason) (increase(jobs_dead_total[1h]))",
  p95: "histogram_quantile(0.95, sum by (le) (rate(job_duration_seconds_bucket[5m])))",
  workersUp: `sum(up{${WORKER_JOB}})`,
  workersKnown: `count(up{${WORKER_JOB}})`,
};

// sum() over a counter no worker has touched yet is an empty vector, not 0:
// prometheus_client only creates a labelled series on its first increment.
// With the workers confirmed up, empty really does mean none happened.
function scalar(samples: InstantSample[]): number {
  return samples.length ? samples[0].value : 0;
}

async function fetchRates() {
  const entries = await Promise.all(
    Object.entries(QUERIES).map(
      async ([key, expr]) => [key, await prometheus.query(expr)] as const,
    ),
  );
  const result = Object.fromEntries(entries) as Record<keyof typeof QUERIES, InstantSample[]>;
  const deadBy = new Map(result.dead.map((sample) => [sample.labels.reason, sample.value]));
  return {
    completed: scalar(result.completed),
    failed: scalar(result.failed),
    deadPermanent: deadBy.get("permanent") ?? 0,
    deadExhausted: deadBy.get("exhausted") ?? 0,
    // NaN when nothing ran in the window, since a quantile of no observations
    // is undefined. Kept as NaN so the tile can say so instead of showing 0 s.
    p95: result.p95.length ? result.p95[0].value : Number.NaN,
    workersUp: scalar(result.workersUp),
    workersKnown: scalar(result.workersKnown),
  };
}

function perMinute(value: number): string {
  return value < 10 ? value.toFixed(1) : formatCount(Math.round(value));
}

function formatSeconds(value: number): string {
  if (Number.isNaN(value)) {
    return "None ran";
  }
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
}

export default function ThroughputTiles() {
  const fetcher = useCallback(fetchRates, []);
  const { data, error, loading } = usePolling(fetcher, POLL_MS);

  if (loading) {
    return <p className="muted">Asking Prometheus</p>;
  }

  if (!data) {
    const unreachable = error instanceof PrometheusError && error.unreachable;
    return (
      <div className="card notice">
        <p>
          {unreachable
            ? "Prometheus is not reachable, so throughput and failure rates are unavailable."
            : `Prometheus rejected a query: ${error?.message}`}
        </p>
        {unreachable && (
          <p className="muted">
            Workers count their own jobs and only Prometheus adds them up. It starts with{" "}
            <span className="mono">docker compose up</span> on port 9090. Queue depth above
            comes from the API and does not need it.
          </p>
        )}
      </div>
    );
  }

  const deadTotal = data.deadPermanent + data.deadExhausted;
  // Without this, an empty result reads as "nothing happened" when the truth
  // may be that Prometheus cannot see a single worker.
  const blind = data.workersKnown === 0 || data.workersUp === 0;

  return (
    <>
      {error && <p className="error">Could not refresh: {error.message}</p>}
      {blind && (
        <p className="warning">
          Prometheus is up but is not scraping any worker, so the rates below read zero
          whatever the workers are doing.
        </p>
      )}
      <div className="stat-row">
        <StatTile
          label="Completed per minute"
          value={perMinute(data.completed)}
          detail="Five minute average, all workers"
        />
        <StatTile
          label="Failed attempts per minute"
          value={perMinute(data.failed)}
          detail="Each one is retried after a backoff"
        />
        <StatTile
          label="Sent to the DLQ in the last hour"
          value={formatCount(Math.round(deadTotal))}
          detail={`${Math.round(data.deadPermanent)} permanent · ${Math.round(
            data.deadExhausted,
          )} out of retries`}
        />
        <StatTile
          label="95th percentile run time"
          value={formatSeconds(data.p95)}
          detail={`${data.workersUp} of ${data.workersKnown} workers reporting`}
        />
      </div>
    </>
  );
}
