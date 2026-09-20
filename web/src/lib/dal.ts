import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { ExistingDocument, JobBalance, LegacyDocument } from "@/lib/nubox";
import { staleDueCutoff } from "@/lib/pending";

export type UserCompany = {
  id: string;
  name: string;
  country: string | null;
  currency: string;
  active: boolean;
  role: string;
};

/**
 * Returns the current authenticated user, or null. Reused by later
 * epics' Server Components/Actions to check auth state.
 *
 * `supabase.auth.getUser()` is a real network round-trip to Supabase
 * Auth (it revalidates the JWT server-side, unlike the local
 * `getSession()` client method) -- and it's called by nearly every DAL
 * function below. Wrapped in React's `cache()` so every call during a
 * single request/render (e.g. a layout and its page both checking
 * auth) shares one round-trip instead of one each.
 */
export const getSession = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
});

/**
 * Returns the companies the current user holds a membership for, via
 * RLS-scoped queries (no client-side filtering). Empty array covers
 * both "no session" and "no memberships".
 */
export const getUserCompanies = cache(async (): Promise<UserCompany[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("company_memberships")
    .select("role, companies (id, name, country, currency, active)");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data
    .filter(
      (
        row,
      ): row is typeof row & {
        companies: {
          id: string;
          name: string;
          country: string | null;
          currency: string;
          active: boolean;
        };
      } => row.companies !== null,
    )
    .map((row) => ({
      id: row.companies.id,
      name: row.companies.name,
      country: row.companies.country,
      currency: row.companies.currency,
      active: row.companies.active,
      role: row.role,
    }));
});

export type Company = {
  id: string;
  name: string;
  country: string | null;
  tax_id: string | null;
  currency: string;
  active: boolean;
};

/**
 * Returns a single company by id (RLS-scoped to the caller's
 * memberships) plus the caller's role for it, or null if not found /
 * not a member. Used by the edit page to gate access and prefill the
 * form. Cached per request/companyId -- called by both a company
 * section's layout and every page under it.
 */
export const getCompanyForEdit = cache(async (
  companyId: string,
): Promise<{ company: Company; role: string } | null> => {
  const user = await getSession();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("company_memberships")
    .select(
      "role, companies (id, name, country, tax_id, currency, active)",
    )
    .eq("company_id", companyId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  const company = Array.isArray(data.companies)
    ? data.companies[0]
    : data.companies;

  if (!company) {
    return null;
  }

  return { company, role: data.role };
});

export type Client = {
  id: string;
  company_id: string;
  name: string;
  tax_id: string | null;
  country: string | null;
  notes: string | null;
  active: boolean;
  invoiceable: boolean;
  monthly: boolean;
};

/**
 * Returns the clients for a company, RLS-scoped (no client-side
 * filtering). Empty array covers "no session", "not a member", and
 * "member with zero clients" alike -- callers that need to distinguish
 * "not a member" for a redirect should gate with getCompanyForEdit
 * first, as the clients list page does.
 */
export const getClients = cache(async (companyId: string): Promise<Client[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, company_id, name, tax_id, country, notes, active, invoiceable, monthly")
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

/**
 * Returns a single client scoped to a company (RLS-scoped), or null if
 * not found / caller isn't a member of that company. Used by the edit
 * page, which relies entirely on RLS to reject non-members.
 */
export async function getClientForEdit(
  companyId: string,
  clientId: string,
): Promise<Client | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("clients")
    .select("id, company_id, name, tax_id, country, notes, active, invoiceable, monthly")
    .eq("company_id", companyId)
    .eq("id", clientId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

/**
 * Case-insensitive substring match against existing client names in a
 * company -- powers the non-blocking near-duplicate-name warning on
 * create. Not a data-integrity rule: a UX warning only (see Story 1.3
 * Design Notes).
 *
 * Checked both directions (does the new name contain an existing one,
 * or vice versa) so e.g. "Acme Corp" vs "Acme Corporation" catches each
 * other regardless of which was entered first -- a single-direction
 * `ilike` would miss the case where the new name is the longer one.
 */
export async function findSimilarClients(
  companyId: string,
  name: string,
): Promise<Pick<Client, "id" | "name">[]> {
  const user = await getSession();
  const supabase = await createClient();

  const trimmed = name.trim();

  if (!user || !trimmed) {
    return [];
  }

  const { data, error } = await supabase
    .from("clients")
    .select("id, name")
    .eq("company_id", companyId);

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  const needle = trimmed.replace(/\s+/g, " ").toLowerCase();

  return data.filter(({ name: existingName }) => {
    const haystack = existingName.replace(/\s+/g, " ").toLowerCase();
    return haystack.includes(needle) || needle.includes(haystack);
  });
}

export type ClientAlias = {
  id: string;
  company_id: string;
  external_name: string;
  client_id: string;
};

/**
 * Returns the CSV-import client-name aliases for a company (Story:
 * import client resolution). `external_name` is stored normalized
 * (trimmed + lowercased) -- callers should normalize a CSV row's
 * client name the same way before looking it up in this list.
 */
export const getClientAliases = cache(
  async (companyId: string): Promise<ClientAlias[]> => {
    const user = await getSession();

    if (!user) {
      return [];
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("client_aliases")
      .select("id, company_id, external_name, client_id")
      .eq("company_id", companyId);

    if (error || !data) {
      if (error) {
        console.error(error);
      }
      return [];
    }

    return data;
  },
);

export type PersonnelType = "employee" | "partner";

export type Personnel = {
  id: string;
  company_id: string;
  name: string;
  type: PersonnelType;
  active: boolean;
};

/**
 * Returns the personnel roster for a company, RLS-scoped (no
 * client-side filtering). Empty array covers "no session", "not a
 * member", and "member with zero personnel" alike -- callers that need
 * to distinguish "not a member" for a redirect should gate with
 * getCompanyForEdit first, as the personnel list page does.
 */
export const getPersonnel = cache(async (companyId: string): Promise<Personnel[]> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("personnel")
    .select("id, company_id, name, type, active")
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

/**
 * Returns a single person scoped to a company (RLS-scoped), or null if
 * not found / caller isn't a member of that company. Used by the edit
 * page, which relies entirely on RLS to reject non-members.
 */
export const getPersonnelForEdit = cache(async (
  companyId: string,
  personnelId: string,
): Promise<Personnel | null> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("personnel")
    .select("id, company_id, name, type, active")
    .eq("company_id", companyId)
    .eq("id", personnelId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
});

export type PersonnelCost = {
  id: string;
  personnel_id: string;
  period: string;
  amount: number;
  currency: string;
};

/**
 * Returns the monthly cost records for a person, RLS-scoped (join
 * through personnel.company_id). Empty array covers "no session", "not
 * a member of that person's company", and "person with zero cost
 * records" alike -- callers that need to distinguish "not
 * found/not a member" for a redirect should gate with
 * getPersonnelForEdit first, as the costs list page does.
 */
export async function getPersonnelCosts(
  personnelId: string,
): Promise<PersonnelCost[]> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("personnel_costs")
    .select("id, personnel_id, period, amount, currency")
    .eq("personnel_id", personnelId)
    .order("period", { ascending: false });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
}

/**
 * Returns a single personnel cost record scoped to a company and person
 * (RLS-scoped, plus an explicit join check), or null if not found /
 * caller isn't a member. Used by the allocate page to fetch the cost's
 * total `amount` for the remainder calculation.
 */
export async function getPersonnelCostForEdit(
  companyId: string,
  personnelId: string,
  personnelCostId: string,
): Promise<PersonnelCost | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("personnel_costs")
    .select("id, personnel_id, period, amount, currency")
    .eq("id", personnelCostId)
    .eq("personnel_id", personnelId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  // Confirm the person actually belongs to companyId -- mirrors the
  // "person belongs to this company" check done elsewhere (e.g.
  // createPersonnelCost) rather than trusting the URL segment alone.
  const person = await getPersonnelForEdit(companyId, personnelId);

  if (!person) {
    return null;
  }

  return data;
}

export type WorkAllocation = {
  id: string;
  personnel_cost_id: string;
  project_id: string;
  amount: number;
  hours: number | null;
};

export type WorkAllocationWithProjectName = WorkAllocation & {
  project_name: string | null;
};

/**
 * Returns the work allocations for a personnel cost, RLS-scoped, joined
 * with the target project's name. Used by the allocate page to show
 * existing allocations and compute the unallocated remainder.
 */
export async function getWorkAllocations(
  personnelCostId: string,
): Promise<WorkAllocationWithProjectName[]> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("work_allocations")
    .select("id, personnel_cost_id, project_id, amount, hours, projects (name)")
    .eq("personnel_cost_id", personnelCostId)
    .order("created_at");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;

    return {
      id: row.id,
      personnel_cost_id: row.personnel_cost_id,
      project_id: row.project_id,
      amount: row.amount,
      hours: row.hours,
      project_name: project?.name ?? null,
    };
  });
}

/**
 * Computes the unallocated remainder of a personnel cost -- total
 * `amount` minus the sum of its work allocations. Always returned
 * explicitly (never omitted or treated as zero when it isn't), per the
 * spec's "never silently dropped" requirement.
 */
export function getWorkAllocationRemainder(
  totalAmount: number,
  allocations: WorkAllocation[],
): number {
  const allocatedSum = allocations.reduce((sum, a) => sum + a.amount, 0);
  return totalAmount - allocatedSum;
}

export type RecurringServicePeriodicity = "monthly" | "annual";

export type RecurringService = {
  id: string;
  company_id: string;
  client_id: string;
  name: string;
  price: number;
  expected_cost: number;
  currency: string;
  periodicity: RecurringServicePeriodicity;
  start_date: string;
  end_date: string | null;
  active: boolean;
};

export type RecurringServiceWithClient = RecurringService & {
  client_name: string | null;
};

/**
 * Returns the recurring services for a company, RLS-scoped (no
 * client-side filtering), joined with the client's name for display.
 * Empty array covers "no session", "not a member", and "member with
 * zero recurring services" alike -- callers that need to distinguish
 * "not a member" for a redirect should gate with getCompanyForEdit
 * first, as the recurring services list page does.
 */
export const getRecurringServices = cache(async (
  companyId: string,
): Promise<RecurringServiceWithClient[]> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("recurring_services")
    .select(
      "id, company_id, client_id, name, price, expected_cost, currency, periodicity, start_date, end_date, active, clients(name)",
    )
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const { clients, ...rest } = row as typeof row & {
      clients: { name: string } | { name: string }[] | null;
    };
    const client = Array.isArray(clients) ? clients[0] : clients;
    return { ...rest, client_name: client?.name ?? null };
  });
});

