import "server-only";

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
 */
export async function getSession(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return user;
}

/**
 * Returns the companies the current user holds a membership for, via
 * RLS-scoped queries (no client-side filtering). Empty array covers
 * both "no session" and "no memberships".
 */
export async function getUserCompanies(): Promise<UserCompany[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

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
}

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
 * form.
 */
export async function getCompanyForEdit(
  companyId: string,
): Promise<{ company: Company; role: string } | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

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
}

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
 * Returns the sales documents for a company, RLS-scoped (no
 * client-side filtering), joined with the client name for display.
 * Empty array covers "no session", "not a member", and "member with
 * zero documents" alike -- callers that need to distinguish "not a
 * member" for a redirect should gate with getCompanyForEdit first, as
 * the sales list page does.
 */
export async function getSalesDocuments(
  companyId: string,
): Promise<SalesDocumentWithRelations[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("sales_documents")
    .select(
      "id, company_id, client_id, document_type, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, voided, voided_at, clients (name)",
    )
    .eq("company_id", companyId)
    .order("document_date", { ascending: false });

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
      "id, company_id, client_id, document_type, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, voided, voided_at",
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
};

export type CostDocumentWithRelations = CostDocument & {
  supplier_name: string | null;
  project_name: string | null;
  is_allocated: boolean;
};

/**
 * Returns the cost documents for a company, RLS-scoped (no client-side
 * filtering), joined with the supplier/project name for display.
 * Mirrors getSalesDocuments. Empty array covers "no session", "not a
 * member", and "member with zero documents" alike -- callers that need
 * to distinguish "not a member" for a redirect should gate with
 * getCompanyForEdit first, as the costs list page does.
 */
export async function getCostDocuments(
  companyId: string,
): Promise<CostDocumentWithRelations[]> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from("cost_documents")
    .select(
      "id, company_id, supplier_id, project_id, classification, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at, suppliers (name), projects (name)",
    )
    .eq("company_id", companyId)
    .order("document_date", { ascending: false });

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
      "id, company_id, supplier_id, project_id, classification, document_date, currency, net_amount, tax_amount, total_amount, created_at, updated_at",
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
