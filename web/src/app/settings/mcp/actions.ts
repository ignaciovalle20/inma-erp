"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type CreateMcpTokenState = {
  error: string | null;
  token: string | null;
};

/**
 * The plaintext token only ever exists in this function's return value
 * and whatever the browser does with it -- create_mcp_access_token()
 * (security definer) generates and hashes it server-side; nothing
 * persists the plaintext anywhere (see migration
 * 20260916010000_mcp_access.sql).
 */
export async function createMcpToken(
  _prevState: CreateMcpTokenState,
  formData: FormData,
): Promise<CreateMcpTokenState> {
  const label = formData.get("label");

  if (typeof label !== "string" || !label.trim()) {
    return { error: "Ponele un nombre al token (ej. \"Claude Code - notebook\").", token: null };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_mcp_access_token", { p_label: label.trim() })
    .select()
    .single<{ id: string; token: string }>();

  if (error || !data) {
    console.error(error);
    return { error: "No se pudo crear el token. Probá de nuevo.", token: null };
  }

  revalidatePath("/settings/mcp");
  return { error: null, token: data.token };
}

export async function revokeMcpToken(tokenId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("mcp_access_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId);

  if (error) {
    console.error(error);
    return;
  }

  revalidatePath("/settings/mcp");
}
