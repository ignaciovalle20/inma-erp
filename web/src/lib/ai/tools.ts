import "server-only";

import {
  getUserCompanies,
  getSalesDocuments,
  getCostDocuments,
  getClients,
  getSuppliers,
  getProjects,
} from "@/lib/dal";
import { computeMonthlyResult } from "@/lib/reporting";
import type { JsonSchema, ToolDefinition } from "@/lib/ai/providers";

export type ToolContext = {
  companyId: string | null;
};

export type ExpenseDraft = {
  kind: "expense";
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
};

export type SaleDraft = {
  kind: "sale";
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

export type Draft = ExpenseDraft | SaleDraft;

type ToolOutcome = { result: unknown; draft?: Draft };

const NO_COMPANY_ERROR = {
  error:
    "No hay una empresa activa en esta conversación. Pedile a la persona que abra una empresa desde la barra lateral antes de seguir, o usá list_companies para mostrarle las opciones.",
};

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

const stringProp = (description: string): JsonSchema => ({ type: "string", description });
const numberProp = (description: string): JsonSchema => ({ type: "number", description });

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

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_companies",
    description: "Lista las empresas a las que pertenece el usuario actual.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_monthly_result",
    description:
      "Devuelve el resultado mensual de la empresa activa: ventas netas, costos directos/generales, margen y resultado operativo para un mes dado.",
    parameters: {
      type: "object",
      properties: {
        period: stringProp("Cualquier fecha dentro del mes a consultar, formato YYYY-MM-DD."),
      },
      required: ["period"],
    },
  },
  {
    name: "list_sales_documents",
    description: "Lista documentos de venta de la empresa activa, opcionalmente filtrados por rango de fechas.",
    parameters: {
      type: "object",
      properties: {
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
      },
    },
  },
  {
    name: "list_cost_documents",
    description: "Lista documentos de costo/gasto de la empresa activa, opcionalmente filtrados por rango de fechas.",
    parameters: {
      type: "object",
      properties: {
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
      },
    },
  },
  {
    name: "list_clients",
    description: "Lista los clientes activos de la empresa activa.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_suppliers",
    description: "Lista los proveedores activos de la empresa activa.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_projects",
    description: "Lista los proyectos activos de la empresa activa.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "propose_expense",
    description:
      "Prepara (sin guardar todavía) un borrador de gasto para que el usuario lo confirme en la interfaz. Llamala solo cuando ya tengas todos los datos necesarios: proveedor (opcional), clasificación, proyecto (obligatorio si es directo), fecha, moneda y al menos una línea con importe.",
    parameters: {
      type: "object",
      properties: {
        supplier_name: stringProp("Nombre del proveedor, tal como aparece en la lista de proveedores. Opcional."),
        project_name: stringProp("Nombre del proyecto. Obligatorio si classification es 'direct'."),
        classification: { type: "string", enum: ["direct", "general"], description: "direct: ligado a un proyecto. general: gasto de la empresa." },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: stringProp("Moneda, ej. CLP, UYU, USD."),
        tax_amount: numberProp("Monto de impuesto (IVA). 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["classification", "document_date", "currency", "lines"],
    },
  },
  {
    name: "propose_sale",
    description:
      "Prepara (sin guardar todavía) un borrador de venta para que el usuario lo confirme en la interfaz. Llamala solo cuando ya tengas todos los datos necesarios: cliente, tipo de documento, proyecto (opcional), fecha, moneda y al menos una línea con importe.",
    parameters: {
      type: "object",
      properties: {
        client_name: stringProp("Nombre del cliente, tal como aparece en la lista de clientes."),
        project_name: stringProp("Nombre del proyecto. Opcional."),
        document_type: { type: "string", enum: ["invoice", "receipt", "credit_note", "manual"] },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: stringProp("Moneda, ej. CLP, UYU, USD."),
        tax_amount: numberProp("Monto de impuesto (IVA). 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["client_name", "document_type", "document_date", "currency", "lines"],
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (name === "list_companies") {
    const companies = await getUserCompanies();
    return { result: companies.map((c) => ({ id: c.id, name: c.name, currency: c.currency })) };
  }

  if (!ctx.companyId) {
    return { result: NO_COMPANY_ERROR };
  }
  const companyId = ctx.companyId;

  switch (name) {
    case "get_monthly_result": {
      const period = typeof args.period === "string" ? args.period : null;
      if (!period) return { result: { error: "Falta el parámetro period." } };
      return { result: await computeMonthlyResult(companyId, period) };
    }
    case "list_sales_documents": {
      const from = typeof args.from === "string" ? args.from : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      const docs = await getSalesDocuments(companyId, { from, to, excludeVoided: true });
      return {
        result: docs.map((d) => ({
          id: d.id,
          client_name: d.client_name,
          document_type: d.document_type,
          document_date: d.document_date,
          currency: d.currency,
          net_amount: d.net_amount,
          total_amount: d.total_amount,
        })),
      };
    }
    case "list_cost_documents": {
      const from = typeof args.from === "string" ? args.from : undefined;
      const to = typeof args.to === "string" ? args.to : undefined;
      const docs = await getCostDocuments(companyId, { from, to });
      return {
        result: docs.map((d) => ({
          id: d.id,
          supplier_name: d.supplier_name,
          project_name: d.project_name,
          classification: d.classification,
          document_date: d.document_date,
          currency: d.currency,
          net_amount: d.net_amount,
          total_amount: d.total_amount,
        })),
      };
    }
    case "list_clients": {
      const clients = await getClients(companyId);
      return { result: clients.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })) };
    }
    case "list_suppliers": {
      const suppliers = await getSuppliers(companyId);
      return { result: suppliers.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })) };
    }
    case "list_projects": {
      const projects = await getProjects(companyId);
      return {
        result: projects
          .filter((p) => p.status === "active")
          .map((p) => ({ id: p.id, name: p.name, client_name: p.client_name })),
      };
    }
    case "propose_expense": {
      const classification = args.classification === "general" ? "general" : "direct";
      const documentDate = typeof args.document_date === "string" ? args.document_date : "";
      const currency = typeof args.currency === "string" ? args.currency : "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!documentDate || !currency) {
        return { result: { error: "Faltan document_date o currency." } };
      }
      if (taxAmount < 0) {
        return { result: { error: "tax_amount no puede ser negativo." } };
      }

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines };

      const [suppliers, projects] = await Promise.all([
        getSuppliers(companyId),
        getProjects(companyId),
      ]);
      const supplier = findByName(suppliers, args.supplier_name as string | undefined);
      const project = findByName(projects, args.project_name as string | undefined);

      if (classification === "direct" && !project) {
        return {
          result: {
            error:
              "Un gasto directo necesita un proyecto válido. Usá list_projects para ver los nombres exactos y volvé a intentar.",
          },
        };
      }

      const netAmount = sumLines(lines);
      const draft: ExpenseDraft = {
        kind: "expense",
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
        total_amount: netAmount + taxAmount,
      };

      return {
        result: {
          ok: true,
          note: "Borrador preparado. Mostrale este resumen al usuario y esperá su confirmación en la interfaz -- vos no lo guardás.",
          draft,
        },
        draft,
      };
    }
    case "propose_sale": {
      const documentType = ["invoice", "receipt", "credit_note", "manual"].includes(
        args.document_type as string,
      )
        ? (args.document_type as SaleDraft["document_type"])
        : "manual";
      const documentDate = typeof args.document_date === "string" ? args.document_date : "";
      const currency = typeof args.currency === "string" ? args.currency : "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!documentDate || !currency) {
        return { result: { error: "Faltan document_date o currency." } };
      }
      if (taxAmount < 0) {
        return { result: { error: "tax_amount no puede ser negativo." } };
      }

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines };

      const [clients, projects] = await Promise.all([
        getClients(companyId),
        getProjects(companyId),
      ]);
      const client = findByName(clients, args.client_name as string | undefined);
      const project = findByName(projects, args.project_name as string | undefined);

      if (!client) {
        return {
          result: {
            error:
              "No encontré ese cliente. Usá list_clients para ver los nombres exactos y volvé a intentar.",
          },
        };
      }

      const netAmount = sumLines(lines);
      const draft: SaleDraft = {
        kind: "sale",
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

      return {
        result: {
          ok: true,
          note: "Borrador preparado. Mostrale este resumen al usuario y esperá su confirmación en la interfaz -- vos no lo guardás.",
          draft,
        },
        draft,
      };
    }
    default:
      return { result: { error: `Herramienta desconocida: ${name}` } };
  }
}
