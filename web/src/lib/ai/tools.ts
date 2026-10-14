import "server-only";

import {
  getUserCompanies,
  getCompanyForEdit,
  getCostDocuments,
  getClients,
  getSuppliers,
  getProjects,
  getBusinessAreas,
  listProjects,
  getProjectQuotesByProject,
  getProjectBillingBalances,
  getSalesListRows,
  getSalesPending,
  ensureRecurringServiceOccurrencesForMonth,
  getRecurringServiceOccurrencesForMonth,
  findPotentialDuplicateCost,
  type ProjectStatus,
  type ProjectListScope,
  type PaymentStatus,
} from "@/lib/dal";
import { getTechnicianCharges } from "@/lib/technicianDal";
import { computeMonthlyResult, computeProjectProfitability } from "@/lib/reporting";
import { PROJECT_STATUSES, PROJECT_STATUS_LABEL } from "@/lib/projectStatus";
import { PAYMENT_STATUS_LABEL } from "@/lib/paymentStatus";
import { companyConfig } from "@/lib/companyConfig";
import type { JsonSchema, ToolDefinition } from "@/lib/ai/providers";

/**
 * The assistant's tool set -- used by BOTH the in-app chat
 * (api/assistant/chat) and the MCP server (api/mcp, which runs these same
 * tools under a real session of the token's owner, see lib/mcp/session.ts).
 * One implementation on purpose: the MCP server used to keep its own copy
 * of every query and drifted from the app (its monthly result added credit
 * notes, counted IVA and double-counted the MS licenses invoice).
 *
 * Every tool reads through lib/dal / lib/reporting, so it sees exactly
 * what the screens show. Nothing here writes: the propose_* tools only
 * build a Draft, and lib/ai/saveDraft.ts saves it once the person confirms.
 */

export type ToolContext = {
  companyId: string | null;
};

type DraftLine = { description: string | null; amount: number };

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
  lines: DraftLine[];
  net_amount: number;
  total_amount: number;
  // Same non-blocking duplicate check the human cost form runs.
  duplicateWarning?: { document_date: string; total_amount: number; currency: string };
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
  lines: DraftLine[];
  net_amount: number;
  total_amount: number;
};

/** Alta de un trabajo, same fields and rules as projects/new (create_project_with_quote). */
export type ProjectDraft = {
  kind: "project";
  name: string;
  client_id: string;
  client_name: string;
  business_area_id: string;
  business_area_name: string;
  status: ProjectStatus;
  quote_number: string | null;
  start_date: string | null;
  end_date: string | null;
  quoted_amount: number | null;
  cost_budget: number | null;
  /** The company's currency, only to display the amounts above. */
  currency: string;
  responsible: string | null;
  invoiceable: boolean;
};

/** A move on the kanban board, same rules as board/actions.ts updateProjectStatus. */
export type ProjectStatusDraft = {
  kind: "project_status";
  project_id: string;
  project_name: string;
  from_status: ProjectStatus;
  status: ProjectStatus;
  hold_reason: string | null;
};

export type Draft = ExpenseDraft | SaleDraft | ProjectDraft | ProjectStatusDraft;

export type ToolOutcome = { result: unknown; draft?: Draft };

// A company with a lot of history can easily have thousands of
// documents -- returning them all would blow past the model's context
// window and run up the user's own API bill for no benefit.
const MAX_LISTED_DOCUMENTS = 200;
const MAX_LISTED_PROJECTS = 50;

