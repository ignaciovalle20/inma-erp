/**
 * The technician readers add up what was paid on each charge, and THROW when
 * a query fails: a saldo built from a failed read would read as "we owe
 * nothing". Same method as dalErrors.test.ts: the real reader, queued rows
 * standing in for the API. All data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSupabase, type FakeResult } from "./fakeSupabase";

const fakeState: { queues: Record<string, FakeResult[]> } = { queues: {} };

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => createFakeSupabase(fakeState.queues),
}));

const ok = (data: unknown = []): FakeResult => ({ data, error: null });
const failure = (message: string): FakeResult => ({ data: null, error: { message } });

function queue(table: string, ...results: FakeResult[]) {
  fakeState.queues[table] = results;
}

const chargeRow = (overrides: Record<string, unknown> = {}) => ({
  id: "charge-1",
  company_id: "company-1",
  project_id: "job-1",
  personnel_id: "tech-1",
  cost_document_id: "cost-1",
  description: "Visita",
  charge_date: "2026-09-10",
  amount: 100000,
  vat_included: false,
  vat_rate: 0.19,
  net_amount: 100000,
  document_status: "pendiente",
  projects: { name: "Trabajo A" },
  personnel: { name: "Técnico Prueba" },
  ...overrides,
});

beforeEach(() => {
  fakeState.queues = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getTechnicianCharges", () => {
  it("adds up the payments applied to each charge", async () => {
    const { getTechnicianCharges } = await import("@/lib/technicianDal");
    queue(
      "technician_payment_applications",
      ok([
        { payment_id: "pay-1", charge_id: "charge-1", amount: 30000 },
        { payment_id: "pay-2", charge_id: "charge-1", amount: 20000 },
        { payment_id: "pay-2", charge_id: "charge-2", amount: 80000 },
      ]),
    );
    queue(
      "technician_charges",
      ok([chargeRow(), chargeRow({ id: "charge-2", amount: 80000, net_amount: 80000, project_id: "job-2" }), chargeRow({ id: "charge-3" })]),
    );

    const charges = await getTechnicianCharges("company-1");

    expect(charges.map((c) => [c.id, c.paid, c.outstanding])).toEqual([
      ["charge-1", 50000, 50000],
      ["charge-2", 80000, 0],
      ["charge-3", 0, 100000],
    ]);
    expect(charges[0].project_name).toBe("Trabajo A");
    expect(charges[0].personnel_name).toBe("Técnico Prueba");
  });

  it("throws when the charges cannot be read, saying which read failed", async () => {
    const { getTechnicianCharges } = await import("@/lib/technicianDal");
    queue("technician_payment_applications", ok());
    queue("technician_charges", failure("statement timeout"));

    await expect(getTechnicianCharges("company-1")).rejects.toThrow(
      "No se pudieron leer los cargos de técnicos: statement timeout",
    );
  });

  it("throws when the payments cannot be read: the saldo would look higher than it is", async () => {
    const { getTechnicianCharges } = await import("@/lib/technicianDal");
    queue("technician_payment_applications", failure("connection reset"));
    queue("technician_charges", ok([chargeRow()]));

    await expect(getTechnicianCharges("company-1")).rejects.toThrow(
      "No se pudieron leer los pagos a técnicos: connection reset",
    );
  });

  it("is fine with a company that has no technicians", async () => {
    const { getTechnicianCharges } = await import("@/lib/technicianDal");
    queue("technician_payment_applications", ok());
    queue("technician_charges", ok());

    await expect(getTechnicianCharges("company-1")).resolves.toEqual([]);
  });
});

describe("getTechnicianAccount", () => {
  it("lists each payment with the charges it covered", async () => {
    const { getTechnicianAccount } = await import("@/lib/technicianDal");
    queue(
      "technician_payment_applications",
      ok([
        { payment_id: "pay-1", charge_id: "charge-1", amount: 100000 },
        { payment_id: "pay-1", charge_id: "charge-2", amount: 30000 },
      ]),
    );
    queue("technician_charges", ok([chargeRow(), chargeRow({ id: "charge-2", amount: 80000, net_amount: 80000 })]));
    queue(
      "technician_payments",
      ok([{ id: "pay-1", personnel_id: "tech-1", payment_date: "2026-09-15", amount: 130000, method: "transferencia", notes: null }]),
    );

    const account = await getTechnicianAccount("company-1", "tech-1");

    expect(account.payments).toEqual([
      {
        id: "pay-1",
        personnel_id: "tech-1",
        payment_date: "2026-09-15",
        amount: 130000,
        method: "transferencia",
        notes: null,
        applications: [
          { charge_id: "charge-1", amount: 100000 },
          { charge_id: "charge-2", amount: 30000 },
        ],
      },
    ]);
    expect(account.charges.map((c) => c.outstanding)).toEqual([0, 50000]);
  });

  it("throws when the payments of the technician cannot be read", async () => {
    const { getTechnicianAccount } = await import("@/lib/technicianDal");
    queue("technician_payment_applications", ok());
    queue("technician_charges", ok());
    queue("technician_payments", failure("permission denied"));

    await expect(getTechnicianAccount("company-1", "tech-1")).rejects.toThrow(
      "No se pudieron leer los pagos del técnico: permission denied",
    );
  });
});