/**
 * Returns a single recurring service scoped to a company (RLS-scoped),
 * or null if not found / caller isn't a member of that company. Used
 * by the edit page, which relies entirely on RLS to reject
 * non-members.
 */
export async function getRecurringServiceForEdit(
  companyId: string,
  recurringServiceId: string,
): Promise<RecurringService | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("recurring_services")
    .select(
      "id, company_id, client_id, name, price, expected_cost, currency, periodicity, start_date, end_date, active",
    )
    .eq("company_id", companyId)
    .eq("id", recurringServiceId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

/**
 * Returns the set of "<recurring_service_id>|<recurring_period>" keys
 * that already have a generated sales_documents row, scoped to a
 * company and a set of service ids. Powers the list page's "already
 * generated this period" check -- callers compare against a key built
 * from each service's own computed current period (month vs. year
 * differs per service periodicity), so this fetches raw pairs rather
 * than pre-filtering by a single period.
 */
export async function getGeneratedRecurringServicePeriods(
  companyId: string,
  recurringServiceIds: string[],
): Promise<Set<string>> {
  if (recurringServiceIds.length === 0) {
    return new Set();
  }

  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return new Set();
  }

  const { data, error } = await supabase
    .from("sales_documents")
    .select("recurring_service_id, recurring_period")
    .eq("company_id", companyId)
    .in("recurring_service_id", recurringServiceIds);

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return new Set();
  }

  return new Set(
    data.map((row) => `${row.recurring_service_id}|${row.recurring_period}`),
  );
}

export type BusinessArea = {
  id: string;
  company_id: string;
  name: string;
  active: boolean;
};

/**
 * Returns the business areas for a company, RLS-scoped (no client-side
 * filtering). Empty array covers "no session", "not a member", and
 * "member with zero areas" alike -- callers that need to distinguish
 * "not a member" for a redirect should gate with getCompanyForEdit
 * first, as the areas list page does.
 */
