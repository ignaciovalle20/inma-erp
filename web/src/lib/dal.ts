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
