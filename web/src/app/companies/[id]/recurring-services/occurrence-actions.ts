"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { periodEnd, todayForCountry } from "@/lib/recurringServicePending";
import { resolveServiceCurrency, serviceCountry } from "@/lib/recurringServiceTypes";

export type MarkOccurrenceResult = { error: string | null };

type OccurrenceRow = {
  status: string;
  invoiced_at: string | null;
};

type Transition = {
  from: string[];
  // The columns to write, computed from the row as it is now (an undo
  // has to know where the cycle came from) and today's local date.
  changes: (row: OccurrenceRow, today: string) => Record<string, string | null>;
};

// The cycle's state machine. "invoiced" already means "pending
// collection"; "pending_collection" is where a cycle starts when its
// service doesn't require an invoice. Void is final -- the cycle keeps
// its (service, period) slot, so it is never regenerated. Facturado and
// Cobrado can each be undone.
const TRANSITIONS = {
  invoice: {
    from: ["pending_invoice"],
    changes: (_row, today) => ({ status: "invoiced", invoiced_at: today }),
  },
  collect: {
    from: ["invoiced", "pending_collection"],
    changes: (_row, today) => ({ status: "collected", collected_at: today }),
  },
  undoInvoice: {
    from: ["invoiced"],
    changes: () => ({ status: "pending_invoice", invoiced_at: null, sales_document_id: null }),
  },
  undoCollect: {
    from: ["collected"],
    // Back to wherever it was collected from: invoiced if it had been
    // invoiced, otherwise the no-invoice "pending collection" start.
    changes: (row) => ({
      status: row.invoiced_at ? "invoiced" : "pending_collection",
      collected_at: null,
    }),
  },
  void: {
    from: ["pending_invoice", "invoiced", "pending_collection"],
    changes: () => ({ status: "void" }),
  },
} satisfies Record<string, Transition>;

const GENERIC_ERROR = "Algo salió mal. Probá de nuevo.";
const STALE_ERROR =
  "Este ciclo ya cambió de estado (quizás alguien lo marcó recién). Actualizá la página.";

type LoadedOccurrence = {
  row: OccurrenceRow & { recurring_service_id: string; sales_document_id: string | null };
  companyCountry: string | null;
  serviceCountry: string | null;
  clientId: string;
};

/**
 * Loads one occurrence and confirms it belongs to companyId --
 * defense-in-depth alongside the RLS UPDATE policy
 * (recurring_service_occurrences has no company_id of its own, see
 * 20260922010000; RLS only checks "some company the caller is a member
 * of", not this specific companyId).
 */
async function loadOccurrence(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  occurrenceId: string,
): Promise<{ data: LoadedOccurrence | null; error: string | null }> {
  const { data, error } = await supabase
    .from("recurring_service_occurrences")
    .select(
      "status, invoiced_at, recurring_service_id, sales_document_id, recurring_services!inner(company_id, client_id, country, companies(country))",
    )
    .eq("id", occurrenceId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return { data: null, error: GENERIC_ERROR };
  }

  type Embedded = {
    company_id: string;
    client_id: string;
    country: string | null;
    companies: { country: string | null } | { country: string | null }[] | null;
  };
  const service = data
    ? ((Array.isArray(data.recurring_services)
        ? data.recurring_services[0]
        : data.recurring_services) as Embedded | undefined)
    : undefined;

  if (!data || service?.company_id !== companyId) {
    return { data: null, error: "No se encontró este ciclo." };
  }

  const company = Array.isArray(service.companies) ? service.companies[0] : service.companies;
  return {
    data: {
      row: {
        status: data.status,
        invoiced_at: data.invoiced_at ?? null,
        recurring_service_id: data.recurring_service_id,
        sales_document_id: data.sales_document_id ?? null,
      },
      companyCountry: company?.country ?? null,
      serviceCountry: service.country ?? null,
      clientId: service.client_id,
    },
    error: null,
  };
}

function revalidateRecurringServices(companyId: string) {
  // Month board, Deuda, the list and every service's history.
  revalidatePath(`/companies/${companyId}/recurring-services`, "layout");
}

/**
 * Moves one occurrence along TRANSITIONS. The UPDATE repeats the status
 * filter, so two people tapping at once can't both apply it.
 */
