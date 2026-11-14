"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { validateProjectRefs, findSimilarClients, getCompanyForEdit, type ProjectStatus } from "@/lib/dal";
import { PROJECT_STATUSES } from "@/lib/projectStatus";
import { companyConfig } from "@/lib/companyConfig";
import {
  projectCurrencyDbErrorMessage,
  projectCurrencyNotAllowedMessage,
  resolveProjectCurrency,
} from "@/lib/projectCurrency";

export type CreateProjectState = {
  error: string | null;
  values: {
    name: string;
    client_id: string;
    business_area_id: string;
    status: ProjectStatus;
    quote_number: string;
    start_date: string;
    end_date: string;
    /** The quote: net sale amount (projects.quoted_amount). */
    quoted_amount: string;
    /** The cost budget (projects.cost_budget). */
    cost_budget: string;
    responsible: string;
    invoiceable: boolean;
    /** projects.currency: the quote and the cost budget are in it. */
    currency: string;
  };
};

/**
 * An optional non-negative amount from the form: null when empty, an error
 * message when it is not a number or is negative.
 */
function optionalAmount(value: FormDataEntryValue | null, label: string): { value: number | null; error: string | null } {
  if (typeof value !== "string" || !value.trim()) return { value: null, error: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { value: null, error: `${label} debe ser un número.` };
  if (parsed < 0) return { value: null, error: `${label} debe ser positivo.` };
  return { value: parsed, error: null };
}

/** "El N° de cotización 1759 ya está en uso en el trabajo “Revisión cámaras”." */
async function quoteNumberInUseMessage(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  quoteNumber: string,
): Promise<string> {
  const generic = `El N° de cotización ${quoteNumber} ya está en uso en otro trabajo. Usá otro número o agregá la cotización a ese trabajo.`;
  const { data, error } = await supabase
    .from("project_quotes")
    .select("projects (name)")
    .eq("company_id", companyId)
    .eq("quote_number", quoteNumber)
    .maybeSingle();
  if (error || !data) return generic;
  const project = Array.isArray(data.projects) ? data.projects[0] : data.projects;
  const jobName = (project as { name?: string } | null)?.name;
  return jobName
    ? `El N° de cotización ${quoteNumber} ya está en uso en el trabajo “${jobName}”. Usá otro número o agregá la cotización a ese trabajo.`
    : generic;
}

export async function createProject(
  companyId: string,
  _prevState: CreateProjectState,
  formData: FormData,
): Promise<CreateProjectState> {
  const name = formData.get("name");
  const clientId = formData.get("client_id");
  const businessAreaId = formData.get("business_area_id");
  const status = formData.get("status");
  const quoteNumber = formData.get("quote_number");
  const startDate = formData.get("start_date");
  const endDate = formData.get("end_date");
  const quotedAmount = formData.get("quoted_amount");
  const costBudget = formData.get("cost_budget");
  const responsible = formData.get("responsible");
  const invoiceable = formData.get("invoiceable") === "on";
  const submittedCurrency = formData.get("currency");

  const values = {
    currency: typeof submittedCurrency === "string" ? submittedCurrency : "",
    name: typeof name === "string" ? name : "",
    client_id: typeof clientId === "string" ? clientId : "",
    business_area_id:
      typeof businessAreaId === "string" ? businessAreaId : "",
    status: (typeof status === "string" && PROJECT_STATUSES.includes(status as ProjectStatus)
      ? status
      : "en_ejecucion") as ProjectStatus,
    quote_number: typeof quoteNumber === "string" ? quoteNumber : "",
    start_date: typeof startDate === "string" ? startDate : "",
    end_date: typeof endDate === "string" ? endDate : "",
    quoted_amount: typeof quotedAmount === "string" ? quotedAmount : "",
    cost_budget: typeof costBudget === "string" ? costBudget : "",
    responsible: typeof responsible === "string" ? responsible : "",
    invoiceable,
  };

  if (typeof name !== "string" || !name.trim()) {
    return { error: "La descripción del trabajo es obligatoria.", values };
  }

  if (typeof clientId !== "string" || !clientId) {
    return { error: "Elegí un cliente.", values };
  }

  if (typeof businessAreaId !== "string" || !businessAreaId) {
    return { error: "Elegí un área de negocio.", values };
  }

  if (typeof status !== "string" || !PROJECT_STATUSES.includes(status as ProjectStatus)) {
    return { error: "Estado inválido.", values };
  }

  const trimmedQuoteNumber =
    typeof quoteNumber === "string" && quoteNumber.trim() ? quoteNumber.trim() : "";

  if (status !== "por_cotizar" && !trimmedQuoteNumber) {
    return {
      error: "El N° de cotización es obligatorio salvo en estado \"Por cotizar\".",
      values,
    };
  }

  // Server-side cross-company validation, same reasoning/pattern as the
  // original createProject: never trust that the UI only offered valid
  // client_id/business_area_id options.
  const refsResult = await validateProjectRefs(companyId, clientId, businessAreaId);

  if (refsResult.error === "lookup_failed") {
    console.error(refsResult.detail);
    return { error: "Algo salió mal. Probá de nuevo.", values };
  }

  if (refsResult.error === "client") {
    return { error: "El cliente elegido no pertenece a esta empresa.", values };
  }

  if (refsResult.error === "business_area") {
    return { error: "El área elegida no pertenece a esta empresa.", values };
  }

  if (
    typeof startDate === "string" &&
    startDate.trim() &&
    typeof endDate === "string" &&
    endDate.trim() &&
    endDate.trim() < startDate.trim()
  ) {
    return { error: "La fecha de fin debe ser posterior o igual a la de inicio.", values };
  }

  const quoted = optionalAmount(quotedAmount, "El monto cotizado");
  if (quoted.error) return { error: quoted.error, values };
  const costBudgetAmount = optionalAmount(costBudget, "El presupuesto de costo");
  if (costBudgetAmount.error) return { error: costBudgetAmount.error, values };

  // The job's currency follows the company's configuration
  // (lib/projectCurrency.ts): fixed when it has one, chosen when it has two.
  const membership = await getCompanyForEdit(companyId);
  if (!membership) {
    return { error: "No tenés acceso a esta empresa.", values };
  }
  const config = companyConfig(membership.company);
  const currency = resolveProjectCurrency(config, submittedCurrency);
  if (!currency) {
    return { error: projectCurrencyNotAllowedMessage(config), values };
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("create_project_with_quote", {
    p_company_id: companyId,
    p_client_id: clientId,
    p_business_area_id: businessAreaId,
    p_name: name.trim(),
    p_status: status,
    p_quote_number: trimmedQuoteNumber || null,
    p_start_date:
      typeof startDate === "string" && startDate.trim() ? startDate.trim() : null,
    p_end_date: typeof endDate === "string" && endDate.trim() ? endDate.trim() : null,
    p_quoted_amount: quoted.value,
    p_cost_budget: costBudgetAmount.value,
    p_responsible:
      typeof responsible === "string" && responsible.trim() ? responsible.trim() : null,
    p_invoiceable: invoiceable,
    p_currency: currency,
  });

  if (error) {
    console.error(error);
    // unique(company_id, quote_number): the quote number is already another
    // job's. Say which one instead of "Algo salió mal" (the add-quote form of
    // a job says it too).
    if (error.code === "23505" && error.message?.includes("project_quotes_company_number_unique")) {
      return { error: await quoteNumberInUseMessage(supabase, companyId, trimmedQuoteNumber), values };
    }
    return {
      error: projectCurrencyDbErrorMessage(error, config) ?? "Algo salió mal. Probá de nuevo.",
      values,
    };
  }

  redirect(`/companies/${companyId}/projects/board`);
}

export type CreateClientQuickResult =
  | {
      status: "created";
      client: { id: string; name: string; invoiceable: boolean; monthly: boolean };
    }
  | { status: "warning"; matches: string[] }
  | { status: "error"; error: string };

/**
 * Inline "alta rápida" of a client from the job creation form -- reuses
 * the same near-duplicate-name warning as clients/new (findSimilarClients),
 * condensed into a single round trip: call once unconfirmed, and if a
 * warning comes back, call again with confirmed=true to save anyway.
 * Invoked directly from a client component (not bound to a <form
 * action>), so it returns a result instead of redirecting.
 */
export async function createClientQuick(
  companyId: string,
  name: string,
  taxId: string,
  confirmed: boolean,
): Promise<CreateClientQuickResult> {
  const trimmedName = name.trim();

  if (!trimmedName) {
    return { status: "error", error: "El nombre es obligatorio." };
  }

  if (!confirmed) {
    const similar = await findSimilarClients(companyId, trimmedName);

    if (similar.length > 0) {
      return { status: "warning", matches: similar.map((client) => client.name) };
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      company_id: companyId,
      name: trimmedName,
      tax_id: taxId.trim() ? taxId.trim() : null,
    })
    .select("id, name, invoiceable, monthly")
    .single();

  if (error || !data) {
    console.error(error);
    return { status: "error", error: "Algo salió mal. Probá de nuevo." };
  }

  revalidatePath(`/companies/${companyId}/projects/new`);

  return { status: "created", client: data };
}
