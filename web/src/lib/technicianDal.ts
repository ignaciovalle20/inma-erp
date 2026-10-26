import "server-only";

import { createClient } from "@/lib/supabase/server";
import { selectAll } from "@/lib/pagination";
import {
  backingOfSourceType,
  outstanding,
  type Backing,
  type DocumentStatus,
  type EnteredAs,
  type WithholdingRate,
} from "@/lib/technicians";

/**
 * Reads of the external technicians (docs/plan-sistema-v3.md, F1). Unlike the
 * older master-list readers in dal.ts, these THROW when a query fails: a
 * saldo built from a failed read would look like "we owe nothing", so the
 * pages catch the error and say it on screen instead.
 */

export type TechnicianCharge = {
  id: string;
  company_id: string;
  project_id: string;
  project_name: string;
  personnel_id: string;
  personnel_name: string;
  /**
   * The charge's own direct cost: its job, in the month of the charge. It
   * stays when a factura / boleta is linked, which only backs it (20261028010000).
   */
  cost_document_id: string;
  description: string | null;
  charge_date: string;
  /** What INMA owes the technician for this job ("a pagar"). */
  amount: number;
  vat_included: boolean;
  vat_rate: number;
  /** The cost of the job. */
  net_amount: number;
  document_status: DocumentStatus;
  /** Chile: factura / boleta / none. Null in Uruguay and in charges of the previous form. */
  backing: Backing | null;
  entered_as: EnteredAs | null;
  withholding_rate: number | null;
  /** The purchase document linked to this charge, if any. */
  linked_document: LinkedDocument | null;
  /** Sum of the payments applied to this charge. */
  paid: number;
  /** What is still owed on it. */
  outstanding: number;
};

/** An imported factura or boleta, as the technician screens show it. */
export type LinkedDocument = {
  id: string;
  source_document_type: string | null;
  document_number: string | null;
  document_date: string;
  net_amount: number;
  total_amount: number;
  supplier_name: string | null;
};

export type TechnicianPaymentApplication = {
  charge_id: string;
  amount: number;
};

export type TechnicianPayment = {
  id: string;
  personnel_id: string;
  payment_date: string;
  amount: number;
  method: string | null;
  notes: string | null;
  applications: TechnicianPaymentApplication[];
};

function readError(what: string, error: { message: string }): Error {
  console.error(error);
  return new Error(`No se pudieron leer ${what}: ${error.message}`);
}

/** A many-to-one embed comes back as an object (or, in some shapes, a one-item array). */
function embeddedName(value: unknown): string {
  const row = Array.isArray(value) ? value[0] : value;
  return typeof (row as { name?: unknown } | null)?.name === "string" ? (row as { name: string }).name : "";
}

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * Which cost documents are a technician's charge, and which charge: "Eliminar"
 * on an expense sends those to Técnicos instead (lib/costDocumentDeletion.ts).
 * Optionally only for some documents.
 */
export async function getTechnicianChargeCostLinks(
  companyId: string,
  costDocumentId?: string,
): Promise<{ id: string; project_id: string; cost_document_id: string }[]> {
  const supabase = await createClient();
  let query = supabase
    .from("technician_charges")
    .select("id, project_id, cost_document_id")
    .eq("company_id", companyId);
  if (costDocumentId) query = query.eq("cost_document_id", costDocumentId);
  const { data, error } = await selectAll(query);
  if (error) throw readError("los cargos de técnicos", error);
  return data as { id: string; project_id: string; cost_document_id: string }[];
}

const DOCUMENT_COLUMNS =
  "id, source_document_type, document_number, document_date, net_amount, total_amount, suppliers (name)";

type DocumentRow = {
  id: string;
  source_document_type: string | null;
  document_number: string | null;
  document_date: string;
  net_amount: number;
  total_amount: number;
  suppliers: unknown;
};

function toLinkedDocument(row: DocumentRow): LinkedDocument {
  const supplierName = embeddedName(row.suppliers);
  return {
    id: row.id,
    source_document_type: row.source_document_type,
    document_number: row.document_number,
    document_date: row.document_date,
    net_amount: Number(row.net_amount),
    total_amount: Number(row.total_amount),
    supplier_name: supplierName || null,
  };
}

