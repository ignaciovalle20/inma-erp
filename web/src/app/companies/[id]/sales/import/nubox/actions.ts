"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getImportBatchDetail, type ImportRowStatus } from "@/lib/dal";
import {
  formatSummary,
  normalizeRut,
  parseNuboxCsv,
  type ImportSummary,
  type JobBalance,
  type NuboxDocument,
} from "@/lib/nubox";
import {
  analyzeNuboxRows,
  type CreditNoteView,
  type InvoiceLinkView,
  type NuboxAnalysis,
} from "./analysis";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

// ---------------------------------------------------------------------
// analyzeNuboxFile: reads the upload, checks it against what the ERP
// already has and returns what the preview shows. No database writes. The
// parsed rows travel back to the browser (same as the generic importer:
// nothing about an in-progress import is persisted), and commitNuboxImport
// re-derives everything from them instead of trusting the preview.
// ---------------------------------------------------------------------

export type PreviewDocument = {
  rowNumber: number;
  documentType: "invoice" | "credit_note";
  documentNumber: string;
  clientName: string;
  rut: string;
  clientIsNew: boolean;
  documentDate: string;
  dueDate: string | null;
  netAmount: number;
  totalAmount: number;
  paymentStatus: string;
};

export type NuboxPreview = {
  fileName: string;
  rows: Record<string, string>[];
  summary: ImportSummary;
  summaryText: string;
  newDocuments: PreviewDocument[];
  /** Documents that take over a sale already loaded without a folio. */
  adoptedDocuments: PreviewDocument[];
  clientsToComplete: NuboxAnalysis["clientsToComplete"];
  leftoverSales: NuboxAnalysis["leftoverSales"];
  reviewDocuments: (PreviewDocument & { reason: string })[];
  errors: { rowNumber: number; folio: string; message: string }[];
  skipped: { rowNumber: number; message: string }[];
  newClients: { rut: string; name: string }[];
  creditNotes: CreditNoteView[];
  invoiceLinks: InvoiceLinkView[];
  jobs: JobBalance[];
};

export type AnalyzeNuboxResult = { error: string } | ({ error: null } & NuboxPreview);

async function requireChileMembership(
  companyId: string,
): Promise<{ error: string } | { error: null; currency: string }> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) return { error: "No tenés acceso a esta empresa." };
  if (membership.company.country?.toUpperCase() !== "CL") {
    return { error: "La importación de Nubox solo está disponible para empresas de Chile." };
  }
  return { error: null, currency: membership.company.currency };
}

type ImportRowRecord = {
  row_number: number;
  status: string;
  error_message: string | null;
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function toPreviewDocument(
  document: NuboxDocument,
  analysis: NuboxAnalysis,
): PreviewDocument {
  return {
    rowNumber: document.rowNumber,
    documentType: document.documentType,
    documentNumber: document.documentNumber,
    clientName: document.clientName,
    rut: document.rut,
    clientIsNew: analysis.clientByRut.get(document.rut) === null,
    documentDate: document.documentDate,
    dueDate: document.dueDate,
    netAmount: document.netAmount,
    totalAmount: document.totalAmount,
    paymentStatus: document.paymentStatus,
  };
}

export async function analyzeNuboxFile(
  companyId: string,
  formData: FormData,
): Promise<AnalyzeNuboxResult> {
  try {
    const gate = await requireChileMembership(companyId);
    if (gate.error !== null) return { error: gate.error };

    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return { error: "Elegí el archivo CSV que exportaste de Nubox." };
    }
    if (file.size > MAX_FILE_BYTES) {
      return { error: "El archivo es demasiado grande (máximo 5 MB)." };
    }

    const parsed = parseNuboxCsv(await file.text());
    if (parsed.error) return { error: parsed.error };
    if (parsed.rows.length > MAX_ROWS) {
      return { error: `El archivo tiene más de ${MAX_ROWS} filas.` };
    }

    const analysis = await analyzeNuboxRows(companyId, parsed.rows);

    const newDocuments: PreviewDocument[] = [];
    const adoptedDocuments: PreviewDocument[] = [];
    const reviewDocuments: (PreviewDocument & { reason: string })[] = [];
    const errors: NuboxPreview["errors"] = [];
    const skipped: NuboxPreview["skipped"] = [];

    for (const result of analysis.results) {
      if (result.error) {
        errors.push({
          rowNumber: result.rowNumber,
          folio: result.raw.Folio ?? "",
          message: result.error,
        });
      } else if (result.skipped) {
        skipped.push({ rowNumber: result.rowNumber, message: result.skipped });
      } else if (result.document) {
        const classification = analysis.classifications.get(result.rowNumber);
        if (classification?.kind === "new") {
          newDocuments.push(toPreviewDocument(result.document, analysis));
        } else if (classification?.kind === "adopt") {
          adoptedDocuments.push(toPreviewDocument(result.document, analysis));
        } else if (classification?.kind === "review") {
          reviewDocuments.push({
            ...toPreviewDocument(result.document, analysis),
            reason: classification.reason,
          });
        }
      }
    }

    return {
      error: null,
      fileName: file.name,
      rows: parsed.rows,
      summary: analysis.summary,
      summaryText: formatSummary(analysis.summary),
      newDocuments,
      adoptedDocuments,
      clientsToComplete: analysis.clientsToComplete,
      leftoverSales: analysis.leftoverSales,
      reviewDocuments,
      errors,
      skipped,
      newClients: analysis.newClients,
      creditNotes: analysis.creditNotes,
      invoiceLinks: analysis.invoiceLinks,
      jobs: analysis.jobs,
    };
  } catch (error) {
    console.error(error);
    return { error: messageOf(error, "No se pudo analizar el archivo.") };
  }
}

