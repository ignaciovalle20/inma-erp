import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";
import { runAsSessionClient } from "@/lib/supabase/server";
import { getCompanyForEdit } from "@/lib/dal";
import { TOOL_DEFINITIONS, executeTool, type Draft } from "@/lib/ai/tools";
import { saveDraft } from "@/lib/ai/saveDraft";
import { getMcpUserClient, McpSessionError } from "@/lib/mcp/session";
import type { JsonSchema } from "@/lib/ai/providers";

/**
 * MCP tools = the in-app assistant's own tools (lib/ai/tools.ts), run
 * under a real session of the token's owner (lib/mcp/session.ts). The
 * only MCP-specific parts are:
 * - every company tool takes company_id (an MCP client has no "active
 *   company" in the sidebar);
 * - propose_* drafts are parked in mcp_pending_drafts and saved by
 *   confirm_draft once the person says yes, with the same saveDraft the
 *   in-app chat uses.
 *
 * This file used to re-implement every query with the service-role
 * client; it drifted from the app (monthly result with credit notes
 * added and IVA included, jobs created without quote) and could never
 * confirm a draft (the create_* RPCs need auth.uid()).
 */

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type McpToolContext = {
  userId: string;
};

type McpOutcome = { result: unknown; isError?: boolean };

const companyIdProp: JsonSchema = {
  type: "string",
  description: "id de la empresa (uuid) -- obtenelo de list_companies si todavía no lo tenés.",
};

const CONFIRM_NOTE =
  " En MCP devuelve un draft_id: mostrale el borrador a la persona y llamá confirm_draft solo si te confirma explícitamente.";

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  ...TOOL_DEFINITIONS.map((tool) => {
    if (tool.name === "list_companies") {
      return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
    }
    return {
      name: tool.name,
      description: tool.name.startsWith("propose_") ? tool.description + CONFIRM_NOTE : tool.description,
      inputSchema: {
        ...tool.parameters,
        properties: { company_id: companyIdProp, ...(tool.parameters.properties ?? {}) },
        required: ["company_id", ...(tool.parameters.required ?? [])],
      },
    };
  }),
  {
    name: "confirm_draft",
    description:
      "Confirma y guarda un borrador preparado por un propose_* (gasto, venta, trabajo o cambio de estado). Llamala solo después de que la persona confirmó explícitamente -- nunca por tu cuenta.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "id devuelto por el propose_* correspondiente." },
      },
      required: ["draft_id"],
    },
  },
];

function hasError(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

async function withUserSession(userId: string, fn: () => Promise<McpOutcome>): Promise<McpOutcome> {
  let client;
  try {
    client = await getMcpUserClient(userId);
  } catch (thrown) {
    const message = thrown instanceof McpSessionError ? thrown.message : "No se pudo iniciar la sesión del usuario.";
    if (!(thrown instanceof McpSessionError)) console.error(thrown);
    return { result: { error: message }, isError: true };
  }
  return runAsSessionClient(client, fn);
}

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<McpOutcome> {
  if (!MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name) || name === "confirm_draft") {
    return { result: { error: `Herramienta desconocida: ${name}` }, isError: true };
  }

  return withUserSession(ctx.userId, async () => {
    if (name === "list_companies") {
      const outcome = await executeTool(name, args, { companyId: null });
      return { result: outcome.result, isError: hasError(outcome.result) || undefined };
    }

    const { company_id: rawCompanyId, ...toolArgs } = args;
    const companyId = typeof rawCompanyId === "string" ? rawCompanyId : null;
    if (!companyId) {
      return { result: { error: "Falta company_id." }, isError: true };
    }
    // RLS-scoped: null for a company the token's owner doesn't belong to.
    if (!(await getCompanyForEdit(companyId))) {
      return { result: { error: "No tenés acceso a esa empresa." }, isError: true };
    }

    const outcome = await executeTool(name, toolArgs, { companyId });
    if (!outcome.draft) {
      return { result: outcome.result, isError: hasError(outcome.result) || undefined };
    }

    const supabase = createServiceRoleClient();
    const { data: draftRow, error: draftError } = await supabase
      .from("mcp_pending_drafts")
      .insert({ user_id: ctx.userId, company_id: companyId, kind: outcome.draft.kind, payload: outcome.draft })
      .select("id")
      .single();

    if (draftError || !draftRow) {
      console.error(draftError);
      return { result: { error: "No se pudo preparar el borrador." }, isError: true };
    }

    return {
      result: {
        draft_id: draftRow.id,
        draft: outcome.draft,
        note:
          "Borrador preparado (vence en 15 minutos). Mostraselo a la persona y llamá confirm_draft solo si te confirma explícitamente." +
          (outcome.draft.kind === "expense" && outcome.draft.duplicateWarning
            ? " OJO: ya existe un gasto con el mismo proveedor, fecha y total -- avisale antes de confirmar."
            : ""),
      },
    };
  });
}