const NO_COMPANY_ERROR = {
  error:
    "No hay una empresa activa. Pedile a la persona que abra una empresa desde la barra lateral antes de seguir, o usá list_companies para mostrarle las opciones.",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/** Exact (accent/case-insensitive) match first, then a single partial match. */
export function findByName<T extends { id: string; name: string }>(
  items: T[],
  name: string | undefined,
): T | null {
  if (!name || !name.trim()) return null;
  const needle = normalize(name);
  const exact = items.find((item) => normalize(item.name) === needle);
  if (exact) return exact;
  const partial = items.filter((item) => normalize(item.name).includes(needle));
  return partial.length === 1 ? partial[0] : null;
}

function sumLines(lines: { amount: number }[]): number {
  return lines.reduce((sum, line) => sum + line.amount, 0);
}

export function validateLines(raw: unknown): DraftLine[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "Se necesita al menos una línea con un importe." };
  }
  const lines: DraftLine[] = [];
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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalAmount(value: unknown, label: string): { value: number | null } | { error: string } {
  if (value === undefined || value === null || value === "") return { value: null };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return { error: `${label} debe ser un número.` };
  if (parsed < 0) return { error: `${label} no puede ser negativo.` };
  return { value: parsed };
}

function errorMessage(thrown: unknown, fallback: string): { error: string } {
  return { error: thrown instanceof Error ? thrown.message : fallback };
}

/**
 * Chile always bills in CLP, so the model never has to ask (decided with
 * the owner); Uruguay can be USD or UYU and the model must ask. Returns
 * an error when the currency is missing and can't be inferred.
 */
