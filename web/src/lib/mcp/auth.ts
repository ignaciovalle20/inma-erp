import "server-only";

import { createHash } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type McpAuthResult = { userId: string } | { error: string; status: number };

/**
 * Authenticates an MCP request by its bearer token instead of a
 * browser session cookie -- see mcp_access_tokens (migration
 * 20260916010000_mcp_access.sql) and createServiceRoleClient's own
 * warning about what that implies for every caller downstream.
 */
export async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { error: "Falta el header Authorization: Bearer <token>.", status: 401 };
  }

  const token = authHeader.slice(authHeader.indexOf(" ") + 1).trim();
  if (!token) {
    return { error: "Token vacío.", status: 401 };
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const supabase = createServiceRoleClient();

  const { data, error } = await supabase
    .from("mcp_access_tokens")
    .select("id, user_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) {
    console.error(error);
    return { error: "No se pudo validar el token.", status: 500 };
  }
  if (!data || data.revoked_at) {
    return { error: "Token inválido o revocado.", status: 401 };
  }

  // Awaited (not fire-and-forget) -- a serverless function can be torn
  // down the instant the response is sent, so a detached promise here
  // could simply never run.
  const { error: updateError } = await supabase
    .from("mcp_access_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);
  if (updateError) {
    console.error(updateError);
  }

  return { userId: data.user_id };
}