async function readLinks(
  supabase: Client,
  companyId: string,
): Promise<{ charge_id: string; cost_document_id: string; cost_amount: number; document: LinkedDocument }[]> {
  const { data, error } = await selectAll(
    supabase
      .from("technician_charge_documents")
      .select(`charge_id, cost_document_id, cost_amount, cost_documents (${DOCUMENT_COLUMNS})`)
      .eq("company_id", companyId),
  );
  if (error) throw readError("los documentos vinculados a cargos", error);
  return data.map((row) => {
    const document = (Array.isArray(row.cost_documents) ? row.cost_documents[0] : row.cost_documents) as DocumentRow;
    return {
      charge_id: row.charge_id,
      cost_document_id: row.cost_document_id,
      cost_amount: Number(row.cost_amount),
      document: toLinkedDocument(document),
    };
  });
}

async function readApplications(supabase: Client, companyId: string) {
  const { data, error } = await selectAll(
    supabase
      .from("technician_payment_applications")
      .select("payment_id, charge_id, amount")
      .eq("company_id", companyId),
  );
  if (error) throw readError("los pagos a técnicos", error);
  return data;
}

async function readCharges(
  supabase: Client,
  companyId: string,
  filter: { personnelId?: string; projectId?: string },
  applications: { charge_id: string; amount: number }[],
  links: { charge_id: string; document: LinkedDocument }[],
): Promise<TechnicianCharge[]> {
  let query = supabase
    .from("technician_charges")
    .select(
      "id, company_id, project_id, personnel_id, cost_document_id, description, charge_date, amount, vat_included, vat_rate, net_amount, document_status, backing, entered_as, withholding_rate, projects (name), personnel (name)",
    )
    .eq("company_id", companyId);

  if (filter.personnelId) query = query.eq("personnel_id", filter.personnelId);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);

  const { data, error } = await selectAll(query.order("charge_date", { ascending: false }));
  if (error) throw readError("los cargos de técnicos", error);

  const paidByCharge = new Map<string, number>();
  for (const application of applications) {
    paidByCharge.set(application.charge_id, (paidByCharge.get(application.charge_id) ?? 0) + application.amount);
  }
  const documentByCharge = new Map(links.map((link) => [link.charge_id, link.document]));

  return data.map((row) => {
    const paid = paidByCharge.get(row.id) ?? 0;
    return {
      id: row.id,
      company_id: row.company_id,
      project_id: row.project_id,
      project_name: embeddedName(row.projects),
      personnel_id: row.personnel_id,
      personnel_name: embeddedName(row.personnel),
      cost_document_id: row.cost_document_id,
      description: row.description,
      charge_date: row.charge_date,
      amount: row.amount,
      vat_included: row.vat_included,
      vat_rate: row.vat_rate,
      net_amount: row.net_amount,
      document_status: row.document_status,
      backing: row.backing,
      entered_as: row.entered_as,
      withholding_rate: row.withholding_rate === null ? null : Number(row.withholding_rate),
      linked_document: documentByCharge.get(row.id) ?? null,
      paid,
      outstanding: outstanding({ amount: row.amount, paid }),
    };
  });
}

/**
 * The charges of a company (optionally of one technician or one job), each
 * with what has been paid on it. Feeds the saldo of the personnel list, the
 * technicians section of a job and the indicators of the board.
 */
export async function getTechnicianCharges(
  companyId: string,
  filter: { personnelId?: string; projectId?: string } = {},
): Promise<TechnicianCharge[]> {
  const supabase = await createClient();
  const [applications, links] = await Promise.all([
    readApplications(supabase, companyId),
    readLinks(supabase, companyId),
  ]);
  return readCharges(supabase, companyId, filter, applications, links);
}

/** One technician's cuenta corriente: every charge and every payment, with what each payment covered. */
export async function getTechnicianAccount(
  companyId: string,
  personnelId: string,
): Promise<{ charges: TechnicianCharge[]; payments: TechnicianPayment[] }> {
  const supabase = await createClient();
  const [applications, links] = await Promise.all([
    readApplications(supabase, companyId),
    readLinks(supabase, companyId),
  ]);
  const charges = await readCharges(supabase, companyId, { personnelId }, applications, links);

  const { data, error } = await selectAll(
    supabase
      .from("technician_payments")
      .select("id, personnel_id, payment_date, amount, method, notes")
      .eq("company_id", companyId)
      .eq("personnel_id", personnelId)
      .order("payment_date", { ascending: false }),
  );
  if (error) throw readError("los pagos del técnico", error);

  const applicationsByPayment = new Map<string, TechnicianPaymentApplication[]>();
  for (const application of applications) {
    const list = applicationsByPayment.get(application.payment_id) ?? [];
    list.push({ charge_id: application.charge_id, amount: application.amount });
    applicationsByPayment.set(application.payment_id, list);
  }

  return {
    charges,
    payments: data.map((row) => ({
      ...row,
      applications: applicationsByPayment.get(row.id) ?? [],
    })),
  };
}