async function transition(
  companyId: string,
  occurrenceId: string,
  { from, changes }: Transition,
  extra: Record<string, string | null> = {},
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error };
  }

  if (!from.includes(loaded.row.status)) {
    return { error: STALE_ERROR };
  }

  const today = todayForCountry(loaded.companyCountry);
  const { data: updated, error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update({ ...changes(loaded.row, today), ...extra })
    .eq("id", occurrenceId)
    .in("status", from)
    .select("id");

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR };
  }

  if (!updated || updated.length === 0) {
    return { error: STALE_ERROR };
  }

  revalidateRecurringServices(companyId);
  return { error: null };
}

/**
 * Checks that a sales document can be linked to this cycle: same
 * company, an invoice that isn't voided, and not already linked to a
 * different cycle. Returns an error message, or null when it's fine.
 */
async function checkLinkableDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  occurrenceId: string,
  salesDocumentId: string,
): Promise<string | null> {
  const { data: document, error } = await supabase
    .from("sales_documents")
    .select("id, voided, document_type")
    .eq("id", salesDocumentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return GENERIC_ERROR;
  }

  if (!document || document.voided) {
    return "No se encontró esa factura en esta empresa.";
  }

  const { data: linked, error: linkedError } = await supabase
    .from("recurring_service_occurrences")
    .select("id")
    .eq("sales_document_id", salesDocumentId)
    .neq("id", occurrenceId)
    .limit(1);

  if (linkedError) {
    console.error(linkedError);
    return GENERIC_ERROR;
  }

  if (linked && linked.length > 0) {
    return "Esa factura ya está vinculada a otro ciclo.";
  }

  return null;
}

/** Facturado, optionally linking the invoice it was billed with. */
export async function markOccurrenceInvoiced(
  companyId: string,
  occurrenceId: string,
  salesDocumentId?: string | null,
) {
  if (salesDocumentId) {
    const supabase = await createClient();
    const problem = await checkLinkableDocument(supabase, companyId, occurrenceId, salesDocumentId);
    if (problem) return { error: problem };
    return transition(companyId, occurrenceId, TRANSITIONS.invoice, {
      sales_document_id: salesDocumentId,
    });
  }
  return transition(companyId, occurrenceId, TRANSITIONS.invoice);
}

export async function markOccurrenceCollected(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.collect);
}

/** Deshacer "Facturado": back to Facturar (and unlinks the invoice). */
export async function undoOccurrenceInvoiced(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.undoInvoice);
}

/** Deshacer "Cobrado": back to Cobrar. */
export async function undoOccurrenceCollected(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.undoCollect);
}

export async function voidOccurrence(companyId: string, occurrenceId: string) {
  return transition(companyId, occurrenceId, TRANSITIONS.void);
}

/**
 * Links (or, with null, unlinks) the sales document of a cycle that is
 * already invoiced or collected.
 */
export async function linkOccurrenceSalesDocument(
  companyId: string,
  occurrenceId: string,
  salesDocumentId: string | null,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error };
  }

  if (!["invoiced", "collected"].includes(loaded.row.status)) {
    return { error: "Solo se puede vincular una factura a un ciclo facturado." };
  }

  if (salesDocumentId) {
    const problem = await checkLinkableDocument(supabase, companyId, occurrenceId, salesDocumentId);
    if (problem) return { error: problem };
  }

  const { error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update({ sales_document_id: salesDocumentId })
    .eq("id", occurrenceId);

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR };
  }

  revalidateRecurringServices(companyId);
  return { error: null };
}

export type SalesDocumentCandidate = {
  id: string;
  document_number: string | null;
  document_date: string;
  client_name: string | null;
  currency: string;
  net_amount: number;
  total_amount: number;
};

/**
 * Invoices of this company that could be linked to the cycle: not
 * voided, not linked to another cycle, newest first. By default only the
 * cycle's own client; `query` matches the document number, or an amount
 * (net or total) when it's a number.
 */
