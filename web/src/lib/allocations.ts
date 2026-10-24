import type { CostAllocationMethod } from "@/lib/dal";

export type AllocationRow = {
  method: CostAllocationMethod;
  value: string;
};

/** A row's share of `total`, in money -- percentage rows are resolved against it. */
export function rowShare(row: AllocationRow, total: number): number {
  const value = Number(row.value);
  if (!Number.isFinite(value)) return 0;
  return row.method === "percentage" ? (total * value) / 100 : value;
}

export function allocationTotals(rows: AllocationRow[], total: number) {
  const assigned = rows.reduce((sum, row) => sum + rowShare(row, total), 0);
  const missing = total - assigned;
  const pct = total > 0 ? assigned / total : 0;
  const matches = Math.abs(missing) <= 0.01;
  return { assigned, missing, pct, matches };
}

// The allocation form works in the currency's minor units (whole pesos for
// CLP, cents otherwise): every amount it saves is a whole number of them.
// A row's `method` is the field the user typed last -- its source of truth --
// and the other field is derived from it on render.

const minorUnits = (decimals: number) => 10 ** decimals;

/** `amount` in minor units, rounded: 2554993 CLP -> 2554993, 12.345 USD -> 1235. */
export function toMinor(amount: number, decimals: number): number {
  return Math.round(amount * minorUnits(decimals));
}

export function fromMinor(minor: number, decimals: number): number {
  return minor / minorUnits(decimals);
}

/**
 * A row's amount in minor units, rounded once from what the user typed: a
 * percentage row is resolved from the typed percentage itself, never from
 * a rounded one. Blank or non-numeric rows count as 0.
 */
export function rowAmountMinor(row: AllocationRow, total: number, decimals: number): number {
  const share = rowShare(row, total);
  return Number.isFinite(share) ? toMinor(share, decimals) : 0;
}

/**
 * Every row's amount in minor units. When percentage rows only miss the
 * total by their own rounding (at most one minor unit per percentage row),
 * the difference goes to the last percentage row so the set adds up
 * exactly -- amount rows are never touched, they are what the user typed.
 */
export function resolveAmounts(rows: AllocationRow[], total: number, decimals: number): number[] {
  const amounts = rows.map((row) => rowAmountMinor(row, total, decimals));
  const lastPercentage = rows.findLastIndex(
    (row) => row.method === "percentage" && row.value.trim() !== "",
  );
  if (lastPercentage === -1) return amounts;

  const percentageRows = rows.filter((row) => row.method === "percentage" && row.value.trim() !== "").length;
  const residue = toMinor(total, decimals) - amounts.reduce((sum, amount) => sum + amount, 0);
  if (residue !== 0 && Math.abs(residue) <= percentageRows) {
    amounts[lastPercentage] += residue;
  }
  return amounts;
}

/** Totals of the form, in minor units: `missing` is negative when the rows go over. */
export function resolvedTotals(rows: AllocationRow[], total: number, decimals: number) {
  const totalMinor = toMinor(total, decimals);
  const assigned = resolveAmounts(rows, total, decimals).reduce((sum, amount) => sum + amount, 0);
  const missing = totalMinor - assigned;
  return { assigned, missing, matches: missing === 0, over: missing < 0 };
}

/** The percentage a row's amount stands for, with 2 decimals ("78.28"). */
export function derivedPercentage(amountMinor: number, total: number, decimals: number): string {
  const totalMinor = toMinor(total, decimals);
  return (totalMinor > 0 ? (amountMinor / totalMinor) * 100 : 0).toFixed(2);
}

/** Splits `total` evenly in whole minor units; the last row takes the residue. */
export function splitEvenly<T extends AllocationRow>(rows: T[], total: number, decimals: number): T[] {
  if (rows.length === 0) return rows;
  const totalMinor = toMinor(total, decimals);
  const base = Math.floor(totalMinor / rows.length);
  return rows.map((row, i) => ({
    ...row,
    method: "fixed_amount",
    value: String(fromMinor(i === rows.length - 1 ? totalMinor - base * (rows.length - 1) : base, decimals)),
  }));
}

/**
 * Puts on one row the exact amount the others leave missing, so the set
 * reaches `total`. Does nothing when the others already cover it or go over.
 */
export function fillRemainder<T extends AllocationRow>(
  rows: T[],
  index: number,
  total: number,
  decimals: number,
): T[] {
  if (!rows[index]) return rows;
  const others = rows.filter((_, i) => i !== index);
  const othersAssigned = resolveAmounts(others, total, decimals).reduce((sum, amount) => sum + amount, 0);
  const remainder = toMinor(total, decimals) - othersAssigned;
  if (remainder <= 0) return rows;
  return rows.map((row, i) =>
    i === index ? { ...row, method: "fixed_amount", value: String(fromMinor(remainder, decimals)) } : row,
  );
}