// ---------------------------------------------------------------------
// Chile: RUTs, backing documents and links (20261026010000)
// ---------------------------------------------------------------------

/**
 * The purchase documents linked to technician charges (all of the company's,
 * or whether one is). Their assignment screens are locked while linked.
 */
export async function getLinkedDocumentIds(companyId: string, costDocumentId?: string): Promise<Set<string>> {
  const supabase = await createClient();
  let query = supabase.from("technician_charge_documents").select("cost_document_id").eq("company_id", companyId);
  if (costDocumentId) query = query.eq("cost_document_id", costDocumentId);
  const { data, error } = await selectAll(query);
  if (error) throw readError("los documentos vinculados a cargos", error);
  return new Set(data.map((row) => row.cost_document_id as string));
}

/** The retención of a boleta by year (boleta_withholding_rates). */
export async function getWithholdingRates(): Promise<WithholdingRate[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("boleta_withholding_rates").select("year, rate").order("year");
  if (error) throw readError("las tasas de retención de boletas", error);
  return (data ?? []).map((row) => ({ year: Number(row.year), rate: Number(row.rate) }));
}

export type TechnicianSupplier = {
  /** The link's id (technician_suppliers). */
  id: string;
  personnel_id: string;
  supplier_id: string;
  supplier_name: string;
  tax_id: string | null;
};

/** The suppliers (RUTs) linked to the company's technicians, or to one of them. */
export async function getTechnicianSuppliers(companyId: string, personnelId?: string): Promise<TechnicianSupplier[]> {
  const supabase = await createClient();
  let query = supabase
    .from("technician_suppliers")
    .select("id, personnel_id, supplier_id, suppliers (name, tax_id)")
    .eq("company_id", companyId);
  if (personnelId) query = query.eq("personnel_id", personnelId);
  const { data, error } = await selectAll(query.order("created_at"));
  if (error) throw readError("los RUT vinculados a técnicos", error);
  return data.map((row) => {
    const supplier = (Array.isArray(row.suppliers) ? row.suppliers[0] : row.suppliers) as {
      name?: string;
      tax_id?: string | null;
    } | null;
    return {
      id: row.id,
      personnel_id: row.personnel_id,
      supplier_id: row.supplier_id,
      supplier_name: supplier?.name ?? "",
      tax_id: supplier?.tax_id ?? null,
    };
  });
}

/** Where a purchase document is imputed today, in words for the screens. */
export type DocumentAssignment = {
  /** Assigned whole to a job, split, or allocated to services (confirmed). */
  allocated: boolean;
  /**
   * Allocated to recurring services (confirmed): it is not linked to charges
   * until that allocation is removed (link_technician_document, SERVICES).
   */
  services: boolean;
  /** "Trabajo X", "Repartido: A, B", "Servicios recurrentes". Null when unassigned. */
  label: string | null;
};

export type TechnicianDocument = LinkedDocument & {
  supplier_id: string | null;
  backing: "factura" | "boleta";
  assignment: DocumentAssignment;
  /** The charges this document is linked to (empty when not linked). */
  linked_charge_ids: string[];
};

type DocumentDetailRow = DocumentRow & {
  supplier_id: string | null;
  classification: string;
  projects: unknown;
  cost_allocations: { projects: unknown; clients: unknown; business_areas: unknown }[] | null;
  cost_service_allocations: { status: string }[] | null;
};

const DOCUMENT_DETAIL_COLUMNS = `${DOCUMENT_COLUMNS}, supplier_id, classification, projects (name), cost_allocations (projects (name), clients (name), business_areas (name)), cost_service_allocations (status)`;

