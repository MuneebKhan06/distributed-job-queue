/**
 * A reader for the Prometheus text exposition format, as served by the API's
 * /metrics.
 *
 * Only what the dashboard needs: sample lines with their labels and values.
 * HELP and TYPE comments are skipped, and so are timestamps, which
 * prometheus_client does not emit. Not a general purpose parser, but it does
 * handle the parts that are easy to get wrong: escaped quotes and backslashes
 * inside label values, and NaN or Inf as a value.
 */

export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;

function parseValue(raw: string): number {
  switch (raw) {
    case "+Inf":
      return Number.POSITIVE_INFINITY;
    case "-Inf":
      return Number.NEGATIVE_INFINITY;
    case "NaN":
      return Number.NaN;
    default:
      return Number(raw);
  }
}

// Walked character by character rather than split on commas, because a label
// value is free text and may itself contain a comma, a quote or an equals sign.
function parseLabels(body: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const eq = body.indexOf("=", i);
    if (eq === -1) {
      break;
    }
    const key = body
      .slice(i, eq)
      .replace(/^[\s,]+/, "")
      .trim();
    let j = eq + 1;
    if (body[j] !== '"') {
      break;
    }
    j += 1;
    let value = "";
    while (j < body.length && body[j] !== '"') {
      if (body[j] === "\\" && j + 1 < body.length) {
        const next = body[j + 1];
        value += next === "n" ? "\n" : next;
        j += 2;
      } else {
        value += body[j];
        j += 1;
      }
    }
    labels[key] = value;
    i = j + 1;
  }
  return labels;
}

export function parsePromText(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = SAMPLE.exec(line);
    if (match) {
      samples.push({
        name: match[1],
        labels: match[2] ? parseLabels(match[2]) : {},
        value: parseValue(match[3]),
      });
    }
  }
  return samples;
}

/** Every sample of one metric, keyed by the value of one label. */
export function byLabel(samples: Sample[], name: string, label: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const sample of samples) {
    if (sample.name === name && label in sample.labels) {
      out.set(sample.labels[label], sample.value);
    }
  }
  return out;
}

/** The value of an unlabelled metric, or null when it is not exposed. */
export function single(samples: Sample[], name: string): number | null {
  const sample = samples.find((item) => item.name === name);
  return sample ? sample.value : null;
}
