import { api } from "../api/client";
import StatTile from "../components/StatTile";
import ThroughputChart from "../components/ThroughputChart";
import ThroughputTiles from "../components/ThroughputTiles";
import { usePolling } from "../hooks/usePolling";
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

type QueueSnapshot = Awaited<ReturnType<typeof fetchQueue>>;

function total(values: Map<string, number>, streams: string[]): number | null {
  const present = streams.filter((stream) => values.has(stream));
  if (present.length === 0) {
    return null;
  }
  return present.reduce((sum, stream) => sum + (values.get(stream) ?? 0), 0);
}

export default function OverviewPage() {
  const { data, error, loading } = usePolling(fetchQueue, POLL_MS);

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
          Queue right now
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

function StreamSplit({ values }: { values: Map<string, number> }) {
  return (
    <>
      {WORK_STREAMS.map((stream) => `${STREAM_LABELS[stream]} ${formatCount(values.get(stream) ?? null)}`).join(
        " · ",
      )}
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
        Retained counts every entry still held in the stream, delivered or not, so it shows
        whether trimming keeps up rather than how much work is left.
      </p>
    </section>
  );
}
