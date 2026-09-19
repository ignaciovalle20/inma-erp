/**
 * The pendientes actions hand back the real failure message (never fail
 * silently) so the row can show it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { rpc: { error: { message: string } | null }; member: boolean } = {
  rpc: { error: null },
  member: true,
};
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return state.rpc;
    },
  }),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () => (state.member ? { company: { name: "Empresa" }, role: "admin" } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

import {
  linkInvoiceAction,
  markPaidAction,
  pairCreditNoteAction,
} from "@/app/companies/[id]/sales/pending/actions";

beforeEach(() => {
  rpcCalls.length = 0;
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.rpc = { error: null };
  state.member = true;
});

describe("pairCreditNoteAction", () => {
  it("calls the pairing RPC and refreshes the screens", async () => {
    const result = await pairCreditNoteAction("company-1", "nc-1", "inv-1");
    expect(result).toEqual({ error: null });
    expect(rpcCalls[0]).toEqual({
      name: "pair_credit_note",
      args: { p_credit_note_id: "nc-1", p_invoice_id: "inv-1" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/sales/pending");
  });

  it("returns the database message when the pairing is refused", async () => {
    state.rpc = { error: { message: "The credit note net amount (100) does not match the invoice (90)" } };
    const result = await pairCreditNoteAction("company-1", "nc-1", "inv-1");
    expect(result.error).toMatch(/does not match the invoice/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("asks for the invoice when none was chosen", async () => {
    const result = await pairCreditNoteAction("company-1", "nc-1", "");
    expect(result.error).toMatch(/Elegí la factura/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a user without access to the company", async () => {
    state.member = false;
    const result = await pairCreditNoteAction("company-1", "nc-1", "inv-1");
    expect(result.error).toMatch(/No tenés acceso/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("linkInvoiceAction", () => {
  it("links the invoice to the chosen job", async () => {
    const result = await linkInvoiceAction("company-1", "inv-1", "job-1");
    expect(result).toEqual({ error: null });
    expect(rpcCalls[0]).toEqual({
      name: "link_sales_document_to_project",
      args: { p_sales_document_id: "inv-1", p_project_id: "job-1" },
    });
  });

  it("returns the database message (e.g. another client's job)", async () => {
    state.rpc = { error: { message: "project_id must belong to the same client as the sales document" } };
    const result = await linkInvoiceAction("company-1", "inv-1", "job-9");
    expect(result.error).toMatch(/same client/);
  });

  it("requires a job", async () => {
    expect((await linkInvoiceAction("company-1", "inv-1", "")).error).toMatch(/Elegí el trabajo/);
  });
});

describe("markPaidAction", () => {
  it("marks the sale as paid with date and method", async () => {
    const result = await markPaidAction("company-1", "sale-1", "2026-09-19", "transferencia");
    expect(result).toEqual({ error: null });
    expect(rpcCalls[0].args).toEqual({
      p_sales_document_id: "sale-1",
      p_paid_at: "2026-09-19",
      p_payment_method: "transferencia",
    });
  });

  it("rejects a missing or malformed date before calling the database", async () => {
    expect((await markPaidAction("company-1", "sale-1", "", "")).error).toMatch(/fecha de pago/);
    expect((await markPaidAction("company-1", "sale-1", "19/09/2026", "")).error).toMatch(/fecha de pago/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns the database message on failure", async () => {
    state.rpc = { error: { message: "Sales document not found or cannot be marked as paid" } };
    const result = await markPaidAction("company-1", "sale-1", "2026-09-19", "");
    expect(result.error).toMatch(/cannot be marked as paid/);
  });
});