export const getBusinessAreas = cache(async (
  companyId: string,
): Promise<BusinessArea[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_areas")
    .select("id, company_id, name, active")
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

/**
 * Returns a single business area scoped to a company (RLS-scoped), or
 * null if not found / caller isn't a member of that company. Used by
 * the edit page, which relies entirely on RLS to reject non-members.
 */
export async function getBusinessAreaForEdit(
  companyId: string,
  areaId: string,
): Promise<BusinessArea | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("business_areas")
    .select("id, company_id, name, active")
    .eq("company_id", companyId)
    .eq("id", areaId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

export type Supplier = {
  id: string;
  company_id: string;
  name: string;
  tax_id: string | null;
  country: string | null;
  notes: string | null;
  active: boolean;
};

/**
 * Returns the suppliers for a company, RLS-scoped (no client-side
 * filtering). Empty array covers "no session", "not a member", and
 * "member with zero suppliers" alike -- callers that need to
 * distinguish "not a member" for a redirect should gate with
 * getCompanyForEdit first, as the suppliers list page does.
 */
export const getSuppliers = cache(async (companyId: string): Promise<Supplier[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, company_id, name, tax_id, country, notes, active")
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

/**
 * Returns a single supplier scoped to a company (RLS-scoped), or null
 * if not found / caller isn't a member of that company. Used by the
 * edit page, which relies entirely on RLS to reject non-members.
 */
export async function getSupplierForEdit(
  companyId: string,
  supplierId: string,
): Promise<Supplier | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("suppliers")
    .select("id, company_id, name, tax_id, country, notes, active")
    .eq("company_id", companyId)
    .eq("id", supplierId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

/**
 * Case-insensitive substring match against existing supplier names in a
 * company -- powers the non-blocking near-duplicate-name warning on
 * create. Not a data-integrity rule: a UX warning only (see Story 1.3
 * Design Notes, reused here per Story 1.4).
 *
 * Checked both directions (does the new name contain an existing one,
 * or vice versa) so e.g. "Acme Corp" vs "Acme Corporation" catches each
 * other regardless of which was entered first -- a single-direction
 * `ilike` would miss the case where the new name is the longer one.
 */
export async function findSimilarSuppliers(
  companyId: string,
  name: string,
): Promise<Pick<Supplier, "id" | "name">[]> {
  const user = await getSession();
  const supabase = await createClient();

  const trimmed = name.trim();

  if (!user || !trimmed) {
    return [];
  }

  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name")
    .eq("company_id", companyId);

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  const needle = trimmed.replace(/\s+/g, " ").toLowerCase();

  return data.filter(({ name: existingName }) => {
    const haystack = existingName.replace(/\s+/g, " ").toLowerCase();
    return haystack.includes(needle) || needle.includes(haystack);
  });
}

export type ProjectStatus =
  | "por_cotizar"
  | "en_ejecucion"
  | "en_espera"
  | "finalizado"
  | "cerrado"
  | "cancelado";

export type Project = {
  id: string;
  company_id: string;
  client_id: string;
  business_area_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: ProjectStatus;
  budget: number | null;
  responsible: string | null;
  invoiceable: boolean;
  hold_reason: string | null;
};

export type ProjectWithRelations = Project & {
  client_name: string | null;
  business_area_name: string | null;
  client_monthly: boolean;
};

export type ProjectQuote = {
  id: string;
  project_id: string;
  company_id: string;
  quote_number: string;
  created_at: string;
};

/**
 * Returns the projects for a company, RLS-scoped (no client-side
 * filtering), joined with client/area names for display. Empty array
 * covers "no session", "not a member", and "member with zero projects"
 * alike -- callers that need to distinguish "not a member" for a
 * redirect should gate with getCompanyForEdit first, as the projects
 * list page does.
 */
export const getProjects = cache(async (
  companyId: string,
): Promise<ProjectWithRelations[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, company_id, client_id, business_area_id, name, start_date, end_date, status, budget, responsible, invoiceable, hold_reason, clients (name, monthly), business_areas (name)",
    )
    .eq("company_id", companyId)
    .order("name");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
    const businessArea = Array.isArray(row.business_areas)
      ? row.business_areas[0]
      : row.business_areas;

    return {
      id: row.id,
      company_id: row.company_id,
      client_id: row.client_id,
      business_area_id: row.business_area_id,
      name: row.name,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
      budget: row.budget,
      responsible: row.responsible,
      invoiceable: row.invoiceable,
      hold_reason: row.hold_reason,
      client_name: client?.name ?? null,
      client_monthly: client?.monthly ?? false,
      business_area_name: businessArea?.name ?? null,
    };
  });
});

/**
 * Returns the quotes for a single project, oldest first -- a job can
 * carry more than one Nubox quote number over its life (e.g. 1674 then
 * 1691), and the kanban card/detail page show every one of them.
 */
export const getProjectQuotes = cache(async (
  companyId: string,
  projectId: string,
): Promise<ProjectQuote[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_quotes")
    .select("id, project_id, company_id, quote_number, created_at")
    .eq("company_id", companyId)
    .eq("project_id", projectId)
    .order("created_at");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

/**
 * Returns every project quote for a company, grouped by project_id --
 * powers the kanban board, which needs each card's quote numbers
 * without an N+1 query per card.
 */
export async function getProjectQuotesByProject(
  companyId: string,
  projectIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  if (projectIds.length === 0) {
    return result;
  }

  const user = await getSession();

  if (!user) {
    return result;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_quotes")
    .select("project_id, quote_number")
    .eq("company_id", companyId)
    .in("project_id", projectIds)
    .order("created_at");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return result;
  }

  for (const row of data) {
    const existing = result.get(row.project_id) ?? [];
    existing.push(row.quote_number);
    result.set(row.project_id, existing);
  }

  return result;
}

export type ProjectRefsValidationResult =
  | { error: null }
  | { error: "client"; detail: unknown }
  | { error: "business_area"; detail: unknown }
  | { error: "lookup_failed"; detail: unknown };

/**
 * Cross-company validation for a project's client_id/business_area_id:
 * both must exist AND belong to companyId. This is a friendly UI
 * check only, done in parallel with (not instead of) the DB-level
 * `projects_validate_company_refs` trigger, which is the real
 * guarantee against a tampered/raw request. Shared by the create and
 * edit Server Actions to avoid duplicating the lookup logic.
 */
export async function validateProjectRefs(
  companyId: string,
  clientId: string,
  businessAreaId: string,
): Promise<ProjectRefsValidationResult> {
  const supabase = await createClient();

  const [{ data: client, error: clientError }, { data: area, error: areaError }] =
    await Promise.all([
      supabase
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .eq("company_id", companyId)
        .maybeSingle(),
      supabase
        .from("business_areas")
        .select("id")
        .eq("id", businessAreaId)
        .eq("company_id", companyId)
        .maybeSingle(),
    ]);

  if (clientError || areaError) {
    return { error: "lookup_failed", detail: { clientError, areaError } };
  }

  if (!client) {
    return { error: "client", detail: null };
  }

  if (!area) {
    return { error: "business_area", detail: null };
  }

  return { error: null };
}

/**
 * Returns a single project scoped to a company (RLS-scoped), or null if
 * not found / caller isn't a member of that company. Used by the edit
 * page, which relies entirely on RLS to reject non-members.
 */
export async function getProjectForEdit(
  companyId: string,
  projectId: string,
): Promise<Project | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, company_id, client_id, business_area_id, name, start_date, end_date, status, budget, responsible, invoiceable, hold_reason",
    )
    .eq("company_id", companyId)
    .eq("id", projectId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

export type SalesDocumentType =
  | "invoice"
  | "receipt"
  | "credit_note"
  | "manual";

export type SalesDocument = {
  id: string;
  company_id: string;
  client_id: string;
  project_id: string | null;
  document_type: SalesDocumentType;
  document_date: string;
  currency: string;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  updated_at: string;
  voided: boolean;
  voided_at: string | null;
  source: "manual" | "import";
  import_row_id: string | null;
  // Story 6.6: null (the default) means this document's effective
  // reporting period is still its own document_date's month --
  // recognized_period_set_by/_at are only ever set together with
  // recognized_period, by reassign_sales_document_period().
  recognized_period: string | null;
  recognized_period_set_by: string | null;
  recognized_period_set_at: string | null;
};

export type SalesDocumentWithRelations = SalesDocument & {
  client_name: string | null;
};

export type SalesLine = {
  id: string;
  sales_document_id: string;
  description: string | null;
  amount: number;
};

export type SalesDocumentWithLines = SalesDocument & {
  lines: SalesLine[];
};

/**
 * Story 6.4: optional filters for getSalesDocuments -- mirrors exactly
 * the query shapes computeMonthlyResult/computeClientProfitability/
 * computeAreaProfitability already use (non-voided, date range,
 * client/project/area tag), so a drill-down link's filtered list sum
 * reconciles with the report figure it came from. All fields optional;
 * omitting a field means "don't filter on it" (not "filter to null").
 */
export type SalesDocumentFilters = {
  from?: string;
  to?: string;
  clientId?: string;
  projectId?: string;
  businessAreaId?: string;
  // Every reporting figure that sums sales_documents excludes voided
  // ones (Story 6.1/6.2) -- report drill-down links pass this so the
  // filtered list's sum reconciles with the figure. Left undefined for
  // plain (non-drill-down) browsing of the sales list, which still
  // shows voided documents with their badge.
  excludeVoided?: boolean;
  // Defaults to date desc (most recent first), matching every existing
  // caller (reports, drill-downs) that never passed a sort before.
  sortBy?: "date" | "total";
  sortDirection?: "asc" | "desc";
};

/**
 * Returns the sales documents for a company, RLS-scoped (no
 * client-side filtering), joined with the client name for display.
 * Empty array covers "no session", "not a member", and "member with
 * zero documents" alike -- callers that need to distinguish "not a
 * member" for a redirect should gate with getCompanyForEdit first, as
 * the sales list page does.
 *
 * `filters` (Story 6.4) narrows the same base query via additional
 * `.eq()`/`.gte()`/`.lt()` calls -- `to` is exclusive (matches the
 * reporting engine's `monthRange` convention: end is the first day of
 * the following period), so a report's `from`/`to` pair can be passed
 * straight through.
 */
export const getSalesDocuments = cache(async (
  companyId: string,
  filters?: SalesDocumentFilters,
): Promise<SalesDocumentWithRelations[]> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  let query = supabase
    .from("sales_documents")
    .select(
      "id, company_id, client_id, project_id, document_type, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, voided, voided_at, source, import_row_id, recognized_period, recognized_period_set_by, recognized_period_set_at, clients (name)",
    )
    .eq("company_id", companyId);

  if (filters?.from) {
    query = query.gte("document_date", filters.from);
  }
  if (filters?.to) {
    query = query.lt("document_date", filters.to);
  }
  if (filters?.clientId) {
    query = query.eq("client_id", filters.clientId);
  }
  if (filters?.projectId) {
    query = query.eq("project_id", filters.projectId);
  }
  if (filters?.businessAreaId) {
    query = query.eq("business_area_id", filters.businessAreaId);
  }
  if (filters?.excludeVoided) {
    query = query.eq("voided", false);
  }

  const sortColumn = filters?.sortBy === "total" ? "total_amount" : "document_date";
  const ascending = filters?.sortDirection === "asc";
  const { data, error } = await query.order(sortColumn, { ascending });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;

    return {
      id: row.id,
      company_id: row.company_id,
      client_id: row.client_id,
      project_id: row.project_id,
      document_type: row.document_type,
      document_date: row.document_date,
      currency: row.currency,
      net_amount: row.net_amount,
      tax_amount: row.tax_amount,
      total_amount: row.total_amount,
      created_at: row.created_at,
      updated_at: row.updated_at,
      voided: row.voided,
      voided_at: row.voided_at,
      source: row.source,
      import_row_id: row.import_row_id,
      recognized_period: row.recognized_period,
      recognized_period_set_by: row.recognized_period_set_by,
      recognized_period_set_at: row.recognized_period_set_at,
      client_name: client?.name ?? null,
    };
  });
});

// Cobro state of a sale (docs/cambios-flujo-v2.md 4.2). null on sales that
// pre-date the Nubox import: "no data" is never shown as "pending".
export type PaymentStatus =
  | "pagado"
  | "por_vencer"
  | "vencido"
  | "no_aplica"
  | "pendiente";

export type SalesListFilters = Omit<SalesDocumentFilters, "sortBy"> & {
  sortBy?: "date" | "total" | "net";
  paymentStatus?: PaymentStatus | "sin_dato";
};

/**
 * A row of the sales list. Kept apart from getSalesDocuments on purpose:
 * that one feeds every report and drill-down and must keep working on
 * databases that have not run the Nubox migration yet; only the sales
 * list itself needs the extra columns.
 */
export type SalesListRow = SalesDocumentWithRelations & {
  document_number: string | null;
  due_date: string | null;
  payment_status: PaymentStatus | null;
  paid_at: string | null;
  payment_method: string | null;
  annulled_by_document_id: string | null;
  annuls_document_id: string | null;
  /** Folio of the credit note / invoice this one is paired with. */
  annulment_partner_number: string | null;
  business_area_id: string | null;
  business_area_name: string | null;
  project_name: string | null;
};

export const getSalesListRows = cache(async (
  companyId: string,
  filters?: SalesListFilters,
): Promise<SalesListRow[]> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  let query = supabase
    .from("sales_documents")
    .select(
      "id, company_id, client_id, project_id, business_area_id, document_type, document_number, document_date, due_date, currency, net_amount, tax_amount, total_amount, payment_status, paid_at, payment_method, annulled_by_document_id, annuls_document_id, created_at, updated_at, voided, voided_at, source, import_row_id, recognized_period, recognized_period_set_by, recognized_period_set_at, clients (name), business_areas (name), projects (name)",
    )
    .eq("company_id", companyId);

  if (filters?.from) query = query.gte("document_date", filters.from);
  if (filters?.to) query = query.lt("document_date", filters.to);
  if (filters?.clientId) query = query.eq("client_id", filters.clientId);
  if (filters?.projectId) query = query.eq("project_id", filters.projectId);
  if (filters?.businessAreaId) query = query.eq("business_area_id", filters.businessAreaId);
  if (filters?.excludeVoided) query = query.eq("voided", false);
  if (filters?.paymentStatus === "sin_dato") {
    query = query.is("payment_status", null);
  } else if (filters?.paymentStatus) {
    query = query.eq("payment_status", filters.paymentStatus);
  }

  const sortColumn =
    filters?.sortBy === "total"
      ? "total_amount"
      : filters?.sortBy === "net"
        ? "net_amount"
        : "document_date";
  const ascending = filters?.sortDirection === "asc";
  const ordered = query.order(sortColumn, { ascending }).order("id");
  const { data, error } = await fetchAllPages((from, to) => ordered.range(from, to));

  if (error) {
    // Surfaced to the page (which shows it) instead of an empty list that
    // would read as "no sales".
    throw new Error(`No se pudo leer el listado de ventas: ${error.message}`);
  }

  const partnerIds = Array.from(
    new Set(
      (data ?? []).flatMap((row) =>
        [row.annulled_by_document_id, row.annuls_document_id].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ),
  );
  const partnerNumbers = new Map<string, string | null>();

  if (partnerIds.length > 0) {
    const { data: partners, error: partnersError } = await supabase
      .from("sales_documents")
      .select("id, document_number")
      .in("id", partnerIds);

    if (partnersError) {
      throw new Error(`No se pudieron leer las notas de crédito: ${partnersError.message}`);
    }
    for (const partner of partners ?? []) {
      partnerNumbers.set(partner.id, partner.document_number);
    }
  }

  const one = <T,>(value: T | T[] | null): T | null =>
    Array.isArray(value) ? (value[0] ?? null) : value;

  return (data ?? []).map((row) => {
    const partnerId = row.annulled_by_document_id ?? row.annuls_document_id;

    return {
      id: row.id,
      company_id: row.company_id,
      client_id: row.client_id,
      project_id: row.project_id,
      document_type: row.document_type,
      document_number: row.document_number,
      document_date: row.document_date,
      due_date: row.due_date,
      currency: row.currency,
      net_amount: Number(row.net_amount),
      tax_amount: Number(row.tax_amount),
      total_amount: Number(row.total_amount),
      payment_status: row.payment_status,
      paid_at: row.paid_at,
      payment_method: row.payment_method,
      annulled_by_document_id: row.annulled_by_document_id,
      annuls_document_id: row.annuls_document_id,
      annulment_partner_number: partnerId ? (partnerNumbers.get(partnerId) ?? null) : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      voided: row.voided,
      voided_at: row.voided_at,
      source: row.source,
      import_row_id: row.import_row_id,
      recognized_period: row.recognized_period,
      recognized_period_set_by: row.recognized_period_set_by,
      recognized_period_set_at: row.recognized_period_set_at,
      client_name: one(row.clients)?.name ?? null,
      business_area_id: row.business_area_id,
      business_area_name: one(row.business_areas)?.name ?? null,
      project_name: one(row.projects)?.name ?? null,
    };
  });
});

/**
 * Returns a single sales document (header + lines) scoped to a company
 * (RLS-scoped), or null if not found / caller isn't a member of that
 * company. Used by the edit page, following getClientForEdit's shape.
 * Whether the document is voided is not checked here -- the caller
 * (the edit page/action) decides what to do with a voided document;
 * this just returns the data.
 */
export async function getSalesDocumentForEdit(
  companyId: string,
  salesDocumentId: string,
): Promise<SalesDocumentWithLines | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data: document, error: documentError } = await supabase
    .from("sales_documents")
    .select(
      "id, company_id, client_id, project_id, document_type, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, voided, voided_at, source, import_row_id, recognized_period, recognized_period_set_by, recognized_period_set_at",
    )
    .eq("company_id", companyId)
    .eq("id", salesDocumentId)
    .maybeSingle();

  if (documentError || !document) {
    if (documentError) {
      console.error(documentError);
    }
    return null;
  }

  const { data: lines, error: linesError } = await supabase
    .from("sales_lines")
    .select("id, sales_document_id, description, amount")
    .eq("sales_document_id", salesDocumentId)
    .order("created_at");

  if (linesError || !lines) {
    if (linesError) {
      console.error(linesError);
    }
    return null;
  }

  return { ...document, lines };
}

