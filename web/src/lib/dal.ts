import "server-only";

import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

export type UserCompany = {
  id: string;
  name: string;
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
    .select("role, companies (id, name)");

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
        companies: { id: string; name: string };
      } => row.companies !== null,
    )
    .map((row) => ({
      id: row.companies.id,
      name: row.companies.name,
      role: row.role,
    }));
}
