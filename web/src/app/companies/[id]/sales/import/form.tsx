"use client";

import Link from "next/link";
import { useMemo, useState, type ChangeEvent } from "react";
import {
  parseImportFile,
  commitImport,
  type ColumnMapping,
  type CommitImportResult,
} from "./actions";

type Step = "upload" | "map" | "preview" | "done";

const FIELD_LABELS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: "date", label: "Date", required: true },
  { key: "client", label: "Client", required: true },
  { key: "amount", label: "Amount", required: true },
  { key: "currency", label: "Currency", required: false },
  { key: "tax", label: "Tax amount", required: false },
];

function parseDatePreview(raw: string | undefined): boolean {
  if (!raw || !raw.trim()) return false;
  return !Number.isNaN(new Date(raw.trim()).getTime());
}

// Mirrors actions.ts's parseDate -- normalizes to YYYY-MM-DD so the
// preview's duplicate check compares against existingDocuments'
// document_date using the same shape the server-side check will see.
function parseDateIso(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseAmountPreview(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const amount = Number(raw.replace(/[,\s]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

type ExistingDocument = {
  client_id: string;
  document_date: string;
  total_amount: number;
};

export function ImportSalesForm({
  companyId,
  defaultCurrency,
  activeClients,
  existingDocuments,
}: {
  companyId: string;
  defaultCurrency: string;
  activeClients: { id: string; name: string }[];
  existingDocuments: ExistingDocument[];
}) {
  const activeClientsByNameLower = useMemo(
    () =>
      new Map(
        activeClients.map((client) => [client.name.trim().toLowerCase(), client.id]),
      ),
    [activeClients],
  );
  const activeClientNamesLower = useMemo(
    () => new Set(activeClientsByNameLower.keys()),
    [activeClientsByNameLower],
  );
  const [forcedRowNumbers, setForcedRowNumbers] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);

  const [mapping, setMapping] = useState<ColumnMapping>({
    date: "",
    client: "",
    amount: "",
    currency: null,
    tax: null,
  });

  const [result, setResult] = useState<CommitImportResult | null>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setPending(true);

    const formData = new FormData();
    formData.set("file", file);

    const parsed = await parseImportFile(companyId, formData);

    setPending(false);

    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }

    setFileName(parsed.fileName);
    setHeaders(parsed.headers);
    setRows(parsed.rows);

    // Best-effort auto-map by header name, so the user usually just
    // confirms rather than picking every field from scratch.
    const guess = (candidates: string[]) =>
      parsed.headers.find((h) => candidates.includes(h.trim().toLowerCase())) ?? "";

    setMapping({
      date: guess(["date", "fecha"]),
      client: guess(["client", "cliente", "customer"]),
      amount: guess(["amount", "monto", "importe", "net_amount"]),
      currency: guess(["currency", "moneda"]) || null,
      tax: guess(["tax", "iva", "tax_amount"]) || null,
    });

    setStep("map");
  }

  const mappingComplete = mapping.date && mapping.client && mapping.amount;

  const previewRows = useMemo(() => {
    return rows.map((row, index) => {
      const dateOk = parseDatePreview(row[mapping.date]);
      const dateIso = parseDateIso(row[mapping.date]);
      const amount = parseAmountPreview(row[mapping.amount]);
      const clientName = row[mapping.client]?.trim() ?? "";
      const clientId = clientName
        ? (activeClientsByNameLower.get(clientName.toLowerCase()) ?? null)
        : null;
      const currency =
        (mapping.currency && row[mapping.currency]?.trim()) || defaultCurrency;
      const tax = mapping.tax ? (parseAmountPreview(row[mapping.tax]) ?? 0) : 0;

      const issues: string[] = [];
      if (!clientName) issues.push("Missing client");
      else if (!activeClientNamesLower.has(clientName.toLowerCase()))
        issues.push("Client not found");
      if (!dateOk) issues.push("Invalid date");
      if (amount === null || amount <= 0) issues.push("Invalid amount");

      // Client-side duplicate heuristic -- only a preview convenience;
      // the server-side check inside import_sales_row is the actual
      // enforcement (see spec Design Notes). Only checked once the row
      // is otherwise valid (client resolved, date and amount parse).
      let isDuplicate = false;
      if (clientId && dateIso && amount !== null && amount > 0) {
        const total = round2(amount + tax);
        isDuplicate = existingDocuments.some(
          (doc) =>
            doc.client_id === clientId &&
            doc.document_date === dateIso &&
            round2(doc.total_amount) === total,
        );
      }

      return {
        rowNumber: index + 1,
        clientName,
        clientId,
        date: row[mapping.date],
        amount,
        currency,
        tax,
        issues,
        isDuplicate,
      };
    });
  }, [rows, mapping, defaultCurrency, activeClientNamesLower, activeClientsByNameLower, existingDocuments]);

  const invalidCount = previewRows.filter((r) => r.issues.length > 0).length;
  const duplicateCount = previewRows.filter(
    (r) => r.issues.length === 0 && r.isDuplicate,
  ).length;

  function toggleForced(rowNumber: number) {
    setForcedRowNumbers((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  async function handleCommit() {
    setPending(true);
    setError(null);
    const res = await commitImport(
      companyId,
      fileName,
      rows,
      mapping,
      Array.from(forcedRowNumbers),
    );
    setPending(false);

    if (res.error !== null) {
      setError(res.error);
      return;
    }

    setResult(res);
    setStep("done");
  }

  if (step === "done" && result && result.error === null) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <p className="font-medium text-black dark:text-zinc-50">
            Import complete
          </p>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            {result.importedRows} of {result.totalRows} rows imported.{" "}
            {result.duplicateRows} row{result.duplicateRows === 1 ? "" : "s"} skipped
            as duplicates. {result.errorRows} row
            {result.errorRows === 1 ? "" : "s"} had errors.
          </p>
        </div>
        {result.errorRows > 0 ? (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              Error rows
            </span>
            <ul className="flex flex-col gap-1">
              {result.rowResults
                .filter((r) => r.status === "error")
                .map((r) => (
                  <li key={r.rowNumber} className="text-red-600 dark:text-red-400">
                    Row {r.rowNumber}: {r.message}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        <Link
          href={`/companies/${companyId}/sales`}
          className="flex h-10 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Back to sales documents
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {step === "upload" ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="file"
            className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            CSV file
          </label>
          <input
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            disabled={pending}
            className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
          />
        </div>
      ) : null}

      {step === "map" || step === "preview" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {fileName} &middot; {rows.length} row{rows.length === 1 ? "" : "s"}
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELD_LABELS.map(({ key, label, required }) => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  {label}
                  {required ? " *" : " (optional)"}
                </label>
                <select
                  value={mapping[key] ?? ""}
                  onChange={(event) =>
                    setMapping((prev) => ({
                      ...prev,
                      [key]: event.target.value || null,
                    }))
                  }
                  className="rounded border border-black/[.08] bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 dark:border-white/[.145] dark:text-zinc-50"
                >
                  <option value="">
                    {required ? "Select a column" : "Not mapped"}
                  </option>
                  {headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {step === "map" ? (
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                disabled={!mappingComplete}
                onClick={() => setStep("preview")}
                className="flex h-10 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
              >
                Preview
              </button>
              <Link
                href={`/companies/${companyId}/sales`}
                className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
              >
                Cancel
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "preview" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {previewRows.length - invalidCount} row
            {previewRows.length - invalidCount === 1 ? "" : "s"} will import,{" "}
            {invalidCount} row{invalidCount === 1 ? "" : "s"} will be skipped
            with errors.
            {duplicateCount > 0
              ? ` ${duplicateCount} possible duplicate${
                  duplicateCount === 1 ? "" : "s"
                } flagged (skipped by default unless forced).`
              : ""}
          </p>
          <div className="max-h-96 overflow-auto rounded-md border border-black/[.08] dark:border-white/[.145]">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    #
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Client
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Date
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Amount
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Currency
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Tax
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Status
                  </th>
                  <th className="px-3 py-2 font-medium text-zinc-600 dark:text-zinc-400">
                    Force import
                  </th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr
                    key={row.rowNumber}
                    className={
                      row.issues.length > 0
                        ? "bg-red-50 dark:bg-red-950/40"
                        : row.isDuplicate
                          ? "bg-amber-50 dark:bg-amber-950/40"
                          : undefined
                    }
                  >
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-500">
                      {row.rowNumber}
                    </td>
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {row.clientName || "—"}
                    </td>
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {row.date || "—"}
                    </td>
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {row.amount ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {row.currency}
                    </td>
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {row.tax}
                    </td>
                    <td className="px-3 py-2">
                      {row.issues.length > 0 ? (
                        <span className="text-xs font-medium text-red-600 dark:text-red-400">
                          {row.issues.join(", ")}
                        </span>
                      ) : row.isDuplicate ? (
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                          Possible duplicate
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.issues.length === 0 && row.isDuplicate ? (
                        <input
                          type="checkbox"
                          checked={forcedRowNumbers.has(row.rowNumber)}
                          onChange={() => toggleForced(row.rowNumber)}
                          aria-label={`Force import row ${row.rowNumber}`}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              disabled={pending}
              onClick={handleCommit}
              className="flex h-10 items-center justify-center rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-60 dark:hover:bg-[#ccc]"
            >
              {pending ? "Importing..." : "Commit import"}
            </button>
            <button
              type="button"
              onClick={() => setStep("map")}
              className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              Back to mapping
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