export type CostClassification = "direct" | "general";

export type CostCategory =
  | "equipment"
  | "materials"
  | "transport"
  | "labor"
  | "other";

export type CostStatus = "provisional" | "confirmed";

export type CostDocument = {
  id: string;
  company_id: string;
  supplier_id: string | null;
  project_id: string | null;
  classification: CostClassification;
  category: CostCategory | null;
  status: CostStatus;
  document_date: string;
  currency: string;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  updated_at: string;
  // Story 6.6: see the matching comment on SalesDocument.
  recognized_period: string | null;
  recognized_period_set_by: string | null;
  recognized_period_set_at: string | null;
};

export type CostDocumentWithRelations = CostDocument & {
  supplier_name: string | null;
  project_name: string | null;
  is_allocated: boolean;
  has_attachment: boolean;
};

/**
 * Story 6.4: optional filters for getCostDocuments -- mirrors the query
 * shapes computeMonthlyResult/computeClientProfitability/
 * computeProjectProfitability already use (date range,
 * project/classification), so a drill-down link's filtered list sum
 * reconciles with the report figure it came from. All fields optional.
 */
export type CostDocumentFilters = {
  from?: string;
  to?: string;
  projectId?: string;
  // For a client/area's profitability drill-down, where the figure
  // rolls up several projects' direct costs at once (see
  // reporting.ts's computeClientProfitability/computeAreaProfitability)
  // -- mutually exclusive with `projectId` in practice, but both are
  // applied if both are somehow passed.
  projectIds?: string[];
  classification?: CostClassification;
  // Defaults to date desc (most recent first), matching every existing
  // caller (reports, drill-downs) that never passed a sort before.
  sortBy?: "date" | "total";
  sortDirection?: "asc" | "desc";
};

/**
 * Returns the cost documents for a company, RLS-scoped (no client-side
 * filtering), joined with the supplier/project name for display.
 * Mirrors getSalesDocuments. Empty array covers "no session", "not a
 * member", and "member with zero documents" alike -- callers that need
 * to distinguish "not a member" for a redirect should gate with
 * getCompanyForEdit first, as the costs list page does.
 *
 * `filters` (Story 6.4) narrows the same base query via additional
 * `.eq()`/`.gte()`/`.lt()` calls -- `to` is exclusive, matching
 * `getSalesDocuments`'s convention.
 */
export const getCostDocuments = cache(async (
  companyId: string,
  filters?: CostDocumentFilters,
): Promise<CostDocumentWithRelations[]> => {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  let query = supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, category, status, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at, suppliers (name), projects (name)",
    )
    .eq("company_id", companyId);

  if (filters?.from) {
    query = query.gte("document_date", filters.from);
  }
  if (filters?.to) {
    query = query.lt("document_date", filters.to);
  }
  if (filters?.projectId) {
    query = query.eq("project_id", filters.projectId);
  }
  if (filters?.projectIds && filters.projectIds.length > 0) {
    query = query.in("project_id", filters.projectIds);
  }
  if (filters?.classification) {
    query = query.eq("classification", filters.classification);
  }

  const sortColumn = filters?.sortBy === "total" ? "total_amount" : "document_date";
  const ascending = filters?.sortDirection === "asc";
  const { data, error } = await query.order(sortColumn, { ascending });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  // Batched follow-up query for allocation counts, rather than a
  // per-row round trip -- one query returning the cost_document_id of
  // every allocation row for this company's documents, then counted in
  // memory. Fine at this scale (small internal tool, per Design Notes);
  // a dedicated count subselect would need a Postgres view/RPC this
  // schema doesn't have yet.
  const documentIds = data.map((row) => row.id);
  const allocationCounts = new Map<string, number>();
  const attachmentCounts = new Map<string, number>();

  if (documentIds.length > 0) {
    const [
      { data: allocationRows, error: allocationError },
      { data: attachmentRows, error: attachmentError },
    ] = await Promise.all([
      supabase
        .from("cost_allocations")
        .select("cost_document_id")
        .in("cost_document_id", documentIds),
      supabase
        .from("cost_document_attachments")
        .select("cost_document_id")
        .in("cost_document_id", documentIds),
    ]);

    if (allocationError) {
      console.error(allocationError);
    } else if (allocationRows) {
      for (const row of allocationRows) {
        allocationCounts.set(
          row.cost_document_id,
          (allocationCounts.get(row.cost_document_id) ?? 0) + 1,
        );
      }
    }

    if (attachmentError) {
      console.error(attachmentError);
    } else if (attachmentRows) {
      for (const row of attachmentRows) {
        attachmentCounts.set(
          row.cost_document_id,
          (attachmentCounts.get(row.cost_document_id) ?? 0) + 1,
        );
      }
    }
  }

  return data.map((row) => {
    const supplier = Array.isArray(row.suppliers)
      ? row.suppliers[0]
      : row.suppliers;
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;

    return {
      id: row.id,
      company_id: row.company_id,
      supplier_id: row.supplier_id,
      project_id: row.project_id,
      classification: row.classification,
      category: row.category,
      status: row.status,
      document_date: row.document_date,
      currency: row.currency,
      net_amount: row.net_amount,
      tax_amount: row.tax_amount,
      total_amount: row.total_amount,
      created_at: row.created_at,
      updated_at: row.updated_at,
      recognized_period: row.recognized_period,
      recognized_period_set_by: row.recognized_period_set_by,
      recognized_period_set_at: row.recognized_period_set_at,
      supplier_name: supplier?.name ?? null,
      project_name: project?.name ?? null,
      is_allocated: (allocationCounts.get(row.id) ?? 0) > 0,
      has_attachment: (attachmentCounts.get(row.id) ?? 0) > 0,
    };
  });
});

