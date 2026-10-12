/**
 * saveDraft re-validates a draft that came back from the browser or an
 * MCP client and saves it through the same RPCs/updates as the human
 * forms. Supabase is a recording fake; every id is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const calls: { kind: string; name: string; args: unknown }[] = [];
const state = { rpcError: null as null | { message: string }, refsFound: true, updatedRows: 1 };

function chain(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["eq", "select"]) builder[method] = () => builder;
  builder.maybeSingle = async () => result;
  builder.single = async () => result;
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      return chain(state.rpcError ? { data: null, error: state.rpcError } : { data: { id: "new-1" }, error: null });
    },
    from: (table: string) => ({
      select: () => chain({ data: state.refsFound ? { id: "ref" } : null, error: null }),
      update: (values: unknown) => {
        calls.push({ kind: "update", name: table, args: values });
        return chain({ data: Array.from({ length: state.updatedRows }, () => ({ id: "pr-1" })), error: null });
      },
    }),
  }),
}));

import { saveDraft } from "@/lib/ai/saveDraft";
import type { Draft } from "@/lib/ai/tools";

const expense: Draft = {
  kind: "expense",
  supplier_id: "su-1",
  supplier_name: "Microsoft",
  project_id: "pr-1",
  project_name: "Firewall",
  classification: "direct",
  document_date: "2026-10-01",
  currency: "CLP",
  tax_amount: 19,
  lines: [{ description: null, amount: 100 }],
  net_amount: 100,
  total_amount: 119,
};

const project: Draft = {
  kind: "project",
  name: "Firewall",
  client_id: "cl-1",
  client_name: "Viña Sur",
  business_area_id: "ar-1",
  business_area_name: "Cloud",
  status: "en_ejecucion",
  quote_number: "COT-90",
  start_date: null,
  end_date: null,
  quoted_amount: 500,
  cost_budget: null,
  currency: "CLP",
  responsible: null,
  invoiceable: true,
};

beforeEach(() => {
  calls.length = 0;
  state.rpcError = null;
  state.refsFound = true;
  state.updatedRows = 1;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveDraft", () => {
  it("saves an expense with create_cost_document", async () => {
    const saved = await saveDraft("co-1", expense);
    expect(saved).toEqual({ ok: true, id: "new-1", href: "/companies/co-1/costs" });
    expect(calls[0]).toMatchObject({ name: "create_cost_document", args: { p_project_id: "pr-1", p_tax_amount: 19 } });
  });

  it("sends a general cost to 'Dividir costo', and refuses one with a job", async () => {
    const general = { ...expense, classification: "general" as const, project_id: null, project_name: null };
    expect(await saveDraft("co-1", general)).toMatchObject({ href: "/companies/co-1/costs/new-1/allocate" });
    expect(await saveDraft("co-1", { ...general, project_id: "pr-1" })).toMatchObject({ ok: false, error: "invalid_draft" });
  });

  it("creates a job with its quote through create_project_with_quote", async () => {
    const saved = await saveDraft("co-1", project);
    expect(saved).toEqual({ ok: true, id: "new-1", href: "/companies/co-1/projects/new-1" });
    expect(calls[0]).toMatchObject({
      name: "create_project_with_quote",
      args: { p_quote_number: "COT-90", p_status: "en_ejecucion", p_quoted_amount: 500, p_invoiceable: true },
    });
  });

  it("refuses a job without quote, or with a client of another company", async () => {
    expect(await saveDraft("co-1", { ...project, quote_number: null })).toMatchObject({ ok: false });
    state.refsFound = false;
    expect(await saveDraft("co-1", project)).toMatchObject({ ok: false, error: "invalid_draft" });
    expect(calls).toEqual([]);
  });

  it("moves a job on the board and clears the reason outside en_espera", async () => {
    const draft: Draft = {
      kind: "project_status",
      project_id: "pr-1",
      project_name: "Firewall",
      from_status: "en_espera",
      status: "finalizado",
      hold_reason: "viejo motivo",
    };
    expect(await saveDraft("co-1", draft)).toEqual({ ok: true, id: "pr-1", href: "/companies/co-1/projects/board" });
    expect(calls[0]).toEqual({ kind: "update", name: "projects", args: { status: "finalizado", hold_reason: null } });

    state.updatedRows = 0;
    expect(await saveDraft("co-1", draft)).toMatchObject({ ok: false, error: "not_found" });
  });

  it("reports a failed RPC instead of claiming success", async () => {
    state.rpcError = { message: "boom" };
    expect(await saveDraft("co-1", expense)).toMatchObject({ ok: false, error: "create_failed" });
  });

  it("refuses anything that isn't a known draft", async () => {
    expect(await saveDraft("co-1", null)).toMatchObject({ ok: false, error: "invalid_draft" });
    expect(await saveDraft("co-1", { kind: "delete_everything" } as unknown as Draft)).toMatchObject({ ok: false });
  });
});
