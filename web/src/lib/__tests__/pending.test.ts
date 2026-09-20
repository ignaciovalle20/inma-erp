/**
 * Pendientes (docs/plan-sistema-v3.md, B1 and B2): every list is cut at the
 * company's "gestionar desde" date, "revisar cobro" is about invoices overdue
 * for more than 60 days, and what the cut hides is only counted. The database
 * is a recording fake; every client and folio is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { method: string; args: unknown[] };
type Result = { data?: unknown; count?: number | null; error: { message: string } | null };

const state: {
  managementStartDate: string | null;
  companyError: { message: string } | null;
  /** Decides the answer of every query from what was asked. */
  answer: (query: { table: string; kind: string; calls: Call[] }) => Result;
} = {
  managementStartDate: "2026-01-01",
  companyError: null,
  answer: () => ({ data: [], count: 0, error: null }),
};

const queries: { table: string; kind: string; calls: Call[] }[] = [];

/** Which of the pending queries this is, from its filters. */
function kindOf(calls: Call[]): string {
  const has = (method: string, ...args: unknown[]) =>
    calls.some((call) => call.method === method && args.every((arg, index) => call.args[index] === arg));
  const head = calls.some((call) => call.method === "select" && (call.args[1] as { head?: boolean } | undefined)?.head);
  const base = has("eq", "document_type", "credit_note")
    ? "notes"
    : has("eq", "payment_status", "vencido")
      ? "stale"
      : has("eq", "document_type", "manual")
        ? "manual"
        : has("eq", "document_type", "invoice")
          ? "unlinked"
          : "other";
  return head ? `${base}-count` : base;
}

function builder(table: string) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "not", "in", "gte", "lt", "order"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  const finish = (): Result => {
    if (table === "companies") {
      return state.companyError
        ? { error: state.companyError }
        : { data: { management_start_date: state.managementStartDate }, error: null };
    }
    const query = { table, kind: kindOf(calls), calls };
    queries.push(query);
    return state.answer(query);
  };
  chain.maybeSingle = async () => finish();
  chain.then = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(finish()).then(resolve, reject);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => builder(table),
  }),
}));

import { getSalesPending } from "@/lib/dal";
import {
  STALE_OVERDUE_DAYS,
  isOutsideManagement,
  parseManagementStartDate,
  staleDueCutoff,
} from "@/lib/pending";

const TODAY = new Date("2026-09-20T15:00:00Z");

function ask(kind: string, key: "gte" | "lt" | "eq", column: string) {
  const query = queries.find((entry) => entry.kind === kind);
  return query?.calls.find((call) => call.method === key && call.args[0] === column)?.args[1];
}

beforeEach(() => {
  queries.length = 0;
  state.managementStartDate = "2026-01-01";
  state.companyError = null;
  state.answer = () => ({ data: [], count: 0, error: null });
});

describe("staleDueCutoff", () => {
  it("is the due date 60 days before today, in calendar days", () => {
    expect(STALE_OVERDUE_DAYS).toBe(60);
    expect(staleDueCutoff(new Date("2026-09-20T15:00:00Z"))).toBe("2026-07-22");
    expect(staleDueCutoff(new Date("2026-03-01T00:00:00Z"))).toBe("2025-12-31");
  });

  it("does not move with the time of day", () => {
    expect(staleDueCutoff(new Date("2026-09-20T00:00:00Z"))).toBe(staleDueCutoff(new Date("2026-09-20T23:59:59Z")));
  });
});

describe("isOutsideManagement", () => {
  it("is only about dates before the start, and never with no start", () => {
    expect(isOutsideManagement("2025-12-31", "2026-01-01")).toBe(true);
    expect(isOutsideManagement("2026-01-01", "2026-01-01")).toBe(false);
    expect(isOutsideManagement("2022-09-01", null)).toBe(false);
  });
});