export async function searchSalesDocumentsForOccurrence(
  companyId: string,
  occurrenceId: string,
  query: string,
  allClients: boolean,
): Promise<{ error: string | null; results: SalesDocumentCandidate[] }> {
  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error, results: [] };
  }

  let search = supabase
    .from("sales_documents")
    .select("id, document_number, document_date, currency, net_amount, total_amount, clients(name)")
    .eq("company_id", companyId)
    .eq("voided", false)
    .in("document_type", ["invoice", "receipt", "manual"])
    .order("document_date", { ascending: false })
    .limit(25);

  if (!allClients) {
    search = search.eq("client_id", loaded.clientId);
  }

  const trimmed = query.trim();
  if (trimmed) {
    const asNumber = Number(trimmed.replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(asNumber) && /^[\d.,]+$/.test(trimmed)) {
      search = search.or(
        `net_amount.eq.${asNumber},total_amount.eq.${asNumber},document_number.ilike.%${trimmed.replace(/[%,()]/g, "")}%`,
      );
    } else {
      search = search.ilike("document_number", `%${trimmed.replace(/[%,()]/g, "")}%`);
    }
  }

  const [{ data, error: searchError }, { data: linkedRows, error: linkedError }] = await Promise.all([
    search,
    supabase
      .from("recurring_service_occurrences")
      .select("sales_document_id, recurring_services!inner(company_id)")
      .eq("recurring_services.company_id", companyId)
      .not("sales_document_id", "is", null)
      .neq("id", occurrenceId),
  ]);

  if (searchError || linkedError) {
    console.error(searchError ?? linkedError);
    return { error: GENERIC_ERROR, results: [] };
  }

  const taken = new Set((linkedRows ?? []).map((row) => row.sales_document_id as string));

  return {
    error: null,
    results: (data ?? [])
      .filter((row) => !taken.has(row.id))
      .map((row) => {
        const { clients, ...rest } = row as typeof row & {
          clients: { name: string } | { name: string }[] | null;
        };
        const client = Array.isArray(clients) ? clients[0] : clients;
        return {
          ...rest,
          net_amount: Number(rest.net_amount),
          total_amount: Number(rest.total_amount),
          client_name: client?.name ?? null,
        };
      }),
  };
}

/**
 * Edits one cycle's own copy of amount / currency / due date / note.
 * Currency follows the service's country (Chile: always CLP; Uruguay:
 * USD or UYU), same rule as the service form and the DB trigger.
 */
export async function updateOccurrenceDetails(
  companyId: string,
  occurrenceId: string,
  values: { amount: string; currency: string; dueDate: string; note: string },
): Promise<MarkOccurrenceResult> {
  const amount = Number(values.amount);
  if (!values.amount.trim() || !Number.isFinite(amount) || amount < 0) {
    return { error: "El monto tiene que ser un número." };
  }

  const dueDate = values.dueDate.trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { error: "La fecha de vencimiento no es válida." };
  }

  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error };
  }

  if (loaded.row.status === "void") {
    return { error: "Un ciclo anulado no se puede editar." };
  }

  const country = serviceCountry(loaded.serviceCountry ?? loaded.companyCountry);
  const currency = resolveServiceCurrency(country, values.currency);
  if (!currency) {
    return {
      error: country === "UY" ? "Elegí USD o UYU." : "Elegí una moneda válida.",
    };
  }

  const { error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update({
      amount,
      currency,
      invoice_due_date: dueDate || null,
      collection_due_date: dueDate || null,
      note: values.note.trim() || null,
    })
    .eq("id", occurrenceId);

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR };
  }

  revalidateRecurringServices(companyId);
  return { error: null };
}

/**
 * "Revisar vínculo": links a flagged cycle to the invoice picked by hand,
 * moving its state the way the automatic matching does (paid in Nubox ->
 * collected, otherwise invoiced; link_recurring_service_occurrence_to_invoice).
 */
export async function resolveOccurrenceLink(
  companyId: string,
  occurrenceId: string,
  salesDocumentId: string,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error };
  }

  if (loaded.row.status === "void") {
    return { error: "Un ciclo anulado no se puede vincular." };
  }

  const problem = await checkLinkableDocument(supabase, companyId, occurrenceId, salesDocumentId);
  if (problem) return { error: problem };

  const { error: linkError } = await supabase.rpc("link_recurring_service_occurrence_to_invoice", {
    p_occurrence_id: occurrenceId,
    p_sales_document_id: salesDocumentId,
  });

  if (linkError) {
    console.error(linkError);
    return { error: GENERIC_ERROR };
  }

  revalidateRecurringServices(companyId);
  return { error: null };
}

/** "Revisar vínculo" -> reviewed, there is no invoice to link (the matching won't flag it again). */
export async function dismissOccurrenceLinkReview(
  companyId: string,
  occurrenceId: string,
): Promise<MarkOccurrenceResult> {
  const supabase = await createClient();
  const { data: loaded, error } = await loadOccurrence(supabase, companyId, occurrenceId);

  if (!loaded) {
    return { error };
  }

  const { error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update({ link_review: "dismissed" })
    .eq("id", occurrenceId);

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR };
  }

  revalidateRecurringServices(companyId);
  return { error: null };
}

