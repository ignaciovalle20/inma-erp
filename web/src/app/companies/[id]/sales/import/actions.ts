"use server";

import Papa from "papaparse";
import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getClients, getClientAliases } from "@/lib/dal";
import { parseCsvDate } from "@/lib/csvDate";

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

function normalizeClientName(raw: string): string {
  return raw.trim().toLowerCase();
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

// A user-made "this CSV name means this existing client" decision from
// the preview step, for rows where no client matched by name or alias.
// Persisted to client_aliases below so a later re-import of the same
// source data resolves it automatically.
export type ClientAssignment = {
  rawName: string;
  clientId: string;
};

export async function createClientForImport(
  companyId: string,
  rawName: string,
): Promise<{ error: string | null; client: { id: string; name: string } | null }> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return { error: "No autorizado.", client: null };
  }

  const name = rawName.trim();

  if (!name) {
    return { error: "El nombre del cliente es obligatorio.", client: null };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({ company_id: companyId, name })
    .select("id, name")
    .single();

  if (error || !data) {
    console.error(error);
    return { error: "No se pudo crear el cliente.", client: null };
  }

  return { error: null, client: data };
}

export async function commitImport(
  companyId: string,
  fileName: string,
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  forcedRowNumbers: number[] = [],
  clientAssignments: ClientAssignment[] = [],
): Promise<CommitImportResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership || membership.company.country?.toUpperCase() !== "CL") {
    return { error: "Import is only available for Chile-based companies." };
  }

  if (rows.length === 0) {
    return { error: "There are no rows to import." };
  }

  const clients = await getClients(companyId);
  const activeClientIds = new Set(
    clients.filter((client) => client.active).map((client) => client.id),
  );
  const activeClientsByName = new Map(
    clients
      .filter((client) => client.active)
      .map((client) => [normalizeClientName(client.name), client.id]),
  );

  const aliases = await getClientAliases(companyId);
  const clientIdByAlias = new Map(
    aliases
      .filter((alias) => activeClientIds.has(alias.client_id))
      .map((alias) => [alias.external_name, alias.client_id]),
  );

  // User assignments from the preview step take precedence over
  // whatever alias may already exist (they're how a wrong alias gets
  // corrected), and get persisted below so future imports reuse them.
  const validAssignments = clientAssignments.filter((a) =>
    activeClientIds.has(a.clientId),
  );
  for (const assignment of validAssignments) {
    clientIdByAlias.set(normalizeClientName(assignment.rawName), assignment.clientId);
  }

  const supabase = await createClient();

  if (validAssignments.length > 0) {
    const { error: aliasError } = await supabase.from("client_aliases").upsert(
      validAssignments.map((a) => ({
        company_id: companyId,
        external_name: normalizeClientName(a.rawName),
        client_id: a.clientId,
      })),
      { onConflict: "company_id,external_name" },
    );

    if (aliasError) {
      console.error(aliasError);
    }
  }

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

  // Resolve + parse every row in JS first (no DB access here), then
  // commit the whole file in one round trip via import_sales_rows_batch
  // -- one PL/pgSQL loop server-side instead of one RPC call per row.
  // See that function's migration comment for how it preserves
  // row-level partial commit and same-file duplicate detection despite
  // running in a single transaction.
  const batchRows = rows.map((row, i) => {
    const rowNumber = i + 1;
    const clientNameRaw = row[mapping.client]?.trim() ?? "";
    const clientId = clientNameRaw
      ? (activeClientsByName.get(normalizeClientName(clientNameRaw)) ??
        clientIdByAlias.get(normalizeClientName(clientNameRaw)) ??
        null)
      : null;

    const documentDate = parseCsvDate(row[mapping.date]);
    const amount = parseAmount(row[mapping.amount]);
    const currency =
      mapping.currency && row[mapping.currency]?.trim()
        ? row[mapping.currency].trim()
        : membership.company.currency;
    const taxAmount = mapping.tax
      ? (parseAmount(row[mapping.tax]) ?? 0)
      : 0;

    return {
      row_number: rowNumber,
      raw_data: row,
      client_id: clientId,
      document_date: documentDate,
      currency,
      amount,
      tax_amount: taxAmount,
      force: forcedRowNumberSet.has(rowNumber),
    };
  });

  const { data: importedRowsData, error: batchRowsError } = await supabase.rpc(
    "import_sales_rows_batch",
    {
      p_import_batch_id: batch.id,
      p_rows: batchRows,
    },
  );

  if (batchRowsError || !importedRowsData) {
    console.error(batchRowsError);
    return { error: "Could not commit the import. Please try again." };
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
    const result = resultByRowNumber.get(rowNumber);
    // Should always be present -- the batch RPC returns exactly one
    // import_rows entry per input row (its own exception handler
    // guarantees that even an unexpected per-row error still returns
    // an 'error' entry). Falling back to 'error' here is defense in
    // depth only, matching the old per-row RPC-failure fallback.
    return {
      rowNumber,
      status: (result?.status as "imported" | "error" | "duplicate") ?? "error",
      message: result?.error_message ?? (result ? null : "Unexpected error processing this row."),
    };
  });

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
