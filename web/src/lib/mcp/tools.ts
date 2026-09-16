import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";

// ---------------------------------------------------------------------
// Minimal JSON Schema type -- same shape as web/src/lib/ai/providers.ts's
// own JsonSchema/ToolDefinition, duplicated here (not imported) because
// this module intentionally never touches web/src/lib/ai/* -- that
// layer is wired to the cookie-based session client for the in-app
// assistant, and this one runs under the service-role client for the
// MCP route instead (see web/src/lib/supabase/service.ts's own
// warning). Keeping them separate means a change to one can't silently
// break the other's auth assumptions.
// ---------------------------------------------------------------------
export type JsonSchema = {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
};

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type McpToolContext = {
  userId: string;
};

type ExpenseDraftPayload = {
  supplier_id: string | null;
  supplier_name: string | null;
  project_id: string | null;
  project_name: string | null;
  classification: "direct" | "general";
  document_date: string;
  currency: string;
  tax_amount: number;
  lines: { description: string | null; amount: number }[];
  net_amount: number;
  total_amount: number;
  duplicate_warning?: { document_date: string; total_amount: number; currency: string };
};

type SaleDraftPayload = {
  client_id: string;
  client_name: string;
  project_id: string | null;
  project_name: string | null;
  document_type: "invoice" | "receipt" | "credit_note" | "manual";
  document_date: string;
  currency: string;
  tax_amount: number;
  lines: { description: string | null; amount: number }[];
  net_amount: number;
  total_amount: number;
};

type ProjectDraftPayload = {
  name: string;
  client_id: string;
  client_name: string;
  business_area_id: string;
  business_area_name: string;
  start_date: string | null;
  end_date: string | null;
  budget: number | null;
  responsible: string | null;
};

const MAX_LISTED_DOCUMENTS = 200;

const stringProp = (description: string): JsonSchema => ({ type: "string", description });
const numberProp = (description: string): JsonSchema => ({ type: "number", description });
const companyIdProp: JsonSchema = {
  type: "string",
  description: "id de la empresa (uuid) -- obtenelo de list_companies si todavía no lo tenés.",
};

