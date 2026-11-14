import "server-only";

import { createClient } from "@/lib/supabase/server";
import { getSession } from "@/lib/dal";
import { selectAll } from "@/lib/pagination";
import { getRateTable } from "@/lib/exchangeRates";
import { convertOn } from "@/lib/multiCurrency";
import { getQuoteBilling, type QuoteBilling } from "@/lib/salesAllocations";
import { getLinkedDocumentIds, getTechnicianCharges, type TechnicianCharge } from "@/lib/technicianDal";
import {
  costAllocationShare,
  projectSummaryFromRows,
  totalProjectSummaries,
  type ProjectSummary,
  type ProjectSummaryTotals,
} from "@/lib/projectSummary";

/**
 * The six figures of every job (or of one), computed by the very function of
 * the job's own page (lib/projectSummary projectSummaryFromRows): life to
 * date, net of IVA, in the job's currency. The Rentabilidad report and the
 * assistant's get_project_detail read them here, so a job shows the same
 * number in the three places.
 *
 * Each table is read once for the whole company and bucketed by job in memory.
 * A failed read of costs or technician charges leaves those figures unknown
 * (null, shown "—") for every job and is listed in `errors`; it never comes
 * out as a lower total.
 */
export type ProjectProfitabilityRow = {
  id: string;
  name: string;
  status: string;
  clientId: string | null;
  clientName: string | null;
  areaId: string | null;
  areaName: string | null;
  /**
   * The job's date, "YYYY-MM-DD": its start date or, without one, the day it
   * was created. Its month groups the job in "por mes" and picks the exchange
   * rate when its figures are added to a total in the company's currency.
   */
  date: string;
  summary: ProjectSummary;
};

function embeddedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const name = (row as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

async function settle<T>(read: Promise<T>, what: string, errors: string[]): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    console.error(error);
    errors.push(what);
    return null;
  }
}

export async function getProjectSummaries(
  companyId: string,
  projectId?: string,
): Promise<{ rows: ProjectProfitabilityRow[]; errors: string[] }> {
  const user = await getSession();
  if (!user) return { rows: [], errors: [] };

  const supabase = await createClient();
  const errors: string[] = [];

  const readProjects = async () => {
    let query = supabase
      .from("projects")
      .select(
        "id, name, status, client_id, business_area_id, start_date, created_at, currency, quoted_amount, clients (name), business_areas (name)",
      )
      .eq("company_id", companyId);
    if (projectId) query = query.eq("id", projectId);
    const { data, error } = await selectAll(query.order("name"));
    if (error) throw new Error(`No se pudieron leer los trabajos: ${error.message}`);
    return data;
  };

  const readDirectCosts = async () => {
    let query = supabase
      .from("cost_documents")
      .select("id, project_id, currency, net_amount")
      .eq("company_id", companyId)
      .eq("classification", "direct");
    query = projectId ? query.eq("project_id", projectId) : query.not("project_id", "is", null);
    const { data, error } = await selectAll(query);
    if (error) throw new Error(`No se pudieron leer los costos: ${error.message}`);
    return data;
  };

  const readAllocatedCosts = async () => {
    let query = supabase
      .from("cost_allocations")
      .select("method, percentage, amount, project_id, cost_documents!inner(id, company_id, currency, net_amount)")
      .eq("cost_documents.company_id", companyId);
    query = projectId ? query.eq("project_id", projectId) : query.not("project_id", "is", null);
    const { data, error } = await selectAll(query);
    if (error) throw new Error(`No se pudieron leer los repartos de costos: ${error.message}`);
    return data;
  };

  const [projects, quoteBilling, costs, charges, technicianDocumentIds] = await Promise.all([
    settle(readProjects(), "los trabajos", errors),
    getQuoteBilling(companyId, projectId ?? null),
    settle(Promise.all([readDirectCosts(), readAllocatedCosts()]), "los gastos de los trabajos", errors),
    settle(getTechnicianCharges(companyId, projectId ? { projectId } : {}), "los cargos de técnicos", errors),
    settle(getLinkedDocumentIds(companyId), "los documentos vinculados a cargos de técnicos", errors),
  ]);

  const billingByProject = new Map<string, QuoteBilling[]>();
  for (const row of quoteBilling) {
    billingByProject.set(row.project_id, [...(billingByProject.get(row.project_id) ?? []), row]);
  }

  let costsByProject: Map<string, { id: string; currency: string; amount: number }[]> | null = null;
  if (costs) {
    const map = new Map<string, { id: string; currency: string; amount: number }[]>();
    const push = (project: string | null, cost: { id: string; currency: string; amount: number }) => {
      if (!project) return;
      map.set(project, [...(map.get(project) ?? []), cost]);
    };
    const [direct, allocated] = costs;
    for (const row of direct) {
      push(row.project_id, { id: row.id, currency: row.currency, amount: Number(row.net_amount ?? 0) });
    }
    for (const row of allocated) {
      const document = Array.isArray(row.cost_documents) ? row.cost_documents[0] : row.cost_documents;
      push(row.project_id, {
        id: document?.id ?? "",
        currency: document?.currency ?? "",
        amount: costAllocationShare({
          method: row.method,
          percentage: row.percentage,
          amount: row.amount,
          documentNet: document?.net_amount ?? 0,
        }),
      });
    }
    costsByProject = map;
  }

  let chargesByProject: Map<string, TechnicianCharge[]> | null = null;
  if (charges) {
    chargesByProject = new Map();
    for (const charge of charges) {
      chargesByProject.set(charge.project_id, [...(chargesByProject.get(charge.project_id) ?? []), charge]);
    }
  }

  const rows = (projects ?? []).map((project): ProjectProfitabilityRow => ({
    id: project.id,
    name: project.name,
    status: project.status,
    clientId: project.client_id,
    clientName: embeddedName(project.clients),
    areaId: project.business_area_id,
    areaName: embeddedName(project.business_areas),
    date: project.start_date ?? String(project.created_at).slice(0, 10),
    summary: projectSummaryFromRows({
      currency: project.currency,
      projectQuotedAmount: project.quoted_amount === null ? null : Number(project.quoted_amount),
      quoteBilling: billingByProject.get(project.id) ?? [],
      costs: costsByProject ? (costsByProject.get(project.id) ?? []) : null,
      technicianCharges: chargesByProject ? (chargesByProject.get(project.id) ?? []) : null,
      technicianDocumentIds,
    }),
  }));

  return { rows, errors };
}

