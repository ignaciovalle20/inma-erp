/**
 * The sales list's filters and links.
 *
 * - Pagadas / Impagas: a credit note has no payment status, so filtering by
 *   one never lists it (e2e found it under Impagas: it is stored with the
 *   default 'impago').
 * - An invoice paying a recurring service period (a confirmed allocation)
 *   is recurring, lands in the service's area and names the service, the
 *   same as the reports (lib/salesAttribution.ts). It used to show "—" in
 *   Área and Trabajo and fall out of the "Recurrentes" filter.
 *
 * The database is a recording fake that answers each table with `tables`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { method: string; args: unknown[] };
const calls: Call[] = [];
const tables: Record<string, unknown[]> = {};

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "is", "not", "in", "gte", "lt", "order"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  const result = () => ({ data: tables[table] ?? [], error: null });
  chain.range = async () => result();
  // Queries awaited without .range() (projects, business areas).
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result());
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => builder(table),
  }),
}));

import { getSalesListRows } from "@/lib/dal";

const asked = (method: string, column: string) =>
  calls.filter((call) => call.method === method && call.args[0] === column).map((call) => call.args[1]);

beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(tables)) delete tables[key];
});

describe("getSalesListRows payment filter", () => {
  it("filters by the status and leaves credit notes out", async () => {
    await getSalesListRows("company-filter-1", { paymentStatus: "impago" });
    expect(asked("eq", "payment_status")).toEqual(["impago"]);
    expect(asked("neq", "document_type")).toEqual(["credit_note"]);
  });

  it("keeps credit notes when no status is asked", async () => {
    await getSalesListRows("company-filter-2", {});
    expect(asked("eq", "payment_status")).toEqual([]);
    expect(asked("neq", "document_type")).toEqual([]);
  });
});

const areas = [
  { id: "area-obras", company_id: "c", name: "Obras", active: true },
  { id: "area-soft", company_id: "c", name: "Software", active: true },
];

const projects = [{ id: "proj-1", company_id: "c", business_area_id: "area-obras", name: "Obra Norte" }];

function document(overrides: Record<string, unknown>) {
  return {
    id: "doc-1",
    company_id: "c",
    client_id: "client-vcb",
    project_id: null,
    business_area_id: null,
    document_type: "invoice",
    document_number: "2704",
    document_date: "2026-10-15",
    due_date: null,
    currency: "CLP",
    net_amount: 1000,
    tax_amount: 190,
    total_amount: 1190,
    payment_status: "impago",
    paid_at: null,
    payment_method: null,
    exchange_rate: null,
    annulled_by_document_id: null,
    annuls_document_id: null,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    voided: false,
    voided_at: null,
    source: "nubox",
    import_row_id: null,
    recognized_period: null,
    recognized_period_set_by: null,
    recognized_period_set_at: null,
    recurring_service_id: null,
    clients: { name: "VCB Constructora", monthly: false },
    business_areas: null,
    projects: null,
    ...overrides,
  };
}

const periodAllocation = (amount: number, service = { id: "svc-razo", name: "Licencias Razo" }) => ({
  id: `alloc-${service.id}`,
  sales_document_id: "doc-1",
  amount,
  project_quotes: null,
  recurring_service_occurrences: {
    recurring_services: { ...service, business_area_id: "area-soft" },
  },
});

const quoteAllocation = (amount: number) => ({
  id: "alloc-quote",
  sales_document_id: "doc-1",
  amount,
  project_quotes: { project_id: "proj-1" },
  recurring_service_occurrences: null,
});

describe("getSalesListRows links to recurring service periods", () => {
  it("shows an invoice paying a service period as recurring, in the service's area, naming the service", async () => {
    tables.sales_documents = [document({})];
    tables.sales_allocations = [periodAllocation(1000)];
    tables.business_areas = areas;
    tables.projects = projects;

    const [row] = await getSalesListRows("company-links-1", {});
    expect(row.is_recurring).toBe(true);
    expect(row.area_label).toBe("Software");
    expect(row.area_multiple).toBe(false);
    expect(row.project_id).toBeNull();
    expect(row.linked_services).toEqual([{ id: "svc-razo", name: "Licencias Razo" }]);
  });

  // FAC 2716 in Chile: 99.990 net paying a 99.900 period, no area on the document.
  it("keeps the service's area when only part of the net is allocated and the rest has no area", async () => {
    tables.sales_documents = [document({ net_amount: 99990 })];
    tables.sales_allocations = [periodAllocation(99900)];
    tables.business_areas = areas;

    const [row] = await getSalesListRows("company-links-7", {});
    expect(row.parts.map((part) => [part.areaId, part.amount])).toEqual([
      ["area-soft", 99900],
      [null, 90],
    ]);
    expect(row.area_label).toBe("Software");
    expect(row.area_multiple).toBe(false);
    expect(row.is_recurring).toBe(true);
  });

  it("keeps it under Recurrentes and out of No recurrentes", async () => {
    tables.sales_documents = [document({})];
    tables.sales_allocations = [periodAllocation(1000)];
    tables.business_areas = areas;

    expect((await getSalesListRows("company-links-2", { recurring: "recurring" })).map((r) => r.id)).toEqual([
      "doc-1",
    ]);
    expect(await getSalesListRows("company-links-3", { recurring: "non_recurring" })).toEqual([]);
  });

  it("shows Varias for an invoice split between a job and a service, and names both", async () => {
    tables.sales_documents = [
      document({ project_id: "proj-1", business_area_id: "area-obras", business_areas: { name: "Obras" }, projects: { name: "Obra Norte" } }),
    ];
    tables.sales_allocations = [
      quoteAllocation(600),
      periodAllocation(300),
      periodAllocation(100, { id: "svc-soporte", name: "Soporte" }),
    ];
    tables.business_areas = areas;
    tables.projects = projects;

    const [row] = await getSalesListRows("company-links-4", {});
    expect(row.is_recurring).toBe(true);
    expect(row.area_label).toBe("Varias");
    expect(row.area_multiple).toBe(true);
    expect(row.project_name).toBe("Obra Norte");
    // Largest share first.
    expect(row.linked_services.map((service) => service.name)).toEqual(["Licencias Razo", "Soporte"]);
    expect(row.parts.map((part) => [part.projectId, part.areaId, part.amount])).toEqual([
      ["proj-1", "area-obras", 600],
      [null, "area-soft", 300],
      [null, "area-soft", 100],
    ]);
  });

  it("leaves an invoice with no allocations as before: its own area, not recurring, no service", async () => {
    tables.sales_documents = [
      // The job's area differs on purpose: with nothing allocated the list keeps the document's.
      document({ project_id: "proj-2", business_area_id: "area-obras", business_areas: { name: "Obras" }, projects: { name: "Obra Sur" } }),
    ];
    tables.business_areas = areas;
    tables.projects = [{ id: "proj-2", company_id: "c", business_area_id: "area-soft", name: "Obra Sur" }];

    const [row] = await getSalesListRows("company-links-5", {});
    expect(row.is_recurring).toBe(false);
    expect(row.area_label).toBe("Obras");
    expect(row.area_multiple).toBe(false);
    expect(row.linked_services).toEqual([]);
    expect(row.project_name).toBe("Obra Sur");
    expect(await getSalesListRows("company-links-6", { recurring: "recurring" })).toEqual([]);
  });
});
