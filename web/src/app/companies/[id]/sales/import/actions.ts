"use server";

import { createClient } from "@/lib/supabase/server";
import { getCompanyForEdit, getClients, getClientAliases } from "@/lib/dal";
import { parseCsvDate } from "@/lib/csvDate";
import { parseAmount, parseTaxAmount } from "@/lib/amounts";
import { companyConfig } from "@/lib/companyConfig";
import { parsePaymentStatusCell, resolveRowCurrency } from "@/lib/genericImport";
import { parseTabularFile } from "@/lib/importFile";

// ---------------------------------------------------------------------
// parseImportFile: reads the uploaded CSV or Excel and returns its
// headers + rows for client-side column mapping. No DB writes -- the
// file itself is never persisted, only the parsed rows travel back to
// the client (see spec Code Map: "avoids re-uploading the file or
// persisting an in-progress import"). Every company can import: what
// differs (currency) comes from its configuration (lib/companyConfig.ts).
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
  taxId: string | null;
  /** Folio / N° de documento: identifies the invoice (an existing one is never imported twice). */
  documentNumber?: string | null;
  /** Pagada / impaga: overwrites the status stored, even one changed by hand. */
  paymentStatus?: string | null;
  paidAt?: string | null;
};

export type ImportRowStatus = "imported" | "error" | "duplicate" | "updated";

export type CommitImportResult =
  | { error: string }
  | {
      error: null;
      totalRows: number;
      importedRows: number;
      errorRows: number;
      duplicateRows: number;
      updatedRows: number;
      rowResults: {
        rowNumber: number;
        status: ImportRowStatus;
        message: string | null;
      }[];
    };

function normalizeClientName(raw: string): string {
  return raw.trim().toLowerCase();
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
  taxId: string | null = null,
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
    .insert({ company_id: companyId, name, tax_id: taxId?.trim() || null })
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
  /** Currency of every row when no column says it (companies with more than one). */
  fileCurrency: string | null = null,
): Promise<CommitImportResult> {
  const membership = await getCompanyForEdit(companyId);

  if (!membership) {
    return { error: "No tenés acceso a esta empresa." };
  }

  if (rows.length === 0) {
    return { error: "No hay filas para importar." };
  }

  const config = companyConfig(membership.company);

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

  // Default behavior: a CSV client name that still doesn't resolve
  // (no exact match, no alias, no manual assignment) gets its own
  // client created automatically rather than failing the row with
  // "Client not found". Created with the literal CSV name, so it
  // needs no alias entry -- a later import of the same name matches
  // it directly via the exact-name lookup above.
  const unresolvedNamesByKey = new Map<string, { rawName: string; taxId: string | null }>();
  for (const row of rows) {
    const rawName = row[mapping.client]?.trim() ?? "";
    if (!rawName) continue;
    const key = normalizeClientName(rawName);
    if (activeClientsByName.has(key) || clientIdByAlias.has(key)) continue;
    if (!unresolvedNamesByKey.has(key)) {
      const taxId = mapping.taxId ? (row[mapping.taxId]?.trim() ?? "") : "";
      unresolvedNamesByKey.set(key, { rawName, taxId: taxId || null });
    }
  }

  if (unresolvedNamesByKey.size > 0) {
    const { data: createdClients, error: createClientsError } = await supabase
      .from("clients")
      .insert(
        Array.from(unresolvedNamesByKey.values()).map(({ rawName, taxId }) => ({
          company_id: companyId,
          name: rawName,
          tax_id: taxId,
        })),
      )
      .select("id, name");

    if (createClientsError) {
      console.error(createClientsError);
    } else if (createdClients) {
      for (const client of createdClients) {
        activeClientsByName.set(normalizeClientName(client.name), client.id);
      }
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
    const currency = resolveRowCurrency(
      config,
      mapping.currency ? row[mapping.currency] : null,
      fileCurrency ?? (config.documentCurrencies.length === 1 ? config.documentCurrencies[0] : null),
    );
    const tax = mapping.tax ? parseTaxAmount(row[mapping.tax]) : { value: 0, error: null };
    const documentNumber = mapping.documentNumber ? (row[mapping.documentNumber]?.trim() ?? "") : "";
    const paymentStatus = parsePaymentStatusCell(mapping.paymentStatus ? row[mapping.paymentStatus] : null);
    const rawPaidAt = mapping.paidAt ? (row[mapping.paidAt]?.trim() ?? "") : "";
    const paidAt = rawPaidAt ? parseCsvDate(rawPaidAt) : null;

    const rejection =
      amount.kind === "invalid"
        ? `Importe inválido ${amount.reason}`
        : tax.error
          ? tax.error
          : currency.kind === "invalid"
            ? `Moneda inválida: ${currency.reason}`
            : paymentStatus.kind === "invalid"
              ? `Estado de pago inválido: ${paymentStatus.reason}`
              : rawPaidAt && !paidAt
                ? `Fecha de pago inválida: "${rawPaidAt}"`
                : null;

    return {
      row_number: rowNumber,
      raw_data: row,
      client_id: clientId,
      document_date: documentDate,
      currency: currency.kind === "ok" ? currency.value : null,
      amount: amount.kind === "ok" ? amount.value : null,
      tax_amount: tax.value ?? 0,
      document_number: documentNumber || null,
      payment_status: paymentStatus.kind === "ok" ? paymentStatus.value : null,
      paid_at: paidAt,
      force: forcedRowNumberSet.has(rowNumber),
      rejection,
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
    "import_sales_rows_batch",
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
    const { error: rejectedError } = await supabase.from("import_rows").insert(
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
    status: ImportRowStatus;
    message: string | null;
  }[] = batchRows.map(({ row_number: rowNumber }) => {
    const rejection = rejectionByRow.get(rowNumber);
    if (rejection) return { rowNumber, status: "error" as const, message: rejection };
    const result = resultByRowNumber.get(rowNumber);
    // Should always be present -- the batch RPC returns exactly one
    // import_rows entry per input row (its own exception handler
    // guarantees that even an unexpected per-row error still returns
    // an 'error' entry). Falling back to 'error' here is defense in
    // depth only, matching the old per-row RPC-failure fallback.
    return {
      rowNumber,
      status: (result?.status as ImportRowStatus) ?? "error",
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

  const updatedRows =
    updatedBatch?.updated_rows ??
    rowResults.filter((r) => r.status === "updated").length;

  return {
    error: null,
    totalRows: rows.length,
    importedRows,
    errorRows,
    duplicateRows,
    updatedRows,
    rowResults,
  };
}
