/**
 * Percentages over sales, the same rule on every screen (audit 2026-11, M-07).
 *
 * A margin percentage only means something over a positive base. Over zero it
 * is a division by zero, and over a negative base (a month or a job whose
 * credit notes exceed its invoices) the sign flips: revenue -100 with costs 50
 * is a margin of -150, and -150 / -100 read "+150 %" -- a loss shown as a
 * healthy margin. Both cases give null, which the screens show as "—".
 */
export function percentOfSales(value: number, sales: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(sales) || sales <= 0) return null;
  return (value / sales) * 100;
}

/** Margin over revenue, in percent; null when revenue is not positive (see percentOfSales). */
export function marginPercent(margin: number, revenue: number): number | null {
  return percentOfSales(margin, revenue);
}
