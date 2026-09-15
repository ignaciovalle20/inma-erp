import { NextResponse } from "next/server";
import { getSession, getCompanyForEdit } from "@/lib/dal";
import { getAiSettingsWithKey } from "@/lib/ai/settings";
import { getProviderClient, type InternalMessage } from "@/lib/ai/providers";
import { TOOL_DEFINITIONS, executeTool, type Draft } from "@/lib/ai/tools";

const MAX_TOOL_ROUNDS = 6;

type ChatRequestBody = {
  companyId?: string;
  messages?: { role: "user" | "assistant"; content: string }[];
};

function buildSystemPrompt(companyName: string | null): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "Sos el asistente integrado de INMA ERP, un sistema de gestión de rentabilidad.",
    `Fecha actual: ${today}.`,
    companyName
      ? `Empresa activa: ${companyName}.`
      : "No hay ninguna empresa activa en esta conversación.",
    "Respondé únicamente preguntas relacionadas con los datos y el uso de esta app (ventas, gastos, clientes, proveedores, proyectos, resultados). Si te preguntan algo no relacionado, decilo amablemente y redirigí la conversación.",
    "Para cualquier dato numérico o listado, usá siempre las herramientas disponibles -- nunca inventes cifras ni IDs.",
    "Para crear un gasto o una venta: primero juntá todos los datos necesarios preguntando lo que falte (podés usar list_clients/list_suppliers/list_projects para confirmar nombres exactos), y recién cuando tengas todo llamá a propose_expense o propose_sale. Esas herramientas NO guardan nada -- solo arman un borrador que el usuario debe confirmar explícitamente en la interfaz. Después de llamarlas, resumile el borrador al usuario en un mensaje corto.",
    "Respondé en español, de forma breve y concreta.",
  ].join("\n");
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

  let companyName: string | null = null;
  if (body.companyId) {
    const membership = await getCompanyForEdit(body.companyId);
    if (!membership) {
      return NextResponse.json({ error: "company_not_found" }, { status: 404 });
    }
    companyName = membership.company.name;
  }

  const provider = getProviderClient(settings.provider);
  const system = buildSystemPrompt(companyName);

  const internalMessages: InternalMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

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
    return NextResponse.json({ error: "provider_error" }, { status: 502 });
  }
}
