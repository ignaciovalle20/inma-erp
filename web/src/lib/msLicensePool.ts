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
 * Only pools typed by hand follow that month rule: a pool split from its
 * invoice (20261109010000) covers that invoice only, so it never warns about
 * another document.
 */
export type MsLicensePool = {
  id: string;
  /** First day of the month ("YYYY-MM-01"). */
  period: string;
  supplierId: string | null;
  supplierName: string | null;
  /**
   * The invoice the pool splits (20261109010000). Such a pool covers that
   * invoice only, never another document of its month.
   */
  costDocumentId?: string | null;
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
 * A document of the MS licenses supplier (Intcomex in Chile, TGM in Uruguay;
 * ms_license_invoices in SQL, migration 20261109010000), from 2026-01. The
 * split is per invoice: only the one marked as the licenses invoice is split
 * among the MS clients of its month; the supplier's other invoices (hardware,
 * other general costs) stay as any cost.
 */
export type MsLicenseInvoice = {
  documentId: string;
  /** "YYYY-MM-01": the month it is recognised in. */
  period: string;
  currency: string;
  supplierId: string;
  supplierName: string;
  documentType: string;
  documentNumber: string | null;
  /** "YYYY-MM-DD" */
  documentDate: string;
  netAmount: number;
  /** Assigned to a job, split (cost_allocations) or allocated to services. */
  assigned: boolean;
  /** Its split, when it is a licenses invoice. */
  poolId: string | null;
  poolTotal: number | null;
  poolAllocated: boolean;
  /** A pool typed by hand for its month (covers the month's supplier invoices). */
  legacyPoolId: string | null;
  /** Net of the supplier's last licenses invoice before its month: the expected cost. */
  referenceNet: number | null;
  /** The suggested licenses invoice of a supplier-month that has none yet. */
  suggested: boolean;
};

/** The suggested licenses invoices, oldest month first: one per supplier and month at most. */
export function suggestedInvoices(invoices: MsLicenseInvoice[]): MsLicenseInvoice[] {
  return invoices
    .filter((invoice) => invoice.suggested)
    .sort((a, b) => a.period.localeCompare(b.period) || a.supplierName.localeCompare(b.supplierName));
}

/**
 * Licenses invoices whose split no longer matches their net (the invoice was
 * corrected after splitting): more than one unit of the currency apart.
 * "Volver a repartir" takes the invoice's current net.
 */
export function invoicesWithPoolDifference(invoices: MsLicenseInvoice[]): MsLicenseInvoice[] {
  return invoices.filter((invoice) => {
    if (invoice.poolId === null || invoice.poolTotal === null) return false;
    // In whole units of the currency: in floating point 85.38 - 85.37 is 0.00999…
    const factor = invoice.currency === "CLP" ? 1 : 100;
    return Math.abs(invoice.poolTotal - invoice.netAmount) * factor >= 1 - 1e-6;
  });
}

/**
 * The licenses invoices already split for the same supplier and month as
 * `invoice` (itself excluded): marking another one needs a confirmation (a
 * re-billing, for example), never a silent sum.
 */
export function otherLicenseInvoicesOfMonth(
  invoices: MsLicenseInvoice[],
  invoice: Pick<MsLicenseInvoice, "documentId" | "supplierId" | "period">,
): MsLicenseInvoice[] {
  return invoices.filter(
    (other) =>
      other.poolId !== null &&
      other.documentId !== invoice.documentId &&
      other.supplierId === invoice.supplierId &&
      other.period === invoice.period,
  );
}

/** Why an invoice cannot be split as the licenses invoice, or null when it can. */
export function licenseInvoiceBlocker(invoice: MsLicenseInvoice): string | null {
  if (invoice.poolId) return "Esta factura ya tiene su reparto de licencias.";
  if (invoice.assigned) {
    return "Esta factura está asignada a un trabajo, dividida o asignada a servicios: quitá esa asignación antes de repartirla como licencias.";
  }
  if (invoice.netAmount <= 0) return "Su neto no es positivo (una nota de crédito resta): no hay costo que repartir.";
  if (invoice.legacyPoolId) return "Ese mes ya tiene un reparto cargado a mano, sin factura: deshacelo antes de repartir esta factura.";
  return null;
}

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
        !pool.costDocumentId &&
        pool.period === period &&
        (inLicensesArea || (pool.supplierId !== null && pool.supplierId === document.supplierId)),
    ) ?? null
  );
}