/** The service, if it belongs to companyId (RLS alone only checks "a company the caller belongs to"). */
async function loadServiceOfCompany(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  serviceId: string,
) {
  const { data, error } = await supabase
    .from("recurring_services")
    .select("id, start_date")
    .eq("id", serviceId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) console.error(error);
  return { service: data as { id: string; start_date: string } | null, failed: Boolean(error) };
}

export type BulkMarkResult = { error: string | null; batchId: string | null; changed: number };

/**
 * "Marcar como facturado / cobrado hasta [mes]": every open cycle of the
 * service due up to the end of `untilMonth` ("YYYY-MM"), stamped with its
 * own due date. Logged under one batch id so it can be undone.
 */
export async function bulkMarkOccurrences(
  companyId: string,
  serviceId: string,
  untilMonth: string,
  action: "invoice" | "collect",
): Promise<BulkMarkResult> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(untilMonth) || !["invoice", "collect"].includes(action)) {
    return { error: "Elegí un mes válido.", batchId: null, changed: 0 };
  }

  const supabase = await createClient();
  const { service, failed } = await loadServiceOfCompany(supabase, companyId, serviceId);
  if (!service) {
    return { error: failed ? GENERIC_ERROR : "No se encontró el servicio.", batchId: null, changed: 0 };
  }

  const { data, error } = await supabase.rpc("bulk_mark_recurring_service_occurrences", {
    p_service_id: serviceId,
    p_until_month: `${untilMonth}-01`,
    p_action: action,
  });

  if (error) {
    console.error(error);
    return { error: GENERIC_ERROR, batchId: null, changed: 0 };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { batch_id: string; changed: number } | undefined;
  revalidateRecurringServices(companyId);
  return { error: null, batchId: row?.batch_id ?? null, changed: row?.changed ?? 0 };
}

/** Deshacer a bulk action: cycles changed again since then are left alone. */
export async function undoBulkMarkOccurrences(
  companyId: string,
  serviceId: string,
  batchId: string,
): Promise<{ error: string | null; restored: number }> {
  const supabase = await createClient();
  const { service, failed } = await loadServiceOfCompany(supabase, companyId, serviceId);
  if (!service) {
    return { error: failed ? GENERIC_ERROR : "No se encontró el servicio.", restored: 0 };
  }

  const { data, error } = await supabase.rpc("undo_recurring_service_occurrences_bulk", {
    p_batch_id: batchId,
  });

  if (error) {
    console.error(error);
    return { error: GENERIC_ERROR, restored: 0 };
  }

  revalidateRecurringServices(companyId);
  return { error: null, restored: typeof data === "number" ? data : 0 };
}

/**
 * After the start date moved forward: voids the still-open cycles whose
 * whole period is before the new start (collected ones are history and
 * stay). Nothing is deleted.
 */
export async function voidOccurrencesBeforeStart(
  companyId: string,
  serviceId: string,
): Promise<{ error: string | null; voided: number }> {
  const supabase = await createClient();
  const { service, failed } = await loadServiceOfCompany(supabase, companyId, serviceId);
  if (!service) {
    return { error: failed ? GENERIC_ERROR : "No se encontró el servicio.", voided: 0 };
  }

  const { data: cycles, error } = await supabase
    .from("recurring_service_occurrences")
    .select("id, period, recurring_services!inner(periodicity)")
    .eq("recurring_service_id", serviceId)
    .in("status", ["pending_invoice", "invoiced", "pending_collection"]);

  if (error) {
    console.error(error);
    return { error: GENERIC_ERROR, voided: 0 };
  }

  const ids = (cycles ?? [])
    .filter((cycle) => {
      const embedded = cycle.recurring_services as { periodicity: string } | { periodicity: string }[];
      const periodicity = Array.isArray(embedded) ? embedded[0]?.periodicity : embedded?.periodicity;
      return periodEnd(cycle.period, periodicity ?? "monthly") < service.start_date;
    })
    .map((cycle) => cycle.id);

  if (ids.length === 0) {
    return { error: null, voided: 0 };
  }

  const { data: updated, error: updateError } = await supabase
    .from("recurring_service_occurrences")
    .update({ status: "void" })
    .in("id", ids)
    .in("status", ["pending_invoice", "invoiced", "pending_collection"])
    .select("id");

  if (updateError) {
    console.error(updateError);
    return { error: GENERIC_ERROR, voided: 0 };
  }

  revalidateRecurringServices(companyId);
  return { error: null, voided: updated?.length ?? 0 };
}