export type ProjectCostRow = {
  id: string;
  document_date: string;
  currency: string;
  amount: number;
  description: string | null;
  supplier_name: string | null;
  category: CostCategory | null;
  status: CostStatus;
  has_attachment: boolean;
  is_allocated_share: boolean;
};

/**
 * A project's ("Trabajo") own cost list, for the project detail page.
 * Two sources feed it, matching exactly what computeProjectProfitability
 * (reporting.ts) already counts as that project's cost -- otherwise the
 * "Costos" figure and the list of gastos below it disagree:
 *
 * 1. Its own `direct` cost_documents (project_id = this project).
 * 2. Its computed share of any `general` cost_documents allocated to it
 *    via cost_allocations -- a real expense for this Trabajo even
 *    though the document itself isn't imputed to a single project.
 *
 * `amount` is the full document total for a direct cost, or the
 * computed share (percentage/fixed_amount) for an allocated one --
 * never the allocated document's own total, which could span several
 * other targets too.
 */
export async function getProjectCosts(
  companyId: string,
  projectId: string,
): Promise<ProjectCostRow[]> {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();

  const [direct, allocated] = await Promise.all([
    getCostDocuments(companyId, { projectId, classification: "direct" }),
    supabase
      .from("cost_allocations")
      .select(
        "method, percentage, amount, cost_documents!inner(id, company_id, document_date, currency, category, status, total_amount, suppliers (name))",
      )
      .eq("project_id", projectId)
      .eq("cost_documents.company_id", companyId),
  ]);

  const directRows: (ProjectCostRow & { costDocumentId: string })[] = direct.map((doc) => ({
    id: doc.id,
    costDocumentId: doc.id,
    document_date: doc.document_date,
    currency: doc.currency,
    amount: doc.total_amount,
    description: null,
    supplier_name: doc.supplier_name,
    category: doc.category,
    status: doc.status,
    has_attachment: doc.has_attachment,
    is_allocated_share: false,
  }));

  if (allocated.error) {
    console.error(allocated.error);
  }

  const allocatedRows: (ProjectCostRow & { costDocumentId: string })[] = (
    allocated.data ?? []
  ).map((row) => {
    const document = Array.isArray(row.cost_documents)
      ? row.cost_documents[0]
      : row.cost_documents;
    const supplier = document
      ? Array.isArray(document.suppliers)
        ? document.suppliers[0]
        : document.suppliers
      : null;
    const total = Number(document?.total_amount ?? 0);
    const share =
      row.method === "percentage"
        ? (total * Number(row.percentage ?? 0)) / 100
        : Number(row.amount ?? 0);

    return {
      id: document?.id ?? "",
      costDocumentId: document?.id ?? "",
      document_date: document?.document_date ?? "",
      currency: document?.currency ?? "",
      amount: share,
      description: null,
      supplier_name: supplier?.name ?? null,
      category: document?.category ?? null,
      status: document?.status ?? "confirmed",
      has_attachment: false,
      is_allocated_share: true,
    };
  });

  const rows = [...directRows, ...allocatedRows];
  const documentIds = [...new Set(rows.map((row) => row.costDocumentId).filter(Boolean))];

  if (documentIds.length > 0) {
    const { data: lineRows, error: lineError } = await supabase
      .from("cost_lines")
      .select("cost_document_id, description")
      .in("cost_document_id", documentIds);

    if (lineError) {
      console.error(lineError);
    } else if (lineRows) {
      const descriptionsByDocumentId = new Map<string, string[]>();
      for (const line of lineRows) {
        if (!line.description) continue;
        const existing = descriptionsByDocumentId.get(line.cost_document_id) ?? [];
        existing.push(line.description);
        descriptionsByDocumentId.set(line.cost_document_id, existing);
      }
      for (const row of rows) {
        const descriptions = descriptionsByDocumentId.get(row.costDocumentId);
        row.description = descriptions ? descriptions.join(", ") : null;
      }
    }
  }

  return rows
    .map(({ costDocumentId: _costDocumentId, ...row }) => row)
    .sort((a, b) =>
      a.document_date < b.document_date ? 1 : a.document_date > b.document_date ? -1 : 0,
    );
}

export type ProvisionalCostDocument = {
  id: string;
  document_date: string;
  currency: string;
  total_amount: number;
  project_name: string | null;
};

/**
 * Fase D: candidates for "vincular a un gasto existente" during
 * purchase-invoice import -- every `provisional` cost document not yet
 * linked to an import row. Linking updates one of these in place
 * (amount/date/currency/status) instead of creating a duplicate
 * cost_documents row for the same real-world expense.
 */
export const getProvisionalCostDocuments = cache(async (
  companyId: string,
): Promise<ProvisionalCostDocument[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cost_documents")
    .select("id, document_date, currency, total_amount, projects (name)")
    .eq("company_id", companyId)
    .eq("status", "provisional")
    .is("import_row_id", null)
    .order("document_date", { ascending: false });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    return {
      id: row.id,
      document_date: row.document_date,
      currency: row.currency,
      total_amount: row.total_amount,
      project_name: project?.name ?? null,
    };
  });
});

/**
 * Returns a single cost document scoped to a company (RLS-scoped), or
 * null if not found / caller isn't a member of that company. Used by
 * the allocate page to gate access and prefill the form.
 */
export async function getCostDocumentForEdit(
  companyId: string,
  costDocumentId: string,
): Promise<CostDocument | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, category, status, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at",
    )
    .eq("company_id", companyId)
    .eq("id", costDocumentId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return data;
}

export type PotentialDuplicateCost = {
  id: string;
  document_date: string;
  classification: CostClassification;
  currency: string;
  total_amount: number;
};

/**
 * Story 3.4: looks for an existing cost document on the same company
 * with the same supplier, document date, and total amount -- the same
 * four fields a human would glance at to recognize "this looks like
 * the same invoice." Skipped entirely when `supplierId` is null, since
 * two undated-supplier costs sharing a date/amount is not suspicious
 * enough to warn on.
 */
export async function findPotentialDuplicateCost(
  companyId: string,
  supplierId: string | null,
  documentDate: string,
  totalAmount: number,
): Promise<PotentialDuplicateCost | null> {
  if (!supplierId) {
    return null;
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cost_documents")
    .select("id, document_date, classification, currency, total_amount")
    .eq("company_id", companyId)
    .eq("supplier_id", supplierId)
    .eq("document_date", documentDate)
    .eq("total_amount", totalAmount)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(error);
    return null;
  }

  return data;
}

export type CostLine = {
  id: string;
  cost_document_id: string;
  description: string | null;
  amount: number;
};

export type CostDocumentDetail = CostDocument & {
  supplier_name: string | null;
  project_name: string | null;
  lines: CostLine[];
};

/**
 * Story 6.4: read-only detail lookup for the new cost document detail
 * page -- mirrors getSalesDocumentForEdit's shape (header + lines,
 * RLS-scoped, null when not found/not a member) but also joins the
 * supplier/project name for display, since this page has no form to
 * fall back on for that context.
 */
export async function getCostDocumentDetail(
  companyId: string,
  costDocumentId: string,
): Promise<CostDocumentDetail | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data: document, error: documentError } = await supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, category, status, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at, suppliers (name), projects (name)",
    )
    .eq("company_id", companyId)
    .eq("id", costDocumentId)
    .maybeSingle();

  if (documentError || !document) {
    if (documentError) {
      console.error(documentError);
    }
    return null;
  }

  const { data: lines, error: linesError } = await supabase
    .from("cost_lines")
    .select("id, cost_document_id, description, amount")
    .eq("cost_document_id", costDocumentId)
    .order("created_at");

  if (linesError || !lines) {
    if (linesError) {
      console.error(linesError);
    }
    return null;
  }

  const supplier = Array.isArray(document.suppliers)
    ? document.suppliers[0]
    : document.suppliers;
  const project = Array.isArray(document.projects)
    ? document.projects[0]
    : document.projects;
  const { suppliers: _suppliers, projects: _projects, ...rest } = document;

  return {
    ...rest,
    supplier_name: supplier?.name ?? null,
    project_name: project?.name ?? null,
    lines,
  };
}

export type CostAllocationTargetType = "project" | "client" | "business_area";
export type CostAllocationMethod = "percentage" | "fixed_amount";

export type CostAllocation = {
  id: string;
  cost_document_id: string;
  project_id: string | null;
  client_id: string | null;
  business_area_id: string | null;
  method: CostAllocationMethod;
  percentage: number | null;
  amount: number | null;
};

export type CostAllocationWithTargetName = CostAllocation & {
  target_type: CostAllocationTargetType;
  target_id: string;
  target_name: string | null;
};

/**
 * Returns the existing allocation rows for a cost document, RLS-scoped,
 * joined with whichever target's name applies to each row. Used by the
 * allocate page to prefill the form with the current allocation set.
 */
