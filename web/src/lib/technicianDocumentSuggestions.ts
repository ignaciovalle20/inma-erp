/**
 * Suggested links between a technician's factura / boleta and their pending
 * charges (Chile, 20261026010000). Runs the pure rule of lib/technicians.ts
 * (proposeTechnicianSuggestions) against the database with the client it is
 * given: the caller's session in the app, so RLS keeps it to their company; a
 * member's client in the integration tests. Called after a purchase import,
 * from "Buscar sugerencias" in Conciliar and when a RUT is linked to a
 * technician. Suggestions are only stored: Conciliar confirms or discards them.
 */
import type { createClient } from "@/lib/supabase/server";
import { fetchAllPages } from "@/lib/pagination";
import { normalizeCountry } from "@/lib/companyConfig";
import {
  backingOfSourceType,
  proposeTechnicianSuggestions,
  type Backing,
  type SuggestionCharge,
  type SuggestionDocument,
} from "@/lib/technicians";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type ApiError = { message: string };
type Page<T> = PromiseLike<{ data: T[] | null; error: ApiError | null }>;

export type TechnicianSuggestionResult = { created: number; error: string | null };

const SOURCE_TYPES = ["FAC-EL", "FAC-EE", "BOL-HE", "BOL-TE"];

function monthWindow(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    start: `${month}-01`,
    end: new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10),
  };
}

/**
 * Looks for a suggestion for every document without a link (or without a
 * suggestion yet, pending or discarded) of a supplier that belongs to a
 * technician: all of them, the given ids, those of one month ("YYYY-MM") or
 * of one technician. Never touches a document twice.
 */
export async function suggestTechnicianDocuments(
  supabase: Supabase,
  companyId: string,
  options: { documentIds?: string[] | null; month?: string | null; personnelId?: string | null } = {},
): Promise<TechnicianSuggestionResult> {
  const none: TechnicianSuggestionResult = { created: 0, error: null };
  if (options.documentIds && options.documentIds.length === 0) return none;

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("country")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) return { ...none, error: companyError.message };
  if (normalizeCountry(company?.country) !== "CL") return none;

  const owners = await fetchAllPages<{ personnel_id: string; supplier_id: string }>((from, to) => {
    let query = supabase
      .from("technician_suppliers")
      .select("personnel_id, supplier_id")
      .eq("company_id", companyId);
    if (options.personnelId) query = query.eq("personnel_id", options.personnelId);
    return query.order("id").range(from, to) as unknown as Page<{ personnel_id: string; supplier_id: string }>;
  });
  if (owners.error) return { ...none, error: owners.error.message };
  if (owners.data.length === 0) return none;
  const ownerBySupplier = new Map(owners.data.map((row) => [row.supplier_id, row.personnel_id]));

  type DocumentRecord = {
    id: string;
    supplier_id: string;
    source_document_type: string | null;
    document_date: string;
    net_amount: number | string;
    cost_service_allocations: { status: string }[] | null;
  };
  const idChunks: (string[] | null)[] = [];
  if (options.documentIds) {
    for (let i = 0; i < options.documentIds.length; i += 150) idChunks.push(options.documentIds.slice(i, i + 150));
  } else {
    idChunks.push(null);
  }
  const documents: DocumentRecord[] = [];
  for (const ids of idChunks) {
    const read = await fetchAllPages<DocumentRecord>((from, to) => {
      let query = supabase
        .from("cost_documents")
        .select("id, supplier_id, source_document_type, document_date, net_amount, cost_service_allocations(status)")
        .eq("company_id", companyId)
        .eq("document_type", "invoice")
        .in("source_document_type", SOURCE_TYPES)
        .in("supplier_id", [...ownerBySupplier.keys()])
        .gt("net_amount", 0);
      if (ids) query = query.in("id", ids);
      if (options.month) {
        const { start, end } = monthWindow(options.month);
        query = query.gte("document_date", start).lt("document_date", end);
      }
      return query.order("id").range(from, to) as unknown as Page<DocumentRecord>;
    });
    if (read.error) return { ...none, error: read.error.message };
    documents.push(...read.data);
  }
  if (documents.length === 0) return none;

  const [links, suggestions, charges] = await Promise.all([
    fetchAllPages<{ cost_document_id: string }>((from, to) =>
      supabase
        .from("technician_charge_documents")
        .select("cost_document_id")
        .eq("company_id", companyId)
        .order("id")
        .range(from, to) as unknown as Page<{ cost_document_id: string }>,
    ),
    fetchAllPages<{ cost_document_id: string; charge_ids: string[]; status: string }>((from, to) =>
      supabase
        .from("technician_document_suggestions")
        .select("cost_document_id, charge_ids, status")
        .eq("company_id", companyId)
        .order("id")
        .range(from, to) as unknown as Page<{ cost_document_id: string; charge_ids: string[]; status: string }>,
    ),
    fetchAllPages<{ id: string; personnel_id: string; backing: Backing | null; charge_date: string; net_amount: number | string }>(
      (from, to) =>
        supabase
          .from("technician_charges")
          .select("id, personnel_id, backing, charge_date, net_amount")
          .eq("company_id", companyId)
          .in("backing", ["factura", "boleta"])
          .not("cost_document_id", "is", null)
          .order("id")
          .range(from, to) as unknown as Page<{
          id: string;
          personnel_id: string;
          backing: Backing | null;
          charge_date: string;
          net_amount: number | string;
        }>,
    ),
  ]);
  const failed = links.error ?? suggestions.error ?? charges.error;
  if (failed) return { ...none, error: failed.message };

  const settled = new Set([
    ...links.data.map((row) => row.cost_document_id),
    ...suggestions.data.map((row) => row.cost_document_id),
  ]);
  const claimed = suggestions.data.filter((row) => row.status === "pending").flatMap((row) => row.charge_ids);

  const candidates: SuggestionDocument[] = documents.flatMap((row) => {
    const backing = backingOfSourceType(row.source_document_type);
    const personnelId = ownerBySupplier.get(row.supplier_id);
    // A document allocated to services is not linked until that is undone by hand.
    const onServices = (row.cost_service_allocations ?? []).some((allocation) => allocation.status === "confirmed");
    if (!backing || !personnelId || settled.has(row.id) || onServices) return [];
    return [{ id: row.id, personnelId, backing, documentDate: row.document_date, net: Number(row.net_amount) }];
  });
  const pending: SuggestionCharge[] = charges.data.map((row) => ({
    id: row.id,
    personnelId: row.personnel_id,
    backing: row.backing,
    chargeDate: row.charge_date,
    cost: Number(row.net_amount),
  }));

  const proposals = proposeTechnicianSuggestions(candidates, pending, claimed);
  const result = { ...none };
  let lastError: string | null = null;
  for (const proposal of proposals) {
    const { error } = await supabase.from("technician_document_suggestions").insert({
      company_id: companyId,
      cost_document_id: proposal.documentId,
      personnel_id: proposal.personnelId,
      charge_ids: proposal.chargeIds,
    });
    if (error) {
      console.error(error);
      lastError = error.message;
      continue;
    }
    result.created += 1;
  }
  if (result.created === 0 && lastError) result.error = lastError;
  return result;
}