/**
 * confirm_draft doesn't take company_id from the caller -- it's read back
 * from the draft row itself, so a confirm call can't be pointed at a
 * different company than the one the draft was proposed for. Membership
 * is re-checked (under the user's session) since the two calls can be
 * minutes apart.
 */
export async function confirmMcpDraft(draftId: string, ctx: McpToolContext): Promise<McpOutcome> {
  const supabase = createServiceRoleClient();

  const { data: draftRow, error: draftError } = await supabase
    .from("mcp_pending_drafts")
    .select("id, user_id, company_id, kind, payload, expires_at, consumed_at")
    .eq("id", draftId)
    .maybeSingle();

  if (draftError) {
    console.error(draftError);
    return { result: { error: "No se pudo leer el borrador." }, isError: true };
  }
  if (!draftRow || draftRow.user_id !== ctx.userId) {
    return { result: { error: "Borrador no encontrado." }, isError: true };
  }
  if (draftRow.consumed_at) {
    return { result: { error: "Este borrador ya fue confirmado antes." }, isError: true };
  }
  if (new Date(draftRow.expires_at).getTime() < Date.now()) {
    return { result: { error: "Este borrador expiró -- volvé a proponerlo." }, isError: true };
  }

  const companyId: string = draftRow.company_id;
  // Drafts parked before this version have no `kind` in the payload.
  const draft = { ...(draftRow.payload as object), kind: draftRow.kind } as Draft;

  return withUserSession(ctx.userId, async () => {
    if (!(await getCompanyForEdit(companyId))) {
      return { result: { error: "No tenés acceso a esa empresa." }, isError: true };
    }

    // Claim the draft before creating anything: only one update can flip
    // consumed_at from null, so two confirmations at once (or a retry
    // after a lost response) can't create the document twice.
    const { data: claimed, error: claimError } = await supabase
      .from("mcp_pending_drafts")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", draftId)
      .is("consumed_at", null)
      .select("id");

    if (claimError) {
      console.error(claimError);
      return { result: { error: "No se pudo reservar el borrador." }, isError: true };
    }
    if (!claimed || claimed.length === 0) {
      return { result: { error: "Este borrador ya fue confirmado antes." }, isError: true };
    }

    const saved = await saveDraft(companyId, draft);
    if (!saved.ok) {
      // Give the draft back so a transient failure doesn't burn it.
      const { error: releaseError } = await supabase
        .from("mcp_pending_drafts")
        .update({ consumed_at: null })
        .eq("id", draftId);
      if (releaseError) console.error(releaseError);
      return {
        result: {
          error:
            saved.error === "invalid_draft"
              ? "El borrador no es válido -- volvé a proponerlo."
              : saved.error === "not_found"
                ? "No se encontró el trabajo."
                : "No se pudo guardar. Probá de nuevo.",
        },
        isError: true,
      };
    }

    return { result: { ok: true, id: saved.id, href: saved.href } };
  });
}
