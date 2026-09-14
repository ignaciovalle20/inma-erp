import "server-only";

import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

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
};

/**
 * Returns the clients for a company, RLS-scoped (no client-side
 * filtering). Empty array covers "no session", "not a member", and
 * "member with zero clients" alike -- callers that need to distinguish
 * "not a member" for a redirect should gate with getCompanyForEdit
 * first, as the clients list page does.
 */
export async function getClients(companyId: string): Promise<Client[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("clients")
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
}

/**
 * Returns a single client scoped to a company (RLS-scoped), or null if
 * not found / caller isn't a member of that company. Used by the edit
 * page, which relies entirely on RLS to reject non-members.
 */
export async function getClientForEdit(
  companyId: string,
  clientId: string,
): Promise<Client | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("clients")
    .select("id, company_id, name, tax_id, country, notes, active")
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
export async function getPersonnel(companyId: string): Promise<Personnel[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
}

/**
 * Returns a single person scoped to a company (RLS-scoped), or null if
 * not found / caller isn't a member of that company. Used by the edit
 * page, which relies entirely on RLS to reject non-members.
 */
export async function getPersonnelForEdit(
  companyId: string,
  personnelId: string,
): Promise<Personnel | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
}

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
export async function getRecurringServices(
  companyId: string,
): Promise<RecurringServiceWithClient[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
}

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
export async function getBusinessAreas(
  companyId: string,
): Promise<BusinessArea[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

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
}

/**
 * Returns a single business area scoped to a company (RLS-scoped), or
 * null if not found / caller isn't a member of that company. Used by
 * the edit page, which relies entirely on RLS to reject non-members.
 */
export async function getBusinessAreaForEdit(
  companyId: string,
  areaId: string,
): Promise<BusinessArea | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
export async function getSuppliers(companyId: string): Promise<Supplier[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

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
}

/**
 * Returns a single supplier scoped to a company (RLS-scoped), or null
 * if not found / caller isn't a member of that company. Used by the
 * edit page, which relies entirely on RLS to reject non-members.
 */
export async function getSupplierForEdit(
  companyId: string,
  supplierId: string,
): Promise<Supplier | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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

export type ProjectStatus = "active" | "on_hold" | "closed";

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
};

export type ProjectWithRelations = Project & {
  client_name: string | null;
  business_area_name: string | null;
};

/**
 * Returns the projects for a company, RLS-scoped (no client-side
 * filtering), joined with client/area names for display. Empty array
 * covers "no session", "not a member", and "member with zero projects"
 * alike -- callers that need to distinguish "not a member" for a
 * redirect should gate with getCompanyForEdit first, as the projects
 * list page does.
 */
export async function getProjects(
  companyId: string,
): Promise<ProjectWithRelations[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, company_id, client_id, business_area_id, name, start_date, end_date, status, budget, responsible, clients (name), business_areas (name)",
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
      client_name: client?.name ?? null,
      business_area_name: businessArea?.name ?? null,
    };
  });
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, company_id, client_id, business_area_id, name, start_date, end_date, status, budget, responsible",
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
export async function getSalesDocuments(
  companyId: string,
  filters?: SalesDocumentFilters,
): Promise<SalesDocumentWithRelations[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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

  const { data, error } = await query.order("document_date", {
    ascending: false,
  });

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
}

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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

export type CostDocument = {
  id: string;
  company_id: string;
  supplier_id: string | null;
  project_id: string | null;
  classification: CostClassification;
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
export async function getCostDocuments(
  companyId: string,
  filters?: CostDocumentFilters,
): Promise<CostDocumentWithRelations[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  let query = supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at, suppliers (name), projects (name)",
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

  const { data, error } = await query.order("document_date", {
    ascending: false,
  });

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

  if (documentIds.length > 0) {
    const { data: allocationRows, error: allocationError } = await supabase
      .from("cost_allocations")
      .select("cost_document_id")
      .in("cost_document_id", documentIds);

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
    };
  });
}

/**
 * Returns a single cost document scoped to a company (RLS-scoped), or
 * null if not found / caller isn't a member of that company. Used by
 * the allocate page to gate access and prefill the form.
 */
export async function getCostDocumentForEdit(
  companyId: string,
  costDocumentId: string,
): Promise<CostDocument | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at",
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: document, error: documentError } = await supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, recognized_period, recognized_period_set_by, recognized_period_set_at, suppliers (name), projects (name)",
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
  const activeProjects = projects.filter(
    (project) => project.status === "active",
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

export type ImportRowStatus = "imported" | "error" | "duplicate";

export type ImportBatch = {
  id: string;
  company_id: string;
  file_name: string;
  total_rows: number;
  imported_rows: number;
  error_rows: number;
  duplicate_rows: number;
  imported_by: string | null;
  imported_at: string;
};

/**
 * Returns the import batches for a company, RLS-scoped (no
 * client-side filtering), newest first. Empty array covers "no
 * session", "not a member", and "member with zero batches" alike --
 * mirrors getSalesDocuments's shape. Read-only, per Story 4.3.
 */
export async function getImportBatches(
  companyId: string,
): Promise<ImportBatch[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("import_batches")
    .select(
      "id, company_id, file_name, total_rows, imported_rows, error_rows, duplicate_rows, imported_by, imported_at",
    )
    .eq("company_id", companyId)
    .order("imported_at", { ascending: false });

  if (error || !data) {
    if (error) {
      console.error(error);
    }
    return [];
  }

  return data;
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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select(
      "id, company_id, file_name, total_rows, imported_rows, error_rows, duplicate_rows, imported_by, imported_at",
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

  const { data: rows, error: rowsError } = await supabase
    .from("import_rows")
    .select(
      "id, import_batch_id, row_number, raw_data, status, error_message, sales_document_id, created_at",
    )
    .eq("import_batch_id", batchId)
    .order("row_number");

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
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

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
