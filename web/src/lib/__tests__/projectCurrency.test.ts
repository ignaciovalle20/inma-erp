/**
 * The currency of a job (projects.currency) follows the company's
 * configuration (lib/companyConfig.ts), never a hard-coded country:
 * Uruguay chooses USD or UYU (UYU by default), Chile has only CLP and is
 * never asked, and a currency the company does not have is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyConfig } from "@/lib/companyConfig";
import {
  PROJECT_CURRENCY_LOCKED_MESSAGE,
  projectCurrencyChoice,
  projectCurrencyDbErrorMessage,
  resolveProjectCurrency,
} from "@/lib/projectCurrency";

type Company = { id: string; name: string; country: string; currency: string };

const state: {
  company: Company | null;
  project: { id: string; currency: string } | null;
  hasMovements: boolean;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  updates: Record<string, unknown>[];
  updateError: { message: string } | null;
  rpcError?: { code: string; message: string } | null;
  /** Name of the job that already holds the quote number (project_quotes lookup). */
  quoteOwner?: string | null;
} = { company: null, project: null, hasMovements: false, rpcCalls: [], updates: [], updateError: null };

const UY: Company = { id: "uy", name: "INMA Uruguay", country: "UY", currency: "UYU" };
const CL: Company = { id: "cl", name: "INMA Chile", country: "CL", currency: "CLP" };

vi.mock("@/lib/dal", () => ({
  validateProjectRefs: async () => ({ error: null }),
  findSimilarClients: async () => [],
  getCompanyForEdit: async () => (state.company ? { role: "admin", company: state.company } : null),
  getProjectForEdit: async () => state.project,
  projectHasMovements: async () => state.hasMovements,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return state.rpcError ? { data: null, error: state.rpcError } : { data: { id: "new-project" }, error: null };
    },
    from: () => {
      const builder: Record<string, unknown> = {};
      builder.maybeSingle = async () => ({
        data: state.quoteOwner ? { projects: { name: state.quoteOwner } } : null,
        error: null,
      });
      builder.update = (values: Record<string, unknown>) => {
        state.updates.push(values);
        return builder;
      };
      builder.eq = () => builder;
      // Chainable (.select().eq().maybeSingle()) and awaitable (.update().eq().select()).
      builder.select = () => builder;
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve(state.updateError ? { data: null, error: state.updateError } : { data: [{ id: "p1" }], error: null });
      return builder;
    },
  }),
}));

class RedirectError extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { createProject } from "@/app/companies/[id]/projects/new/actions";
import { updateProject } from "@/app/companies/[id]/projects/[projectId]/edit/actions";