const linesSchema: JsonSchema = {
  type: "array",
  description: "Líneas del documento. Cada una necesita un importe neto mayor a cero.",
  items: {
    type: "object",
    properties: {
      description: stringProp("Descripción de la línea (opcional)."),
      amount: numberProp("Importe neto de la línea, mayor a cero."),
    },
    required: ["amount"],
  },
};

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_companies",
    description: "Lista las empresas a las que pertenece el dueño de este token.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_clients",
    description: "Lista los clientes activos de una empresa.",
    inputSchema: { type: "object", properties: { company_id: companyIdProp }, required: ["company_id"] },
  },
  {
    name: "list_suppliers",
    description: "Lista los proveedores activos de una empresa.",
    inputSchema: { type: "object", properties: { company_id: companyIdProp }, required: ["company_id"] },
  },
  {
    name: "list_projects",
    description: "Lista los proyectos (\"trabajos\") activos de una empresa.",
    inputSchema: { type: "object", properties: { company_id: companyIdProp }, required: ["company_id"] },
  },
  {
    name: "list_sales_documents",
    description: "Lista documentos de venta de una empresa, opcionalmente filtrados por rango de fechas.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
      },
      required: ["company_id"],
    },
  },
  {
    name: "list_cost_documents",
    description: "Lista documentos de costo/gasto de una empresa, opcionalmente filtrados por rango de fechas.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
      },
      required: ["company_id"],
    },
  },
  {
    name: "get_monthly_result",
    description:
      "Resultado mensual simplificado de una empresa: ventas netas, costos directos, costos generales y resultado operativo, calculados por fecha de documento (no considera reasignación de período ni prorrateos de costos generales/personal -- para el detalle completo, usá la app).",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        period: stringProp("Cualquier fecha dentro del mes a consultar, YYYY-MM-DD."),
      },
      required: ["company_id", "period"],
    },
  },
  {
    name: "propose_expense",
    description:
      "Prepara (sin guardar) un borrador de gasto y devuelve un draft_id. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente que lo guarde.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        supplier_name: stringProp("Nombre del proveedor, tal como aparece en list_suppliers. Opcional."),
        project_name: stringProp("Nombre del proyecto. Obligatorio si classification es 'direct'."),
        classification: { type: "string", enum: ["direct", "general"], description: "direct: ligado a un proyecto. general: gasto de la empresa." },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: stringProp("Moneda, ej. CLP, UYU, USD."),
        tax_amount: numberProp("Monto de impuesto (IVA). 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["company_id", "classification", "document_date", "currency", "lines"],
    },
  },
  {
    name: "propose_sale",
    description:
      "Prepara (sin guardar) un borrador de venta y devuelve un draft_id. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente que lo guarde.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        client_name: stringProp("Nombre del cliente, tal como aparece en list_clients."),
        project_name: stringProp("Nombre del proyecto. Opcional."),
        document_type: { type: "string", enum: ["invoice", "receipt", "credit_note", "manual"] },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: stringProp("Moneda, ej. CLP, UYU, USD."),
        tax_amount: numberProp("Monto de impuesto (IVA). 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["company_id", "client_name", "document_type", "document_date", "currency", "lines"],
    },
  },
  {
    name: "propose_project",
    description:
      "Prepara (sin guardar) un borrador de proyecto (\"trabajo\") nuevo y devuelve un draft_id. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente que lo guarde.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: companyIdProp,
        name: stringProp("Nombre del proyecto/trabajo."),
        client_name: stringProp("Nombre del cliente, tal como aparece en list_clients."),
        business_area_name: stringProp(
          "Nombre del área de negocio. Opcional -- si no se especifica, se usa \"Otros\".",
        ),
        start_date: stringProp("Fecha de inicio, YYYY-MM-DD. Opcional."),
        end_date: stringProp("Fecha de fin, YYYY-MM-DD. Opcional."),
        budget: numberProp("Presupuesto. Opcional."),
        responsible: stringProp("Responsable del proyecto. Opcional."),
      },
      required: ["company_id", "name", "client_name"],
    },
  },
  {
    name: "confirm_draft",
    description:
      "Confirma y guarda un borrador ya preparado por propose_expense/propose_sale/propose_project. Llamala solo después de que el usuario confirmó explícitamente -- nunca por tu cuenta.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: stringProp("id devuelto por la llamada a propose_* correspondiente."),
      },
      required: ["draft_id"],
    },
  },
];

function findByName<T extends { id: string; name: string }>(
  items: T[],
  name: string | undefined,
): T | null {
  if (!name || !name.trim()) return null;
  const needle = name.trim().toLowerCase();
  return (
    items.find((item) => item.name.trim().toLowerCase() === needle) ??
    items.find((item) => item.name.trim().toLowerCase().includes(needle)) ??
    null
  );
}

function sumLines(lines: { amount: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}

function validateLines(
  raw: unknown,
): { description: string | null; amount: number }[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Se necesita al menos una línea con un importe." };
  }
  const lines: { description: string | null; amount: number }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const amount = Number((item as Record<string, unknown>).amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const description = (item as Record<string, unknown>).description;
    lines.push({
      description: typeof description === "string" && description.trim() ? description.trim() : null,
      amount,
    });
  }
  if (lines.length === 0) {
    return { error: "Ninguna línea tiene un importe válido mayor a cero." };
  }
  return lines;
}

/**
 * The real authorization boundary for every MCP tool call -- this
 * client connects as service_role (see createServiceRoleClient's own
 * warning), which bypasses RLS entirely, so nothing here can lean on
 * "the query just returned nothing" the way a normal RLS-scoped
 * caller could. Every branch below calls this before touching a
 * company's data.
 */
async function assertMembership(
  supabase: ReturnType<typeof createServiceRoleClient>,
  userId: string,
  companyId: string,
): Promise<{ error: string } | null> {
  const { data, error } = await supabase
    .from("company_memberships")
    .select("user_id")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    console.error(error);
    return { error: "No se pudo verificar el acceso a la empresa." };
  }
  if (!data) {
    return { error: "No tenés acceso a esa empresa." };
  }
  return null;
}

