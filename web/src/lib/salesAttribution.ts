/**
 * Where a sales document's net lands in the reports, by job and by area.
 *
 * sales_documents.project_id holds ONE job (the largest share), and the
 * document's business_area_id ONE area, so a document allocated to two jobs,
 * or to a job and a recurring service, used to count whole on one of them
 * and nothing on the others. The confirmed allocations (sales_allocations)
 * are the source of truth instead:
 *
 * - each allocation to a job's quote is that job's, in the job's area;
 * - each allocation to a recurring service period is no job's, in the
 *   service's area (its revenue is the client's and the area's, as always);
 * - whatever is left unallocated stays on the document's own area, no job;
 * - a document with no confirmed allocation (a credit note, which is never
 *   allocated; or one with suggestions only) keeps project_id as before.
 *
 * The parts always add up to the document's amount, so Σ jobs + rest and
 * Σ areas still equal the month's net sales.
 */
import type { createClient } from "@/lib/supabase/server";

export type AttributionAllocation = {
  salesDocumentId: string;
  amount: number;
  /** Job of the quote (quote allocations). */
  projectId: string | null;
  /** Area of the recurring service (period allocations). */
  serviceAreaId: string | null;
  /** The recurring service of the period (period allocations; optional for callers that only split amounts). */
  serviceId?: string | null;
  serviceName?: string | null;
  kind: "quote" | "period";
};

export type SaleForAttribution = {
  /** Amount to split, with whatever sign the caller uses (credit notes are never allocated). */
  amount: number;
  documentType: string;
  projectId: string | null;
  businessAreaId: string | null;
};

export type SalePart = {
  projectId: string | null;
  areaId: string | null;
  amount: number;
};

export function attributeSale(
  sale: SaleForAttribution,
  allocations: AttributionAllocation[],
  projectAreaById: ReadonlyMap<string, string | null>,
): SalePart[] {
  const projectArea = (projectId: string | null) =>
    projectId ? (projectAreaById.get(projectId) ?? null) : null;

  if (sale.documentType === "credit_note" || allocations.length === 0) {
    return [
      {
        projectId: sale.projectId,
        areaId: projectArea(sale.projectId) ?? sale.businessAreaId,
        amount: sale.amount,
      },
    ];
  }

  const sign = sale.amount < 0 ? -1 : 1;
  const parts: SalePart[] = allocations.map((allocation) =>
    allocation.kind === "quote"
      ? {
          projectId: allocation.projectId,
          areaId: projectArea(allocation.projectId) ?? sale.businessAreaId,
          amount: sign * allocation.amount,
        }
      : {
          projectId: null,
          areaId: allocation.serviceAreaId ?? sale.businessAreaId,
          amount: sign * allocation.amount,
        },
  );

  const allocated = parts.reduce((sum, part) => sum + part.amount, 0);
  const rest = sale.amount - allocated;
  if (rest !== 0) {
    parts.push({ projectId: null, areaId: sale.businessAreaId, amount: rest });
  }
  return parts;
}

/** The part of a document that lands on one job / one area (0 when none). */
export function attributedTo(
  parts: SalePart[],
  entity: { projectId?: string | null; areaId?: string | null },
): number {
  return parts
    .filter(
      (part) =>
        (entity.projectId === undefined || entity.projectId === null || part.projectId === entity.projectId) &&
        (entity.areaId === undefined || entity.areaId === null || part.areaId === entity.areaId),
    )
    .reduce((sum, part) => sum + part.amount, 0);
}

export type LinkedService = { id: string; name: string | null };

/** How the list, the export and the assistant name a service a document pays. */
export const serviceLinkLabel = (service: LinkedService) => `Servicio: ${service.name ?? "sin nombre"}`;

export type SaleListLinks = {
  /** At least one confirmed allocation to a recurring service period. */
  periodLinked: boolean;
  /** The one area the parts land in (null: none of them has an area, or several do). */
  areaId: string | null;
  /** The parts land in more than one area (a part with no area does not count as one). */
  multipleAreas: boolean;
  /** Services of the period allocations, once each, the largest share first. */
  services: LinkedService[];
};

/**
 * What the sales list shows for a document's links, from the same parts as
 * the reports: its area (the parts' one area, or "several"), whether it is
 * recurring because it pays a service period, and which services. A
 * document with no confirmed allocation keeps its own area, as before.
 */
