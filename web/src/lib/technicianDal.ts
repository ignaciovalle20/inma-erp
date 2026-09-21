import "server-only";

import { createClient } from "@/lib/supabase/server";
import { selectAll } from "@/lib/pagination";
import { outstanding, type DocumentStatus } from "@/lib/technicians";

/**
 * Reads of the external technicians (docs/plan-sistema-v3.md, F1). Unlike the
 * older master-list readers in dal.ts, these THROW when a query fails: a
 * saldo built from a failed read would look like "we owe nothing", so the
 * pages catch the error and say it on screen instead.
 */

export type TechnicianCharge = {
  id: string;
  company_id: string;
  project_id: string;
  project_name: string;
  personnel_id: string;
  personnel_name: string;
  cost_document_id: string;
  description: string | null;
  charge_date: string;
  /** What INMA owes the technician for this job. */
  amount: number;
  vat_included: boolean;
  vat_rate: number;
  /** The cost of the job. */
  net_amount: number;
  document_status: DocumentStatus;
  /** Sum of the payments applied to this charge. */
  paid: number;
  /** What is still owed on it. */
  outstanding: number;
};

export type TechnicianPaymentApplication = {
  charge_id: string;
  amount: number;
};

export type TechnicianPayment = {
  id: string;
  personnel_id: string;
  payment_date: string;
  amount: number;
  method: string | null;
  notes: string | null;
  applications: TechnicianPaymentApplication[];
};

function readError(what: string, error: { message: string }): Error {
  console.error(error);
  return new Error(`No se pudieron leer ${what}: ${error.message}`);
}

/** A many-to-one embed comes back as an object (or, in some shapes, a one-item array). */
function embeddedName(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  return typeof (row as { name?: unknown } | null)?.name === "string" ? (row as { name: string }).name : "";
}

type Client = Awaited<ReturnType<typeof createClient>>;

async function readApplications(supabase: Client, companyId: string) {
  const { data, error } = await selectAll(
    supabase
      .from("technician_payment_applications")
      .select("payment_id, charge_id, amount")
      .eq("company_id", companyId),
  );
  if (error) throw readError("los pagos a técnicos", error);
  return data;
}

async function readCharges(
  supabase: Client,
  companyId: string,
  filter: { personnelId?: string; projectId?: string },
  applications: { charge_id: string; amount: number }[],
): Promise<TechnicianCharge[]> {
  let query = supabase
    .from("technician_charges")
    .select(
      "id, company_id, project_id, personnel_id, cost_document_id, description, charge_date, amount, vat_included, vat_rate, net_amount, document_status, projects (name), personnel (name)",
    )
    .eq("company_id", companyId);

  if (filter.personnelId) query = query.eq("personnel_id", filter.personnelId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);

  const { data, error } = await selectAll(query.order("charge_date", { ascending: false }));
  if (error) throw readError("los cargos de técnicos", error);

  const paidByCharge = new Map<string, number>();
  for (const application of applications) {
    paidByCharge.set(application.charge_id, (paidByCharge.get(application.charge_id) ?? 0) + application.amount);
  }

  return data.map((row) => {
    const paid = paidByCharge.get(row.id) ?? 0;
    return {
      id: row.id,
      company_id: row.company_id,
      project_id: row.project_id,
      project_name: embeddedName(row.projects),
      personnel_id: row.personnel_id,
      personnel_name: embeddedName(row.personnel),
      cost_document_id: row.cost_document_id,
      description: row.description,
      charge_date: row.charge_date,
      amount: row.amount,
      vat_included: row.vat_included,
      vat_rate: row.vat_rate,
      net_amount: row.net_amount,
      document_status: row.document_status,
      paid,
      outstanding: outstanding({ amount: row.amount, paid }),
    };
  });
}

/**
 * The charges of a company (optionally of one technician or one job), each
 * with what has been paid on it. Feeds the saldo of the personnel list, the
 * technicians section of a job and the indicators of the board.
 */
export async function getTechnicianCharges(
  companyId: string,
  filter: { personnelId?: string; projectId?: string } = {},
): Promise<TechnicianCharge[]> {
  const supabase = await createClient();
  const applications = await readApplications(supabase, companyId);
  return readCharges(supabase, companyId, filter, applications);
}

/** One technician's cuenta corriente: every charge and every payment, with what each payment covered. */
export async function getTechnicianAccount(
  companyId: string,
  personnelId: string,
): Promise<{ charges: TechnicianCharge[]; payments: TechnicianPayment[] }> {
  const supabase = await createClient();
  const applications = await readApplications(supabase, companyId);
  const charges = await readCharges(supabase, companyId, { personnelId }, applications);

  const { data, error } = await selectAll(
    supabase
      .from("technician_payments")
      .select("id, personnel_id, payment_date, amount, method, notes")
      .eq("company_id", companyId)
      .eq("personnel_id", personnelId)
      .order("payment_date", { ascending: false }),
  );
  if (error) throw readError("los pagos del técnico", error);

  const applicationsByPayment = new Map<string, TechnicianPaymentApplication[]>();
  for (const application of applications) {
    const list = applicationsByPayment.get(application.payment_id) ?? [];
    list.push({ charge_id: application.charge_id, amount: application.amount });
    applicationsByPayment.set(application.payment_id, list);
  }

  return {
    charges,
    payments: data.map((row) => ({
      ...row,
      applications: applicationsByPayment.get(row.id) ?? [],
    })),
  };
}
