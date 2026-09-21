/**
 * The payment actions of an external technician (docs/plan-sistema-v3.md, F1):
 * one payment covers several charges of the SAME technician, never more than
 * what a charge still owes, and the split has to add up to the payment. The
 * action checks it against what is owed right now, before the database does.
 * All data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const state: {
  rpc: { error: { message: string } | null };
  account: { charges: { id: string; outstanding: number }[] } | Error;
  member: boolean;
} = {
  rpc: { error: null },
  account: {
    // The technician owes 100.000 on job A and 80.000 on job B; job C is paid off.
    charges: [
      { id: "charge-a", outstanding: 100000 },
      { id: "charge-b", outstanding: 80000 },
      { id: "charge-c", outstanding: 0 },
    ],
  },
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
  getCompanyForEdit: async () => (state.member ? { company: { name: "Empresa", currency: "CLP" }, role: "admin" } : null),
}));

vi.mock("@/lib/technicianDal", () => ({
  getTechnicianAccount: async () => {
    if (state.account instanceof Error) throw state.account;
    return { charges: state.account.charges, payments: [] };
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

import {
  deleteTechnicianPayment,
  recordTechnicianPayment,
  type PaymentFormState,
} from "@/app/companies/[id]/personnel/[personnelId]/account/actions";

const initial: PaymentFormState = { error: null, saved: false };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const twoCharges = JSON.stringify([
  { chargeId: "charge-a", amount: 100000 },
  { chargeId: "charge-b", amount: 30000 },
]);

const validFields = {
  payment_date: "2026-09-15",
  amount: "130000",
  method: " Transferencia ",
  notes: "",
  applications: twoCharges,
};

beforeEach(() => {
  rpcCalls.length = 0;
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.rpc = { error: null };
  state.member = true;
  state.account = {
    charges: [
      { id: "charge-a", outstanding: 100000 },
      { id: "charge-b", outstanding: 80000 },
      { id: "charge-c", outstanding: 0 },
    ],
  };
});

describe("recordTechnicianPayment", () => {
  it("records one payment that covers two jobs (the F1 acceptance case)", async () => {
    const result = await recordTechnicianPayment("company-1", "tech-1", initial, form(validFields));

    expect(result).toEqual({ error: null, saved: true });
    expect(rpcCalls).toEqual([
      {
        name: "record_technician_payment",
        args: {
          p_personnel_id: "tech-1",
          p_payment_date: "2026-09-15",
          p_amount: 130000,
          p_method: "Transferencia",
          p_notes: null,
          p_applications: [
            { charge_id: "charge-a", amount: 100000 },
            { charge_id: "charge-b", amount: 30000 },
          ],
        },
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/personnel/tech-1/account");
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/personnel");
  });

  it("refuses to pay a charge more than it is owed", async () => {
    const result = await recordTechnicianPayment(
      "company-1",
      "tech-1",
      initial,
      form({
        ...validFields,
        amount: "90000",
        applications: JSON.stringify([{ chargeId: "charge-b", amount: 90000 }]),
      }),
    );

    expect(result.error).toMatch(/más de lo que falta/);
    expect(result.saved).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a charge that is not this technician's, or that is already paid off", async () => {
    const other = await recordTechnicianPayment(
      "company-1",
      "tech-1",
      initial,
      form({ ...validFields, amount: "500", applications: JSON.stringify([{ chargeId: "somebody-else", amount: 500 }]) }),
    );
    const paidOff = await recordTechnicianPayment(
      "company-1",
      "tech-1",
      initial,
      form({ ...validFields, amount: "500", applications: JSON.stringify([{ chargeId: "charge-c", amount: 500 }]) }),
    );

    expect(other.error).toMatch(/no es de este técnico/);
    expect(paidOff.error).toMatch(/no es de este técnico/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a split that does not add up to the payment", async () => {
    const result = await recordTechnicianPayment(
      "company-1",
      "tech-1",
      initial,
      form({ ...validFields, amount: "150000" }),
    );

    expect(result.error).toMatch(/sumar exactamente/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("checks the date and the split before anything else", async () => {
    expect((await recordTechnicianPayment("c", "t", initial, form({ ...validFields, payment_date: "" }))).error).toMatch(
      /fecha del pago/,
    );
    expect(
      (await recordTechnicianPayment("c", "t", initial, form({ ...validFields, applications: "not json" }))).error,
    ).toMatch(/recargá la página/);
    expect(
      (await recordTechnicianPayment("c", "t", initial, form({ ...validFields, applications: '[{"chargeId":1}]' })))
        .error,
    ).toMatch(/recargá la página/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("returns the database reason when it refuses", async () => {
    state.rpc = { error: { message: "The payment applied to a charge (130000) cannot exceed its amount (100000)" } };
    const result = await recordTechnicianPayment("company-1", "tech-1", initial, form(validFields));

    expect(result.error).toMatch(/no puede aplicarse a un cargo por más/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says so when what is owed cannot be read, instead of paying blind", async () => {
    state.account = new Error("No se pudieron leer los cargos de técnicos: timeout");
    const result = await recordTechnicianPayment("company-1", "tech-1", initial, form(validFields));

    expect(result.error).toMatch(/No se pudieron leer los cargos/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a user without access to the company", async () => {
    state.member = false;
    const result = await recordTechnicianPayment("company-1", "tech-1", initial, form(validFields));

    expect(result.error).toMatch(/No tenés acceso/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("deleteTechnicianPayment", () => {
  it("deletes the payment and refreshes the account", async () => {
    const result = await deleteTechnicianPayment("company-1", "tech-1", "pay-1");

    expect(result).toEqual({ error: null });
    expect(rpcCalls[0]).toEqual({ name: "delete_technician_payment", args: { p_payment_id: "pay-1" } });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/personnel/tech-1/account");
  });

  it("returns the database message when it cannot", async () => {
    state.rpc = { error: { message: "Technician payment not found" } };
    const result = await deleteTechnicianPayment("company-1", "tech-1", "pay-9");

    expect(result.error).toBe("Technician payment not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
