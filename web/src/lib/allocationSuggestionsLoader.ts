/**
 * Runs the automatic allocation suggestions (lib/allocationSuggestions.ts)
 * against the database with the client it is given -- the caller's session
 * in the app (RLS keeps it to their company), a member's client in the
 * integration tests. Only that client is used, so this module has no
 * dependency on the request (cookies) and can run anywhere.
 */
import type { createClient } from "@/lib/supabase/server";
import { fetchAllPages } from "@/lib/pagination";
import { shiftMonth } from "@/lib/period";
import { boardMonthOf } from "@/lib/recurringServicePending";
import {
  suggestAllocationsFor,
  type SuggestedAllocation,
  type SuggestionPeriod,
  type SuggestionQuote,
} from "@/lib/allocationSuggestions";

type Supabase = Awaited<ReturnType<typeof createClient>>;

const SUGGESTABLE_TYPES = ["invoice", "receipt", "manual"];

/** Ids in groups small enough for a URL filter. */
function chunkIds(ids: string[], size = 150): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

type DocRecord = {
  sales_document_id: string;
  client_id: string | null;
  document_number: string | null;
  document_date: string;
  currency: string;
  net_amount: number | string;
};

type PeriodRecord = {
  recurring_service_period_id: string;
  recurring_service_id: string;
  period: string;
  invoice_due_date: string | null;
  currency: string;
  expected_amount: number | string;
  billed_amount: number | string;
  suggested_amount: number | string;
  confirmed_count: number | string;
  suggested_count: number | string;
  billing_status: string;
};

type ServiceRecord = {
  id: string;
  client_id: string;
  periodicity: string;
  invoicing_mode: string;
  due_month: number | null;
};

type QuoteRecord = {
  project_quote_id: string;
  project_id: string;
  quoted_amount: number | string | null;
  billed_amount: number | string;
  suggested_amount: number | string;
};

/**
 * Suggests destinations for the company's documents that have no allocation
 * yet -- all of them, or the given ones -- and stores them as 'suggested'
 * with their reason. A document that already has any allocation is never
 * touched, so importing the same documents again never duplicates anything
 * (the unique indexes per document and destination guarantee it too).
 * Returns how many documents got a suggestion.
 */