function monthRange(period: string): { start: string; end: string } {
  const periodDate = new Date(period);
  const monthStart = new Date(Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(periodDate.getUTCFullYear(), periodDate.getUTCMonth() + 1, 1));
  return { start: monthStart.toISOString().slice(0, 10), end: monthEnd.toISOString().slice(0, 10) };
}

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<{ result: unknown; isError?: boolean }> {
  const supabase = createServiceRoleClient();
  const userId = ctx.userId;

  if (name === "list_companies") {
    const { data, error } = await supabase
      .from("company_memberships")
      .select("companies (id, name, country, currency, active)")
      .eq("user_id", userId);

    if (error) {
      console.error(error);
      return { result: { error: "No se pudieron listar las empresas." }, isError: true };
    }
    const companies = (data ?? [])
      .map((row) => (Array.isArray(row.companies) ? row.companies[0] : row.companies))
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => ({ id: c.id, name: c.name, currency: c.currency }));
    return { result: companies };
  }

  const companyId = typeof args.company_id === "string" ? args.company_id : null;
  if (!companyId) {
    return { result: { error: "Falta company_id." }, isError: true };
  }

  const membershipError = await assertMembership(supabase, userId, companyId);
  if (membershipError) {
    return { result: membershipError, isError: true };
  }

  switch (name) {
    case "list_clients": {
      const { data, error } = await supabase
        .from("clients")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name");
      if (error) {
        console.error(error);
        return { result: { error: "No se pudieron listar los clientes." }, isError: true };
      }
      return { result: data ?? [] };
    }
    case "list_suppliers": {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("active", true)
        .order("name");
      if (error) {
        console.error(error);
        return { result: { error: "No se pudieron listar los proveedores." }, isError: true };
      }
      return { result: data ?? [] };
    }
    case "list_projects": {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, status, clients (name)")
        .eq("company_id", companyId)
        .eq("status", "active")
        .order("name");
      if (error) {
        console.error(error);
        return { result: { error: "No se pudieron listar los proyectos." }, isError: true };
      }
      return {
        result: (data ?? []).map((row) => {
          const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
          return { id: row.id, name: row.name, client_name: client?.name ?? null };
        }),
      };
    }
    case "list_sales_documents": {
      const from = typeof args.from === "string" ? args.from : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      let query = supabase
        .from("sales_documents")
        .select("id, document_type, document_date, currency, net_amount, total_amount, clients (name)")
        .eq("company_id", companyId)
        .eq("voided", false);
      if (from) query = query.gte("document_date", from);
      if (to) query = query.lt("document_date", to);
      const { data, error } = await query.order("document_date", { ascending: false });
      if (error) {
        console.error(error);
        return { result: { error: "No se pudieron listar las ventas." }, isError: true };
      }
      const docs = data ?? [];
      const shown = docs.slice(0, MAX_LISTED_DOCUMENTS);
      return {
        result: {
          total_count: docs.length,
          shown_count: shown.length,
          truncated: docs.length > shown.length,
          documents: shown.map((row) => {
            const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
            return {
              id: row.id,
              client_name: client?.name ?? null,
              document_type: row.document_type,
              document_date: row.document_date,
              currency: row.currency,
              net_amount: row.net_amount,
              total_amount: row.total_amount,
            };
          }),
        },
      };
    }
    case "list_cost_documents": {
      const from = typeof args.from === "string" ? args.from : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      let query = supabase
        .from("cost_documents")
        .select(
          "id, classification, document_date, currency, net_amount, total_amount, suppliers (name), projects (name)",
        )
        .eq("company_id", companyId);
      if (from) query = query.gte("document_date", from);
      if (to) query = query.lt("document_date", to);
      const { data, error } = await query.order("document_date", { ascending: false });
      if (error) {
        console.error(error);
        return { result: { error: "No se pudieron listar los costos." }, isError: true };
      }
      const docs = data ?? [];
      const shown = docs.slice(0, MAX_LISTED_DOCUMENTS);
      return {
        result: {
          total_count: docs.length,
          shown_count: shown.length,
          truncated: docs.length > shown.length,
          documents: shown.map((row) => {
            const supplier = Array.isArray(row.suppliers) ? row.suppliers[0] : row.suppliers;
            const project = Array.isArray(row.projects) ? row.projects[0] : row.projects;
            return {
              id: row.id,
              supplier_name: supplier?.name ?? null,
              project_name: project?.name ?? null,
              classification: row.classification,
              document_date: row.document_date,
              currency: row.currency,
              net_amount: row.net_amount,
              total_amount: row.total_amount,
            };
          }),
        },
      };
    }
    case "get_monthly_result": {
      const period = typeof args.period === "string" ? args.period : null;
      if (!period) return { result: { error: "Falta period." }, isError: true };
      const { start, end } = monthRange(period);

      const [salesResult, directCostResult, generalCostResult] = await Promise.all([
        supabase
          .from("sales_documents")
          .select("net_amount")
          .eq("company_id", companyId)
          .eq("voided", false)
          .gte("document_date", start)
          .lt("document_date", end),
        supabase
          .from("cost_documents")
          .select("total_amount")
          .eq("company_id", companyId)
          .eq("classification", "direct")
          .gte("document_date", start)
          .lt("document_date", end),
        supabase
          .from("cost_documents")
          .select("total_amount")
          .eq("company_id", companyId)
          .eq("classification", "general")
          .gte("document_date", start)
          .lt("document_date", end),
      ]);

      const netSales = (salesResult.data ?? []).reduce((sum, r) => sum + Number(r.net_amount ?? 0), 0);
      const directCosts = (directCostResult.data ?? []).reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0);
      const generalCosts = (generalCostResult.data ?? []).reduce((sum, r) => sum + Number(r.total_amount ?? 0), 0);

      return {
        result: {
          period: start,
          net_sales: netSales,
          direct_costs: directCosts,
          direct_margin: netSales - directCosts,
          general_costs: generalCosts,
          operating_result: netSales - directCosts - generalCosts,
          note:
            "Cálculo simplificado por fecha de documento -- no incluye reasignación de período ni prorrateo de costos generales/personal. Para el número exacto, mirá el reporte de Resultado mensual en la app.",
        },
      };
    }
    case "propose_expense": {
      const classification = args.classification === "general" ? "general" : "direct";
      const documentDate = typeof args.document_date === "string" ? args.document_date : "";
      const currency = typeof args.currency === "string" ? args.currency : "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!documentDate || !currency) {
        return { result: { error: "Faltan document_date o currency." }, isError: true };
      }
      if (taxAmount < 0) {
        return { result: { error: "tax_amount no puede ser negativo." }, isError: true };
      }

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines, isError: true };

      const [{ data: suppliers }, { data: projects }] = await Promise.all([
        supabase.from("suppliers").select("id, name").eq("company_id", companyId).eq("active", true),
        supabase.from("projects").select("id, name").eq("company_id", companyId).eq("status", "active"),
      ]);
      const supplier = findByName(suppliers ?? [], args.supplier_name as string | undefined);
      const project = findByName(projects ?? [], args.project_name as string | undefined);

      if (classification === "direct" && !project) {
        return {
          result: { error: "Un gasto directo necesita un proyecto válido. Usá list_projects." },
          isError: true,
        };
      }

      const netAmount = sumLines(lines);
      const totalAmount = netAmount + taxAmount;

      let duplicateWarning: ExpenseDraftPayload["duplicate_warning"];
      if (supplier) {
        const { data: duplicate } = await supabase
          .from("cost_documents")
          .select("document_date, total_amount, currency")
          .eq("company_id", companyId)
          .eq("supplier_id", supplier.id)
          .eq("document_date", documentDate)
          .eq("total_amount", totalAmount)
          .limit(1)
          .maybeSingle();
        if (duplicate) {
          duplicateWarning = duplicate;
        }
      }

      const payload: ExpenseDraftPayload = {
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier?.name ?? null,
        project_id: classification === "direct" ? (project?.id ?? null) : null,
        project_name: classification === "direct" ? (project?.name ?? null) : null,
        classification,
        document_date: documentDate,
        currency,
        tax_amount: taxAmount,
        lines,
        net_amount: netAmount,
        total_amount: totalAmount,
        duplicate_warning: duplicateWarning,
      };

      const { data: draftRow, error: draftError } = await supabase
        .from("mcp_pending_drafts")
        .insert({ user_id: userId, company_id: companyId, kind: "expense", payload })
        .select("id")
        .single();

      if (draftError || !draftRow) {
        console.error(draftError);
        return { result: { error: "No se pudo preparar el borrador." }, isError: true };
      }

      return {
        result: {
          draft_id: draftRow.id,
          draft: payload,
          note: duplicateWarning
            ? "Borrador preparado, PERO ya existe un gasto con el mismo proveedor, fecha y total -- avisale al usuario antes de confirmar."
            : "Borrador preparado. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente.",
        },
      };
    }
    case "propose_sale": {
      const documentType = ["invoice", "receipt", "credit_note", "manual"].includes(args.document_type as string)
        ? (args.document_type as SaleDraftPayload["document_type"])
        : "manual";
      const documentDate = typeof args.document_date === "string" ? args.document_date : "";
      const currency = typeof args.currency === "string" ? args.currency : "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!documentDate || !currency) {
        return { result: { error: "Faltan document_date o currency." }, isError: true };
      }
      if (taxAmount < 0) {
        return { result: { error: "tax_amount no puede ser negativo." }, isError: true };
      }

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines, isError: true };

      const [{ data: clients }, { data: projects }] = await Promise.all([
        supabase.from("clients").select("id, name").eq("company_id", companyId).eq("active", true),
        supabase.from("projects").select("id, name").eq("company_id", companyId).eq("status", "active"),
      ]);
      const client = findByName(clients ?? [], args.client_name as string | undefined);
      const project = findByName(projects ?? [], args.project_name as string | undefined);

      if (!client) {
        return { result: { error: "No encontré ese cliente. Usá list_clients." }, isError: true };
      }

      const netAmount = sumLines(lines);
      const payload: SaleDraftPayload = {
        client_id: client.id,
        client_name: client.name,
        project_id: project?.id ?? null,
        project_name: project?.name ?? null,
        document_type: documentType,
        document_date: documentDate,
        currency,
        tax_amount: taxAmount,
        lines,
        net_amount: netAmount,
        total_amount: netAmount + taxAmount,
      };

      const { data: draftRow, error: draftError } = await supabase
        .from("mcp_pending_drafts")
        .insert({ user_id: userId, company_id: companyId, kind: "sale", payload })
        .select("id")
        .single();

      if (draftError || !draftRow) {
        console.error(draftError);
        return { result: { error: "No se pudo preparar el borrador." }, isError: true };
      }

      return {
        result: {
          draft_id: draftRow.id,
          draft: payload,
          note: "Borrador preparado. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente.",
        },
      };
    }
    case "propose_project": {
      const projectName = typeof args.name === "string" ? args.name.trim() : "";
      if (!projectName) {
        return { result: { error: "Falta name." }, isError: true };
      }

      const [{ data: clients }, { data: areas }] = await Promise.all([
        supabase.from("clients").select("id, name").eq("company_id", companyId).eq("active", true),
        supabase.from("business_areas").select("id, name").eq("company_id", companyId).eq("active", true),
      ]);
      const client = findByName(clients ?? [], args.client_name as string | undefined);
      const requestedAreaName =
        typeof args.business_area_name === "string" && args.business_area_name.trim()
          ? args.business_area_name
          : "Otros"; // no area given -- falls back to "Otros" rather than asking.
      const area = findByName(areas ?? [], requestedAreaName);

      if (!client) {
        return { result: { error: "No encontré ese cliente. Usá list_clients." }, isError: true };
      }
      if (!area) {
        return {
          result: {
            error:
              requestedAreaName === "Otros"
                ? "No encontré un área \"Otros\" en esta empresa -- especificá una área de negocio existente."
                : "No encontré esa área de negocio.",
          },
          isError: true,
        };
      }

      const budget = Number.isFinite(Number(args.budget)) ? Number(args.budget) : null;
      if (budget !== null && budget < 0) {
        return { result: { error: "budget no puede ser negativo." }, isError: true };
      }

      const startDate = typeof args.start_date === "string" && args.start_date.trim() ? args.start_date.trim() : null;
      const endDate = typeof args.end_date === "string" && args.end_date.trim() ? args.end_date.trim() : null;
      if (startDate && endDate && endDate < startDate) {
        return { result: { error: "end_date no puede ser anterior a start_date." }, isError: true };
      }

      const payload: ProjectDraftPayload = {
        name: projectName,
        client_id: client.id,
        client_name: client.name,
        business_area_id: area.id,
        business_area_name: area.name,
        start_date: startDate,
        end_date: endDate,
        budget,
        responsible: typeof args.responsible === "string" && args.responsible.trim() ? args.responsible.trim() : null,
      };

      const { data: draftRow, error: draftError } = await supabase
        .from("mcp_pending_drafts")
        .insert({ user_id: userId, company_id: companyId, kind: "project", payload })
        .select("id")
        .single();

      if (draftError || !draftRow) {
        console.error(draftError);
        return { result: { error: "No se pudo preparar el borrador." }, isError: true };
      }

      return {
        result: {
          draft_id: draftRow.id,
          draft: payload,
          note: "Borrador preparado. Mostraselo al usuario y llamá confirm_draft solo si te confirma explícitamente.",
        },
      };
    }
    default:
      return { result: { error: `Herramienta desconocida: ${name}` }, isError: true };
  }
}