function form(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

const jobFields = {
  name: "Instalación",
  client_id: "client-1",
  business_area_id: "area-1",
  status: "en_ejecucion",
  quote_number: "COT-1",
  quoted_amount: "1500",
};

const initialState = {
  error: null,
  values: {
    name: "",
    client_id: "",
    business_area_id: "",
    status: "en_ejecucion" as const,
    quote_number: "",
    start_date: "",
    end_date: "",
    quoted_amount: "",
    cost_budget: "",
    responsible: "",
    invoiceable: true,
    currency: "",
  },
};

async function create(companyId: string, fields: Record<string, string>) {
  try {
    return await createProject(companyId, initialState, form(fields));
  } catch (thrown) {
    if (thrown instanceof RedirectError) return { redirected: thrown.url };
    throw thrown;
  }
}

async function update(fields: Record<string, string>) {
  try {
    return await updateProject("uy", "p1", { error: null }, form(fields));
  } catch (thrown) {
    if (thrown instanceof RedirectError) return { redirected: thrown.url };
    throw thrown;
  }
}

beforeEach(() => {
  state.company = null;
  state.project = null;
  state.hasMovements = false;
  state.rpcCalls = [];
  state.updates = [];
  state.updateError = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("projectCurrencyChoice", () => {
  it("offers USD and UYU in Uruguay, the local currency first", () => {
    expect(projectCurrencyChoice(companyConfig(UY))).toEqual({
      currencies: ["USD", "UYU"],
      defaultCurrency: "UYU",
      showSelector: true,
    });
  });

  it("asks nothing in Chile: CLP only, no selector", () => {
    expect(projectCurrencyChoice(companyConfig(CL))).toEqual({
      currencies: ["CLP"],
      defaultCurrency: "CLP",
      showSelector: false,
    });
  });

  it("keeps the job's own currency when editing", () => {
    expect(projectCurrencyChoice(companyConfig(UY), "USD").defaultCurrency).toBe("USD");
  });

  it("refuses a currency the company does not have", () => {
    expect(resolveProjectCurrency(companyConfig(UY), "CLP")).toBeNull();
    expect(resolveProjectCurrency(companyConfig(UY), "usd")).toBe("USD");
    // Chile: always CLP, whatever is sent.
    expect(resolveProjectCurrency(companyConfig(CL), "")).toBe("CLP");
  });

  it("explains the database refusals", () => {
    const config = companyConfig(UY);
    expect(projectCurrencyDbErrorMessage({ message: "project_currency_locked: ..." }, config)).toBe(
      PROJECT_CURRENCY_LOCKED_MESSAGE,
    );
    expect(projectCurrencyDbErrorMessage({ message: "project_currency_not_allowed: ..." }, config)).toMatch(/USD o UYU/);
    expect(projectCurrencyDbErrorMessage({ message: "other" }, config)).toBeNull();
  });
});

describe("createProject", () => {
  it("creates a job in USD for a Uruguayan company", async () => {
    state.company = UY;

    const result = await create("uy", { ...jobFields, currency: "USD" });

    expect(result).toEqual({ redirected: "/companies/uy/projects/board" });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "create_project_with_quote",
      args: { p_company_id: "uy", p_currency: "USD", p_quoted_amount: 1500 },
    });
  });

  it("creates a job in CLP for a Chilean company without asking", async () => {
    state.company = CL;

    const result = await create("cl", jobFields);

    expect(result).toEqual({ redirected: "/companies/cl/projects/board" });
    expect(state.rpcCalls[0].args.p_currency).toBe("CLP");
  });

  it("refuses a currency the company does not have", async () => {
    state.company = UY;

    const result = await create("uy", { ...jobFields, currency: "CLP" });

    expect(result).toMatchObject({ error: "Elegí la moneda del trabajo: USD o UYU." });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("says the quote number is already another job's instead of 'Algo salió mal'", async () => {
    state.company = CL;
    state.rpcError = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "project_quotes_company_number_unique"',
    };
    try {
      state.quoteOwner = "Revision camaras";
      const named = await create("cl", { ...jobFields, quote_number: " 1759 " });
      expect(named).toMatchObject({
        error: "El N° de cotización 1759 ya está en uso en el trabajo “Revision camaras”. Usá otro número o agregá la cotización a ese trabajo.",
        values: { quote_number: " 1759 " },
      });

      state.quoteOwner = null;
      const unnamed = await create("cl", { ...jobFields, quote_number: "1759" });
      expect(unnamed).toMatchObject({ error: expect.stringMatching(/^El N° de cotización 1759 ya está en uso en otro trabajo/) });
    } finally {
      state.rpcError = null;
      state.quoteOwner = null;
    }
  });

  it("refuses a Uruguayan job with no currency instead of assuming one", async () => {
    state.company = UY;

    const result = await create("uy", jobFields);

    expect(result).toMatchObject({ error: expect.stringMatching(/USD o UYU/) });
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe("updateProject", () => {
  const editFields = {
    name: "Instalación",
    client_id: "client-1",
    business_area_id: "area-1",
    status: "en_ejecucion",
  };

  it("changes the currency of a job with no movements", async () => {
    state.company = UY;
    state.project = { id: "p1", currency: "UYU" };

    const result = await update({ ...editFields, currency: "USD" });

    expect(result).toEqual({ redirected: "/companies/uy/projects/p1" });
    expect(state.updates[0]).toMatchObject({ currency: "USD" });
  });

  it("does not write the currency when it did not change", async () => {
    state.company = UY;
    state.project = { id: "p1", currency: "USD" };
    state.hasMovements = true;

    const result = await update({ ...editFields, currency: "USD" });

    expect(result).toEqual({ redirected: "/companies/uy/projects/p1" });
    expect(state.updates[0]).not.toHaveProperty("currency");
  });

  it("blocks changing the currency once the job has movements", async () => {
    state.company = UY;
    state.project = { id: "p1", currency: "UYU" };
    state.hasMovements = true;

    const result = await update({ ...editFields, currency: "USD" });

    expect(result).toEqual({ error: PROJECT_CURRENCY_LOCKED_MESSAGE });
    expect(state.updates).toHaveLength(0);
  });

  it("refuses a currency the company does not have", async () => {
    state.company = UY;
    state.project = { id: "p1", currency: "UYU" };

    const result = await update({ ...editFields, currency: "CLP" });

    expect(result).toEqual({ error: "Elegí la moneda del trabajo: USD o UYU." });
    expect(state.updates).toHaveLength(0);
  });

  it("shows the database's refusal clearly when it blocks the change", async () => {
    state.company = UY;
    state.project = { id: "p1", currency: "UYU" };
    state.updateError = { message: "project_currency_locked: el trabajo ya tiene ventas" };

    const result = await update({ ...editFields, currency: "USD" });

    expect(result).toEqual({ error: PROJECT_CURRENCY_LOCKED_MESSAGE });
  });
});
