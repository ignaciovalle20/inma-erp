import { NextResponse } from "next/server";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { getAiSettingsWithKey } from "@/lib/ai/settings";
import { getProviderClient, type InternalMessage } from "@/lib/ai/providers";
import { TOOL_DEFINITIONS, executeTool, type Draft } from "@/lib/ai/tools";

const MAX_TOOL_ROUNDS = 8;

// The client resends the whole conversation on every turn -- without a
// cap, a long chat's token cost (and the provider round-trip latency)
// grows roughly quadratically. Keep only the most recent exchanges;
// the client applies the same cap so the payload doesn't grow forever
// either, this is just the defensive backstop.
const MAX_HISTORY_MESSAGES = 24;

type ChatRequestBody = {
  companyId?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
};

/**
 * The provider SDKs throw typed errors with a `status` (Anthropic,
 * OpenAI) carrying the HTTP status from the underlying API call --
 * translate the common ones into a code the client can show a useful
 * message for, instead of one generic "couldn't connect" that masks
 * an invalid key, a bad model name, or a rate limit the same way.
 */
function classifyProviderError(error: unknown): { code: string; detail: string } {
  const status = (error as { status?: number })?.status;
  const detail = error instanceof Error ? error.message : String(error);

  if (status === 401 || status === 403) return { code: "invalid_api_key", detail };
  if (status === 404) return { code: "model_not_found", detail };
  if (status === 429) return { code: "rate_limited", detail };
  return { code: "provider_error", detail };
}

function buildSystemPrompt(company: { name: string; country: string | null; currency: string } | null): string {
  const today = new Date().toISOString().slice(0, 10);
  const currencyRule = !company
    ? null
    : company.country === "CL"
      ? "Moneda: en esta empresa (Chile) todo es en CLP. No preguntes la moneda."
      : `Moneda de la empresa: ${company.currency}. Los gastos y ventas pueden ser en USD o UYU: si la persona no dijo la moneda, preguntásela.`;
  return [
    "Sos el asistente integrado de INMA ERP, el sistema de gestión de la empresa (trabajos, ventas, costos, servicios recurrentes, técnicos y resultados).",
    `Fecha actual: ${today}.`,
    company ? `Empresa activa: ${company.name}.` : "No hay ninguna empresa activa en esta conversación.",
    currencyRule,
    "Vocabulario: a los proyectos se les dice \"trabajos\". Un trabajo nace de una cotización aceptada en Nubox (N° de cotización), pasa por el tablero (Por cotizar, En ejecución, En espera, Finalizado, Cerrado, Cancelado) y se factura al final. La cotización es el monto neto vendido; el presupuesto de costo es aparte. Las facturas de Nubox se importan al cierre de mes, no se cargan a mano.",
    "Respondé únicamente sobre los datos y el uso de esta app. Si te preguntan otra cosa, decilo amablemente y redirigí.",
    "Para cualquier dato numérico o listado usá siempre las herramientas -- nunca inventes cifras, nombres ni ids. Los montos que devuelven las herramientas ya están en la moneda indicada; mostralos con separador de miles.",
    "Para buscar un trabajo usá list_projects con query (sirve el nombre, el cliente, el N° de cotización o el N° de factura).",
    "Para crear un gasto, una venta, un trabajo o cambiar el estado de un trabajo: juntá los datos que falten preguntando (confirmá nombres con list_clients/list_suppliers/list_business_areas/list_projects) y recién ahí llamá al propose_* que corresponda. Esas herramientas NO guardan nada: arman un borrador que la persona confirma con el botón de la interfaz. Después resumí el borrador en un mensaje corto. Proponé un solo borrador por respuesta.",
    "Respondé en español, de forma breve y concreta.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function POST(request: Request) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    return NextResponse.json({ error: "empty_messages" }, { status: 400 });
  }

  const settings = await getAiSettingsWithKey();
  if (!settings) {
    return NextResponse.json({ error: "not_configured" }, { status: 409 });
  }

  let company: { name: string; country: string | null; currency: string } | null = null;
  if (body.companyId) {
    const membership = await getCompanyForEdit(body.companyId);
    if (!membership) {
      return NextResponse.json({ error: "company_not_found" }, { status: 404 });
    }
    company = membership.company;
  }

  const provider = getProviderClient(settings.provider);
  const system = buildSystemPrompt(company);

  const internalMessages: InternalMessage[] = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  let pendingDraft: Draft | undefined;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await provider.send({
        apiKey: settings.apiKey,
        model: settings.model,
        system,
        tools: TOOL_DEFINITIONS,
        messages: internalMessages,
      });

      if (response.toolCalls.length === 0) {
        return NextResponse.json({ text: response.text ?? "", draft: pendingDraft ?? null });
      }

      internalMessages.push({
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls,
      });

      const results = await Promise.all(
        response.toolCalls.map(async (call) => {
          const outcome = await executeTool(call.name, call.arguments, {
            companyId: body.companyId ?? null,
          });
          if (outcome.draft) {
            pendingDraft = outcome.draft;
          }
          return { id: call.id, name: call.name, result: outcome.result };
        }),
      );

      internalMessages.push({ role: "tool_results", results });
    }

    return NextResponse.json({
      text: "No pude terminar de procesar tu pedido en este turno -- probá reformularlo o partirlo en pasos más chicos.",
      draft: pendingDraft ?? null,
    });
  } catch (error) {
    console.error(error);
    const { code, detail } = classifyProviderError(error);
    return NextResponse.json({ error: code, detail: detail.slice(0, 300) }, { status: 502 });
  }
}