function assignmentOf(row: DocumentDetailRow): DocumentAssignment {
  if (row.classification === "direct") {
    return { allocated: true, services: false, label: `Trabajo ${embeddedName(row.projects) || "—"}` };
  }
  const split = (row.cost_allocations ?? []).map(
    (allocation) =>
      embeddedName(allocation.projects) || embeddedName(allocation.clients) || embeddedName(allocation.business_areas),
  );
  const services = (row.cost_service_allocations ?? []).some((allocation) => allocation.status === "confirmed");
  if (split.length > 0) {
    return { allocated: true, services, label: `Repartido: ${split.join(", ")}${services ? " y servicios recurrentes" : ""}` };
  }
  if (services) return { allocated: true, services, label: "Servicios recurrentes" };
  return { allocated: false, services: false, label: null };
}

function toTechnicianDocument(row: DocumentDetailRow, linkedChargeIds: string[]): TechnicianDocument | null {
  const backing = backingOfSourceType(row.source_document_type);
  if (!backing) return null;
  return {
    ...toLinkedDocument(row),
    supplier_id: row.supplier_id,
    backing,
    assignment: assignmentOf(row),
    linked_charge_ids: linkedChargeIds,
  };
}

/**
 * The imported facturas (FAC-EL, FAC-EE) and boletas (BOL-HE, BOL-TE) of a
 * technician's suppliers, linked or not, newest first.
 */
export async function getTechnicianDocuments(companyId: string, personnelId: string): Promise<TechnicianDocument[]> {
  const supabase = await createClient();
  const suppliers = await getTechnicianSuppliers(companyId, personnelId);
  if (suppliers.length === 0) return [];

  const [documents, links] = await Promise.all([
    selectAll(
      supabase
        .from("cost_documents")
        .select(DOCUMENT_DETAIL_COLUMNS)
        .eq("company_id", companyId)
        .eq("document_type", "invoice")
        .in("supplier_id", suppliers.map((supplier) => supplier.supplier_id))
        .in("source_document_type", ["FAC-EL", "FAC-EE", "BOL-HE", "BOL-TE"])
        .order("document_date", { ascending: false }),
    ),
    readLinks(supabase, companyId),
  ]);
  if (documents.error) throw readError("los documentos del técnico", documents.error);

  const chargesByDocument = new Map<string, string[]>();
  for (const link of links) {
    chargesByDocument.set(link.cost_document_id, [...(chargesByDocument.get(link.cost_document_id) ?? []), link.charge_id]);
  }

  return (documents.data as unknown as DocumentDetailRow[]).flatMap((row) => {
    const document = toTechnicianDocument(row, chargesByDocument.get(row.id) ?? []);
    return document ? [document] : [];
  });
}

export type DocumentLinkContext = {
  document: TechnicianDocument | null;
  /** The document's supplier is not a technician's yet (its RUT is not in any ficha). */
  supplierId: string | null;
  supplierName: string | null;
  technician: { id: string; name: string } | null;
  /** Charges already linked to this document. */
  linkedCharges: TechnicianCharge[];
  /** The technician's charges with the document's backing and no document yet. */
  pendingCharges: TechnicianCharge[];
  /** A pending suggestion of Conciliar for this document. */
  suggestedChargeIds: string[];
};

/** Everything the "Es de un técnico" screen of a purchase document needs. */
export async function getDocumentLinkContext(companyId: string, costDocumentId: string): Promise<DocumentLinkContext> {
  const supabase = await createClient();
  const [documentRead, links, suggestionRead] = await Promise.all([
    supabase
      .from("cost_documents")
      .select(DOCUMENT_DETAIL_COLUMNS)
      .eq("company_id", companyId)
      .eq("id", costDocumentId)
      .maybeSingle(),
    readLinks(supabase, companyId),
    supabase
      .from("technician_document_suggestions")
      .select("charge_ids, status")
      .eq("company_id", companyId)
      .eq("cost_document_id", costDocumentId)
      .maybeSingle(),
  ]);
  if (documentRead.error) throw readError("el documento", documentRead.error);
  if (suggestionRead.error) throw readError("la sugerencia del documento", suggestionRead.error);

  const row = documentRead.data as unknown as DocumentDetailRow | null;
  const linkedIds = links.filter((link) => link.cost_document_id === costDocumentId).map((link) => link.charge_id);
  const document = row ? toTechnicianDocument(row, linkedIds) : null;
  const empty: DocumentLinkContext = {
    document,
    supplierId: row?.supplier_id ?? null,
    supplierName: row ? embeddedName(row.suppliers) || null : null,
    technician: null,
    linkedCharges: [],
    pendingCharges: [],
    suggestedChargeIds: [],
  };
  if (!document || !document.supplier_id) return empty;

  const { data: owner, error: ownerError } = await supabase
    .from("technician_suppliers")
    .select("personnel_id, personnel (name)")
    .eq("company_id", companyId)
    .eq("supplier_id", document.supplier_id)
    .maybeSingle();
  if (ownerError) throw readError("el técnico del proveedor", ownerError);
  if (!owner) return empty;

  const applications = await readApplications(supabase, companyId);
  const charges = await readCharges(supabase, companyId, { personnelId: owner.personnel_id }, applications, links);
  const suggestion = suggestionRead.data as { charge_ids: string[]; status: string } | null;

  return {
    ...empty,
    technician: { id: owner.personnel_id, name: embeddedName(owner.personnel) },
    linkedCharges: charges.filter((charge) => linkedIds.includes(charge.id)),
    pendingCharges: charges.filter(
      (charge) => charge.backing === document.backing && !charge.linked_document,
    ),
    suggestedChargeIds: suggestion?.status === "pending" ? suggestion.charge_ids : [],
  };
}

