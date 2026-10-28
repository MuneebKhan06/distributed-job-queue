/**
 * A minimal client for the Prometheus HTTP query API.
 *
 * Instant queries for the headline rates and range queries for the chart.
 * Prometheus sends every sample value as a string, NaN included, so values
 * are converted here once rather than at each call site.
 */

import { fetchWithTimeout } from "../lib/fetchWithTimeout";

const BASE_URL = import.meta.env.VITE_PROMETHEUS_BASE_URL ?? "/prom";

export class PrometheusError extends Error {
  constructor(
    message: string,
    // True when Prometheus could not be reached at all, as opposed to it
    // answering and rejecting the query. The overview words the two apart.
    readonly unreachable: boolean,
  ) {
    super(message);
    this.name = "PrometheusError";
  }
}

export interface InstantSample {
  labels: Record<string, string>;
  value: number;
}

export interface RangeSeries {
  labels: Record<string, string>;
  points: { time: number; value: number }[];
}

interface PromResponse<T> {
  status: "success" | "error";
  data?: { resultType: string; result: T };
  error?: string;
}

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${BASE_URL}${path}?${new URLSearchParams(params)}`);
  } catch {
    // A timeout lands here too. A Prometheus that cannot answer in time is
    // as good as unreachable for a screen that refreshes every few seconds.
    throw new PrometheusError("Prometheus is not reachable", true);
  }

  // Prometheus answers every query, good or bad, with a JSON body. Anything
  // else came from in between: the Vite dev proxy, for one, replies 500 with
  // an empty body when nothing listens on the target port, which is the usual
  // case of the compose stack not running. So the body is the test, not the
  // status code.
  let body: PromResponse<T>;
  try {
    body = await response.json();
  } catch {
    throw new PrometheusError("Prometheus is not reachable", true);
  }
  if (body.status !== "success" || !body.data) {
    throw new PrometheusError(body.error ?? `Query failed with ${response.status}`, false);
  }
  return body.data.result;
}

export const prometheus = {
  async query(expr: string): Promise<InstantSample[]> {
    const result = await get<{ metric: Record<string, string>; value: [number, string] }[]>(
      "/api/v1/query",
      { query: expr },
    );
    return result.map((item) => ({ labels: item.metric, value: Number(item.value[1]) }));
  },

  async queryRange(
    expr: string,
    startSeconds: number,
    endSeconds: number,
    stepSeconds: number,
  ): Promise<RangeSeries[]> {
    const result = await get<{ metric: Record<string, string>; values: [number, string][] }[]>(
      "/api/v1/query_range",
      {
        query: expr,
        start: String(startSeconds),
        end: String(endSeconds),
        step: String(stepSeconds),
      },
    );
    return result.map((item) => ({
      labels: item.metric,
      points: item.values.map(([time, value]) => ({ time, value: Number(value) })),
    }));
  },
};
