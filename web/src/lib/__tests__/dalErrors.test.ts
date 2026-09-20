/**
 * B5 (docs/plan-sistema-v3.md, H06): the DAL readers that feed figures used to
 * return [] when the API failed, and the screen showed "no costs" / "every
 * project is pending". They now throw a message the screen can show.
 * The database is a table-by-table fake; all data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error: { message: string } | null };
const tables: Record<string, Result[]> = {};

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "not", "in", "gte", "lt", "order", "range", "or"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) => {
    const queue = tables[table];
    if (!queue || queue.length === 0) throw new Error(`no queued response for "${table}"`);
    return Promise.resolve(queue.shift() as Result).then(resolve, reject);
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => builder(table),
  }),
}));

import { getCostDocuments, getProjectCostStatus } from "@/lib/dal";

const failure = (message: string): Result => ({ data: null, error: { message } });
const ok = (data: unknown = []): Result => ({ data, error: null });

const costRow = {
  id: "cost-1",
  company_id: "company-1",
  supplier_id: null,
  project_id: null,
  classification: "general",
  category: null,
  status: "confirmed",
  document_date: "2026-09-01",
  currency: "CLP",
  net_amount: 100,
  tax_amount: 19,
  total_amount: 119,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  recognized_period: null,
  recognized_period_set_by: null,
  recognized_period_set_at: null,
  suppliers: null,
  projects: null,
};

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
});

describe("getCostDocuments", () => {
  it("throws when the list cannot be read, instead of returning an empty list", async () => {
    tables.cost_documents = [failure("timeout")];

    await expect(getCostDocuments("company-1")).rejects.toThrow("No se pudieron leer los costos: timeout");
  });

  it("throws when the allocations cannot be read: every cost would show as unallocated", async () => {
    tables.cost_documents = [ok([costRow])];
    tables.cost_allocations = [failure("boom")];
    tables.cost_document_attachments = [ok()];

    await expect(getCostDocuments("company-1")).rejects.toThrow(
      "No se pudieron leer las asignaciones de los costos: boom",
    );
  });

  it("returns the documents, flagged allocated or not, when everything is readable", async () => {
    tables.cost_documents = [ok([costRow])];
    tables.cost_allocations = [ok([{ cost_document_id: "cost-1" }])];
    tables.cost_document_attachments = [ok()];

    const documents = await getCostDocuments("company-1");

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: "cost-1", is_allocated: true, has_attachment: false });
  });

  it("an empty period is an empty list, not an error", async () => {
    tables.cost_documents = [ok([])];

    await expect(getCostDocuments("company-1")).resolves.toEqual([]);
  });
});

describe("getProjectCostStatus", () => {
  const activeProject = {
    id: "project-1",
    company_id: "company-1",
    client_id: "client-1",
    business_area_id: null,
    name: "Proyecto 1",
    start_date: null,
    end_date: null,
    status: "en_ejecucion",
    budget: null,
    responsible: null,
    clients: { name: "Cliente 1" },
    business_areas: null,
  };

  it("throws when the costs of the projects cannot be read, instead of marking all of them pending", async () => {
    tables.projects = [ok([activeProject])];
    tables.cost_documents = [failure("db down")];
    tables.project_cost_confirmations = [ok()];

    await expect(getProjectCostStatus("company-1", "2026-09-01")).rejects.toThrow(
      "No se pudieron leer los costos de los proyectos: db down",
    );
  });

  it("marks a project with no cost as pending when the reads worked", async () => {
    tables.projects = [ok([activeProject])];
    tables.cost_documents = [ok()];
    tables.project_cost_confirmations = [ok()];

    const projects = await getProjectCostStatus("company-1", "2026-09-01");

    expect(projects.map((project) => [project.id, project.cost_status])).toEqual([["project-1", "pending"]]);
  });
});
