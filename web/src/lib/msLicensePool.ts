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
