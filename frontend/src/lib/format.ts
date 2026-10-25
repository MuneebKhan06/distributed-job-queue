const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

/** 1,284 stays exact, 12,900 becomes 12.9K: tiles have room for four or so digits. */
export function formatCount(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "No data";
  }
  return Math.abs(value) < 10_000 ? whole.format(value) : compact.format(value);
}