export async function getCostAllocations(
  costDocumentId: string,
): Promise<CostAllocationWithTargetName[]> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("cost_allocations")
    .select(
      "id, cost_document_id, project_id, client_id, business_area_id, method, percentage, amount, projects (name), clients (name), business_areas (name)",
    )
    .eq("cost_document_id", costDocumentId)
    .order("created_at");

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data.map((row) => {
    const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
    const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
    const businessArea = Array.isArray(row.business_areas)
      ? row.business_areas[0]
      : row.business_areas;

    let target_type: CostAllocationTargetType;
    let target_id: string;
    let target_name: string | null;

    if (row.project_id) {
      target_type = "project";
      target_id = row.project_id;
      target_name = project?.name ?? null;
    } else if (row.client_id) {
      target_type = "client";
      target_id = row.client_id;
      target_name = client?.name ?? null;
    } else {
      target_type = "business_area";
      target_id = row.business_area_id as string;
      target_name = businessArea?.name ?? null;
    }

    return {
      id: row.id,
      cost_document_id: row.cost_document_id,
      project_id: row.project_id,
      client_id: row.client_id,
      business_area_id: row.business_area_id,
      method: row.method,
      percentage: row.percentage,
      amount: row.amount,
      target_type,
      target_id,
      target_name,
    };
  });
}

export type ProjectCostStatus = "has_costs" | "confirmed_zero" | "pending";

export type ProjectWithCostStatus = ProjectWithRelations & {
  cost_status: ProjectCostStatus;
};

/**
 * Returns each active project for a company with a computed
 * `cost_status` for the given period ('has_costs' | 'confirmed_zero' |
 * 'pending'). period is any date within the target month -- it's
 * normalized here to the month's [start, end) range for the
 * cost_documents query and to the first-of-month for the confirmations
 * lookup, matching how `project_cost_confirmations.period` is stored.
 *
 * The three states are computed at read time, never stored redundantly
 * -- cost_documents remains the single source of truth for "has
 * costs" (per spec Boundaries). Only active projects are included,
 * matching the epic's autonomous decision to scope this to the
 * projects list's normal working set.
 */
export async function getProjectCostStatus(
  companyId: string,
  period: string,
): Promise<ProjectWithCostStatus[]> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const periodDate = new Date(period);
  const monthStart = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth(), 1),
  );
  const monthEnd = new Date(
    Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1),
  );
  const monthStartStr = monthStart.toISOString().slice(0, 10);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);

  const projects = await getProjects(companyId);
  // "active" -> "en_ejecucion" (direct migration, docs/cambios-flujo-v2.md
  // 4.1): this view tracks month-to-date cost completeness, a narrower
  // question than "is this job open" -- the kanban board (all 6
  // statuses) is where the full job lifecycle lives.
  const activeProjects = projects.filter(
    (project) => project.status === "en_ejecucion",
  );

  if (activeProjects.length === 0) {
    return [];
  }

  const projectIds = activeProjects.map((project) => project.id);

  const [{ data: costRows, error: costError }, { data: confirmationRows, error: confirmationError }] =
    await Promise.all([
      supabase
        .from("cost_documents")
        .select("project_id")
        .in("project_id", projectIds)
        .gte("document_date", monthStartStr)
        .lt("document_date", monthEndStr),
      supabase
        .from("project_cost_confirmations")
        .select("project_id")
        .in("project_id", projectIds)
        .eq("period", monthStartStr),
    ]);

  if (costError) {
    console.error(costError);
  }
  if (confirmationError) {
    console.error(confirmationError);
  }

  const projectsWithCosts = new Set(
    (costRows ?? [])
      .map((row) => row.project_id)
      .filter((id): id is string => id != null),
  );
  const projectsConfirmedZero = new Set(
    (confirmationRows ?? [])
      .map((row) => row.project_id)
      .filter((id): id is string => id != null),
  );

  return activeProjects.map((project) => {
    let cost_status: ProjectCostStatus;
    if (projectsWithCosts.has(project.id)) {
      cost_status = "has_costs";
    } else if (projectsConfirmedZero.has(project.id)) {
      cost_status = "confirmed_zero";
    } else {
      cost_status = "pending";
    }

    return { ...project, cost_status };
  });
}

export type ImportRowStatus =
  | "imported"
  | "error"
  | "duplicate"
  | "updated"
  | "unchanged"
  | "review";

export type ImportBatch = {
  id: string;
  company_id: string;
  file_name: string;
  total_rows: number;
  imported_rows: number;
  error_rows: number;
  duplicate_rows: number;
  // Nubox upserts (docs/cambios-flujo-v2.md 4.2): the generic importer
  // leaves these at 0.
  updated_rows: number;
  unchanged_rows: number;
  review_rows: number;
  oldest_document_date: string | null;
  imported_by: string | null;
  imported_at: string;
};

const IMPORT_BATCH_COLUMNS =
  "id, company_id, file_name, total_rows, imported_rows, error_rows, duplicate_rows, updated_rows, unchanged_rows, review_rows, oldest_document_date, imported_by, imported_at";

/**
 * Returns the import batches for a company, RLS-scoped (no
 * client-side filtering), newest first. Empty array covers "no
 * session", "not a member", and "member with zero batches" alike --
 * mirrors getSalesDocuments's shape. Read-only, per Story 4.3.
 */
export async function getImportBatches(
  companyId: string,
): Promise<ImportBatch[]> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("import_batches")
    .select(
      IMPORT_BATCH_COLUMNS,
    )
    .eq("company_id", companyId)
    .order("imported_at", { ascending: false });

  if (error) {
    // Thrown, not swallowed: an empty history would read as "nothing was
    // ever imported" when the query itself failed.
    throw new Error(`No se pudo leer el historial de importación: ${error.message}`);
  }

  return data ?? [];
}

export type ImportRow = {
  id: string;
  import_batch_id: string;
  row_number: number;
  raw_data: unknown;
  status: ImportRowStatus;
  error_message: string | null;
  sales_document_id: string | null;
  created_at: string;
};

export type ImportBatchDetail = {
  batch: ImportBatch;
  rows: ImportRow[];
};

/**
 * Returns a single import batch (header + its rows, ordered by
 * row_number) scoped to a company (RLS-scoped), or null if not found /
 * caller isn't a member of that company. Mirrors
 * getSalesDocumentForEdit's shape. Read-only, per Story 4.3.
 */
export async function getImportBatchDetail(
  companyId: string,
  batchId: string,
): Promise<ImportBatchDetail | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select(
      IMPORT_BATCH_COLUMNS,
    )
    .eq("company_id", companyId)
    .eq("id", batchId)
    .maybeSingle();

  if (batchError || !batch) {
    if (batchError) {
      console.error(batchError);
    }
    return null;
  }

  const orderedRows = supabase
    .from("import_rows")
    .select(
      "id, import_batch_id, row_number, raw_data, status, error_message, sales_document_id, created_at",
    )
    .eq("import_batch_id", batchId)
    .order("row_number")
    .order("id");
  // A historical import has thousands of rows: the API alone would return
  // the first 1000 and silently drop the rest (including their errors).
  const { data: rows, error: rowsError } = await fetchAllPages((from, to) => orderedRows.range(from, to));

  if (rowsError || !rows) {
    if (rowsError) {
      console.error(rowsError);
    }
    return null;
  }

  return { batch, rows };
}

export type ImportRowBatchInfo = {
  import_batch_id: string;
  row_number: number;
  file_name: string;
};

/**
 * Returns the batch id, row number, and source file name for a given
 * import row, for the provenance line/link on the sales document edit
 * page (RLS-scoped via import_rows' membership-join policy -- returns
 * null for a row the caller can't see, same as every other *ForEdit
 * lookup here). file_name is joined in from import_batches since the
 * provenance line needs to name the file, not just link to it.
 */
