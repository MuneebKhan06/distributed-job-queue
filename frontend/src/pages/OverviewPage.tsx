import { api } from "../api/client";
import StatTile from "../components/StatTile";
import ThroughputChart from "../components/ThroughputChart";
import ThroughputTiles from "../components/ThroughputTiles";
import { usePolling } from "../hooks/usePolling";
import { countArrivals } from "../lib/dlqArrivals";
import { formatCount } from "../lib/format";
import { byLabel, parsePromText, single } from "../lib/promText";

const POLL_MS = 5000;

// Highest priority first, the order the weighted poll cycle favours them.
const WORK_STREAMS = ["jobs.high", "jobs.normal", "jobs.low"];
const DLQ_STREAM = "jobs.dlq";

const STREAM_LABELS: Record<string, string> = {
  "jobs.high": "High",
  "jobs.normal": "Normal",
  "jobs.low": "Low",
  "jobs.dlq": "Dead letter",
};

const HOUR_MS = 60 * 60 * 1000;
// Enough rows to count a bad hour exactly. Past this the tile says "100+".
const ARRIVALS_LIMIT = 100;

async function fetchQueue() {
  // Each request is a scrape, and refresh_queue_depths reads Redis on every
  // scrape, so these are live numbers rather than whatever was cached last.
  const samples = parsePromText(await api.metricsText());
  return {
    lag: byLabel(samples, "queue_depth", "stream"),
    pending: byLabel(samples, "queue_pending", "stream"),
    length: byLabel(samples, "stream_length", "stream"),
    retry: single(samples, "retry_queue_depth"),
  };
}

// Polled on its own. It used to share a Promise.all with the metrics scrape,
// so a failed DLQ read, a much heavier query, blanked every queue tile even
// though the numbers they show had arrived fine.
async function fetchArrivals() {
  const dlq = await api.listDlq(ARRIVALS_LIMIT, 0);
  return countArrivals(dlq, Date.now() - HOUR_MS, ARRIVALS_LIMIT);
}

type QueueSnapshot = Awaited<ReturnType<typeof fetchQueue>>;
type Arrivals = Awaited<ReturnType<typeof fetchArrivals>>;

function total(values: Map<string, number>, streams: string[]): number | null {
  const present = streams.filter((stream) => values.has(stream));
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, stream) => sum + (values.get(stream) ?? 0), 0);
}

export default function OverviewPage() {
  const { data, error, loading } = usePolling(fetchQueue, POLL_MS);
  const { data: arrivals, error: arrivalsError } = usePolling(fetchArrivals, POLL_MS);

  if (loading) {
    return <p className="muted">Loading queue metrics</p>;
  }
  if (!data) {
    return <p className="error">Could not read the API's metrics: {error?.message}</p>;
  }

  return (
    <div className="overview">
      {error && <p className="error">Could not refresh: {error.message}</p>}
      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading" className="section-title">
          Queue
        </h2>
        <div className="stat-row">
          <StatTile
            label="Waiting for a worker"
            value={formatCount(total(data.lag, WORK_STREAMS))}
            detail={<StreamSplit values={data.lag} />}
          />
          <StatTile
            label="Being worked on"
            value={formatCount(total(data.pending, WORK_STREAMS))}
            detail="Delivered, not yet acknowledged"
          />
          <StatTile
            label="Waiting to retry"
            value={formatCount(data.retry)}
            detail="Backing off before the next attempt"
          />
          <StatTile
            label="Sent to the DLQ in the last hour"
            value={arrivalsValue(arrivals)}
            detail={
              arrivals ? (
                <ArrivalSplit arrivals={arrivals} />
              ) : arrivalsError ? (
                `Could not read the DLQ: ${arrivalsError.message}`
              ) : (
                "Counting"
              )
            }
          />
        </div>
      </section>
      <section aria-labelledby="rates-heading">
        <h2 id="rates-heading" className="section-title">
          Throughput and failures
        </h2>
        <ThroughputTiles />
      </section>
      <ThroughputChart />
      <StreamTable data={data} />
    </div>
  );
}

function arrivalsValue(arrivals: Arrivals | null): string {
  if (!arrivals) {
    return formatCount(null);
  }
  return arrivals.capped ? `${ARRIVALS_LIMIT}+` : formatCount(arrivals.total);
}

function ArrivalSplit({ arrivals }: { arrivals: Arrivals }) {
  const parts = [`${arrivals.permanent} permanent`, `${arrivals.exhausted} out of retries`];
  // Only mentioned when there are any, since they should be rare.
  if (arrivals.undecodable > 0) {
    parts.push(`${arrivals.undecodable} undecodable`);
  }
  return <>{parts.join(" \u00b7 ")}</>;
}

function StreamSplit({ values }: { values: Map<string, number> }) {
  return (
    <>
      {WORK_STREAMS.map(
        (stream) => `${STREAM_LABELS[stream]} ${formatCount(values.get(stream) ?? null)}`,
      ).join(" · ")}
    </>
  );
}

function StreamTable({ data }: { data: QueueSnapshot }) {
  return (
    <section className="card table-card">
      <div className="table-scroll">
        <table className="table numeric-table">
          <thead>
            <tr>
              <th>Stream</th>
              <th>Waiting</th>
              <th>In flight</th>
              <th>Retained</th>
            </tr>
          </thead>
          <tbody>
            {WORK_STREAMS.map((stream) => (
              <tr key={stream}>
                <td>
                  {STREAM_LABELS[stream]} <span className="mono muted">{stream}</span>
                </td>
                <td>{formatCount(data.lag.get(stream) ?? null)}</td>
                <td>{formatCount(data.pending.get(stream) ?? null)}</td>
                <td>{formatCount(data.length.get(stream) ?? null)}</td>
              </tr>
            ))}
            {/* The DLQ stream has a consumer group but no reader, so its lag is
                every failure ever written, not work outstanding. It is shown
                for retention only and kept out of the totals above. */}
            <tr>
              <td>
                {STREAM_LABELS[DLQ_STREAM]} <span className="mono muted">{DLQ_STREAM}</span>
              </td>
              <td className="muted">Not read</td>
              <td className="muted">Not read</td>
              <td>{formatCount(data.length.get(DLQ_STREAM) ?? null)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted table-note">
        Retained counts every entry still held in the stream, delivered or not, so it shows whether
        trimming keeps up rather than how much work is left.
      </p>
    </section>
  );
}
