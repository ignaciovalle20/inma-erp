import { marginPercent } from "@/lib/margins";

/**
 * The six number cards of a job's detail ("Resumen del proyecto"), all net of
 * IVA and in the job's own currency. Nothing is converted here: an amount in
 * another currency is left out of the totals and reported in `excluded`, so
 * the screen can say so instead of adding pesos to dollars.
 *
 *   Total cotizado  = the job's quotes (project_quote_billing_summary.quoted_amount,
 *                     the job's quoted_amount when no quote has one).
 *   Total facturado = the confirmed sales allocations of its quotes, net
 *                     (project_quote_billing_summary.billed_amount).
 *   Total gastos    = its cost documents and allocation shares, net, without
 *                     anything that belongs to a technician (see below).
 *   Total técnicos  = Σ technician_charges.net_amount: factura → neto, boleta →
 *                     bruto (líquido + retención), sin respaldo → the amount.
 *   Margen          = facturado − (gastos + técnicos).
 *   Margen %        = margen / facturado × 100; null (shown "—") when nothing
 *                     positive was billed (lib/margins).
 *
 * No double count: each technician charge keeps its own direct cost document
 * on the job, and its factura / boleta may also be assigned to a job. Both are
 * taken out of Gastos -- the charge counts once, in Técnicos.
 *
 * Null means "unknown" (a read failed), never zero: the screen shows "—".
 */
export type ProjectSummaryCost = {
  /** cost_documents.id of the document the row comes from. */
  costDocumentId: string;
  currency: string;
  /** Net amount of the document on this job (its whole net, or its share). */
  amount: number;
};

export type ProjectSummaryTechnicianCharge = {
  /** The charge's own direct cost document. */
  costDocumentId: string;
  /** Facturas / boletas applied to the charge. */
  linkedDocumentIds: string[];
  /** The cost of the charge: neto (factura), bruto (boleta) or the amount. */
  netAmount: number;
  /** technician_charges.currency. */
  currency: string;
};

export type ProjectSummaryInput = {
  /** The job's currency (projects.currency). */
  currency: string;
  /** Already in the job's currency; null when the job has no quoted amount. */
  quoted: number | null;
  /** Already in the job's currency; null when it could not be read. */
  billed: number | null;
  /** Null when the costs could not be read. */
  costs: ProjectSummaryCost[] | null;
  /** Null when the technician charges could not be read. */
  technicianCharges: ProjectSummaryTechnicianCharge[] | null;
  /**
   * Every cost document linked to any technician charge of the company
   * (technician_charge_documents). Null when unknown; the job's own charges'
   * links are always excluded anyway.
   */
  technicianDocumentIds?: ReadonlySet<string> | null;
};

export type ProjectSummaryExclusion = {
  kind: "gastos" | "tecnicos";
  currency: string;
  amount: number;
};

export type ProjectSummary = {
  currency: string;
  quoted: number | null;
  billed: number | null;
  expenses: number | null;
  technicians: number | null;
  margin: number | null;
  /** Rounded to one decimal. */
  marginPct: number | null;
  /** Amounts in another currency, left out of the totals above. */
  excluded: ProjectSummaryExclusion[];
};

/** Sums without the floating-point tail (0.1 + 0.2), to the cent. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addExclusion(
  list: ProjectSummaryExclusion[],
  kind: ProjectSummaryExclusion["kind"],
  currency: string,
  amount: number,
) {
  const existing = list.find((item) => item.kind === kind && item.currency === currency);
  if (existing) existing.amount = round2(existing.amount + amount);
  else list.push({ kind, currency, amount: round2(amount) });
}

export function computeProjectSummary(input: ProjectSummaryInput): ProjectSummary {
  const { currency } = input;
  const excluded: ProjectSummaryExclusion[] = [];

  let technicians: number | null = null;
  // Without the charges there is no telling which costs are theirs, so
  // Gastos is unknown too.
  let expenses: number | null = null;

  if (input.technicianCharges !== null) {
    const technicianDocs = new Set<string>(input.technicianDocumentIds ?? []);
    let total = 0;
    for (const charge of input.technicianCharges) {
      technicianDocs.add(charge.costDocumentId);
      for (const id of charge.linkedDocumentIds) technicianDocs.add(id);
      if (charge.currency && charge.currency !== currency) {
        addExclusion(excluded, "tecnicos", charge.currency, charge.netAmount);
        continue;
      }
      total += charge.netAmount;
    }
    technicians = round2(total);

    if (input.costs !== null) {
      let costTotal = 0;
      for (const cost of input.costs) {
        if (technicianDocs.has(cost.costDocumentId)) continue;
        if (cost.currency && cost.currency !== currency) {
          addExclusion(excluded, "gastos", cost.currency, cost.amount);
          continue;
        }
        costTotal += cost.amount;
      }
      expenses = round2(costTotal);
    }
  }

  const margin =
    input.billed !== null && expenses !== null && technicians !== null
      ? round2(input.billed - (expenses + technicians))
      : null;
  const pct = margin !== null && input.billed !== null ? marginPercent(margin, input.billed) : null;

  return {
    currency,
    quoted: input.quoted,
    billed: input.billed,
    expenses,
    technicians,
    margin,
    marginPct: pct === null ? null : Math.round(pct * 10) / 10,
    excluded,
  };
}