export type PendingTechnicianSuggestion = {
  costDocumentId: string;
  document: TechnicianDocument;
  technicianName: string;
  charges: { id: string; project_id: string; project_name: string; charge_date: string; cost: number }[];
  /** False when a charge changed, went away or got another document since: confirming would fail. */
  stillValid: boolean;
};

/** Suggestions of Conciliar waiting for a decision; `month` filters by the document's date. */
export async function getPendingTechnicianSuggestions(
  companyId: string,
  month: string | null,
): Promise<PendingTechnicianSuggestion[]> {
  const supabase = await createClient();
  const { data, error } = await selectAll(
    supabase
      .from("technician_document_suggestions")
      .select(`cost_document_id, charge_ids, personnel (name), cost_documents (${DOCUMENT_DETAIL_COLUMNS})`)
      .eq("company_id", companyId)
      .eq("status", "pending"),
  );
  if (error) throw readError("las sugerencias de documentos de técnicos", error);

  const rows = data
    .map((row) => ({
      chargeIds: row.charge_ids as string[],
      technicianName: embeddedName(row.personnel),
      document: (Array.isArray(row.cost_documents) ? row.cost_documents[0] : row.cost_documents) as DocumentDetailRow,
    }))
    .filter((row) => row.document && (!month || row.document.document_date.slice(0, 7) === month));
  if (rows.length === 0) return [];

  const chargeIds = [...new Set(rows.flatMap((row) => row.chargeIds))];
  const { data: chargeRows, error: chargeError } = await selectAll(
    supabase
      .from("technician_charges")
      .select("id, project_id, charge_date, net_amount, projects (name), technician_charge_documents (id)")
      .eq("company_id", companyId)
      .in("id", chargeIds),
  );
  if (chargeError) throw readError("los cargos sugeridos", chargeError);
  const chargeById = new Map(chargeRows.map((row) => [row.id, row]));
  const isLinked = (charge: { technician_charge_documents: unknown }) => {
    const links = charge.technician_charge_documents;
    return Array.isArray(links) ? links.length > 0 : Boolean(links);
  };

  return rows
    .flatMap((row) => {
      const document = toTechnicianDocument(row.document, []);
      if (!document) return [];
      const found = row.chargeIds.flatMap((id) => {
        const charge = chargeById.get(id);
        return charge ? [charge] : [];
      });
      const charges = found.map((charge) => ({
        id: charge.id as string,
        project_id: charge.project_id as string,
        project_name: embeddedName(charge.projects),
        charge_date: charge.charge_date as string,
        cost: Number(charge.net_amount),
      }));
      const sum = charges.reduce((total, charge) => total + charge.cost, 0);
      const stillValid =
        !document.assignment.services &&
        found.length === row.chargeIds.length &&
        found.every((charge) => !isLinked(charge)) &&
        Math.abs(document.net_amount - sum) <= charges.length;
      return [
        {
          costDocumentId: document.id,
          document,
          technicianName: row.technicianName,
          charges,
          stillValid,
        },
      ];
    })
    .sort((a, b) => b.document.document_date.localeCompare(a.document.document_date));
}
