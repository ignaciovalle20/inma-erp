/**
 * Facturar / Cobrar / Anular on the recurring-services Pendientes screen:
 * company check, allowed source states, race protection, and the date
 * stamped in the company's own time zone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = {
  status: string;
  recurring_services: { company_id: string; companies: { country: string | null } };
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

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

import {
  markOccurrenceInvoiced,
  markOccurrenceCollected,
  voidOccurrence,
} from "@/app/companies/[id]/recurring-services/pending/actions";

const rowIn = (status: string, companyId = "company-1", country: string | null = "CL"): Row => ({
  status,
  recurring_services: { company_id: companyId, companies: { country } },
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
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/recurring-services/pending");
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/recurring-services");
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

  it("can't skip Facturado", async () => {
    state.row = rowIn("pending_invoice");
    expect((await markOccurrenceCollected("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });
});

describe("voidOccurrence", () => {
  it.each(["pending_invoice", "invoiced"])("voids from %s without stamping a date", async (status) => {
    state.row = rowIn(status);
    const result = await voidOccurrence("company-1", "occ-1");
    expect(result).toEqual({ error: null });
    expect(updates[0].changes).toEqual({ status: "void" });
    expect(updates[0].filters).toContainEqual(["status", ["pending_invoice", "invoiced"]]);
  });

  it.each(["collected", "void"])("can't void a %s occurrence", async (status) => {
    state.row = rowIn(status);
    expect((await voidOccurrence("company-1", "occ-1")).error).toMatch(/ya cambió de estado/);
    expect(updates).toHaveLength(0);
  });
});
