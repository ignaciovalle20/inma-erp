/**
 * The MCP server runs the assistant's own tools under the token owner's
 * session. Confirming a draft must be claimed atomically before anything
 * is created (two confirmations at once, or a retry after a lost
 * response, used to create the document twice) and handed back if saving
 * fails. The database is a small in-memory fake; every id is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type DraftRow = {
  id: string;
  user_id: string;
  company_id: string;
  kind: string;
  payload: Record<string, unknown>;
  expires_at: string;
  consumed_at: string | null;
};

const state: {
  draft: DraftRow | null;
  claimRows: number;
  save: { ok: true; id: string; href: string } | { ok: false; error: string; status: number };
  member: boolean;
  sessionFails: boolean;
  inserted: Record<string, unknown>[];
} = {
  draft: null,
  claimRows: 1,
  save: { ok: true, id: "sale-1", href: "/x" },
  member: true,
  sessionFails: false,
  inserted: [],
};

const events: string[] = [];

function updateBuilder(values: Record<string, unknown>) {
  const builder = {
    eq: () => builder,
    is: () => builder,
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
      if (table !== "mcp_pending_drafts") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.draft, error: null }) }),
        }),
        insert: (row: Record<string, unknown>) => {
          state.inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "draft-9" }, error: null }) }) };
        },
        update: (values: Record<string, unknown>) => updateBuilder(values),
      };
    },
  }),
}));

vi.mock("@/lib/mcp/session", () => {
  class McpSessionError extends Error {}
  return {
    McpSessionError,
    getMcpUserClient: async () => {
      events.push("session");
      if (state.sessionFails) throw new McpSessionError("No se pudo iniciar la sesión del usuario para el MCP.");
      return {};
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  runAsSessionClient: (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => (state.member ? { company: { id: "company-1" }, role: "owner" } : null),
}));

vi.mock("@/lib/ai/saveDraft", () => ({
  saveDraft: async (_companyId: string, draft: { kind: string }) => {
    events.push(`save:${draft.kind}`);
    return state.save;
  },
}));

vi.mock("@/lib/ai/tools", () => ({
  TOOL_DEFINITIONS: [
    { name: "list_companies", description: "x", parameters: { type: "object", properties: {} } },
    { name: "list_clients", description: "x", parameters: { type: "object", properties: {} } },
    {
      name: "propose_sale",
      description: "x",
      parameters: { type: "object", properties: { client_name: { type: "string" } }, required: ["client_name"] },
    },
  ],
  executeTool: async (name: string, _args: unknown, ctx: { companyId: string | null }) => {
    events.push(`tool:${name}:${ctx.companyId}`);
    if (name === "propose_sale") {
      return { result: { ok: true }, draft: { kind: "sale", client_id: "client-1" } };
    }
    return { result: [{ id: "client-1" }] };
  },
}));

import { confirmMcpDraft, executeMcpTool, MCP_TOOL_DEFINITIONS } from "@/lib/mcp/tools";

const saleDraft: DraftRow = {
  id: "draft-1",
  user_id: "user-1",
  company_id: "company-1",
  kind: "sale",
  // Shape parked before this version: no `kind` inside the payload.
  payload: { client_id: "client-1", document_type: "invoice" },
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  consumed_at: null,
};

beforeEach(() => {
  events.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.draft = { ...saleDraft };
  state.claimRows = 1;
  state.save = { ok: true, id: "sale-1", href: "/companies/company-1/sales" };
  state.member = true;
  state.sessionFails = false;
  state.inserted = [];
});

const ctx = { userId: "user-1" };

describe("confirmMcpDraft", () => {
  it("claims the draft, then saves it under the user's session", async () => {
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBeUndefined();
    expect(outcome.result).toEqual({ ok: true, id: "sale-1", href: "/companies/company-1/sales" });
    expect(events).toEqual(["session", expect.stringMatching(/^claim:/), "save:sale"]);
  });

  it("creates nothing when another confirmation claimed the draft first", async () => {
    state.claimRows = 0;
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.result)).toMatch(/ya fue confirmado/);
    expect(events.some((event) => event.startsWith("save:"))).toBe(false);
  });

  it("gives the draft back when saving fails, so it can be retried", async () => {
    state.save = { ok: false, error: "create_failed", status: 500 };
    const outcome = await confirmMcpDraft("draft-1", ctx);

    expect(outcome.isError).toBe(true);
    expect(events).toEqual(["session", expect.stringMatching(/^claim:/), "save:sale", 'update:{"consumed_at":null}']);
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
    expect(events.filter((e) => e !== "session")).toEqual([]);
  });

  it("reports a session that can't be opened instead of failing silently", async () => {
    state.sessionFails = true;
    const outcome = await confirmMcpDraft("draft-1", ctx);
    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.result)).toMatch(/sesión/);
    expect(events).toEqual(["session"]);
  });
});

describe("executeMcpTool", () => {
  it("requires company_id on every company tool, and not on list_companies", () => {
    for (const tool of MCP_TOOL_DEFINITIONS) {
      const required = tool.inputSchema.required ?? [];
      if (tool.name === "list_companies" || tool.name === "confirm_draft") {
        expect(required).not.toContain("company_id");
      } else {
        expect(required).toContain("company_id");
      }
    }
  });

  it("runs the shared tool for the given company", async () => {
    const outcome = await executeMcpTool("list_clients", { company_id: "company-1" }, ctx);
    expect(outcome.result).toEqual([{ id: "client-1" }]);
    expect(events).toEqual(["session", "tool:list_clients:company-1"]);
  });

  it("refuses a company the user doesn't belong to", async () => {
    state.member = false;
    const outcome = await executeMcpTool("list_clients", { company_id: "company-2" }, ctx);
    expect(outcome.isError).toBe(true);
    expect(events).toEqual(["session"]);
  });

  it("parks a proposed draft and returns its id instead of saving", async () => {
    const outcome = await executeMcpTool("propose_sale", { company_id: "company-1", client_name: "x" }, ctx);
    expect(outcome.result).toMatchObject({ draft_id: "draft-9" });
    expect(state.inserted).toEqual([
      { user_id: "user-1", company_id: "company-1", kind: "sale", payload: { kind: "sale", client_id: "client-1" } },
    ]);
    expect(events.some((e) => e.startsWith("save:"))).toBe(false);
  });

  it("does not run confirm_draft or unknown tools through here", async () => {
    expect((await executeMcpTool("confirm_draft", {}, ctx)).isError).toBe(true);
    expect((await executeMcpTool("drop_tables", {}, ctx)).isError).toBe(true);
    expect(events).toEqual([]);
  });
});