describe("parseManagementStartDate", () => {
  it("reads a real date, and empty as no limit", () => {
    expect(parseManagementStartDate("2026-01-01")).toEqual({ ok: true, value: "2026-01-01" });
    expect(parseManagementStartDate("  2026-04-15 ")).toEqual({ ok: true, value: "2026-04-15" });
    expect(parseManagementStartDate("")).toEqual({ ok: true, value: null });
    expect(parseManagementStartDate(null)).toEqual({ ok: true, value: null });
  });

  it.each(["2026-02-30", "2026-13-01", "01/01/2026", "2026-1-1", "mañana", "2026-00-10"])("rejects %s", (value) => {
    expect(parseManagementStartDate(value)).toEqual({ ok: false });
  });
});

describe("getSalesPending", () => {
  it("cuts the four lists at the start date and counts what it hides before it", async () => {
    await getSalesPending("company-1", TODAY);

    for (const kind of ["notes", "unlinked", "stale", "manual"]) {
      expect(ask(kind, "gte", "document_date")).toBe("2026-01-01");
    }
    for (const kind of ["notes-count", "unlinked-count", "manual-count"]) {
      expect(ask(kind, "lt", "document_date")).toBe("2026-01-01");
    }
  });

  it("follows the date: a different start moves every cut, with nothing else changing", async () => {
    state.managementStartDate = "2026-06-01";
    await getSalesPending("company-1", TODAY);

    for (const kind of ["notes", "unlinked", "stale", "manual"]) {
      expect(ask(kind, "gte", "document_date")).toBe("2026-06-01");
    }
    expect(ask("unlinked-count", "lt", "document_date")).toBe("2026-06-01");
  });

  it("with no start date lists everything and hides nothing", async () => {
    state.managementStartDate = null;
    const pending = await getSalesPending("company-1", TODAY);

    for (const kind of ["notes", "unlinked", "stale", "manual"]) {
      expect(ask(kind, "gte", "document_date")).toBeUndefined();
    }
    // The counts are not even asked: there is no "before" to count.
    expect(queries.some((query) => query.kind.endsWith("-count"))).toBe(false);
    expect(pending.managementStartDate).toBeNull();
    expect(pending.outsideManagement).toEqual({ total: 0, creditNotes: 0, invoices: 0, manualSales: 0 });
  });

  it("'revisar cobro' asks for vencido invoices due more than 60 days ago", async () => {
    await getSalesPending("company-1", TODAY);

    expect(ask("stale", "eq", "payment_status")).toBe("vencido");
    expect(ask("stale", "lt", "due_date")).toBe("2026-07-22");
    // Not the old rule: it no longer looks at the oldest date of the last file.
    expect(queries.some((query) => query.table === "import_batches")).toBe(false);
  });

  it("reports what the cut hides, by kind and in total", async () => {
    state.answer = ({ kind }) => {
      const counts: Record<string, number> = { "notes-count": 165, "unlinked-count": 1487, "manual-count": 3 };
      return kind in counts ? { count: counts[kind], error: null } : { data: [], count: 0, error: null };
    };
    const pending = await getSalesPending("company-1", TODAY);

    expect(pending.outsideManagement).toEqual({ creditNotes: 165, invoices: 1487, manualSales: 3, total: 1655 });
    expect(pending.managementStartDate).toBe("2026-01-01");
  });

  it("says which list failed instead of showing an empty one", async () => {
    state.answer = ({ kind }) =>
      kind === "stale" ? { error: { message: "boom" } } : { data: [], count: 0, error: null };

    await expect(getSalesPending("company-1", TODAY)).rejects.toThrow(/No se pudieron leer las facturas vencidas: boom/);
  });

  it("names the migration when the company has no date column yet", async () => {
    state.companyError = { message: 'column companies.management_start_date does not exist' };

    await expect(getSalesPending("company-1", TODAY)).rejects.toThrow(
      /fecha de gestión.*20260921010000_companies_management_start_date/,
    );
  });
});
