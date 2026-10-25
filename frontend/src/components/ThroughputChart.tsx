import { type KeyboardEvent, type PointerEvent, useCallback, useState } from "react";

import { prometheus } from "../api/prometheus";
import { useElementWidth } from "../hooks/useElementWidth";
import { usePolling } from "../hooks/usePolling";

const WINDOW_SECONDS = 30 * 60;
const STEP_SECONDS = 30;
const POLL_MS = 30000;
// A two minute rate over a 30s step: each point averages four scrapes, smooth
// enough to read and still quick to show a stall.
const EXPR = "sum(rate(jobs_completed_total[2m])) * 60";

const HEIGHT = 200;
const PAD = { top: 16, right: 56, bottom: 26, left: 40 };

interface Point {
  time: number;
  value: number;
}

async function fetchSeries(): Promise<Point[]> {
  const end = Math.floor(Date.now() / 1000);
  const series = await prometheus.queryRange(EXPR, end - WINDOW_SECONDS, end, STEP_SECONDS);
  return (series[0]?.points ?? []).filter((point) => Number.isFinite(point.value));
}

/** A round upper bound, so the axis reads 0 / 5 / 10 and not 0 / 4.37 / 8.74. */
function niceMax(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

function formatRate(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

// Axis ticks are round numbers by construction, so they drop the decimal that
// a reading like 4.3 needs.
function formatTick(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatClock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Splits the line wherever samples are missing. Prometheus leaves a gap when
 * it could not scrape, and joining across it would draw a straight line
 * through a period nobody measured.
 */
function segments(points: Point[]): Point[][] {
  const runs: Point[][] = [];
  for (const point of points) {
    const run = runs[runs.length - 1];
    if (run && point.time - run[run.length - 1].time <= STEP_SECONDS * 1.5) {
      run.push(point);
    } else {
      runs.push([point]);
    }
  }
  return runs;
}

export default function ThroughputChart() {
  const fetcher = useCallback(fetchSeries, []);
  const { data: points, error } = usePolling(fetcher, POLL_MS);
  const { ref, width } = useElementWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);

  // ThroughputTiles already explains an unreachable Prometheus. Saying it a
  // second time here would only push the queue table further down.
  if (!points) {
    return error ? null : <p className="muted">Loading throughput</p>;
  }

  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS;
  const max = niceMax(Math.max(0, ...points.map((point) => point.value)));
  const plotWidth = Math.max(width - PAD.left - PAD.right, 10);
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (time: number) => PAD.left + ((time - start) / WINDOW_SECONDS) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - (value / max) * plotHeight;

  const baseline = y(0);
  const runs = segments(points);
  const last = points[points.length - 1];
  const hovered = active !== null ? points[active] : null;

  // Four time labels need about 400px before the first two run together, the
  // first being pinned to the left edge. Narrower plots get three.
  const tickMinutes = plotWidth >= 400 ? [0, 10, 20, 30] : [0, 15, 30];
  const xTicks = tickMinutes.map((minutesAgo) => end - minutesAgo * 60);
  const yTicks = [0, max / 2, max];

  // The crosshair finds the nearest sample to the pointer, so the reader aims
  // at a time, not at a two pixel line.
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0) {
      return;
    }
    // Scaled by the rendered size, in case the viewBox and the box it is
    // drawn in differ for a frame while a resize settles.
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientX - bounds.left) * (width / bounds.width) - PAD.left;
    const time = start + (offset / plotWidth) * WINDOW_SECONDS;
    let nearest = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs(points[i].time - time) < Math.abs(points[nearest].time - time)) {
        nearest = i;
      }
    }
    setActive(nearest);
  };

  // The same readout from the keyboard, one sample per arrow press.
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) {
      return;
    }
    event.preventDefault();
    const from = active ?? points.length - 1;
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive(Math.min(points.length - 1, Math.max(0, from + step)));
  };

  return (
    <section className="card chart-card" aria-labelledby="throughput-title">
      <h2 id="throughput-title" className="card-title">
        Jobs completed per minute, last 30 minutes
      </h2>
      <div ref={ref} className="chart-frame">
        {points.length === 0 ? (
          <p className="muted chart-empty">No completions recorded in the last 30 minutes.</p>
        ) : (
          // Sized by CSS to its container, with the measured width used only
          // for the viewBox. An SVG with a fixed width attribute takes part in
          // layout and can hold its container open wider than the screen.
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            height={HEIGHT}
            role="img"
            aria-label={`Jobs completed per minute. Latest ${formatRate(last.value)}.`}
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
          >
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  className="chart-grid"
                  x1={PAD.left}
                  x2={PAD.left + plotWidth}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  className="chart-tick"
                  x={PAD.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {formatTick(tick)}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <text
                key={tick}
                className="chart-tick"
                x={x(tick)}
                y={HEIGHT - 6}
                textAnchor={tick === end ? "end" : tick === start ? "start" : "middle"}
              >
                {tick === end ? "now" : formatClock(tick)}
              </text>
            ))}
            {runs.map((run) => {
              const line = run.map((point) => `${x(point.time)},${y(point.value)}`).join(" L");
              return (
                <g key={run[0].time}>
                  <path
                    className="chart-area"
                    d={`M${x(run[0].time)},${baseline} L${line} L${x(
                      run[run.length - 1].time,
                    )},${baseline} Z`}
                  />
                  <path className="chart-line" d={`M${line}`} />
                </g>
              );
            })}
            <circle className="chart-dot" cx={x(last.time)} cy={y(last.value)} r={4} />
            <text className="chart-end-label" x={x(last.time) + 10} y={y(last.value)} dy="0.32em">
              {formatRate(last.value)}
            </text>
            {hovered && (
              <g>
                <line
                  className="chart-crosshair"
                  x1={x(hovered.time)}
                  x2={x(hovered.time)}
                  y1={PAD.top}
                  y2={baseline}
                />
                <circle className="chart-dot" cx={x(hovered.time)} cy={y(hovered.value)} r={4} />
              </g>
            )}
          </svg>
        )}
        {hovered && (
          <div
            className="chart-tooltip"
            style={{
              left: Math.min(x(hovered.time) + 12, width - 140),
              top: Math.max(y(hovered.value) - 44, 0),
            }}
          >
            <strong>{formatRate(hovered.value)} per minute</strong>
            <span className="muted">{formatClock(hovered.time)}</span>
          </div>
        )}
      </div>
      {/* Every value the tooltip shows is also here, so nothing on the chart
          is reachable only by hovering. */}
      {points.length > 0 && (
        <details className="chart-table">
          <summary>Show as a table</summary>
          <table className="table numeric-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Per minute</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((point) => (
                <tr key={point.time}>
                  <td>{formatClock(point.time)}</td>
                  <td>{formatRate(point.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
