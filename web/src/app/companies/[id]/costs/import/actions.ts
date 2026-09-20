"use server";

import Papa from "papaparse";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getSuppliers } from "@/lib/dal";
import { parseCsvDate } from "@/lib/csvDate";
import { parseAmount, parseTaxAmount } from "@/lib/amounts";

// ---------------------------------------------------------------------
// parseImportFile: reads the uploaded CSV and returns its headers +
// rows for client-side column mapping. Same shape as the sales import's
// own parseImportFile (web/.../sales/import/actions.ts) -- neither
// touches sales- or cost-specific tables, so this is a deliberate small
// duplication rather than a shared-lib extraction for a single other
// caller.
// ---------------------------------------------------------------------
export type ParseImportFileResult =
  | { error: string }
  | { error: null; fileName: string; headers: string[]; rows: Record<string, string>[] };

export async function parseImportFile(
  companyId: string,
  formData: FormData,
): Promise<ParseImportFileResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership || membership.company.country?.toUpperCase() !== "CL") {
    return { error: "Import is only available for Chile-based companies." };
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return { error: "Please choose a CSV file to upload." };
  }

  const text = await file.text();

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0) {
    return { error: "Could not parse this file as CSV. Please check its format." };
  }

  const headers = parsed.meta.fields ?? [];

  if (headers.length === 0 || parsed.data.length === 0) {
    return { error: "The file has no rows to import." };
  }

  return {
    error: null,
    fileName: file.name,
    headers,
    rows: parsed.data,
  };
}

export type ColumnMapping = {
  date: string;
  supplier: string;
  amount: string;
  currency: string | null;
  tax: string | null;
  taxId: string | null;
};

export type CommitImportResult =
  | { error: string }
  | {
      error: null;
      totalRows: number;
      importedRows: number;
      errorRows: number;
      duplicateRows: number;
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
): Promise<{ error: string | null; supplier: { id: string; name: string } | null }> {
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
    .insert({ company_id: companyId, name, tax_id: taxId?.trim() || null })
    .select("id, name")
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
): Promise<CommitImportResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership || membership.company.country?.toUpperCase() !== "CL") {
    return { error: "Import is only available for Chile-based companies." };
  }

  if (rows.length === 0) {
    return { error: "There are no rows to import." };
  }

  const suppliers = await getSuppliers(companyId);
  const activeSuppliersByName = new Map(
    suppliers
      .filter((supplier) => supplier.active)
      .map((supplier) => [normalizeSupplierName(supplier.name), supplier.id]),
  );

  const supabase = await createClient();

  // Default behavior, mirroring sales import's unresolved-client
  // handling: a CSV supplier name that doesn't match any active
  // supplier gets its own supplier created automatically with that
  // exact name, rather than failing the row.
  const unresolvedNamesByKey = new Map<string, { rawName: string; taxId: string | null }>();
  for (const row of rows) {
    const rawName = row[mapping.supplier]?.trim() ?? "";
    if (!rawName) continue;
    const key = normalizeSupplierName(rawName);
    if (activeSuppliersByName.has(key)) continue;
    if (!unresolvedNamesByKey.has(key)) {
      const taxId = mapping.taxId ? (row[mapping.taxId]?.trim() ?? "") : "";
      unresolvedNamesByKey.set(key, { rawName, taxId: taxId || null });
    }
  }

  if (unresolvedNamesByKey.size > 0) {
    const { data: createdSuppliers, error: createSuppliersError } = await supabase
      .from("suppliers")
      .insert(
        Array.from(unresolvedNamesByKey.values()).map(({ rawName, taxId }) => ({
          company_id: companyId,
          name: rawName,
          tax_id: taxId,
        })),
      )
      .select("id, name");

    if (createSuppliersError) {
      console.error(createSuppliersError);
    } else if (createdSuppliers) {
      for (const supplier of createdSuppliers) {
        activeSuppliersByName.set(normalizeSupplierName(supplier.name), supplier.id);
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
    const supplierId = supplierNameRaw
      ? (activeSuppliersByName.get(normalizeSupplierName(supplierNameRaw)) ?? null)
      : null;

    const documentDate = parseCsvDate(row[mapping.date]);
    const amount = parseAmount(row[mapping.amount]);
    const currency =
      mapping.currency && row[mapping.currency]?.trim()
        ? row[mapping.currency].trim()
        : membership.company.currency;
    const tax = mapping.tax ? parseTaxAmount(row[mapping.tax]) : { value: 0, error: null };

    return {
      row_number: rowNumber,
      raw_data: row,
      supplier_id: supplierId,
      document_date: documentDate,
      currency,
      amount: amount.kind === "ok" ? amount.value : null,
      tax_amount: tax.value ?? 0,
      force: forcedRowNumberSet.has(rowNumber),
      link_to_cost_document_id: linkedRowNumbers[rowNumber] ?? null,
      rejection:
        amount.kind === "invalid" ? `Importe inválido ${amount.reason}` : (tax.error as string | null),
    };
  });

  // Rows whose amount or tax cannot be read are not sent to the database: it
  // would only say "Invalid or missing amount" (or, for the tax, read it as 0 and
  // go on). They are kept in the batch with the real reason.
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

  const resultByRowNumber = new Map(
    (importedRowsData as { row_number: number; status: string; error_message: string | null }[]).map(
      (row) => [row.row_number, row],
    ),
  );

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
    rowResults,
  };
}