// ---------------------------------------------------------------------
// commitNuboxImport
// ---------------------------------------------------------------------

export type NuboxDecisions = {
  /** Credit-note folio -> invoice folio to annul; null = do not pair. Missing = automatic pairing if any. */
  pairs: Record<string, string | null>;
  /** Invoice folio -> job id; null = leave unlinked. Missing = the pre-marked suggestion, if any. */
  links: Record<string, string | null>;
};

export type CommitNuboxResult =
  | { error: string }
  | {
      error: null;
      batchId: string;
      summaryText: string;
      createdClients: number;
      completedClients: number;
      pairedCreditNotes: number;
      counts: { imported: number; adopted: number; updated: number; unchanged: number; review: number; errors: number };
      skipped: number;
      rowResults: {
        rowNumber: number;
        folio: string;
        status: ImportRowStatus;
        message: string | null;
      }[];
      warnings: string[];
    };

export async function commitNuboxImport(
  companyId: string,
  fileName: string,
  rows: Record<string, string>[],
  decisions: NuboxDecisions,
): Promise<CommitNuboxResult> {
  try {
    const gate = await requireChileMembership(companyId);
    if (gate.error !== null) return { error: gate.error };

    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS) {
      return { error: "El archivo no tiene filas válidas para importar." };
    }

    // Everything is derived again here from the raw rows: the browser only
    // contributes the user's choices, and those are checked below.
    const analysis = await analyzeNuboxRows(companyId, rows);
    const documents = analysis.results.flatMap((result) => (result.document ? [result.document] : []));

    if (documents.length === 0) {
      return { error: "Ninguna fila del archivo se puede importar; revisá los errores." };
    }

    // --- Credit-note pairings -------------------------------------------
    const pairFor = new Map<string, string>();
    const usedInvoices = new Set<string>();

    for (const note of analysis.creditNotes) {
      if (note.state === "paired" || note.state === "none") continue;

      const decision = decisions.pairs?.[note.documentNumber];
      let chosen: string | null;

      if (decision === undefined) {
        chosen = note.autoPairedWith;
      } else if (decision === null) {
        chosen = null;
      } else {
        const allowed = note.autoPairedWith
          ? [note.autoPairedWith]
          : note.candidates.map((candidate) => candidate.documentNumber);
        if (!allowed.includes(decision)) {
          return {
            error: `La N/C ${note.documentNumber} no puede emparejarse con la factura ${decision}.`,
          };
        }
        chosen = decision;
      }

      if (chosen) {
        if (usedInvoices.has(chosen)) {
          return { error: `La factura ${chosen} está elegida para más de una nota de crédito.` };
        }
        usedInvoices.add(chosen);
        pairFor.set(note.documentNumber, chosen);
      }
    }

    // --- Invoice -> job -------------------------------------------------
    const linkFor = new Map<string, string>();
    const jobById = new Map(analysis.jobs.map((job) => [job.projectId, job]));

    for (const link of analysis.invoiceLinks) {
      // An invoice about to be annulled by a credit note is not linked.
      if (usedInvoices.has(link.documentNumber)) continue;

      const decision = decisions.links?.[link.documentNumber];
      const projectId = decision === undefined ? link.suggestedProjectId : decision;
      if (!projectId) continue;

      const job = jobById.get(projectId);
      if (!job || job.clientId !== link.clientId) {
        return {
          error: `El trabajo elegido para la factura ${link.documentNumber} no existe o es de otro cliente.`,
        };
      }
      linkFor.set(link.documentNumber, projectId);
    }

    const supabase = await createClient();

    // --- New clients (by RUT) -------------------------------------------
    const clientIdByRut = new Map<string, string>();
    for (const [rut, match] of analysis.clientByRut) {
      if (match) clientIdByRut.set(rut, match.id);
    }

    // Clients loaded before Nubox get their RUT here (found by name). It is
    // idempotent: a failed import later on leaves the RUT in place and the
    // next attempt simply matches them by RUT.
    let completedClients = 0;
    for (const client of analysis.clientsToComplete) {
      const { error: rutError } = await supabase
        .from("clients")
        .update({ tax_id: client.rut })
        .eq("id", client.id)
        .eq("company_id", companyId)
        .is("tax_id", null);

      if (rutError) {
        return {
          error: `No se pudo cargar el RUT ${client.rut} al cliente ${client.storedName}: ${rutError.message}.`,
        };
      }
      completedClients += 1;
    }

    let createdClients = 0;
    if (analysis.newClients.length > 0) {
      const { data: created, error: clientsError } = await supabase
        .from("clients")
        .insert(
          analysis.newClients.map((client) => ({
            company_id: companyId,
            name: client.name,
            tax_id: client.rut,
          })),
        )
        .select("id, tax_id");

      if (clientsError || !created) {
        return {
          error: `No se pudieron crear los clientes nuevos: ${clientsError?.message ?? "sin respuesta"}.`,
        };
      }

      for (const client of created) {
        const rut = normalizeRut(client.tax_id);
        if (rut) clientIdByRut.set(rut, client.id);
      }
      createdClients = created.length;
    }

    // --- Batch ----------------------------------------------------------
    const errorRows = analysis.results.filter((result) => result.error);
    const skippedCount = analysis.results.filter((result) => result.skipped).length;

    const { data: batch, error: batchError } = await supabase
      .rpc("create_import_batch", {
        p_company_id: companyId,
        p_file_name: fileName,
        p_total_rows: documents.length + errorRows.length,
      })
      .select()
      .single<{ id: string }>();

    if (batchError || !batch) {
      return { error: `No se pudo crear el lote de importación: ${batchError?.message ?? "sin respuesta"}.` };
    }

    const adoptFor = new Map<number, string>();
    for (const [rowNumber, classification] of analysis.classifications) {
      if (classification.kind === "adopt") adoptFor.set(rowNumber, classification.legacy.id);
    }

    const rpcRows = documents.map((document) => ({
      row_number: document.rowNumber,
      raw_data: document.raw,
      document_type: document.documentType,
      document_number: document.documentNumber,
      client_id: clientIdByRut.get(document.rut) ?? null,
      document_date: document.documentDate,
      due_date: document.dueDate,
      currency: gate.currency,
      net_amount: document.netAmount,
      tax_amount: document.taxAmount,
      other_taxes: document.otherTaxes,
      total_amount: document.totalAmount,
      payment_status: document.paymentStatus,
      nubox_send_number: document.sendNumber,
      project_id: linkFor.get(document.documentNumber) ?? null,
      adopt_document_id: adoptFor.get(document.rowNumber) ?? null,
      pair_with_document_number:
        document.documentType === "credit_note" ? (pairFor.get(document.documentNumber) ?? null) : null,
    }));

    const { data: rowResults, error: rowsError } = await supabase.rpc("import_nubox_documents_batch", {
      p_import_batch_id: batch.id,
      p_rows: rpcRows,
    });

    if (rowsError || !rowResults) {
      return {
        error: `La importación falló y no se guardó ninguna fila: ${rowsError?.message ?? "sin respuesta"}.`,
      };
    }

    // Rows the app rejected before the database saw them (bad amount, bad
    // RUT, unsupported type...) are kept in the batch too, with their reason.
    const warnings: string[] = [];
    if (errorRows.length > 0) {
      const { error: errorRowsError } = await supabase.from("import_rows").insert(
        errorRows.map((row) => ({
          import_batch_id: batch.id,
          row_number: row.rowNumber,
          raw_data: row.raw,
          status: "error",
          error_message: row.error,
        })),
      );
      if (errorRowsError) {
        warnings.push(`No se pudieron guardar las filas con error en el historial: ${errorRowsError.message}.`);
      }
    }

    const { error: countsError } = await supabase.rpc("update_import_batch_counts", {
      p_import_batch_id: batch.id,
    });
    if (countsError) {
      warnings.push(`No se pudieron actualizar los contadores del lote: ${countsError.message}.`);
    }

    const folioByRow = new Map<number, string>(
      analysis.results.map((result) => [result.rowNumber, result.raw.Folio ?? ""]),
    );

    // What the function returns is cut at the API's 1000 rows, so a
    // historical file would be counted wrong on screen even though every row
    // was saved. The batch is read back in full instead (page by page).
    const incomplete =
      "No se pudo leer el resultado completo del lote; los totales de esta pantalla pueden estar incompletos. Revisá el historial de importación.";
    let storedRows = rowResults as ImportRowRecord[];
    try {
      const detail = await getImportBatchDetail(companyId, batch.id);
      if (detail) {
        storedRows = detail.rows;
      } else {
        warnings.push(incomplete);
      }
    } catch (thrown) {
      console.error(thrown);
      warnings.push(incomplete);
    }

    const seenRows = new Set(storedRows.map((row) => row.row_number));
    const results = [
      ...storedRows.map((row) => ({
        rowNumber: row.row_number,
        folio: folioByRow.get(row.row_number) ?? "",
        status: row.status as ImportRowStatus,
        message: row.error_message,
      })),
      // Rejected rows that could not be saved in the batch still show here.
      ...errorRows
        .filter((row) => !seenRows.has(row.rowNumber))
        .map((row) => ({
          rowNumber: row.rowNumber,
          folio: row.raw.Folio ?? "",
          status: "error" as ImportRowStatus,
          message: row.error,
        })),
    ].sort((a, b) => a.rowNumber - b.rowNumber);

    const count = (status: ImportRowStatus) => results.filter((row) => row.status === status).length;
    const adoptedCount = results.filter((row) => row.status === "updated" && adoptFor.has(row.rowNumber)).length;
    const counts = {
      imported: count("imported"),
      adopted: adoptedCount,
      updated: count("updated") - adoptedCount,
      unchanged: count("unchanged"),
      review: count("review"),
      errors: count("error"),
    };

    // A pairing that the database refused is reported on the credit note row.
    const failedPairs = results.filter((row) => row.message?.includes("No se pudo emparejar")).length;

    revalidatePath(`/companies/${companyId}/sales`);
    revalidatePath(`/companies/${companyId}/sales/import-history`);
    revalidatePath(`/companies/${companyId}/sales/pending`);

    return {
      error: null,
      batchId: batch.id,
      summaryText: formatSummary({
        new: counts.imported,
        adopted: counts.adopted,
        updated: counts.updated,
        unchanged: counts.unchanged,
        review: counts.review,
        errors: counts.errors,
        skipped: skippedCount,
      }),
      createdClients,
      completedClients,
      pairedCreditNotes: Math.max(0, pairFor.size - failedPairs),
      counts,
      skipped: skippedCount,
      rowResults: results,
      warnings,
    };
  } catch (error) {
    console.error(error);
    return { error: messageOf(error, "No se pudo completar la importación.") };
  }
}
