"use server";

import Papa from "papaparse";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getClients } from "@/lib/dal";

// ---------------------------------------------------------------------
// parseImportFile: reads the uploaded CSV and returns its headers +
// rows for client-side column mapping. No DB writes -- the file itself
// is never persisted, only the parsed rows travel back to the client
// (see spec Code Map: "avoids re-uploading the file or persisting an
// in-progress import").
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

// ---------------------------------------------------------------------
// commitImport: takes the already-parsed rows + the user's column
// mapping, resolves each row's client name and validates its
// date/amount, then commits via create_import_batch + import_sales_row
// per row (row-level partial commit -- valid rows import even if
// others in the same file fail).
// ---------------------------------------------------------------------
export type ColumnMapping = {
  date: string;
  client: string;
  amount: string;
  currency: string | null;
  tax: string | null;
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

function parseDate(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  const trimmed = raw.trim();
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  // Normalize to YYYY-MM-DD for the `date` column.
  return date.toISOString().slice(0, 10);
}

function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const cleaned = raw.replace(/[,\s]/g, "");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) {
    return null;
  }
  return amount;
}

export async function commitImport(
  companyId: string,
  fileName: string,
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  forcedRowNumbers: number[] = [],
): Promise<CommitImportResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership || membership.company.country?.toUpperCase() !== "CL") {
    return { error: "Import is only available for Chile-based companies." };
  }

  if (rows.length === 0) {
    return { error: "There are no rows to import." };
  }

  const clients = await getClients(companyId);
  const activeClientsByName = new Map(
    clients
      .filter((client) => client.active)
      .map((client) => [client.name.trim().toLowerCase(), client.id]),
  );

  const supabase = await createClient();

  const { data: batch, error: batchError } = await supabase.rpc(
    "create_import_batch",
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

  const rowResults: {
    rowNumber: number;
    status: "imported" | "error" | "duplicate";
    message: string | null;
  }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1;

    const clientNameRaw = row[mapping.client]?.trim() ?? "";
    const clientId = clientNameRaw
      ? (activeClientsByName.get(clientNameRaw.toLowerCase()) ?? null)
      : null;

    const documentDate = parseDate(row[mapping.date]);
    const amount = parseAmount(row[mapping.amount]);
    const currency =
      mapping.currency && row[mapping.currency]?.trim()
        ? row[mapping.currency].trim()
        : membership.company.currency;
    const taxAmount = mapping.tax
      ? (parseAmount(row[mapping.tax]) ?? 0)
      : 0;

    const { data: importRow, error: rowError } = await supabase.rpc(
      "import_sales_row",
      {
        p_import_batch_id: batch.id,
        p_row_number: rowNumber,
        p_raw_data: row,
        p_client_id: clientId,
        p_document_date: documentDate,
        p_currency: currency,
        p_amount: amount,
        p_tax_amount: taxAmount,
        p_force: forcedRowNumberSet.has(rowNumber),
      },
    );

    if (rowError || !importRow) {
      // A structural failure (e.g. malformed call) -- record it as a
      // local error result so the loop keeps going for the rest of the
      // file; the batch's counts are still recomputed from what
      // actually landed in import_rows.
      console.error(rowError);
      rowResults.push({
        rowNumber,
        status: "error",
        message: "Unexpected error processing this row.",
      });
      continue;
    }

    rowResults.push({
      rowNumber,
      status: importRow.status,
      message: importRow.error_message,
    });
  }

  const { data: updatedBatch, error: countsError } = await supabase.rpc(
    "update_import_batch_counts",
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
