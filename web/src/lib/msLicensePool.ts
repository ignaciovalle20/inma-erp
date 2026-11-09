/**
 * The Microsoft licenses invoice is loaded once, as the month's MS licenses
 * pool (Costos -> Reparto licencias MS). A cost document that is that same
 * invoice is "cubierto por pool" and no report adds it
 * (docs/verificacion-contable-2026-10-04.md, P08 -> point 5).
 *
 * Mirror of the database's covered_by_cost_pool_id(cost_documents)
 * (migration 20261004050000), used by the cost form to warn before saving:
 * a pool of the document's month, and
 *   - the pool's supplier is the document's, or the document is attributed
 *     to the MS licenses area;
 *   - and the document is not attributed to any job or area outside the MS
 *     licenses area (that supplier may bill other things too, and dropping
 *     a real cost would overstate the result).
 */
export type MsLicensePool = {
  id: string;
  /** First day of the month ("YYYY-MM-01"). */
  period: string;
  supplierId: string | null;
  supplierName: string | null;
};

/**
 * The areas a document lands in, from its imputation: each job counts as its
 * area, each area target as itself; a client target has no area. A job whose
 * area is not known counts as an area outside the licenses area, so it never
 * produces a warning the database would not confirm.
 */
export function attributedAreaIds(
  imputation: { projectIds: string[]; areaIds: string[] },
  projectAreaById: Record<string, string>,
): string[] {
  return [
    ...imputation.projectIds.map((projectId) => projectAreaById[projectId] ?? `unknown-job:${projectId}`),
    ...imputation.areaIds,
  ];
}

/**
 * A month of the MS licenses supplier's invoices (Intcomex in Chile, TGM in
 * Uruguay; ms_license_pool_months in SQL): the net a pool of that month would
 * cover and the pool it already has, if any (fix-math 2026-11, point 2).
 */
export type MsLicensePoolMonth = {
  /** "YYYY-MM-01" */
  period: string;
  currency: string;
  supplierId: string;
  supplierName: string;
  documentCount: number;
  netTotal: number;
  poolId: string | null;
  poolTotal: number | null;
  poolAllocated: boolean;
};

/** One line of the split the screen proposes before it is saved. */
export type PoolShareProposal = {
  occurrenceId: string;
  serviceName: string;
  clientName: string | null;
  /** What weighs it: what was billed that month, else the expected amount. */
  weight: number;
  basis: "billed" | "expected";
  share: number;
};

/** The months of supplier invoices that have no pool yet: the ones to split, oldest first. */
export function monthsToSplit(months: MsLicensePoolMonth[]): MsLicensePoolMonth[] {
  return months.filter((month) => month.poolId === null && month.netTotal > 0).sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Months whose pool no longer matches the supplier's invoices (an invoice or
 * a credit note loaded after the split, a pool typed by hand): more than one
 * unit of the currency apart.
 */
export function monthsWithPoolDifference(months: MsLicensePoolMonth[]): MsLicensePoolMonth[] {
  return months.filter((month) => {
    if (month.poolId === null || month.poolTotal === null) return false;
    // In whole units of the currency: in floating point 85.38 - 85.37 is 0.00999…
    const factor = month.currency === "CLP" ? 1 : 100;
    return Math.abs(month.poolTotal - month.netTotal) * factor >= 1 - 1e-6;
  });
}

/** A cycle of the pool's month, type and currency: who should carry part of the invoice. */
export type PoolCohortCycle = {
  occurrenceId: string;
  status: string;
  serviceName: string;
  clientName: string | null;
  /** Expected amount of the cycle (what weighs it while nothing is billed). */
  amount: number;
};

/**
 * What a split pool no longer covers (audit 2026-11, M-01): the split is a
 * snapshot of the cycles that existed when it was made, so a cycle created
 * later carries no part of the supplier's invoice (its client looks free of
 * cost) and a share on a cycle voided afterwards is never recognised.
 * Either one means the pool should be split again.
 */
export function poolCoverageGaps(
  cohort: PoolCohortCycle[],
  allocatedOccurrenceIds: ReadonlySet<string>,
): { missing: PoolCohortCycle[]; onVoid: PoolCohortCycle[] } {
  return {
    missing: cohort.filter((cycle) => cycle.status !== "void" && !allocatedOccurrenceIds.has(cycle.occurrenceId)),
    onVoid: cohort.filter((cycle) => cycle.status === "void" && allocatedOccurrenceIds.has(cycle.occurrenceId)),
  };
}

export function findCoveringPool(
  document: {
    /** "YYYY-MM-DD" (the effective date of the document). */
    date: string;
    supplierId: string | null;
    /** Areas the document is attributed to (its job's area). */
    areaIds: string[];
  },
  pools: MsLicensePool[],
  msLicenseAreaIds: string[],
): MsLicensePool | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(document.date)) return null;
  const period = `${document.date.slice(0, 7)}-01`;
  const msAreas = new Set(msLicenseAreaIds);

  if (document.areaIds.some((areaId) => !msAreas.has(areaId))) return null;
  const inLicensesArea = document.areaIds.length > 0;

  return (
    pools.find(
      (pool) =>
        pool.period === period &&
        (inLicensesArea || (pool.supplierId !== null && pool.supplierId === document.supplierId)),
    ) ?? null
  );
}
