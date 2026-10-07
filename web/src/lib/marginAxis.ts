/**
 * Scale of the margin % line of the dashboard chart. A month with tiny
 * sales and a large margin (e.g. 1348%) used to send the line far outside
 * the chart, so the axis follows the data but never goes past
 * [MARGIN_AXIS_FLOOR, MARGIN_AXIS_CEILING]; values beyond it are drawn at
 * the edge and flagged as out of scale. Display only: how the margin is
 * calculated does not change.
 */
export const MARGIN_AXIS_FLOOR = -100;
export const MARGIN_AXIS_CEILING = 200;

export type MarginAxis = { min: number; max: number };

/** Axis range for these margin percentages, rounded to a readable step. Always includes 0. */
export function marginAxis(values: number[]): MarginAxis {
  const finite = values.filter((value) => Number.isFinite(value));
  const low = Math.max(MARGIN_AXIS_FLOOR, Math.min(0, ...finite));
  const high = Math.min(MARGIN_AXIS_CEILING, Math.max(0, ...finite));
  const span = high - low;
  const step = span > 150 ? 50 : span > 60 ? 25 : 10;
  const min = Math.floor(low / step) * step || 0;
  const max = Math.max(Math.ceil(high / step) * step, min + step);
  return { min, max };
}

export type MarginPosition = {
  /** The value clamped into the axis. */
  shown: number;
  /** Where the real value is relative to the axis. */
  outOfScale: "above" | "below" | null;
};

export function marginPosition(value: number, axis: MarginAxis): MarginPosition {
  if (value > axis.max) return { shown: axis.max, outOfScale: "above" };
  if (value < axis.min) return { shown: axis.min, outOfScale: "below" };
  return { shown: value, outOfScale: null };
}
