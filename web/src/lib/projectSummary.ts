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
/**
 * Total cotizado of a job, the one rule of the detail card and the projects
 * list: the sum of project_quote_billing_summary.quoted_amount over its quotes
 * that have one, or the job's own quoted_amount when none does (also when it
 * has no quote at all). Null when there is no amount anywhere.
 */
export function quotedTotal(
  quotes: { quoted_amount: number | string | null }[],
  projectQuotedAmount: number | null,
): number | null {
  const withAmount = quotes.filter((quote) => quote.quoted_amount !== null && quote.quoted_amount !== undefined);
  if (withAmount.length === 0) return projectQuotedAmount;
  return round2(withAmount.reduce((sum, quote) => sum + Number(quote.quoted_amount), 0));
}

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

/** A cost_allocations row's share of its document's net (set_cost_allocations' own math). */
export function costAllocationShare(row: {
  method: string;
  percentage: number | string | null;
  amount: number | string | null;
  documentNet: number | string | null;
}): number {
  if (row.method === "percentage") {
    return (Number(row.documentNet ?? 0) * Number(row.percentage ?? 0)) / 100;
  }
  return Number(row.amount ?? 0);
}

/**
 * The rows a job's six figures come from, as the database gives them. The
 * job's page, the Rentabilidad report and the assistant's get_project_detail
 * all hand theirs to projectSummaryFromRows, so the three show one number.
 */
export type ProjectSummaryRows = {
  /** The job's currency (projects.currency). */
  currency: string;
  /** projects.quoted_amount. */
  projectQuotedAmount: number | null;
  /** The job's rows of project_quote_billing_summary (placeholder included). */
  quoteBilling: { quoted_amount: number | string | null; billed_amount: number | string }[];
  /** Its direct cost documents and allocation shares, net; null when unreadable. */
  costs: { id: string; currency: string; amount: number }[] | null;
  /** Its technician charges; null when unreadable. */
  technicianCharges:
    | {
        cost_document_id: string;
        net_amount: number | string;
        currency: string;
        document_links: { document: { id: string } }[];
      }[]
    | null;
  /** Every cost document linked to a technician charge of the company; null when unreadable. */
  technicianDocumentIds: ReadonlySet<string> | null;
};

export function projectSummaryFromRows(rows: ProjectSummaryRows): ProjectSummary {
  return computeProjectSummary({
    currency: rows.currency,
    quoted: quotedTotal(rows.quoteBilling, rows.projectQuotedAmount),
    billed: round2(rows.quoteBilling.reduce((sum, quote) => sum + Number(quote.billed_amount), 0)),
    costs:
      rows.costs === null
        ? null
        : rows.costs.map((cost) => ({ costDocumentId: cost.id, currency: cost.currency, amount: cost.amount })),
    // Without the charges or their documents there is no telling which costs
    // are a technician's: Gastos, Técnicos and the margin stay unknown.
    technicianCharges:
      rows.technicianCharges === null || rows.technicianDocumentIds === null
        ? null
        : rows.technicianCharges.map((charge) => ({
            costDocumentId: charge.cost_document_id,
            linkedDocumentIds: charge.document_links.map((link) => link.document.id),
            netAmount: Number(charge.net_amount),
            currency: charge.currency,
          })),
    technicianDocumentIds: rows.technicianDocumentIds,
  });
}

/**
 * Several jobs added up (a client, a business area, a month, the company), in
 * one currency -- the company's. Every job figure converts from the job's
 * currency, and what the job's own cards left out for being in another
 * currency (`excluded`) converts from that one, so here it does count.
 *
 * What has no exchange rate is left out and listed in `unconverted`; a job
 * with an unknown figure (a failed read) is left out of that figure and counted
 * in `unknownJobs`. Neither is ever added as zero without saying so.
 */
export type ProjectSummaryTotals = {
  currency: string;
  jobs: number;
  quoted: number;
  billed: number;
  expenses: number;
  technicians: number;
  margin: number;
  /** Rounded to one decimal; null when nothing positive was billed. */
  marginPct: number | null;
  /** True when some amount was converted from another currency. */
  converted: boolean;
  /** Amounts with no exchange rate: not in the totals above. */
  unconverted: { kind: "cotizado" | "facturado" | "gastos" | "tecnicos"; currency: string; amount: number }[];
  /** Jobs with a figure that could not be read: the totals are short. */
  unknownJobs: number;
};

/** `amount` in `from` on `date` expressed in the totals' currency; null when there is no rate. */
export type SummaryConverter = (amount: number, from: string, date: string) => number | null;

export function totalProjectSummaries(
  items: { summary: ProjectSummary; date: string }[],
  currency: string,
  convert: SummaryConverter,
): ProjectSummaryTotals {
  const sums = { cotizado: 0, facturado: 0, gastos: 0, tecnicos: 0 };
  const unconverted: ProjectSummaryTotals["unconverted"] = [];
  let converted = false;
  let unknownJobs = 0;

  const add = (kind: keyof typeof sums, amount: number, from: string, date: string) => {
    if (amount === 0) return;
    if (!from || from === currency) {
      sums[kind] += amount;
      return;
    }
    const value = convert(amount, from, date);
    if (value === null) {
      const existing = unconverted.find((item) => item.kind === kind && item.currency === from);
      if (existing) existing.amount = round2(existing.amount + amount);
      else unconverted.push({ kind, currency: from, amount: round2(amount) });
      return;
    }
    converted = true;
    sums[kind] += value;
  };

  for (const { summary, date } of items) {
    // No quoted amount is a job without a quote, not a failed read.
    add("cotizado", summary.quoted ?? 0, summary.currency, date);
    if (summary.billed === null || summary.expenses === null || summary.technicians === null) unknownJobs += 1;
    add("facturado", summary.billed ?? 0, summary.currency, date);
    add("gastos", summary.expenses ?? 0, summary.currency, date);
    add("tecnicos", summary.technicians ?? 0, summary.currency, date);
    for (const item of summary.excluded) add(item.kind, item.amount, item.currency, date);
  }

  const billed = round2(sums.facturado);
  const expenses = round2(sums.gastos);
  const technicians = round2(sums.tecnicos);
  const margin = round2(billed - (expenses + technicians));
  const pct = marginPercent(margin, billed);

  return {
    currency,
    jobs: items.length,
    quoted: round2(sums.cotizado),
    billed,
    expenses,
    technicians,
    margin,
    marginPct: pct === null ? null : Math.round(pct * 10) / 10,
    converted,
    unconverted,
    unknownJobs,
  };
}