export async function suggestAllocations(
  supabase: Supabase,
  companyId: string,
  documentIds: string[] | null = null,
  /** Only documents dated in this month ("YYYY-MM"); null = any month. */
  month: string | null = null,
): Promise<{ created: number; error: string | null }> {
  if (documentIds && documentIds.length === 0) return { created: 0, error: null };

  const docs: DocRecord[] = [];
  for (const ids of documentIds ? chunkIds(documentIds) : [null]) {
    const { data, error } = await fetchAllPages<DocRecord>((from, to) => {
      let query = supabase
        .from("sales_document_allocation_summary")
        .select("sales_document_id, client_id, document_number, document_date, currency, net_amount")
        .eq("company_id", companyId)
        .eq("allocation_count", 0)
        .in("document_type", SUGGESTABLE_TYPES)
        .gt("net_amount", 0)
        .not("client_id", "is", null);
      if (ids) query = query.in("sales_document_id", ids);
      if (month) {
        query = query.gte("document_date", `${month}-01`).lt("document_date", `${shiftMonth(month, 1)}-01`);
      }
      return query.order("sales_document_id").range(from, to) as unknown as PromiseLike<{
        data: DocRecord[] | null;
        error: { message: string } | null;
      }>;
    });
    if (error) {
      console.error(error);
      return { created: 0, error: error.message };
    }
    docs.push(...data);
  }

  if (docs.length === 0) return { created: 0, error: null };

  const firstMonth = docs.map((doc) => doc.document_date.slice(0, 7)).sort()[0];
  // Annual periods start in January but are due in their renewal month:
  // twelve months back on the period itself covers them.
  const from = shiftMonth(firstMonth, -1);
  const [company, periods, services, quotes, projects] = await Promise.all([
    supabase.from("companies").select("currency").eq("id", companyId).maybeSingle(),
    fetchAllPages<PeriodRecord>((start, end) =>
      supabase
        .from("recurring_service_period_summary")
        .select(
          "recurring_service_period_id, recurring_service_id, period, invoice_due_date, currency, expected_amount, billed_amount, suggested_amount, confirmed_count, suggested_count, billing_status",
        )
        .eq("company_id", companyId)
        .or(`invoice_due_date.gte.${from}-01,and(invoice_due_date.is.null,period.gte.${shiftMonth(from, -12)}-01)`)
        .order("recurring_service_period_id")
        .range(start, end) as unknown as PromiseLike<{ data: PeriodRecord[] | null; error: { message: string } | null }>,
    ),
    fetchAllPages<ServiceRecord>((start, end) =>
      supabase
        .from("recurring_services")
        .select("id, client_id, periodicity, invoicing_mode, due_month")
        .eq("company_id", companyId)
        .order("id")
        .range(start, end) as unknown as PromiseLike<{ data: ServiceRecord[] | null; error: { message: string } | null }>,
    ),
    fetchAllPages<QuoteRecord>((start, end) =>
      supabase
        .from("project_quote_billing_summary")
        .select("project_quote_id, project_id, quoted_amount, billed_amount, suggested_amount")
        .eq("company_id", companyId)
        .order("project_quote_id")
        .range(start, end) as unknown as PromiseLike<{ data: QuoteRecord[] | null; error: { message: string } | null }>,
    ),
    fetchAllPages<{ id: string; client_id: string; status: string }>((start, end) =>
      supabase
        .from("projects")
        .select("id, client_id, status")
        .eq("company_id", companyId)
        .order("id")
        .range(start, end) as unknown as PromiseLike<{
        data: { id: string; client_id: string; status: string }[] | null;
        error: { message: string } | null;
      }>,
    ),
  ]);

  const failed = company.error ?? periods.error ?? services.error ?? quotes.error ?? projects.error;
  if (failed) {
    console.error(failed);
    return { created: 0, error: failed.message };
  }

  const serviceById = new Map(services.data.map((service) => [service.id, service]));
  const suggestionPeriods: SuggestionPeriod[] = periods.data.flatMap((period) => {
    const service = serviceById.get(period.recurring_service_id);
    if (!service) return [];
    const hasAllocations = Number(period.confirmed_count) + Number(period.suggested_count) > 0;
    return [
      {
        id: period.recurring_service_period_id,
        clientId: service.client_id,
        currency: period.currency,
        month: boardMonthOf({
          invoice_due_date: period.invoice_due_date,
          period: period.period,
          service_periodicity: service.periodicity,
          service_invoicing_mode: service.invoicing_mode,
          service_due_month: service.due_month,
        }),
        expected: Number(period.expected_amount),
        allocated: Number(period.billed_amount) + Number(period.suggested_amount),
        hasAllocations,
        // Pending to invoice, or already billed (the rules check what is
        // left); a period marked invoiced/paid by hand, with no allocation,
        // is done.
        open: period.billing_status !== "void" && (hasAllocations || period.billing_status === "pending_invoice"),
      },
    ];
  });

  const projectById = new Map(projects.data.map((project) => [project.id, project]));
  const companyCurrency = (company.data?.currency as string | undefined) ?? "";
  const suggestionQuotes: SuggestionQuote[] = quotes.data.flatMap((quote) => {
    const project = projectById.get(quote.project_id);
    if (!project || project.status === "cancelado") return [];
    return [
      {
        id: quote.project_quote_id,
        clientId: project.client_id,
        currency: companyCurrency,
        balance:
          quote.quoted_amount === null
            ? null
            : Number(quote.quoted_amount) - Number(quote.billed_amount) - Number(quote.suggested_amount),
      },
    ];
  });

  const suggestions = suggestAllocationsFor(
    docs.map((doc) => ({
      id: doc.sales_document_id,
      clientId: doc.client_id as string,
      currency: doc.currency,
      netAmount: Number(doc.net_amount),
      documentDate: doc.document_date,
      documentNumber: doc.document_number,
    })),
    suggestionPeriods,
    suggestionQuotes,
  );

  const byDocument = new Map<string, SuggestedAllocation[]>();
  for (const suggestion of suggestions) {
    byDocument.set(suggestion.documentId, [...(byDocument.get(suggestion.documentId) ?? []), suggestion]);
  }

  let created = 0;
  let lastError: string | null = null;
  // One insert per document: a document that changed meanwhile (got an
  // allocation, was voided) fails alone and the rest still go in.
  for (const [documentId, rows] of byDocument) {
    const { error } = await supabase.from("sales_allocations").insert(
      rows.map((row) => ({
        company_id: companyId,
        sales_document_id: documentId,
        recurring_service_period_id: row.targetType === "period" ? row.targetId : null,
        project_quote_id: row.targetType === "quote" ? row.targetId : null,
        amount: row.amount,
        status: "suggested",
        suggestion_reason: row.reason,
      })),
    );
    if (error) {
      console.error(error);
      lastError = error.message;
    } else {
      created += 1;
    }
  }

  return { created, error: created === 0 ? lastError : null };
}

/** Suggestions for the documents an import batch created or updated. */
export async function suggestAllocationsForImportBatch(
  supabase: Supabase,
  companyId: string,
  importBatchId: string,
): Promise<{ created: number; error: string | null }> {
  const { data, error } = await fetchAllPages<{ sales_document_id: string }>((from, to) =>
    supabase
      .from("import_rows")
      .select("sales_document_id")
      .eq("import_batch_id", importBatchId)
      .not("sales_document_id", "is", null)
      .order("id")
      .range(from, to) as unknown as PromiseLike<{
      data: { sales_document_id: string }[] | null;
      error: { message: string } | null;
    }>,
  );
  if (error) {
    console.error(error);
    return { created: 0, error: error.message };
  }
  const ids = [...new Set(data.map((row) => row.sales_document_id))];
  return suggestAllocations(supabase, companyId, ids);
}