async function resolveCurrency(
  companyId: string,
  raw: unknown,
): Promise<{ currency: string } | { error: string }> {
  const membership = await getCompanyForEdit(companyId);
  const config = companyConfig({
    country: membership?.company.country ?? null,
    currency: membership?.company.currency ?? "",
  });
  const given = str(raw)?.toUpperCase();

  // The company's rule (lib/companyConfig.ts): its only currency, never
  // asked; otherwise one of its currencies, asked when missing.
  if (config.fixedCurrency) {
    return { currency: config.fixedCurrency };
  }
  if (given) {
    return config.documentCurrencies.includes(given)
      ? { currency: given }
      : { error: `Moneda ${given} no válida en esta empresa: tiene que ser ${config.documentCurrencies.join(" o ")}.` };
  }
  return {
    error: `Falta la moneda. En esta empresa puede ser ${config.documentCurrencies.join(" o ")}: preguntale a la persona cuál corresponde antes de seguir.`,
  };
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

const currencyProp = stringProp(
  "Moneda. En Chile se usa siempre CLP (se completa sola). En Uruguay puede ser USD o UYU: si la persona no lo dijo, preguntale.",
);

const statusEnum: JsonSchema = {
  type: "string",
  enum: [...PROJECT_STATUSES],
  description: PROJECT_STATUSES.map((s) => `${s} = ${PROJECT_STATUS_LABEL[s]}`).join(", "),
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_companies",
    description: "Lista las empresas a las que pertenece el usuario (id, nombre, país, moneda).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_monthly_result",
    description:
      "Resultado mensual de la empresa, igual al de la pantalla: ventas netas (incluye servicios recurrentes y descuenta notas de crédito), costos directos, costos generales (incluye personal), margen y resultado operativo, todo convertido a la moneda de la empresa.",
    parameters: {
      type: "object",
      properties: {
        period: stringProp("Cualquier fecha dentro del mes a consultar, formato YYYY-MM-DD."),
      },
      required: ["period"],
    },
  },
  {
    name: "list_projects",
    description:
      "Busca trabajos (proyectos) de la empresa. Sin 'query' lista por pestaña (activos/finalizados/todos). Con 'query' busca en todos los estados por nombre del trabajo, cliente, N° de cotización o N° de factura/boleta/venta manual. Devuelve estado, cotización (monto neto vendido), presupuesto de costo, saldo por facturar y N° de cotización.",
    parameters: {
      type: "object",
      properties: {
        query: stringProp("Texto a buscar (opcional)."),
        scope: {
          type: "string",
          enum: ["activos", "finalizados", "todos"],
          description: "Pestaña, cuando no hay query. Por defecto 'activos'.",
        },
      },
    },
  },
  {
    name: "get_project_detail",
    description:
      "Detalle de un trabajo: datos, cotizaciones, facturado y saldo por facturar, y rentabilidad acumulada (ingresos, costos, margen, desvío contra el presupuesto de costo). Pedí el id con list_projects.",
    parameters: {
      type: "object",
      properties: { project_id: stringProp("id del trabajo (de list_projects).") },
      required: ["project_id"],
    },
  },
  {
    name: "list_sales_documents",
    description:
      "Lista documentos de venta (facturas, boletas, notas de crédito, ventas manuales) con N° de documento, trabajo, moneda, estado de pago (pagado / impago), fecha de pago y vencimiento. Filtros opcionales por fecha y estado de pago. Los montos son netos en la moneda de cada documento: nunca sumes monedas distintas sin convertir.",
    parameters: {
      type: "object",
      properties: {
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
        payment_status: {
          type: "string",
          enum: ["pagado", "impago"],
          description: "Filtrar por estado de pago (opcional).",
        },
      },
    },
  },
  {
    name: "get_sales_pending",
    description:
      "Pendientes de ventas, igual que la pantalla Pendientes: notas de crédito sin emparejar, facturas sin trabajo, facturas vencidas hace mucho (revisar cobro en Nubox) y ventas manuales sin cobrar.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_cost_documents",
    description:
      "Lista documentos de costo/gasto con proveedor, trabajo, clasificación, estado (provisorio/confirmado) y si la factura ya está cubierta por el pool de licencias Microsoft (en ese caso no suma en los reportes).",
    parameters: {
      type: "object",
      properties: {
        from: stringProp("Fecha desde (inclusive), YYYY-MM-DD."),
        to: stringProp("Fecha hasta (exclusive), YYYY-MM-DD."),
      },
    },
  },
  {
    name: "get_recurring_services_month",
    description:
      "Tablero de servicios recurrentes de un mes (licencias Microsoft, hosting, Starlink, servidores): cada ciclo con cliente, monto, estado (por facturar, facturado, por cobrar, cobrado) y N° de factura vinculada.",
    parameters: {
      type: "object",
      properties: { month: stringProp("Mes YYYY-MM. Por defecto el mes actual.") },
    },
  },
  {
    name: "get_technician_balances",
    description:
      "Saldo que se le debe a cada técnico externo (cargos en trabajos menos pagos aplicados), con el detalle de cargos pendientes.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_clients",
    description: "Lista los clientes activos.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_suppliers",
    description: "Lista los proveedores activos.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_business_areas",
    description: "Lista las áreas de negocio activas (p. ej. Licencias MS, Hosting, Starlink, Cloud).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "propose_project",
    description:
      "Prepara (sin guardar) el alta de un trabajo, igual que el formulario Nuevo trabajo. El N° de cotización es obligatorio salvo en estado por_cotizar. Llamala solo con los datos completos; la persona confirma en la interfaz.",
    parameters: {
      type: "object",
      properties: {
        name: stringProp("Descripción del trabajo."),
        client_name: stringProp("Cliente, tal como aparece en list_clients."),
        business_area_name: stringProp("Área de negocio, tal como aparece en list_business_areas."),
        quote_number: stringProp("N° de cotización de Nubox."),
        status: { ...statusEnum, description: `Estado inicial, por defecto en_ejecucion. ${statusEnum.description}` },
        quoted_amount: numberProp("Monto neto cotizado (lo vendido, sin IVA). Opcional."),
        cost_budget: numberProp("Presupuesto de costo. Opcional."),
        start_date: stringProp("Fecha de inicio YYYY-MM-DD. Opcional."),
        end_date: stringProp("Fecha de fin YYYY-MM-DD. Opcional."),
        responsible: stringProp("Responsable. Opcional."),
        invoiceable: { type: "boolean", description: "Si se factura (por defecto sí)." },
      },
      required: ["name", "client_name", "business_area_name"],
    },
  },
  {
    name: "propose_project_status",
    description:
      "Prepara (sin guardar) el cambio de estado de un trabajo en el tablero. 'en_espera' necesita un motivo. La persona confirma en la interfaz.",
    parameters: {
      type: "object",
      properties: {
        project_id: stringProp("id del trabajo (de list_projects)."),
        status: statusEnum,
        hold_reason: stringProp("Motivo, obligatorio si el estado es en_espera."),
      },
      required: ["project_id", "status"],
    },
  },
  {
    name: "propose_expense",
    description:
      "Prepara (sin guardar) un gasto para que la persona lo confirme en la interfaz. Directo = de un trabajo (obligatorio el trabajo); general = de la empresa (después se reparte con 'Dividir costo').",
    parameters: {
      type: "object",
      properties: {
        supplier_name: stringProp("Proveedor, tal como aparece en list_suppliers. Opcional."),
        project_name: stringProp("Trabajo. Obligatorio si classification es 'direct'."),
        project_id: stringProp("id del trabajo, si ya lo tenés de list_projects (preferible al nombre)."),
        classification: { type: "string", enum: ["direct", "general"], description: "direct: de un trabajo. general: de la empresa." },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: currencyProp,
        tax_amount: numberProp("IVA. 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["classification", "document_date", "lines"],
    },
  },
  {
    name: "propose_sale",
    description:
      "Prepara (sin guardar) una venta para que la persona la confirme. Las facturas de Nubox se importan al cierre de mes: usala sobre todo para ventas sin factura (manual) o boletas.",
    parameters: {
      type: "object",
      properties: {
        client_name: stringProp("Cliente, tal como aparece en list_clients."),
        project_name: stringProp("Trabajo. Opcional."),
        project_id: stringProp("id del trabajo, si ya lo tenés de list_projects (preferible al nombre)."),
        document_type: { type: "string", enum: ["invoice", "receipt", "credit_note", "manual"], description: "invoice = factura, receipt = boleta, credit_note = nota de crédito, manual = venta sin factura." },
        document_date: stringProp("Fecha del documento, YYYY-MM-DD."),
        currency: currencyProp,
        tax_amount: numberProp("IVA. 0 si no aplica."),
        lines: linesSchema,
      },
      required: ["client_name", "document_type", "document_date", "lines"],
    },
  },
];

async function resolveProject(
  companyId: string,
  args: Record<string, unknown>,
) {
  const projects = await getProjects(companyId);
  const id = str(args.project_id);
  if (id) return projects.find((p) => p.id === id) ?? null;
  return findByName(projects, str(args.project_name));
}

function listResult<T>(rows: T[]) {
  const shown = rows.slice(0, MAX_LISTED_DOCUMENTS);
  return {
    total_count: rows.length,
    shown_count: shown.length,
    truncated: rows.length > shown.length,
    note:
      rows.length > shown.length
        ? "Hay más documentos de los que se muestran: pedile a la persona un rango de fechas más chico (from/to)."
        : undefined,
    shown,
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (name === "list_companies") {
    const companies = await getUserCompanies();
    return {
      result: companies.map((c) => ({ id: c.id, name: c.name, country: c.country, currency: c.currency })),
    };
  }

  if (!ctx.companyId) {
    return { result: NO_COMPANY_ERROR };
  }
  const companyId = ctx.companyId;

  try {
    return await runCompanyTool(name, args, companyId);
  } catch (thrown) {
    console.error(thrown);
    return { result: errorMessage(thrown, "No se pudo completar la consulta.") };
  }
}

async function runCompanyTool(
  name: string,
  args: Record<string, unknown>,
  companyId: string,
): Promise<ToolOutcome> {
  switch (name) {
    case "get_monthly_result": {
      const period = str(args.period);
      if (!period || !DATE_RE.test(period)) return { result: { error: "Falta period (YYYY-MM-DD)." } };
      const membership = await getCompanyForEdit(companyId);
      const result = await computeMonthlyResult(companyId, period);
      return { result: { currency: membership?.company.currency ?? null, ...result } };
    }

    case "list_projects": {
      const query = str(args.query);
      const scope: ProjectListScope =
        args.scope === "finalizados" || args.scope === "todos" ? args.scope : "activos";
      const [{ rows, total }, balances] = await Promise.all([
        listProjects(companyId, { scope, query, limit: MAX_LISTED_PROJECTS }),
        getProjectBillingBalances(companyId),
      ]);
      const quotes = await getProjectQuotesByProject(companyId, rows.map((r) => r.id));
      const invoiced = new Map(balances.map((b) => [b.projectId, b.invoicedAmount]));
      return {
        result: {
          total_count: total,
          shown_count: rows.length,
          note:
            total > rows.length
              ? "Hay más trabajos de los que se muestran: afiná la búsqueda con query."
              : undefined,
          projects: rows.map((p) => {
            const billed = invoiced.get(p.id);
            return {
              id: p.id,
              name: p.name,
              client_name: p.client_name,
              business_area_name: p.business_area_name,
              status: p.status,
              status_label: PROJECT_STATUS_LABEL[p.status] ?? p.status,
              hold_reason: p.hold_reason,
              quote_numbers: quotes.get(p.id) ?? [],
              quoted_amount: p.quoted_amount,
              cost_budget: p.cost_budget,
              invoiced_amount: billed ?? null,
              balance_to_invoice:
                p.quoted_amount !== null && billed !== undefined ? p.quoted_amount - billed : null,
              responsible: p.responsible,
              start_date: p.start_date,
              end_date: p.end_date,
            };
          }),
        },
      };
    }

    case "get_project_detail": {
      const project = await resolveProject(companyId, args);
      if (!project) return { result: { error: "No encontré ese trabajo. Usá list_projects para obtener el id." } };
      const today = new Date().toISOString().slice(0, 10);
      const [quotes, balances, profitability] = await Promise.all([
        getProjectQuotesByProject(companyId, [project.id]),
        getProjectBillingBalances(companyId),
        computeProjectProfitability(companyId, project.id, today),
      ]);
      const billed = balances.find((b) => b.projectId === project.id)?.invoicedAmount ?? null;
      return {
        result: {
          id: project.id,
          name: project.name,
          client_name: project.client_name,
          business_area_name: project.business_area_name,
          status: project.status,
          status_label: PROJECT_STATUS_LABEL[project.status] ?? project.status,
          hold_reason: project.hold_reason,
          quote_numbers: quotes.get(project.id) ?? [],
          quoted_amount: project.quoted_amount,
          cost_budget: project.cost_budget,
          invoiced_amount: billed,
          balance_to_invoice:
            project.quoted_amount !== null && billed !== null ? project.quoted_amount - billed : null,
          responsible: project.responsible,
          invoiceable: project.invoiceable,
          accumulated: {
            revenue: profitability.accumulatedRevenue,
            costs: profitability.accumulatedCosts,
            margin: profitability.accumulatedMargin,
            cost_budget_variance: profitability.budgetVariance,
          },
        },
      };
    }

    case "list_sales_documents": {
      const paymentStatus = str(args.payment_status) as PaymentStatus | undefined;
      const rows = await getSalesListRows(companyId, {
        from: str(args.from),
        to: str(args.to),
        paymentStatus: paymentStatus && paymentStatus in PAYMENT_STATUS_LABEL ? paymentStatus : undefined,
      });
      const active = rows.filter((d) => !d.voided);
      const { shown, ...meta } = listResult(active);
      return {
        result: {
          ...meta,
          documents: shown.map((d) => ({
            id: d.id,
            document_number: d.document_number,
            document_type: d.document_type,
            document_date: d.document_date,
            client_name: d.client_name,
            project_name: d.project_name,
            business_area_name: d.business_area_name,
            currency: d.currency,
            net_amount: d.net_amount,
            total_amount: d.total_amount,
            payment_status: d.payment_status,
            paid_at: d.paid_at,
            due_date: d.due_date,
            is_recurring: d.is_recurring,
            annulled_by_credit_note: d.annulled_by_document_id !== null,
          })),
        },
      };
    }

    case "get_sales_pending": {
      const pending = await getSalesPending(companyId);
      const brief = (rows: typeof pending.unlinkedInvoices) =>
        rows.slice(0, MAX_LISTED_DOCUMENTS).map((r) => ({
          id: r.id,
          document_number: r.documentNumber,
          document_type: r.documentType,
          client_name: r.clientName,
          document_date: r.documentDate,
          due_date: r.dueDate,
          payment_status: r.paymentStatus,
          net_amount: r.netAmount,
          total_amount: r.totalAmount,
        }));
      return {
        result: {
          managed_from: pending.managementStartDate,
          unpaired_credit_notes: brief(pending.unpairedCreditNotes),
          invoices_without_project: brief(pending.unlinkedInvoices),
          long_overdue_invoices: brief(pending.staleUnpaidInvoices),
          unpaid_manual_sales: brief(pending.unpaidManualSales),
          hidden_before_managed_from: pending.outsideManagement,
        },
      };
    }

    case "list_cost_documents": {
      const docs = await getCostDocuments(companyId, { from: str(args.from), to: str(args.to) });
      const { shown, ...meta } = listResult(docs);
      return {
        result: {
          ...meta,
          documents: shown.map((d) => ({
            id: d.id,
            supplier_name: d.supplier_name,
            project_name: d.project_name,
            classification: d.classification,
            category: d.category,
            status: d.status,
            document_date: d.document_date,
            currency: d.currency,
            net_amount: d.net_amount,
            total_amount: d.total_amount,
            covered_by_ms_pool: d.covered_by_cost_pool_id !== null,
            split_between_projects: d.is_allocated,
          })),
        },
      };
    }

    case "get_recurring_services_month": {
      const month = str(args.month) ?? new Date().toISOString().slice(0, 7);
      if (!MONTH_RE.test(month)) return { result: { error: "month debe tener formato YYYY-MM." } };
      // The board does the same on open: idempotent, only creates the
      // month's missing cycles so the list matches the screen.
      await ensureRecurringServiceOccurrencesForMonth(companyId, month);
      const cycles = await getRecurringServiceOccurrencesForMonth(companyId, month);
      return {
        result: {
          month,
          cycles: cycles
            .filter((c) => c.status !== "void")
            .map((c) => ({
              id: c.id,
              service: c.service_name,
              service_type: c.service_type,
              client_name: c.client_name,
              period: c.period,
              amount: c.amount,
              currency: c.currency,
              status: c.status,
              invoice_due_date: c.invoice_due_date,
              collection_due_date: c.collection_due_date,
              invoice_number: c.sales_document_number,
              needs_invoice_link_review: c.link_review === "no_match" || c.link_review === "multiple",
              note: c.note,
            })),
        },
      };
    }

    case "get_technician_balances": {
      const charges = await getTechnicianCharges(companyId);
      const byTechnician = new Map<
        string,
        { technician: string; outstanding: number; pending_charges: { project: string; date: string; amount: number; outstanding: number }[] }
      >();
      for (const charge of charges) {
        const entry = byTechnician.get(charge.personnel_id) ?? {
          technician: charge.personnel_name,
          outstanding: 0,
          pending_charges: [],
        };
        entry.outstanding += charge.outstanding;
        if (charge.outstanding > 0) {
          entry.pending_charges.push({
            project: charge.project_name,
            date: charge.charge_date,
            amount: charge.amount,
            outstanding: charge.outstanding,
          });
        }
        byTechnician.set(charge.personnel_id, entry);
      }
      return { result: [...byTechnician.values()] };
    }

    case "list_clients": {
      const clients = await getClients(companyId);
      return { result: clients.filter((c) => c.active).map((c) => ({ id: c.id, name: c.name })) };
    }

    case "list_suppliers": {
      const suppliers = await getSuppliers(companyId);
      return { result: suppliers.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })) };
    }

    case "list_business_areas": {
      const areas = await getBusinessAreas(companyId);
      return { result: areas.filter((a) => a.active).map((a) => ({ id: a.id, name: a.name })) };
    }

    case "propose_project": {
      const projectName = str(args.name);
      if (!projectName) return { result: { error: "Falta la descripción del trabajo (name)." } };

      const status = (str(args.status) ?? "en_ejecucion") as ProjectStatus;
      if (!PROJECT_STATUSES.includes(status)) return { result: { error: `Estado inválido: ${status}.` } };

      const quoteNumber = str(args.quote_number) ?? null;
      if (status !== "por_cotizar" && !quoteNumber) {
        return {
          result: { error: "Falta el N° de cotización (obligatorio salvo en estado por_cotizar). Pedíselo a la persona." },
        };
      }

      const quoted = optionalAmount(args.quoted_amount, "El monto cotizado");
      if ("error" in quoted) return { result: quoted };
      const budget = optionalAmount(args.cost_budget, "El presupuesto de costo");
      if ("error" in budget) return { result: budget };

      const startDate = str(args.start_date) ?? null;
      const endDate = str(args.end_date) ?? null;
      if ((startDate && !DATE_RE.test(startDate)) || (endDate && !DATE_RE.test(endDate))) {
        return { result: { error: "Las fechas van en formato YYYY-MM-DD." } };
      }
      if (startDate && endDate && endDate < startDate) {
        return { result: { error: "La fecha de fin no puede ser anterior a la de inicio." } };
      }

      const [clients, areas, membership] = await Promise.all([
        getClients(companyId),
        getBusinessAreas(companyId),
        getCompanyForEdit(companyId),
      ]);
      const client = findByName(clients.filter((c) => c.active), str(args.client_name));
      if (!client) {
        return { result: { error: "No encontré ese cliente (o hay varios parecidos). Usá list_clients y confirmá el nombre exacto." } };
      }
      const area = findByName(areas.filter((a) => a.active), str(args.business_area_name));
      if (!area) {
        return { result: { error: "No encontré esa área de negocio. Usá list_business_areas y confirmá con la persona." } };
      }

      const draft: ProjectDraft = {
        kind: "project",
        name: projectName,
        client_id: client.id,
        client_name: client.name,
        business_area_id: area.id,
        business_area_name: area.name,
        status,
        quote_number: quoteNumber,
        start_date: startDate,
        end_date: endDate,
        quoted_amount: quoted.value,
        cost_budget: budget.value,
        currency: membership?.company.currency ?? "",
        responsible: str(args.responsible) ?? null,
        invoiceable: args.invoiceable === false ? false : true,
      };
      return {
        result: { ok: true, note: "Borrador preparado. Resumíselo a la persona; lo confirma en la interfaz.", draft },
        draft,
      };
    }

    case "propose_project_status": {
      const project = await resolveProject(companyId, args);
      if (!project) return { result: { error: "No encontré ese trabajo. Usá list_projects para obtener el id." } };
      const status = str(args.status) as ProjectStatus | undefined;
      if (!status || !PROJECT_STATUSES.includes(status)) return { result: { error: "Estado inválido." } };
      if (status === project.status) {
        return { result: { error: `El trabajo ya está en "${PROJECT_STATUS_LABEL[status]}".` } };
      }
      const holdReason = str(args.hold_reason) ?? null;
      if (status === "en_espera" && !holdReason) {
        return { result: { error: "\"En espera\" necesita un motivo: preguntáselo a la persona." } };
      }
      const draft: ProjectStatusDraft = {
        kind: "project_status",
        project_id: project.id,
        project_name: project.name,
        from_status: project.status,
        status,
        hold_reason: status === "en_espera" ? holdReason : null,
      };
      return {
        result: { ok: true, note: "Borrador preparado. La persona lo confirma en la interfaz.", draft },
        draft,
      };
    }

    case "propose_expense": {
      const classification = args.classification === "general" ? "general" : "direct";
      const documentDate = str(args.document_date) ?? "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!DATE_RE.test(documentDate)) return { result: { error: "Falta document_date (YYYY-MM-DD)." } };
      if (taxAmount < 0) return { result: { error: "tax_amount no puede ser negativo." } };

      const currency = await resolveCurrency(companyId, args.currency);
      if ("error" in currency) return { result: currency };

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines };

      const [suppliers, project] = await Promise.all([getSuppliers(companyId), resolveProject(companyId, args)]);
      const supplierName = str(args.supplier_name);
      const supplier = findByName(suppliers.filter((s) => s.active), supplierName);
      if (supplierName && !supplier) {
        return { result: { error: "No encontré ese proveedor (o hay varios parecidos). Usá list_suppliers y confirmá el nombre." } };
      }

      if (classification === "direct" && !project) {
        return {
          result: { error: "Un gasto directo necesita un trabajo válido. Usá list_projects para encontrarlo y volvé a intentar." },
        };
      }

      const netAmount = sumLines(lines);
      const totalAmount = netAmount + taxAmount;
      const duplicate = await findPotentialDuplicateCost(
        companyId,
        supplier?.id ?? null,
        documentDate,
        totalAmount,
      );

      const draft: ExpenseDraft = {
        kind: "expense",
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier?.name ?? null,
        project_id: classification === "direct" ? (project?.id ?? null) : null,
        project_name: classification === "direct" ? (project?.name ?? null) : null,
        classification,
        document_date: documentDate,
        currency: currency.currency,
        tax_amount: taxAmount,
        lines,
        net_amount: netAmount,
        total_amount: totalAmount,
        duplicateWarning: duplicate
          ? { document_date: duplicate.document_date, total_amount: duplicate.total_amount, currency: duplicate.currency }
          : undefined,
      };

      return {
        result: {
          ok: true,
          note: duplicate
            ? "Borrador preparado, PERO ya existe un gasto con el mismo proveedor, fecha y total: avisale del posible duplicado antes de que confirme."
            : classification === "general"
              ? "Borrador preparado. Es un gasto general: al confirmarlo, la app lleva a 'Dividir costo' para repartirlo."
              : "Borrador preparado. Resumíselo a la persona; lo confirma en la interfaz.",
          draft,
        },
        draft,
      };
    }

    case "propose_sale": {
      const documentType = ["invoice", "receipt", "credit_note", "manual"].includes(args.document_type as string)
        ? (args.document_type as SaleDraft["document_type"])
        : "manual";
      const documentDate = str(args.document_date) ?? "";
      const taxAmount = Number.isFinite(Number(args.tax_amount)) ? Number(args.tax_amount) : 0;

      if (!DATE_RE.test(documentDate)) return { result: { error: "Falta document_date (YYYY-MM-DD)." } };
      if (taxAmount < 0) return { result: { error: "tax_amount no puede ser negativo." } };

      const currency = await resolveCurrency(companyId, args.currency);
      if ("error" in currency) return { result: currency };

      const lines = validateLines(args.lines);
      if ("error" in lines) return { result: lines };

      const [clients, project] = await Promise.all([getClients(companyId), resolveProject(companyId, args)]);
      const client = findByName(clients.filter((c) => c.active), str(args.client_name));
      if (!client) {
        return { result: { error: "No encontré ese cliente (o hay varios parecidos). Usá list_clients y confirmá el nombre." } };
      }
      if ((str(args.project_id) || str(args.project_name)) && !project) {
        return { result: { error: "No encontré ese trabajo. Usá list_projects para encontrarlo." } };
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
        currency: currency.currency,
        tax_amount: taxAmount,
        lines,
        net_amount: netAmount,
        total_amount: netAmount + taxAmount,
      };

      return {
        result: { ok: true, note: "Borrador preparado. Resumíselo a la persona; lo confirma en la interfaz.", draft },
        draft,
      };
    }

    default:
      return { result: { error: `Herramienta desconocida: ${name}` } };
  }
}
