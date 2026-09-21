/**
 * Creating and editing a person in Personal, in particular an external
 * technician (docs/plan-sistema-v3.md, F1): what is sent to the database, the
 * ficha only for technicians, rates read with the local convention, and the
 * real reason on screen when the database refuses. All data invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state: {
  insert: { error: { message: string } | null };
  update: { data: { id: string }[] | null; error: { message: string } | null };
} = { insert: { error: null }, update: { data: [{ id: "person-1" }], error: null } };

const inserted: Record<string, unknown>[] = [];
const updated: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== "personnel") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return state.insert;
        },
        update: (row: Record<string, unknown>) => {
          updated.push(row);
          const chain = {
            eq: () => chain,
            select: async () => state.update,
          };
          return chain;
        },
      };
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { createPersonnel, type CreatePersonnelState } from "@/app/companies/[id]/personnel/new/actions";
import { updatePersonnel } from "@/app/companies/[id]/personnel/[personnelId]/edit/actions";
import { EMPTY_TECHNICIAN_FORM } from "@/lib/technicians";

const emptyState: CreatePersonnelState = {
  error: null,
  values: { name: "", type: "employee", ...EMPTY_TECHNICIAN_FORM },
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const technician = {
  name: "  Técnico Uno  ",
  type: "contractor",
  tax_id: " 12.345.678-5 ",
  payment_document: "boleta_honorarios",
  rate_visit: "25.000",
  rate_hour: "",
  rate_network_point: "9500,5",
  payment_details: " Banco Prueba, cuenta 000 ",
};

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.insert = { error: null };
  state.update = { data: [{ id: "person-1" }], error: null };
});

describe("createPersonnel", () => {
  it("creates an external technician with their ficha and goes back to Personal", async () => {
    await expect(createPersonnel("company-1", emptyState, form(technician))).rejects.toThrow(
      "REDIRECT:/companies/company-1/personnel",
    );

    expect(inserted).toEqual([
      {
        company_id: "company-1",
        name: "Técnico Uno",
        type: "contractor",
        tax_id: "12.345.678-5",
        payment_document: "boleta_honorarios",
        default_rates: { visit: 25000, network_point: 9500.5 },
        payment_details: "Banco Prueba, cuenta 000",
      },
    ]);
  });

  it("creates a technician with an empty ficha", async () => {
    await expect(
      createPersonnel("company-1", emptyState, form({ name: "Técnico Dos", type: "contractor" })),
    ).rejects.toThrow("REDIRECT");

    expect(inserted[0]).toEqual({
      company_id: "company-1",
      name: "Técnico Dos",
      type: "contractor",
      tax_id: null,
      payment_document: null,
      default_rates: {},
      payment_details: null,
    });
  });

  it("sends no ficha for an employee, even if the fields came along", async () => {
    await expect(
      createPersonnel("company-1", emptyState, form({ ...technician, name: "Persona Uno", type: "employee" })),
    ).rejects.toThrow("REDIRECT");

    expect(inserted[0]).toEqual({ company_id: "company-1", name: "Persona Uno", type: "employee" });
  });

  it("checks the form before calling the database, and gives back what was typed", async () => {
    const noName = await createPersonnel("c", emptyState, form({ ...technician, name: "   " }));
    const badType = await createPersonnel("c", emptyState, form({ ...technician, type: "boss" }));
    const badRate = await createPersonnel("c", emptyState, form({ ...technician, rate_hour: "25,000" }));
    const badDocument = await createPersonnel("c", emptyState, form({ ...technician, payment_document: "recibo" }));

    expect(noName.error).toMatch(/nombre es obligatorio/);
    expect(badType.error).toMatch(/tipo válido/);
    expect(badRate.error).toMatch(/^Tarifa de hora inválida "25,000"/);
    expect(badDocument.error).toMatch(/documento de pago válido/);
    expect(inserted).toHaveLength(0);
    // The form comes back with the rates as they were typed, not as they were read.
    expect(badRate.values).toMatchObject({ name: "  Técnico Uno  ", rate_visit: "25.000", rate_network_point: "9500,5" });
  });

  it("says the migration is missing when the database has no ficha columns", async () => {
    state.insert = { error: { message: "Could not find the 'tax_id' column of 'personnel' in the schema cache" } };

    const result = await createPersonnel("company-1", emptyState, form(technician));

    expect(result.error).toBe("Falta aplicar la migración de técnicos externos en la base de datos.");
    expect(result.values.name).toBe("  Técnico Uno  ");
  });

  it("says the migration is missing when the type check does not accept technicians yet", async () => {
    state.insert = {
      error: { message: 'new row for relation "personnel" violates check constraint "personnel_type_check"' },
    };

    const result = await createPersonnel("company-1", emptyState, form(technician));

    expect(result.error).toMatch(/Falta aplicar la migración/);
  });

  it("shows any other database message as it is", async () => {
    state.insert = { error: { message: "permission denied for table personnel" } };

    const result = await createPersonnel("company-1", emptyState, form(technician));

    expect(result.error).toBe("permission denied for table personnel");
  });
});

describe("updatePersonnel", () => {
  const edit = { ...technician, name: "Técnico Uno", active: "on" };

  it("saves the ficha of a technician", async () => {
    await expect(updatePersonnel("company-1", "person-1", { error: null }, form(edit))).rejects.toThrow(
      "REDIRECT:/companies/company-1/personnel",
    );

    expect(updated[0]).toMatchObject({
      name: "Técnico Uno",
      type: "contractor",
      active: true,
      default_rates: { visit: 25000, network_point: 9500.5 },
    });
  });

  it("leaves the ficha columns alone for an employee", async () => {
    await expect(
      updatePersonnel("company-1", "person-1", { error: null }, form({ name: "Persona Uno", type: "partner" })),
    ).rejects.toThrow("REDIRECT");

    expect(updated[0]).toEqual({ name: "Persona Uno", type: "partner", active: false });
  });

  it("refuses an unreadable rate before calling the database", async () => {
    const result = await updatePersonnel("c", "p", { error: null }, form({ ...edit, rate_visit: "abc" }));

    expect(result.error).toMatch(/^Tarifa de visita inválida "abc"/);
    expect(updated).toHaveLength(0);
  });

  it("says the migration is missing instead of a raw error", async () => {
    state.update = { data: null, error: { message: "Could not find the 'default_rates' column of 'personnel' in the schema cache" } };

    const result = await updatePersonnel("company-1", "person-1", { error: null }, form(edit));

    expect(result.error).toMatch(/Falta aplicar la migración/);
  });

  it("says so when nothing was updated (no permission or not this company)", async () => {
    state.update = { data: [], error: null };

    const result = await updatePersonnel("company-1", "person-1", { error: null }, form(edit));

    expect(result.error).toMatch(/No tenés permiso/);
  });
});