/**
 * confirm_draft doesn't take company_id from the caller -- it's read
 * back from the draft row itself, so a confirm call can't be pointed
 * at a different company than the one the draft was proposed for.
 * Membership is re-checked here regardless of what was checked at
 * propose time (the two calls can be minutes apart).
 */
export async function confirmMcpDraft(
  draftId: string,
  ctx: McpToolContext,
): Promise<{ result: unknown; isError?: boolean }> {
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

  const membershipError = await assertMembership(supabase, ctx.userId, draftRow.company_id);
  if (membershipError) {
    return { result: membershipError, isError: true };
  }

  const companyId = draftRow.company_id;

  if (draftRow.kind === "expense") {
    const draft = draftRow.payload as ExpenseDraftPayload;
    const { data, error } = await supabase.rpc("create_cost_document", {
      p_company_id: companyId,
      p_supplier_id: draft.supplier_id,
      p_project_id: draft.project_id,
      p_classification: draft.classification,
      p_document_date: draft.document_date,
      p_currency: draft.currency,
      p_tax_amount: draft.tax_amount,
      p_lines: draft.lines,
    });
    if (error) {
      console.error(error);
      return { result: { error: "No se pudo crear el gasto." }, isError: true };
    }
    await supabase.from("mcp_pending_drafts").update({ consumed_at: new Date().toISOString() }).eq("id", draftId);
    return { result: { ok: true, id: data.id, href: `/companies/${companyId}/costs` } };
  }

  if (draftRow.kind === "sale") {
    const draft = draftRow.payload as SaleDraftPayload;
    const { data, error } = await supabase.rpc("create_sales_document", {
      p_company_id: companyId,
      p_client_id: draft.client_id,
      p_document_type: draft.document_type,
      p_document_date: draft.document_date,
      p_currency: draft.currency,
      p_tax_amount: draft.tax_amount,
      p_lines: draft.lines,
      p_project_id: draft.project_id,
    });
    if (error) {
      console.error(error);
      return { result: { error: "No se pudo crear la venta." }, isError: true };
    }
    await supabase.from("mcp_pending_drafts").update({ consumed_at: new Date().toISOString() }).eq("id", draftId);
    return { result: { ok: true, id: data.id, href: `/companies/${companyId}/sales` } };
  }

  if (draftRow.kind === "project") {
    const draft = draftRow.payload as ProjectDraftPayload;
    const { data, error } = await supabase
      .from("projects")
      .insert({
        company_id: companyId,
        client_id: draft.client_id,
        business_area_id: draft.business_area_id,
        name: draft.name,
        start_date: draft.start_date,
        end_date: draft.end_date,
        budget: draft.budget,
        responsible: draft.responsible,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error(error);
      return { result: { error: "No se pudo crear el proyecto." }, isError: true };
    }
    await supabase.from("mcp_pending_drafts").update({ consumed_at: new Date().toISOString() }).eq("id", draftId);
    return { result: { ok: true, id: data.id, href: `/companies/${companyId}/projects` } };
  }

  return { result: { error: "Tipo de borrador desconocido." }, isError: true };
}
