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

/** Resets every row to an even percentage split across all of them. */
export function splitEvenly<T extends AllocationRow>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const share = 100 / rows.length;
  return rows.map((row) => ({
    ...row,
    method: "percentage",
    value: share.toFixed(2),
  }));
}

/**
 * Tops up one row so the set reaches `total` exactly, leaving every
 * other row untouched.
 */
export function fillRemainder<T extends AllocationRow>(
  rows: T[],
  index: number,
  total: number,
  amountDecimals = 2,
): T[] {
  const target = rows[index];
  if (!target) return rows;

  const othersAssigned = rows.reduce(
    (sum, row, i) => (i === index ? sum : sum + rowShare(row, total)),
    0,
  );
  const remainder = total - othersAssigned;
  const value =
    target.method === "percentage"
      ? total > 0
        ? (remainder / total) * 100
        : 0
      : remainder;

  const decimals = target.method === "percentage" ? 2 : amountDecimals;
  return rows.map((row, i) =>
    i === index ? { ...row, value: value.toFixed(decimals) } : row,
  );
}

/** Fixed-amount rows converted to percentage, same underlying share. */
export function toPercentage<T extends AllocationRow>(rows: T[], total: number): T[] {
  return rows.map((row) => {
    if (row.method === "percentage") return row;
    const amount = Number(row.value);
    const pct = Number.isFinite(amount) && total > 0 ? (amount / total) * 100 : 0;
    return { ...row, method: "percentage", value: pct.toFixed(2) };
  });
}

/** Percentage rows converted to fixed amount, same underlying share. */
export function toFixedAmount<T extends AllocationRow>(rows: T[], total: number, amountDecimals = 2): T[] {
  return rows.map((row) => {
    if (row.method === "fixed_amount") return row;
    const pct = Number(row.value);
    const amount = Number.isFinite(pct) ? (total * pct) / 100 : 0;
    return { ...row, method: "fixed_amount", value: amount.toFixed(amountDecimals) };
  });
}
