/**
 * The sales list's Pagadas / Impagas filter: a credit note has no payment
 * status, so filtering by one never lists it (e2e found it under Impagas:
 * it is stored with the default 'impago'). The database is a recording fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { method: string; args: unknown[] };
const calls: Call[] = [];

function builder() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "is", "not", "in", "gte", "lt", "order"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.range = async () => ({ data: [], error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => builder(),
  }),
}));

import { getSalesListRows } from "@/lib/dal";

const asked = (method: string, column: string) =>
  calls.filter((call) => call.method === method && call.args[0] === column).map((call) => call.args[1]);

beforeEach(() => {
  calls.length = 0;
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