export function describeSaleLinks(
  documentAreaId: string | null,
  parts: SalePart[],
  allocations: AttributionAllocation[],
): SaleListLinks {
  const byService = new Map<string, { service: LinkedService; amount: number }>();
  for (const allocation of allocations) {
    if (allocation.kind !== "period" || !allocation.serviceId) continue;
    const entry = byService.get(allocation.serviceId) ?? {
      service: { id: allocation.serviceId, name: allocation.serviceName ?? null },
      amount: 0,
    };
    entry.amount += Math.abs(allocation.amount);
    byService.set(allocation.serviceId, entry);
  }
  const services = Array.from(byService.values())
    .sort((a, b) => b.amount - a.amount)
    .map((entry) => entry.service);
  const periodLinked = allocations.some((allocation) => allocation.kind === "period");

  if (allocations.length === 0 || parts.length === 0) {
    return { periodLinked, areaId: documentAreaId, multipleAreas: false, services };
  }
  // Only parts that land in an area name one: the unallocated rest of a
  // document with no area of its own (an invoice of 99.990 paying a 99.900
  // period) does not turn the service's area into "several". Nor does a
  // rounding leftover.
  const areas = new Set(
    parts
      .filter((part) => part.areaId !== null && Math.abs(part.amount) >= 0.005)
      .map((part) => part.areaId),
  );
  if (areas.size > 1) {
    return { periodLinked, areaId: null, multipleAreas: true, services };
  }
  return { periodLinked, areaId: areas.values().next().value ?? null, multipleAreas: false, services };
}

type ApiError = { message: string };

type AttributionRecord = {
  id: string;
  sales_document_id: string;
  amount: number | string;
  project_quotes: { project_id: string } | { project_id: string }[] | null;
  recurring_service_occurrences:
    | { recurring_services: ServiceRecord | ServiceRecord[] | null }
    | { recurring_services: ServiceRecord | ServiceRecord[] | null }[]
    | null;
};

type ServiceRecord = { id: string; name: string | null; business_area_id: string | null };

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type SupabaseLike = Awaited<ReturnType<typeof createClient>>;

/**
 * The company's confirmed allocations, grouped by document, with the job of
 * each quote and the area of each period's service. `documentIds` limits
 * them (in chunks, the ids travel in the URL).
 */
export async function loadAttributionAllocations(
  supabase: SupabaseLike,
  companyId: string,
  documentIds?: string[],
): Promise<{ byDocument: Map<string, AttributionAllocation[]>; error: ApiError | null }> {
  const byDocument = new Map<string, AttributionAllocation[]>();
  const chunks: (string[] | null)[] = [];
  if (documentIds) {
    for (let i = 0; i < documentIds.length; i += 150) chunks.push(documentIds.slice(i, i + 150));
  } else {
    chunks.push(null);
  }

  for (const ids of chunks) {
    for (let from = 0; ; from += 1000) {
      let query = supabase
        .from("sales_allocations")
        .select(
          "id, sales_document_id, amount, project_quotes(project_id), recurring_service_occurrences(recurring_services(id, name, business_area_id))",
        )
        .eq("company_id", companyId)
        .eq("status", "confirmed");
      if (ids) query = query.in("sales_document_id", ids);
      const { data: page, error } = await query.order("id").range(from, from + 999);
      if (error) return { byDocument, error };
      const data = (page ?? []) as unknown as AttributionRecord[];
      for (const row of data) {
        const quote = firstOf(row.project_quotes);
        const period = firstOf(row.recurring_service_occurrences);
        const service = period ? firstOf(period.recurring_services) : null;
        const allocation: AttributionAllocation = {
          salesDocumentId: row.sales_document_id,
          amount: Number(row.amount),
          projectId: quote?.project_id ?? null,
          serviceAreaId: service?.business_area_id ?? null,
          serviceId: service?.id ?? null,
          serviceName: service?.name ?? null,
          kind: quote ? "quote" : "period",
        };
        byDocument.set(row.sales_document_id, [...(byDocument.get(row.sales_document_id) ?? []), allocation]);
      }
      if (data.length < 1000) break;
    }
  }

  return { byDocument, error: null };
}