export async function getImportRowBatchInfo(
  importRowId: string,
): Promise<ImportRowBatchInfo | null> {
  const user = await getSession();
  const supabase = await createClient();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("import_rows")
    .select("import_batch_id, row_number, import_batches (file_name)")
    .eq("id", importRowId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  const batch = Array.isArray(data.import_batches)
    ? data.import_batches[0]
    : data.import_batches;

  if (!batch) {
    return null;
  }

  return {
    import_batch_id: data.import_batch_id,
    row_number: data.row_number,
    file_name: batch.file_name,
  };
}

export type AiProvider = "anthropic" | "openai" | "gemini";

export type AiSettings = {
  provider: AiProvider;
  model: string;
  hasApiKey: boolean;
};

/**
 * Returns the current user's AI assistant configuration for display in
 * the settings UI -- never the raw api_key (see lib/ai/settings.ts for
 * the server-only variant that includes it, used solely by the
 * assistant's route handler). null covers "no session" and "not
 * configured yet" alike.
 */
export const getAiSettings = cache(async (): Promise<AiSettings | null> => {
  const user = await getSession();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_ai_settings")
    .select("provider, model, api_key")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  return {
    provider: data.provider,
    model: data.model,
    hasApiKey: Boolean(data.api_key),
  };
});

export type McpAccessToken = {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/**
 * The user's own MCP personal access tokens -- RLS-scoped (owner
 * only), never the plaintext value (mcp_access_tokens only ever stores
 * a hash -- see migration 20260916010000_mcp_access.sql). Used by the
 * settings/mcp page to list/revoke tokens; the MCP route itself
 * authenticates through a separate, service-role path
 * (lib/mcp/auth.ts), not this function.
 */
export const getMcpAccessTokens = cache(async (): Promise<McpAccessToken[]> => {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("mcp_access_tokens")
    .select("id, label, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
});

// ---------------------------------------------------------------------
// Nubox sales import support (docs/cambios-flujo-v2.md 4.2)
// ---------------------------------------------------------------------
// These reads throw on a database error instead of returning [] like the
// older functions above: the import screens show the message, and an
// empty list would read as "nothing exists yet" and let a re-import
// create what is actually already there.

const IN_CHUNK_SIZE = 150;

function chunk<T>(items: T[], size = IN_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The API returns at most 1000 rows per request (max_rows), silently: a
 * ledger with years of history would come back cut off, and every total
 * built from it would be wrong. This reads page after page until a short
 * one. The query must have a stable order (the callers add the id).
 */
const API_PAGE_SIZE = 1000;

async function fetchAllPages<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];

  for (let from = 0; ; from += API_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + API_PAGE_SIZE - 1);
    if (error) return { data: all, error };
    all.push(...(data ?? []));
    if (!data || data.length < API_PAGE_SIZE) return { data: all, error: null };
  }
}

/** Stored documents matching the given folios (any type), for the upsert preview. */
export async function getExistingDocumentsByNumber(
  companyId: string,
  numbers: string[],
): Promise<ExistingDocument[]> {
  const user = await getSession();

  if (!user || numbers.length === 0) {
    return [];
  }

  const supabase = await createClient();
  const result: ExistingDocument[] = [];

  for (const part of chunk(Array.from(new Set(numbers)))) {
    const { data, error } = await supabase
      .from("sales_documents")
      .select(
        "id, document_type, document_number, client_id, net_amount, total_amount, payment_status, due_date, document_date, voided, annulled_by_document_id, annuls_document_id, project_id",
      )
      .eq("company_id", companyId)
      .in("document_number", part);

    if (error) {
      throw new Error(`No se pudieron leer los documentos existentes: ${error.message}`);
    }

    for (const row of data ?? []) {
      result.push({
        id: row.id,
        documentType: row.document_type,
        documentNumber: row.document_number,
        clientId: row.client_id,
        netAmount: Number(row.net_amount),
        totalAmount: Number(row.total_amount),
        paymentStatus: row.payment_status,
        dueDate: row.due_date,
        documentDate: row.document_date,
        voided: row.voided,
        annulledByDocumentId: row.annulled_by_document_id,
        annulsDocumentId: row.annuls_document_id,
        projectId: row.project_id,
      });
    }
  }

  return result;
}

/**
 * Sales already in the ERP without a folio (CSV importer, manual entry):
 * what a first Nubox import has to reconcile with instead of duplicating.
 * Narrowed to the given clients and dates so it never reads the whole ledger.
 */
export async function getUnnumberedSales(
  companyId: string,
  clientIds: string[],
  fromDate: string,
  toDate: string,
): Promise<LegacyDocument[]> {
  const user = await getSession();

  if (!user || clientIds.length === 0) {
    return [];
  }

  const supabase = await createClient();
  const result: LegacyDocument[] = [];

  for (const part of chunk(clientIds)) {
    const { data, error } = await supabase
      .from("sales_documents")
      .select("id, client_id, document_date, net_amount, total_amount, document_type, created_at")
      .eq("company_id", companyId)
      .is("document_number", null)
      .eq("voided", false)
      .in("document_type", ["invoice", "manual", "receipt"])
      .in("client_id", part)
      .gte("document_date", fromDate)
      .lte("document_date", toDate);

    if (error) {
      throw new Error(`No se pudieron leer las ventas ya cargadas: ${error.message}`);
    }

    for (const row of data ?? []) {
      result.push({
        id: row.id,
        clientId: row.client_id,
        documentDate: row.document_date,
        netAmount: Number(row.net_amount),
        totalAmount: Number(row.total_amount),
        documentType: row.document_type,
        createdAt: row.created_at,
      });
    }
  }

  return result;
}

export type PairableInvoice = {
  id: string;
  documentNumber: string;
  clientId: string;
  netAmount: number;
  documentDate: string;
};

/** Stored invoices that no credit note has annulled, for the given clients. */
export async function getPairableInvoices(
  companyId: string,
  clientIds: string[],
): Promise<PairableInvoice[]> {
  const user = await getSession();

  if (!user || clientIds.length === 0) {
    return [];
  }

  const supabase = await createClient();
  const result: PairableInvoice[] = [];

  for (const part of chunk(Array.from(new Set(clientIds)))) {
    const ordered = supabase
      .from("sales_documents")
      .select("id, document_number, client_id, net_amount, document_date")
      .eq("company_id", companyId)
      .eq("document_type", "invoice")
      .eq("voided", false)
      .is("annulled_by_document_id", null)
      .not("document_number", "is", null)
      .in("client_id", part)
      .order("id");
    // A client with years of invoices can exceed one API page.
    const { data, error } = await fetchAllPages((from, to) => ordered.range(from, to));

    if (error) {
      throw new Error(`No se pudieron leer las facturas a emparejar: ${error.message}`);
    }

    for (const row of data ?? []) {
      result.push({
        id: row.id,
        documentNumber: row.document_number as string,
        clientId: row.client_id,
        netAmount: Number(row.net_amount),
        documentDate: row.document_date,
      });
    }
  }

  return result;
}

/**
 * Balance still to invoice per job: quoted amount (projects.budget) minus
 * the net of the non-annulled invoices already linked to it. Closed and
 * cancelled jobs are left out (both spellings of the status enum, so this
 * keeps working across the 4.1 status change) -- they must not steal an
 * exact-amount match from the job that is really being invoiced.
 */
export async function getProjectBillingBalances(companyId: string): Promise<JobBalance[]> {
  const user = await getSession();

  if (!user) {
    return [];
  }

  const supabase = await createClient();
  const [projectsResult, invoicesResult] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, client_id, budget")
      .eq("company_id", companyId)
      .not("status", "in", "(closed,cerrado,cancelado)"),
    (() => {
      const ordered = supabase
        .from("sales_documents")
        .select("project_id, net_amount")
        .eq("company_id", companyId)
        .eq("document_type", "invoice")
        .eq("voided", false)
        .not("project_id", "is", null)
        .order("id");
      return fetchAllPages((from, to) => ordered.range(from, to));
    })(),
  ]);

  if (projectsResult.error) {
    throw new Error(`No se pudieron leer los trabajos: ${projectsResult.error.message}`);
  }
  if (invoicesResult.error) {
    throw new Error(`No se pudieron leer las facturas vinculadas: ${invoicesResult.error.message}`);
  }

  const invoiced = new Map<string, number>();
  for (const row of invoicesResult.data ?? []) {
    const projectId = row.project_id as string;
    invoiced.set(projectId, (invoiced.get(projectId) ?? 0) + Number(row.net_amount));
  }

  return (projectsResult.data ?? []).map((project) => ({
    projectId: project.id,
    name: project.name,
    clientId: project.client_id,
    quotedAmount: project.budget === null ? null : Number(project.budget),
    invoicedAmount: invoiced.get(project.id) ?? 0,
  }));
}

export type PendingSalesRow = {
  id: string;
  documentNumber: string | null;
  documentType: SalesDocumentType;
  clientId: string;
  clientName: string | null;
  documentDate: string;
  dueDate: string | null;
  paymentStatus: PaymentStatus | null;
  netAmount: number;
  totalAmount: number;
};

export type PendingCreditNote = PendingSalesRow & {
  /** Invoices it could annul: same client and net, not later, not yet annulled. */
  candidates: { id: string; documentNumber: string; documentDate: string }[];
};

/** What the "gestionar desde" date hides: pending-type documents older than it. */
export type OutsideManagement = {
  total: number;
  creditNotes: number;
  invoices: number;
  manualSales: number;
};

export type SalesPending = {
  /** The company's "gestionar desde" date the lists are cut at (null = no limit). */
  managementStartDate: string | null;
  unpairedCreditNotes: PendingCreditNote[];
  unlinkedInvoices: PendingSalesRow[];
  /** Overdue (vencido) for more than STALE_OVERDUE_DAYS: the cobro should be checked in Nubox. */
  staleUnpaidInvoices: PendingSalesRow[];
  unpaidManualSales: PendingSalesRow[];
  outsideManagement: OutsideManagement;
};

const PENDING_COLUMNS =
  "id, document_number, document_type, client_id, document_date, due_date, payment_status, net_amount, total_amount, clients (name)";

type PendingRowRecord = {
  id: string;
  document_number: string | null;
  document_type: SalesDocumentType;
  client_id: string;
  document_date: string;
  due_date: string | null;
  payment_status: PaymentStatus | null;
  net_amount: number | string;
  total_amount: number | string;
  clients: { name: string } | { name: string }[] | null;
};

