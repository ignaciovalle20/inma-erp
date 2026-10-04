/**
 * Facturado / Cobrado / Deshacer / Anular / edit on the recurring-services
 * board cards: company check, allowed source states, race protection, the
 * date stamped in the company's own time zone, and the country's
 * currency rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = {
  status: string;
  invoiced_at: string | null;
  recurring_service_id: string;
  sales_document_id: string | null;
  recurring_services: {
    company_id: string;
    client_id: string;
    country: string | null;
    companies: { country: string | null };
  };
} | null;

const state: {
  row: Row;
  selectError: { message: string } | null;
  updateError: { message: string } | null;
  updatedRows: { id: string }[];
} = { row: null, selectError: null, updateError: null, updatedRows: [] };

const updates: { changes: Record<string, unknown>; filters: [string, unknown][] }[] = [];
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: state.row, error: state.selectError }),
        }),
      }),
      update: (changes: Record<string, unknown>) => {
        const entry = { changes, filters: [] as [string, unknown][] };
        updates.push(entry);
        const builder = {
          eq: (col: string, value: unknown) => (entry.filters.push([col, value]), builder),
          in: (col: string, value: unknown) => (entry.filters.push([col, value]), builder),
          select: async () => ({ data: state.updatedRows, error: state.updateError }),
        };
        return builder;
      },
    }),
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));

import {
  markOccurrenceInvoiced,
  markOccurrenceCollected,
  undoOccurrenceInvoiced,
  undoOccurrenceCollected,
  updateOccurrenceDetails,
  voidOccurrence,
} from "@/app/companies/[id]/recurring-services/occurrence-actions";

const rowIn = (
  status: string,
  companyId = "company-1",
  country: string | null = "CL",
  invoicedAt: string | null = null,
): Row => ({
  status,
  invoiced_at: invoicedAt,
  recurring_service_id: "service-1",
  sales_document_id: null,
  recurring_services: { company_id: companyId, client_id: "client-1", country, companies: { country } },
});

beforeEach(() => {
  updates.length = 0;
  revalidatePath.mockClear();
  state.row = null;
  state.selectError = null;
  state.updateError = null;
  state.updatedRows = [{ id: "occ-1" }];
  vi.spyOn(console, "error").mockImplementation(() => {});
  // 01:30 UTC on the 23rd = still the evening of the 22nd in Chile/Uruguay.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T01:30:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("markOccurrenceInvoiced", () => {
  it("moves pending_invoice -> invoiced, stamped with the company's local date", async () => {
    state.row = rowIn("pending_invoice");
    const result = await markOccurrenceInvoiced("company-1", "occ-1");

    expect(result).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "invoiced", invoiced_at: "2026-09-22" });
    expect(updates[0].filters).toEqual([
      ["id", "occ-1"],
      ["status", ["pending_invoice"]],
    ]);
    // The whole module: month board, Deuda, list and service history.
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/recurring-services", "layout");
  });

  it("refuses an occurrence of another company without writing", async () => {
    state.row = rowIn("pending_invoice", "company-2");
    const result = await markOccurrenceInvoiced("company-1", "occ-1");
    expect(result.error).toMatch(/No se encontró/);
    expect(updates).toHaveLength(0);
  });

  it("refuses a missing occurrence", async () => {
    const result = await markOccurrenceInvoiced("company-1", "occ-1");
    expect(result.error).toMatch(/No se encontró/);
    expect(updates).toHaveLength(0);
  });

  it("refuses when it is no longer pending_invoice", async () => {
    state.row = rowIn("invoiced");
    const result = await markOccurrenceInvoiced("company-1", "occ-1");
    expect(result.error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });

  it("reports the race when someone else changed it between the check and the update", async () => {
    state.row = rowIn("pending_invoice");
    state.updatedRows = [];
    const result = await markOccurrenceInvoiced("company-1", "occ-1");
    expect(result.error).toMatch(/ya cambió de estado/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns a generic message (and logs) when the database fails", async () => {
    state.selectError = { message: "boom" };
    expect((await markOccurrenceInvoiced("company-1", "occ-1")).error).toMatch(/Algo salió mal/);

    state.selectError = null;
    state.row = rowIn("pending_invoice");
    state.updateError = { message: "boom" };
    expect((await markOccurrenceInvoiced("company-1", "occ-1")).error).toMatch(/Algo salió mal/);
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});

describe("markOccurrenceCollected", () => {
  it("moves invoiced -> collected with collected_at", async () => {
    state.row = rowIn("invoiced", "company-1", "UY");
    const result = await markOccurrenceCollected("company-1", "occ-1");
    expect(result).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "collected", collected_at: "2026-09-22" });
  });

  it("moves pending_collection (service without invoice) -> collected", async () => {
    state.row = rowIn("pending_collection");
    expect(await markOccurrenceCollected("company-1", "occ-1")).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "collected", collected_at: "2026-09-22" });
    expect(updates[0].filters).toContainEqual(["status", ["invoiced", "pending_collection"]]);
  });

  it("can't skip Facturado", async () => {
    state.row = rowIn("pending_invoice");
    expect((await markOccurrenceCollected("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });
});

describe("undo", () => {
  it("Deshacer facturado goes back to Facturar and unlinks the invoice", async () => {
    state.row = rowIn("invoiced", "company-1", "CL", "2026-09-20");
    expect(await undoOccurrenceInvoiced("company-1", "occ-1")).toEqual({ error: null });
    expect(updates[0].changes).toEqual({
      status: "pending_invoice",
      invoiced_at: null,
      sales_document_id: null,
    });
    expect(updates[0].filters).toContainEqual(["status", ["invoiced"]]);
  });

  it("Deshacer cobrado goes back to invoiced when it had been invoiced", async () => {
    state.row = rowIn("collected", "company-1", "CL", "2026-09-20");
    expect(await undoOccurrenceCollected("company-1", "occ-1")).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "invoiced", collected_at: null });
  });

  it("Deshacer cobrado goes back to pending_collection for a service without invoice", async () => {
    state.row = rowIn("collected");
    expect(await undoOccurrenceCollected("company-1", "occ-1")).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "pending_collection", collected_at: null });
  });

  it("can't undo what isn't there", async () => {
    state.row = rowIn("pending_invoice");
    expect((await undoOccurrenceInvoiced("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect((await undoOccurrenceCollected("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });
});

describe("updateOccurrenceDetails", () => {
  const values = { amount: "1500", currency: "USD", dueDate: "2026-10-05", note: " HES 123 " };

  it("forces CLP for a Chile service, whatever was sent", async () => {
    state.row = rowIn("pending_invoice", "company-1", "CL");
    expect(await updateOccurrenceDetails("company-1", "occ-1", values)).toEqual({ error: null });
    expect(updates[0].changes).toEqual({
      amount: 1500,
      currency: "CLP",
      invoice_due_date: "2026-10-05",
      collection_due_date: "2026-10-05",
      note: "HES 123",
    });
  });

  it("accepts USD/UYU for Uruguay and refuses anything else", async () => {
    state.row = rowIn("invoiced", "company-1", "UY");
    expect(await updateOccurrenceDetails("company-1", "occ-1", values)).toEqual({ error: null });
    expect(updates[0].changes.currency).toBe("USD");

    expect((await updateOccurrenceDetails("company-1", "occ-1", { ...values, currency: "CLP" })).error).toMatch(
      /USD o UYU/,
    );
    expect((await updateOccurrenceDetails("company-1", "occ-1", { ...values, currency: "" })).error).toMatch(
      /USD o UYU/,
    );
    expect(updates).toHaveLength(1);
  });

  it("refuses a bad amount or a voided cycle", async () => {
    state.row = rowIn("pending_invoice");
    expect((await updateOccurrenceDetails("company-1", "occ-1", { ...values, amount: "abc" })).error).toMatch(/monto/);
    state.row = rowIn("void");
    expect((await updateOccurrenceDetails("company-1", "occ-1", values)).error).toMatch(/anulado/);
    expect(updates).toHaveLength(0);
  });
});

describe("voidOccurrence", () => {
  it.each(["pending_invoice", "invoiced", "pending_collection"])("voids from %s without stamping a date", async (status) => {
    state.row = rowIn(status);
    const result = await voidOccurrence("company-1", "occ-1");
    expect(result).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "void" });
    expect(updates[0].filters).toContainEqual(["status", ["pending_invoice", "invoiced", "pending_collection"]]);
  });

  it.each(["collected", "void"])("can't void a %s occurrence", async (status) => {
    state.row = rowIn(status);
    expect((await voidOccurrence("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });
});
