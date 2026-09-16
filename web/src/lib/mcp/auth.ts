import "server-only";

import { createHash } from "crypto";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type McpAuthResult = { userId: string } | { error: string; status: number };

/**
 * Authenticates an MCP request by its bearer token instead of a
 * browser session cookie -- see mcp_access_tokens (migration
 * 20260916010000_mcp_access.sql) and createServiceRoleClient's own
 * warning about what that implies for every caller downstream.
 *
 * Prefers the Authorization: Bearer header (Claude Code and most MCP
 * clients let you set one), but falls back to a `?token=` query
 * param -- some clients (ChatGPT's custom connector setup, as of this
 * writing) only offer "no auth" or OAuth for a custom MCP server, with
 * no field for a raw header. Embedding the token in the server URL
 * itself is the only way those clients can authenticate at all. This
 * is a real, accepted security tradeoff (a URL can end up in logs/
 * history more easily than a header) -- the mitigation is that these
 * are short, single-purpose personal tokens the user can revoke
 * instantly from /settings/mcp, not a long-lived credential.
 */
export async function authenticateMcpRequest(request: Request): Promise<McpAuthResult> {
  const authHeader = request.headers.get("authorization");
  const headerToken =
    authHeader && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(authHeader.indexOf(" ") + 1).trim()
      : null;
  const queryToken = new URL(request.url).searchParams.get("token");
  const token = headerToken || queryToken;

  if (!token) {
    return {
      error:
        "Falta autenticación: pasá Authorization: Bearer <token>, o agregá ?token=<token> a la URL del servidor si tu cliente no soporta headers custom.",
      status: 401,
    };
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
