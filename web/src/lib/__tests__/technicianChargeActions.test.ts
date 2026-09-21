/**
 * The charge actions of an external technician (docs/plan-sistema-v3.md, F1):
 * they pick the IVA rate of the country, keep the rate a charge was loaded
 * with when it is corrected, and hand back the real reason when the database
 * refuses (a charge with payments cannot be touched). All data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  rpc: { error: { message: string } | null };
  storedCharge: { data: { vat_rate: number } | null; error: { message: string } | null };
  currency: string;
  member: boolean;
} = { rpc: { error: null }, storedCharge: { data: { vat_rate: 0.19 }, error: null }, currency: "CLP", member: true };

const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return state.rpc;
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => state.storedCharge,
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/dal", () => ({
  getCompanyForEdit: async () =>
    state.member ? { company: { name: "Empresa", currency: state.currency }, role: "admin" } : null,
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import {
  createTechnicianCharge,
  deleteTechnicianCharge,
  setTechnicianChargeDocument,
  updateTechnicianCharge,
  type ChargeFormState,
} from "@/app/companies/[id]/projects/[projectId]/technician-charges/actions";

const emptyState: ChargeFormState = {
  error: null,
  values: { personnel_id: "", charge_date: "", description: "", amount: "", vat_included: false },
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const validFields = {
  personnel_id: "tech-1",
  charge_date: "2026-09-10",
  description: "  Visita  ",
  amount: "122000",
  vat_included: "on",
};

beforeEach(() => {
  rpcCalls.length = 0;
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.rpc = { error: null };
  state.storedCharge = { data: { vat_rate: 0.19 }, error: null };
  state.currency = "CLP";
  state.member = true;
});

describe("createTechnicianCharge", () => {
  it("uses 22% in Uruguay and goes back to the job", async () => {
    state.currency = "UYU";

    await expect(
      createTechnicianCharge("company-1", "job-1", emptyState, form(validFields)),
    ).rejects.toThrow("REDIRECT:/companies/company-1/projects/job-1");

    expect(rpcCalls[0]).toEqual({
      name: "create_technician_charge",
      args: {
        p_project_id: "job-1",
        p_personnel_id: "tech-1",
        p_description: "Visita",
        p_charge_date: "2026-09-10",
        p_amount: 122000,
        p_vat_included: true,
        p_vat_rate: 0.22,
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/job-1");
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/board");
  });

  it("uses 19% in Chile, and no description when it is blank", async () => {
    await expect(
      createTechnicianCharge(
        "company-1",
        "job-1",
        emptyState,
        form({ ...validFields, description: "   ", vat_included: "" }),
      ),
    ).rejects.toThrow("REDIRECT");

    expect(rpcCalls[0].args).toMatchObject({ p_vat_rate: 0.19, p_description: null, p_vat_included: false });
  });

  it("checks the form before calling the database", async () => {
    const noTechnician = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, personnel_id: "" }));
    const badDate = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, charge_date: "10/09/2026" }));
    const zero = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, amount: "0" }));
    const empty = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, amount: "" }));

    expect(noTechnician.error).toMatch(/Elegí el técnico/);
    expect(badDate.error).toMatch(/fecha/);
    expect(zero.error).toMatch(/mayor a cero/);
    expect(empty.error).toMatch(/mayor a cero/);
    expect(rpcCalls).toHaveLength(0);
    // What was typed comes back, so the form does not lose it.
    expect(zero.values.description).toBe("  Visita  ");
  });

  it("reads the amount with the local convention: 122.000 is 122000, not 122", async () => {
    await expect(
      createTechnicianCharge("company-1", "job-1", emptyState, form({ ...validFields, amount: "122.000" })),
    ).rejects.toThrow("REDIRECT");
    await expect(
      createTechnicianCharge("company-1", "job-1", emptyState, form({ ...validFields, amount: "9.500,50" })),
    ).rejects.toThrow("REDIRECT");

    expect(rpcCalls.map((call) => call.args.p_amount)).toEqual([122000, 9500.5]);
  });

  it("refuses an amount it cannot read instead of saving a guess", async () => {
    const ambiguous = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, amount: "122,000" }));
    const text = await createTechnicianCharge("c", "j", emptyState, form({ ...validFields, amount: "mil" }));

    expect(ambiguous.error).toMatch(/^Monto inválido "122,000": es ambiguo/);
    expect(text.error).toMatch(/^Monto inválido "mil"/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("says the migration is missing instead of a raw error", async () => {
    state.rpc = {
      error: { message: "Could not find the function public.create_technician_charge(p_amount) in the schema cache" },
    };
    const result = await createTechnicianCharge("company-1", "job-1", emptyState, form(validFields));
    expect(result.error).toMatch(/Falta aplicar la migración/);
  });

  it("returns the database message when it refuses", async () => {
    state.rpc = { error: { message: "Only external technicians can have technician charges" } };
    const result = await createTechnicianCharge("company-1", "job-1", emptyState, form(validFields));
    expect(result.error).toMatch(/external technicians/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a user without access to the company", async () => {
    state.member = false;
    const result = await createTechnicianCharge("company-1", "job-1", emptyState, form(validFields));
    expect(result.error).toMatch(/No tenés acceso/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("updateTechnicianCharge", () => {
  it("keeps the rate the charge was loaded with, not today's", async () => {
    state.currency = "UYU"; // today's rate would be 22%
    state.storedCharge = { data: { vat_rate: 0.19 }, error: null };

    await expect(
      updateTechnicianCharge("company-1", "job-1", "charge-1", emptyState, form(validFields)),
    ).rejects.toThrow("REDIRECT:/companies/company-1/projects/job-1");

    expect(rpcCalls[0].name).toBe("update_technician_charge");
    expect(rpcCalls[0].args).toMatchObject({ p_charge_id: "charge-1", p_vat_rate: 0.19, p_amount: 122000 });
  });

  it("reads the corrected amount with the local convention too", async () => {
    await expect(
      updateTechnicianCharge("company-1", "job-1", "charge-1", emptyState, form({ ...validFields, amount: "85.000" })),
    ).rejects.toThrow("REDIRECT");

    expect(rpcCalls[0].args).toMatchObject({ p_amount: 85000 });
  });

  it("explains that a charge with payments cannot be corrected", async () => {
    state.rpc = { error: { message: "This charge already has payments applied: delete those payments first" } };
    const result = await updateTechnicianCharge("company-1", "job-1", "charge-1", emptyState, form(validFields));
    expect(result.error).toMatch(/ya tiene pagos aplicados/);
  });

  it("says so when the charge cannot be found or read", async () => {
    state.storedCharge = { data: null, error: null };
    expect((await updateTechnicianCharge("c", "j", "x", emptyState, form(validFields))).error).toMatch(
      /No se encontró el cargo/,
    );

    state.storedCharge = { data: null, error: { message: "boom" } };
    expect((await updateTechnicianCharge("c", "j", "x", emptyState, form(validFields))).error).toBe("boom");
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("deleteTechnicianCharge", () => {
  it("deletes and goes back to the job", async () => {
    await expect(deleteTechnicianCharge("company-1", "job-1", "charge-1")).rejects.toThrow(
      "REDIRECT:/companies/company-1/projects/job-1",
    );
    expect(rpcCalls[0]).toEqual({ name: "delete_technician_charge", args: { p_charge_id: "charge-1" } });
  });

  it("stays on the screen with the reason when the charge has payments", async () => {
    state.rpc = { error: { message: "This charge already has payments applied: delete those payments first" } };
    const result = await deleteTechnicianCharge("company-1", "job-1", "charge-1");
    expect(result.error).toMatch(/pagos aplicados/);
  });
});

describe("setTechnicianChargeDocument", () => {
  it("marks the document as received and refreshes the job, the board and the saldo", async () => {
    const result = await setTechnicianChargeDocument("company-1", "job-1", "charge-1", "recibida");

    expect(result).toEqual({ error: null });
    expect(rpcCalls[0]).toEqual({
      name: "set_technician_charge_document",
      args: { p_charge_id: "charge-1", p_document_status: "recibida" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/job-1");
    expect(revalidatePath).toHaveBeenCalledWith("/companies/company-1/projects/board");
  });

  it("returns the database message on failure", async () => {
    state.rpc = { error: { message: "Technician charge not found" } };
    const result = await setTechnicianChargeDocument("company-1", "job-1", "charge-1", "pendiente");
    expect(result.error).toBe("Technician charge not found");
  });
});
