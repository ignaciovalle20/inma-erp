/**
 * Confirming an MCP draft must be claimed atomically before anything is
 * created (two confirmations at once, or a retry after a lost response,
 * used to create the document twice) and handed back if creation fails.
 * The database is a small in-memory fake; every id is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type Draft = {
  id: string;
  user_id: string;
  company_id: string;
  kind: string;
  payload: unknown;
  expires_at: string;
  consumed_at: string | null;
};

const state: {
  draft: Draft | null;
  /** Rows the claim update reports back (0 = someone else already claimed it). */
  claimRows: number;
  rpc: { data: unknown; error: { message: string } | null };
  member: boolean;
} = { draft: null, claimRows: 1, rpc: { data: null, error: null }, member: true };

const events: string[] = [];

function updateBuilder(values: Record<string, unknown>) {
  const filters: Record<string, unknown> = {};
  const builder = {
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    is: (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    },
    select: () => {
      events.push(`claim:${JSON.stringify(values)}`);
      return Promise.resolve({
        data: Array.from({ length: state.claimRows }, () => ({ id: "draft-1" })),
        error: null,
      });
    },
    // Awaited without .select() -> the "give it back" update.
    then: (resolve: (value: { error: null }) => unknown) => {
      events.push(`update:${JSON.stringify(values)}`);
      return Promise.resolve({ error: null }).then(resolve);
    },
  };
  return builder;
}

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "mcp_pending_drafts") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.draft, error: null }) }),
          }),
          update: (values: Record<string, unknown>) => updateBuilder(values),
        };
      }
      if (table === "company_memberships") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: state.member ? { user_id: "user-1" } : null, error: null }) }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      events.push(`rpc:${name}`);
      return state.rpc;
    },
  }),
}));

import { confirmMcpDraft } from "@/lib/mcp/tools";

const saleDraft: Draft = {
  id: "draft-1",
  user_id: "user-1",
  company_id: "company-1",
  kind: "sale",
  payload: {
    client_id: "client-1",
    document_type: "invoice",
    document_date: "2026-09-01",
    currency: "CLP",
    tax_amount: 0,
    lines: [{ description: "Servicio", amount: 1000 }],
    project_id: null,
  },
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  consumed_at: null,
};

beforeEach(() => {
  events.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.draft = { ...saleDraft };
  state.claimRows = 1;
  state.rpc = { data: { id: "sale-1" }, error: null };
  state.member = true;
});

const ctx = { userId: "user-1" };

describe("confirmMcpDraft", () => {
  it("claims the draft before it creates the document", async () => {
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBeUndefined();
    expect(events[0]).toMatch(/^claim:/);
    expect(events[1]).toBe("rpc:create_sales_document");
    // Not released after a success.
    expect(events.filter((event) => event.startsWith("update:"))).toEqual([]);
  });

  it("creates nothing when another confirmation claimed the draft first", async () => {
    state.claimRows = 0;
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.result)).toMatch(/ya fue confirmado/);
    expect(events.some((event) => event.startsWith("rpc:"))).toBe(false);
  });

  it("gives the draft back when creating the document fails, so it can be retried", async () => {
    state.rpc = { data: null, error: { message: "boom" } };
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBe(true);
    expect(events).toEqual([expect.stringMatching(/^claim:/), "rpc:create_sales_document", 'update:{"consumed_at":null}']);
  });

  it("refuses an already consumed draft without touching anything", async () => {
    state.draft = { ...saleDraft, consumed_at: new Date().toISOString() };
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBe(true);
    expect(events).toEqual([]);
  });

  it("refuses a draft of another user and a user without access to the company", async () => {
    state.draft = { ...saleDraft, user_id: "someone-else" };
    expect((await confirmMcpDraft("draft-1", ctx)).isError).toBe(true);

    state.draft = { ...saleDraft };
    state.member = false;
    expect((await confirmMcpDraft("draft-1", ctx)).isError).toBe(true);
    expect(events).toEqual([]);
  });
});
