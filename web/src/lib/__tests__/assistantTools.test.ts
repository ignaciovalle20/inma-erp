/**
 * The assistant's tools (shared by the in-app chat and the MCP server)
 * must follow the same rules as the screens: a job needs its quote
 * number, "En espera" needs a reason, Chile is always CLP, and a name
 * that matches several records is never guessed. The data layer is
 * mocked; every id is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const company = { id: "co-1", name: "INMA Chile", country: "CL", currency: "CLP", tax_id: null, active: true };

const state = {
  company: { ...company } as typeof company & { country: string },
  clients: [
    { id: "cl-1", name: "Constructora Andes", active: true },
    { id: "cl-2", name: "Andes Logística", active: true },
    { id: "cl-3", name: "Viña Sur", active: true },
  ],
  suppliers: [{ id: "su-1", name: "Microsoft", active: true }],
  areas: [
    { id: "ar-1", name: "Hosting", active: true },
    { id: "ar-2", name: "Cloud", active: true },
  ],
  projects: [
    { id: "pr-1", name: "Migración correo", status: "en_ejecucion", client_name: "Viña Sur", quoted_amount: 1000 },
  ],
};

const listProjects = vi.fn();

vi.mock("@/lib/dal", () => ({
  getUserCompanies: async () => [{ ...company, role: "owner" }],
  getCompanyForEdit: async () => ({ company: state.company, role: "owner" }),
  getCostDocuments: async () => [],
  getClients: async () => state.clients,
  getSuppliers: async () => state.suppliers,
  getProjects: async () => state.projects,
  getBusinessAreas: async () => state.areas,
  listProjects: (...args: unknown[]) => listProjects(...args),
  getProjectQuotesByProject: async () => new Map([["pr-1", ["COT-77"]]]),
  getProjectBillingBalances: async () => [{ projectId: "pr-1", name: "x", clientId: "cl-3", quotedAmount: 1000, invoicedAmount: 400 }],
  getSalesListRows: async () => [],
  getSalesPending: async () => ({}),
  ensureRecurringServiceOccurrencesForMonth: async () => 0,
  getRecurringServiceOccurrencesForMonth: async () => [],
  findPotentialDuplicateCost: async () => null,
}));
vi.mock("@/lib/technicianDal", () => ({
  getTechnicianCharges: async () => [
    { personnel_id: "t-1", personnel_name: "Pedro", project_name: "A", charge_date: "2026-09-01", amount: 100, outstanding: 60 },
    { personnel_id: "t-1", personnel_name: "Pedro", project_name: "B", charge_date: "2026-09-02", amount: 50, outstanding: 0 },
  ],
}));
vi.mock("@/lib/reporting", () => ({
  computeMonthlyResult: async () => ({ netSales: 10 }),
  computeProjectProfitability: async () => ({}),
}));

import { executeTool, findByName, TOOL_DEFINITIONS } from "@/lib/ai/tools";

const ctx = { companyId: "co-1" };

beforeEach(() => {
  state.company = { ...company };
  listProjects.mockReset();
  listProjects.mockResolvedValue({
    rows: [{ ...state.projects[0], business_area_name: "Cloud", hold_reason: null, cost_budget: null, responsible: null, start_date: null, end_date: null }],
    total: 1,
  });
});

describe("findByName", () => {
  it("matches ignoring accents and case, and never guesses between several", () => {
    expect(findByName(state.clients, "viña sur")?.id).toBe("cl-3");
    expect(findByName(state.clients, "VINA SUR")?.id).toBe("cl-3");
    expect(findByName(state.clients, "andes")).toBeNull();
    expect(findByName(state.clients, "Constructora")?.id).toBe("cl-1");
  });
});

describe("propose_project", () => {
  const base = { name: "Firewall", client_name: "Viña Sur", business_area_name: "Cloud" };

  it("asks for the quote number unless the job is still por cotizar", async () => {
    const missing = await executeTool("propose_project", base, ctx);
    expect(missing.draft).toBeUndefined();
    expect(JSON.stringify(missing.result)).toMatch(/cotización/);

    const toQuote = await executeTool("propose_project", { ...base, status: "por_cotizar" }, ctx);
    expect(toQuote.draft?.kind).toBe("project");
  });

  it("builds the draft with the real ids, the quote and the default status", async () => {
    const outcome = await executeTool("propose_project", { ...base, quote_number: " COT-90 ", quoted_amount: 500 }, ctx);
    expect(outcome.draft).toMatchObject({
      kind: "project",
      client_id: "cl-3",
      business_area_id: "ar-2",
      status: "en_ejecucion",
      quote_number: "COT-90",
      quoted_amount: 500,
      currency: "CLP",
      invoiceable: true,
    });
  });

  it("rejects an unknown area or a negative amount", async () => {
    expect((await executeTool("propose_project", { ...base, quote_number: "1", business_area_name: "Starlink" }, ctx)).draft).toBeUndefined();
    expect((await executeTool("propose_project", { ...base, quote_number: "1", quoted_amount: -1 }, ctx)).draft).toBeUndefined();
  });
});

describe("propose_project_status", () => {
  it("needs a reason for en_espera and refuses a no-op move", async () => {
    expect((await executeTool("propose_project_status", { project_id: "pr-1", status: "en_espera" }, ctx)).draft).toBeUndefined();
    expect((await executeTool("propose_project_status", { project_id: "pr-1", status: "en_ejecucion" }, ctx)).draft).toBeUndefined();

    const outcome = await executeTool(
      "propose_project_status",
      { project_id: "pr-1", status: "en_espera", hold_reason: "Esperando OC" },
      ctx,
    );
    expect(outcome.draft).toEqual({
      kind: "project_status",
      project_id: "pr-1",
      project_name: "Migración correo",
      from_status: "en_ejecucion",
      status: "en_espera",
      hold_reason: "Esperando OC",
    });
  });
});

describe("currency", () => {
  const expense = {
    classification: "direct",
    project_id: "pr-1",
    document_date: "2026-10-01",
    lines: [{ amount: 100 }],
  };

  it("is always CLP in Chile, whatever the model sends", async () => {
    const outcome = await executeTool("propose_expense", { ...expense, currency: "USD" }, ctx);
    expect(outcome.draft).toMatchObject({ currency: "CLP", project_id: "pr-1", total_amount: 100 });
  });

  it("must be asked in Uruguay", async () => {
    state.company = { ...company, country: "UY", currency: "USD" };
    const missing = await executeTool("propose_expense", expense, ctx);
    expect(missing.draft).toBeUndefined();
    expect(JSON.stringify(missing.result)).toMatch(/USD o UYU/);

    const given = await executeTool("propose_expense", { ...expense, currency: "uyu" }, ctx);
    expect(given.draft).toMatchObject({ currency: "UYU" });
  });
});

describe("read tools", () => {
  it("list_projects searches with the screen's RPC and adds the balance to invoice", async () => {
    const outcome = await executeTool("list_projects", { query: "COT-77" }, ctx);
    expect(listProjects).toHaveBeenCalledWith("co-1", { scope: "activos", query: "COT-77", limit: 50 });
    const project = (outcome.result as { projects: Record<string, unknown>[] }).projects[0];
    expect(project).toMatchObject({ quote_numbers: ["COT-77"], invoiced_amount: 400, balance_to_invoice: 600, status_label: "En ejecución" });
  });

  it("get_technician_balances adds up what is still owed per technician", async () => {
    const outcome = await executeTool("get_technician_balances", {}, ctx);
    expect(outcome.result).toEqual([
      { technician: "Pedro", outstanding: 60, pending_charges: [{ project: "A", date: "2026-09-01", amount: 100, outstanding: 60 }] },
    ]);
  });

  it("turns a failing query into an error the model can relay", async () => {
    listProjects.mockRejectedValueOnce(new Error("No se pudieron leer los proyectos: timeout"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = await executeTool("list_projects", {}, ctx);
    expect(outcome.result).toEqual({ error: "No se pudieron leer los proyectos: timeout" });
  });

  it("asks for a company before any company tool", async () => {
    const outcome = await executeTool("list_clients", {}, { companyId: null });
    expect(JSON.stringify(outcome.result)).toMatch(/empresa activa/);
  });
});

describe("definitions", () => {
  it("every tool has a handler", async () => {
    for (const tool of TOOL_DEFINITIONS) {
      const outcome = await executeTool(tool.name, {}, ctx);
      expect(JSON.stringify(outcome.result)).not.toMatch(/Herramienta desconocida/);
    }
  });
});
