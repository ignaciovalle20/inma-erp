"use server";

import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getSuppliers } from "@/lib/dal";
import { parseCsvDate } from "@/lib/csvDate";
import { purchaseRowCells, resolvePurchaseRow } from "@/lib/purchaseImport";
import { companyConfig } from "@/lib/companyConfig";
import { resolveRowCurrency } from "@/lib/genericImport";
import { parseTabularFile } from "@/lib/importFile";
import { normalizeRut, taxIdForStorage } from "@/lib/rut";
import { suggestCostAllocations } from "@/lib/costAllocationSuggestionsLoader";
import { suggestTechnicianDocuments } from "@/lib/technicianDocumentSuggestions";

// ---------------------------------------------------------------------
// parseImportFile: reads the uploaded CSV or Excel and returns its
// headers + rows for client-side column mapping -- the same reader as the
// sales import (lib/importFile.ts). Available to every company; the
// currency rule comes from its configuration (lib/companyConfig.ts).
// ---------------------------------------------------------------------
export type ParseImportFileResult =
  | { error: string }
  | { error: null; fileName: string; headers: string[]; rows: Record<string, string>[] };

export async function parseImportFile(
  companyId: string,
  formData: FormData,
): Promise<ParseImportFileResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return { error: "No tenés acceso a esta empresa." };
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { error: "Elegí un archivo CSV o Excel." };
  }

  const parsed = await parseTabularFile(file);
  if ("error" in parsed) {
    return { error: parsed.error };
  }

  return {
    error: null,
    fileName: file.name,
    headers: parsed.headers,
    rows: parsed.rows,
  };
}

export type ColumnMapping = {
  date: string;
  supplier: string;
  /** Neto. The net of the document is Neto + Exento (lib/purchaseImport.ts). */
  amount: string;
  currency: string | null;
  tax: string | null;
  taxId: string | null;
  exempt: string | null;
  otherTaxes: string | null;
  total: string | null;
  documentType: string | null;
  documentNumber: string | null;
  status: string | null;
};

export type CommitImportResult =
  | { error: string }
  | {
      error: null;
      totalRows: number;
      importedRows: number;
      errorRows: number;
      duplicateRows: number;
      /** Imported invoices the rules allocated to recurring services (confirmed / to confirm). */
      serviceAllocations: { confirmed: number; suggested: number };
      /** Chile: facturas / boletas of technicians suggested to their pending charges (Conciliar). */
      technicianSuggestions: number;
      rowResults: {
        rowNumber: number;
        status: "imported" | "error" | "duplicate";
        message: string | null;
      }[];
    };

function normalizeSupplierName(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function createSupplierForImport(
  companyId: string,
  rawName: string,
  taxId: string | null = null,
): Promise<{ error: string | null; supplier: { id: string; name: string; tax_id: string | null } | null }> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return { error: "No autorizado.", supplier: null };
  }

  const name = rawName.trim();

  if (!name) {
    return { error: "El nombre del proveedor es obligatorio.", supplier: null };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("suppliers")
    .insert({ company_id: companyId, name, tax_id: taxIdForStorage(taxId) })
    .select("id, name, tax_id")
    .single();

  if (error || !data) {
    console.error(error);
    return { error: "No se pudo crear el proveedor.", supplier: null };
  }

  return { error: null, supplier: data };
}