/** One job's six figures; null when the job does not exist (or is not the caller's to see). */
export async function getProjectSummary(companyId: string, projectId: string): Promise<ProjectSummary | null> {
  const { rows } = await getProjectSummaries(companyId, projectId);
  return rows[0]?.summary ?? null;
}

export type ProfitabilityGroup = { id: string; name: string; totals: ProjectSummaryTotals };

export type ProfitabilityReport = {
  /** The company's currency: every total below is in it. */
  currency: string;
  /** Each job in its own currency, exactly as its page shows it. */
  projects: ProjectProfitabilityRow[];
  clients: ProfitabilityGroup[];
  areas: ProfitabilityGroup[];
  /** Newest first; id and name are "YYYY-MM". */
  months: ProfitabilityGroup[];
  company: ProjectSummaryTotals;
  errors: string[];
};

/**
 * The Rentabilidad report: every job, and the jobs added up by client, by
 * business area, by month (the job's date) and for the whole company. The
 * totals are in the company's currency: a job in another currency -- and the
 * amounts its own cards leave out for being in another one -- convert with
 * the exchange_rate_snapshots rate of the job's month (or the nearest earlier
 * one). What has no rate is left out and listed, never added 1:1.
 */
export async function getProfitabilityReport(companyId: string, currency: string): Promise<ProfitabilityReport> {
  const [{ rows, errors }, table] = await Promise.all([getProjectSummaries(companyId), getRateTable()]);
  const convert = (amount: number, from: string, date: string) => convertOn(table, amount, from, currency, date);
  const total = (list: ProjectProfitabilityRow[]) => totalProjectSummaries(list, currency, convert);

  const groupBy = (
    keyOf: (row: ProjectProfitabilityRow) => { id: string; name: string } | null,
  ): ProfitabilityGroup[] => {
    const groups = new Map<string, { name: string; rows: ProjectProfitabilityRow[] }>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) continue;
      const group = groups.get(key.id) ?? { name: key.name, rows: [] };
      group.rows.push(row);
      groups.set(key.id, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, name: group.name, totals: total(group.rows) }));
  };

  const byName = (a: ProfitabilityGroup, b: ProfitabilityGroup) => a.name.localeCompare(b.name, "es");

  return {
    currency,
    projects: rows,
    clients: groupBy((row) => (row.clientId ? { id: row.clientId, name: row.clientName ?? "—" } : { id: "", name: "Sin cliente" })).sort(byName),
    areas: groupBy((row) => (row.areaId ? { id: row.areaId, name: row.areaName ?? "—" } : { id: "", name: "Sin área" })).sort(byName),
    months: groupBy((row) => ({ id: row.date.slice(0, 7), name: row.date.slice(0, 7) })).sort((a, b) => b.id.localeCompare(a.id)),
    company: total(rows),
    errors,
  };
}