function toPendingRow(row: PendingRowRecord): PendingSalesRow {
  const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;

  return {
    id: row.id,
    documentNumber: row.document_number,
    documentType: row.document_type,
    clientId: row.client_id,
    clientName: client?.name ?? null,
    documentDate: row.document_date,
    dueDate: row.due_date,
    paymentStatus: row.payment_status,
    netAmount: Number(row.net_amount),
    totalAmount: Number(row.total_amount),
  };
}

/**
 * The company's "gestionar desde" date (docs/plan-sistema-v3.md, B1): Pendientes
 * only shows documents from this date on. Null = no limit. Read on its own (not
 * added to getCompanyForEdit) so a database that has not run the migration only
 * breaks the screens that use it, and says why.
 */
export async function getManagementStartDate(companyId: string): Promise<string | null> {
  const user = await getSession();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("companies")
    .select("management_start_date")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    const hint = /management_start_date|column/i.test(error.message)
      ? " (¿falta aplicar la migración 20260921010000_companies_management_start_date.sql?)"
      : "";
    throw new Error(`No se pudo leer la fecha de gestión de la empresa: ${error.message}${hint}`);
  }

  return (data?.management_start_date as string | null | undefined) ?? null;
}

/**
 * The lists the month close will need (docs 4.2 / 4.4), until that wizard
 * exists: credit notes still unpaired, invoices with no job, overdue
 * invoices to re-check and manual sales awaiting cobro. Every list is cut at
 * the company's "gestionar desde" date; what the cut hides is only counted.
 */
export async function getSalesPending(
  companyId: string,
  today: Date = new Date(),
): Promise<SalesPending> {
  const user = await getSession();
  const empty: SalesPending = {
    managementStartDate: null,
    unpairedCreditNotes: [],
    unlinkedInvoices: [],
    staleUnpaidInvoices: [],
    unpaidManualSales: [],
    outsideManagement: { total: 0, creditNotes: 0, invoices: 0, manualSales: 0 },
  };

  if (!user) {
    return empty;
  }

  const supabase = await createClient();
  const managementStartDate = await getManagementStartDate(companyId);
  const overdueBefore = staleDueCutoff(today);

  // Each list is cut at the company's start date when it has one (plain
  // conditional filters: PostgREST's builder types get too deep for generics).
  const from = managementStartDate;

  let notesQuery = supabase
    .from("sales_documents")
    .select(PENDING_COLUMNS)
    .eq("company_id", companyId)
    .eq("document_type", "credit_note")
    .eq("voided", false)
    .is("annuls_document_id", null)
    .not("document_number", "is", null);
  if (from) notesQuery = notesQuery.gte("document_date", from);

  let unlinkedQuery = supabase
    .from("sales_documents")
    .select(PENDING_COLUMNS)
    .eq("company_id", companyId)
    .eq("document_type", "invoice")
    .eq("voided", false)
    .is("project_id", null);
  if (from) unlinkedQuery = unlinkedQuery.gte("document_date", from);

  let staleQuery = supabase
    .from("sales_documents")
    .select(PENDING_COLUMNS)
    .eq("company_id", companyId)
    .eq("document_type", "invoice")
    .eq("voided", false)
    .eq("payment_status", "vencido")
    .lt("due_date", overdueBefore);
  if (from) staleQuery = staleQuery.gte("document_date", from);

  let manualQuery = supabase
    .from("sales_documents")
    .select(PENDING_COLUMNS)
    .eq("company_id", companyId)
    .eq("document_type", "manual")
    .eq("voided", false)
    .eq("payment_status", "pendiente");
  if (from) manualQuery = manualQuery.gte("document_date", from);

  // What the cut hides: the same filters as the first three lists, counted on
  // the dates before the start. Without a start date nothing is hidden.
  const none = Promise.resolve({ count: 0 as number | null, error: null });

  let outsideNotesQuery = supabase
    .from("sales_documents")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("document_type", "credit_note")
    .eq("voided", false)
    .is("annuls_document_id", null)
    .not("document_number", "is", null);
  if (from) outsideNotesQuery = outsideNotesQuery.lt("document_date", from);

  let outsideInvoicesQuery = supabase
    .from("sales_documents")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("document_type", "invoice")
    .eq("voided", false)
    .is("project_id", null);
  if (from) outsideInvoicesQuery = outsideInvoicesQuery.lt("document_date", from);

  let outsideManualQuery = supabase
    .from("sales_documents")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("document_type", "manual")
    .eq("voided", false)
    .eq("payment_status", "pendiente");
  if (from) outsideManualQuery = outsideManualQuery.lt("document_date", from);

  const [notesResult, unlinkedResult, staleResult, manualResult, outsideNotes, outsideInvoices, outsideManual] =
    await Promise.all([
      notesQuery.order("document_date", { ascending: false }),
      unlinkedQuery.order("document_date", { ascending: false }),
      staleQuery.order("due_date", { ascending: true }),
      manualQuery.order("document_date", { ascending: false }),
      from ? outsideNotesQuery : none,
      from ? outsideInvoicesQuery : none,
      from ? outsideManualQuery : none,
    ]);

  for (const [label, result] of [
    ["las notas de crédito", notesResult],
    ["las facturas sin trabajo", unlinkedResult],
    ["las facturas vencidas", staleResult],
    ["las ventas sin factura", manualResult],
    ["las notas de crédito anteriores a la gestión", outsideNotes],
    ["las facturas anteriores a la gestión", outsideInvoices],
    ["las ventas sin factura anteriores a la gestión", outsideManual],
  ] as const) {
    if (result.error) {
      throw new Error(`No se pudieron leer ${label}: ${result.error.message}`);
    }
  }

  const notes = ((notesResult.data ?? []) as PendingRowRecord[]).map(toPendingRow);
  const invoices = await getPairableInvoices(
    companyId,
    notes.map((note) => note.clientId),
  );

  const outside = {
    creditNotes: outsideNotes.count ?? 0,
    invoices: outsideInvoices.count ?? 0,
    manualSales: outsideManual.count ?? 0,
  };

  return {
    managementStartDate,
    unpairedCreditNotes: notes.map((note) => ({
      ...note,
      candidates: invoices
        .filter(
          (invoice) =>
            invoice.clientId === note.clientId &&
            invoice.netAmount === note.netAmount &&
            invoice.documentDate <= note.documentDate,
        )
        .map((invoice) => ({
          id: invoice.id,
          documentNumber: invoice.documentNumber,
          documentDate: invoice.documentDate,
        })),
    })),
    unlinkedInvoices: ((unlinkedResult.data ?? []) as PendingRowRecord[]).map(toPendingRow),
    staleUnpaidInvoices: ((staleResult.data ?? []) as PendingRowRecord[]).map(toPendingRow),
    unpaidManualSales: ((manualResult.data ?? []) as PendingRowRecord[]).map(toPendingRow),
    outsideManagement: {
      ...outside,
      total: outside.creditNotes + outside.invoices + outside.manualSales,
    },
  };
}

export type SalesDocumentBilling = {
  document_number: string | null;
  due_date: string | null;
  payment_status: PaymentStatus | null;
  paid_at: string | null;
  payment_method: string | null;
  nubox_send_number: string | null;
  /** Folio of the credit note that annulled this invoice, if any. */
  annulled_by_number: string | null;
  /** Folio of the invoice this credit note annuls, if any. */
  annuls_number: string | null;
};

/**
 * Folio, cobro and credit-note link of one sale -- read on its own (not
 * added to getSalesDocumentForEdit) so the edit page keeps working on a
 * database that has not run the Nubox migration. Never throws: on any
 * error the caller simply shows no billing block.
 */
export async function getSalesDocumentBilling(
  companyId: string,
  salesDocumentId: string,
): Promise<SalesDocumentBilling | null> {
  const user = await getSession();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales_documents")
    .select(
      "document_number, due_date, payment_status, paid_at, payment_method, nubox_send_number, annulled_by_document_id, annuls_document_id",
    )
    .eq("company_id", companyId)
    .eq("id", salesDocumentId)
    .maybeSingle();

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return null;
  }

  const partnerIds = [data.annulled_by_document_id, data.annuls_document_id].filter(
    (id): id is string => Boolean(id),
  );
  const numbers = new Map<string, string | null>();

  if (partnerIds.length > 0) {
    const { data: partners } = await supabase
      .from("sales_documents")
      .select("id, document_number")
      .in("id", partnerIds);

    for (const partner of partners ?? []) {
      numbers.set(partner.id, partner.document_number);
    }
  }

  return {
    document_number: data.document_number,
    due_date: data.due_date,
    payment_status: data.payment_status,
    paid_at: data.paid_at,
    payment_method: data.payment_method,
    nubox_send_number: data.nubox_send_number,
    annulled_by_number: data.annulled_by_document_id
      ? (numbers.get(data.annulled_by_document_id) ?? null)
      : null,
    annuls_number: data.annuls_document_id ? (numbers.get(data.annuls_document_id) ?? null) : null,
  };
}