export async function commitImport(
  companyId: string,
  fileName: string,
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  forcedRowNumbers: number[] = [],
  linkedRowNumbers: Record<number, string> = {},
  /** Currency of every row when no column says it (companies with more than one). */
  fileCurrency: string | null = null,
): Promise<CommitImportResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return { error: "No tenés acceso a esta empresa." };
  }

  const config = companyConfig(membership.company);

  if (rows.length === 0) {
    return { error: "There are no rows to import." };
  }

  const suppliers = await getSuppliers(companyId);
  const activeSuppliers = suppliers.filter((supplier) => supplier.active);
  const activeSuppliersByName = new Map(
    activeSuppliers.map((supplier) => [normalizeSupplierName(supplier.name), supplier.id]),
  );
  // The RUT says who a supplier is; the same one can come with another spelling
  // of the name. Only a row without a known RUT falls back to the name.
  const activeSuppliersByRut = new Map(
    activeSuppliers.flatMap((supplier) => {
      const rut = normalizeRut(supplier.tax_id);
      return rut ? [[rut, supplier.id] as const] : [];
    }),
  );
  const rowTaxId = (row: Record<string, string>) => (mapping.taxId ? taxIdForStorage(row[mapping.taxId]) : null);
  const resolveSupplierId = (row: Record<string, string>, rawName: string): string | null => {
    const rut = mapping.taxId ? normalizeRut(row[mapping.taxId]) : null;
    return (rut ? activeSuppliersByRut.get(rut) : null) ?? activeSuppliersByName.get(normalizeSupplierName(rawName)) ?? null;
  };

  const supabase = await createClient();

  // Default behavior, mirroring sales import's unresolved-client
  // handling: a CSV supplier that doesn't match any active supplier by
  // RUT or name gets its own supplier created automatically with that
  // exact name, rather than failing the row. One found by name without a
  // RUT gets the file's: that is what links it to a technician with that
  // RUT (suppliers_link_technician).
  const unresolvedByKey = new Map<string, { rawName: string; taxId: string | null }>();
  const taxIdsToFill = new Map<string, string>();
  const supplierHasTaxId = new Set(activeSuppliers.filter((supplier) => supplier.tax_id?.trim()).map((supplier) => supplier.id));
  for (const row of rows) {
    const rawName = row[mapping.supplier]?.trim() ?? "";
    if (!rawName) continue;
    const taxId = rowTaxId(row);
    const known = resolveSupplierId(row, rawName);
    if (known) {
      if (taxId && !supplierHasTaxId.has(known)) taxIdsToFill.set(known, taxId);
      continue;
    }
    const key = (mapping.taxId ? normalizeRut(row[mapping.taxId]) : null) ?? normalizeSupplierName(rawName);
    if (!unresolvedByKey.has(key)) unresolvedByKey.set(key, { rawName, taxId });
  }

  for (const [supplierId, taxId] of taxIdsToFill) {
    const { error: fillError } = await supabase
      .from("suppliers")
      .update({ tax_id: taxId })
      .eq("id", supplierId)
      .is("tax_id", null);
    if (fillError) console.error(fillError);
  }

  if (unresolvedByKey.size > 0) {
    const { data: createdSuppliers, error: createSuppliersError } = await supabase
      .from("suppliers")
      .insert(
        Array.from(unresolvedByKey.values()).map(({ rawName, taxId }) => ({
          company_id: companyId,
          name: rawName,
          tax_id: taxId,
        })),
      )
      .select("id, name, tax_id");

    if (createSuppliersError) {
      console.error(createSuppliersError);
    } else if (createdSuppliers) {
      for (const supplier of createdSuppliers) {
        activeSuppliersByName.set(normalizeSupplierName(supplier.name), supplier.id);
        const rut = normalizeRut(supplier.tax_id);
        if (rut) activeSuppliersByRut.set(rut, supplier.id);
      }
    }
  }

  const { data: batch, error: batchError } = await supabase.rpc(
    "create_cost_import_batch",
    {
      p_company_id: companyId,
      p_file_name: fileName,
      p_total_rows: rows.length,
    },
  );

  if (batchError || !batch) {
    console.error(batchError);
    return { error: "Could not start the import. Please try again." };
  }

  const forcedRowNumberSet = new Set(forcedRowNumbers);

  const batchRows = rows.map((row, i) => {
    const rowNumber = i + 1;
    const supplierNameRaw = row[mapping.supplier]?.trim() ?? "";
    const supplierId = supplierNameRaw ? resolveSupplierId(row, supplierNameRaw) : null;

    const documentDate = parseCsvDate(row[mapping.date]);
    const purchase = resolvePurchaseRow(purchaseRowCells(row, mapping));
    const amounts = purchase.amounts;
    const currency = resolveRowCurrency(
      config,
      mapping.currency ? row[mapping.currency] : null,
      fileCurrency ?? (config.documentCurrencies.includes(config.localCurrency) ? config.localCurrency : null),
    );

    // Positive amounts: the database stores a credit note's negative.
    return {
      row_number: rowNumber,
      raw_data: row,
      supplier_id: supplierId,
      document_date: documentDate,
      currency: currency.kind === "ok" ? currency.value : null,
      amount: amounts?.netAmount ?? null,
      exempt_amount: amounts?.exemptAmount ?? 0,
      tax_amount: amounts?.taxAmount ?? 0,
      other_taxes: amounts?.otherTaxes ?? 0,
      document_type: amounts?.documentType ?? "invoice",
      source_document_type: amounts?.sourceDocumentType ?? null,
      document_number: amounts?.documentNumber ?? null,
      force: forcedRowNumberSet.has(rowNumber),
      link_to_cost_document_id: linkedRowNumbers[rowNumber] ?? null,
      rejection:
        purchase.error ?? (currency.kind === "invalid" ? `Moneda inválida: ${currency.reason}` : null),
    };
  });

  // Rows whose amounts cannot be read or don't add up are not sent to the
  // database: it would only say the amount is missing. They are kept in the
  // batch with the real reason (which column, which value).
  const rejected = batchRows.filter((row) => row.rejection);
  const rejectionByRow = new Map(rejected.map((row) => [row.row_number, row.rejection as string]));
  const rpcRows = batchRows
    .filter((row) => !row.rejection)
    .map((row) => {
      const { rejection, ...rest } = row;
      void rejection;
      return rest;
    });

  const { data: importedRowsData, error: batchRowsError } = await supabase.rpc(
    "import_cost_rows_batch",
    {
      p_import_batch_id: batch.id,
      p_rows: rpcRows,
    },
  );

  if (batchRowsError || !importedRowsData) {
    console.error(batchRowsError);
    return { error: "Could not commit the import. Please try again." };
  }

  if (rejected.length > 0) {
    const { error: rejectedError } = await supabase.from("cost_import_rows").insert(
      rejected.map((row) => ({
        import_batch_id: batch.id,
        row_number: row.row_number,
        raw_data: row.raw_data,
        status: "error",
        error_message: row.rejection,
      })),
    );
    if (rejectedError) console.error(rejectedError);
  }

  const importedRowList = importedRowsData as {
    row_number: number;
    status: string;
    error_message: string | null;
    cost_document_id: string | null;
  }[];
  const resultByRowNumber = new Map(importedRowList.map((row) => [row.row_number, row]));

  // The imported purchase invoices -> the cost periods of their supplier's
  // recurring services (exact amount / same-amount batch / proportional).
  // Best effort: the import is already committed.
  const importedDocumentIds = importedRowList
    .filter((row) => row.status === "imported" && row.cost_document_id)
    .map((row) => row.cost_document_id as string);
  const suggestions = await suggestCostAllocations(supabase, companyId, { documentIds: importedDocumentIds });
  if (suggestions.error) console.error(suggestions.error);
  // Chile: a technician's factura / boleta -> the pending charges it covers
  // (a supplier created above with a technician's RUT is already linked to
  // them by the database). Only suggested: confirmed in Conciliar.
  const technicianSuggestions = await suggestTechnicianDocuments(supabase, companyId, {
    documentIds: importedDocumentIds,
  });
  if (technicianSuggestions.error) console.error(technicianSuggestions.error);

  const rowResults: {
    rowNumber: number;
    status: "imported" | "error" | "duplicate";
    message: string | null;
  }[] = batchRows.map(({ row_number: rowNumber }) => {
    const rejection = rejectionByRow.get(rowNumber);
    if (rejection) return { rowNumber, status: "error" as const, message: rejection };
    const result = resultByRowNumber.get(rowNumber);
    return {
      rowNumber,
      status: (result?.status as "imported" | "error" | "duplicate") ?? "error",
      message: result?.error_message ?? (result ? null : "Unexpected error processing this row."),
    };
  });

  const { data: updatedBatch, error: countsError } = await supabase.rpc(
    "update_cost_import_batch_counts",
    { p_import_batch_id: batch.id },
  );

  if (countsError || !updatedBatch) {
    console.error(countsError);
  }

  const importedRows =
    updatedBatch?.imported_rows ??
    rowResults.filter((r) => r.status === "imported").length;
  const errorRows =
    updatedBatch?.error_rows ??
    rowResults.filter((r) => r.status === "error").length;
  const duplicateRows =
    updatedBatch?.duplicate_rows ??
    rowResults.filter((r) => r.status === "duplicate").length;

  return {
    error: null,
    totalRows: rows.length,
    importedRows,
    errorRows,
    duplicateRows,
    serviceAllocations: { confirmed: suggestions.confirmed, suggested: suggestions.suggested },
    technicianSuggestions: technicianSuggestions.created,
    rowResults,
  };
}
