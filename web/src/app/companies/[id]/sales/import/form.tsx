"use client";

import Link from "next/link";
import { useMemo, useState, type ChangeEvent } from "react";
import {
  parseImportFile,
  commitImport,
  createClientForImport,
  type ColumnMapping,
  type CommitImportResult,
  type ClientAssignment,
} from "./actions";
import { parseCsvDate } from "@/lib/csvDate";
import { Button, LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { fieldInput, fieldLabel } from "@/components/FormField";

type Step = "upload" | "map" | "preview" | "done";

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "1 ARCHIVO" },
  { key: "map", label: "2 MAPEO" },
  { key: "preview", label: "3 PREVISUALIZACIÓN" },
];

const FIELD_LABELS: { key: keyof ColumnMapping; label: string; required: boolean }[] = [
  { key: "date", label: "Fecha", required: true },
  { key: "client", label: "Cliente", required: true },
  { key: "amount", label: "Importe", required: true },
  { key: "currency", label: "Moneda", required: false },
  { key: "tax", label: "IVA", required: false },
];

function normalizeClientName(raw: string): string {
  return raw.trim().toLowerCase();
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
  clientAliases,
  existingDocuments,
}: {
  companyId: string;
  defaultCurrency: string;
  activeClients: { id: string; name: string }[];
  clientAliases: { externalName: string; clientId: string }[];
  existingDocuments: ExistingDocument[];
}) {
  // Clients known this session: the ones passed in from the server,
  // plus any created inline from the "cliente no encontrado" prompt
  // below (so they show up immediately without a full page reload).
  const [knownClients, setKnownClients] = useState(activeClients);
  const knownClientsByNameLower = useMemo(
    () => new Map(knownClients.map((client) => [normalizeClientName(client.name), client.id])),
    [knownClients],
  );
  // company_id-scoped aliases from prior imports: CSV name -> client_id,
  // already normalized (trimmed + lowercased) server-side.
  const aliasClientIdByName = useMemo(
    () => new Map(clientAliases.map((a) => [a.externalName, a.clientId])),
    [clientAliases],
  );
  // This session's own "assign this CSV name to this client" choices,
  // made in the preview step for names that matched neither an active
  // client nor an existing alias. Keyed by normalized CSV name.
  const [assignments, setAssignments] = useState<Map<string, ClientAssignment>>(new Map());

  const resolveClientId = (rawName: string): string | null => {
    const key = normalizeClientName(rawName);
    if (!key) return null;
    return (
      knownClientsByNameLower.get(key) ??
      aliasClientIdByName.get(key) ??
      assignments.get(key)?.clientId ??
      null
    );
  };

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
    // confirms rather than picking every field from scratch. Candidates
    // are tried in priority order (not header order), so e.g. the
    // Chilean export's "Monto neto"/"Monto IVA" columns win over a
    // more generic "monto" match when both are present.
    const headersLower = parsed.headers.map((h) => [h, h.trim().toLowerCase()] as const);
    const guess = (candidates: string[]) => {
      for (const candidate of candidates) {
        const match = headersLower.find(([, lower]) => lower === candidate);
        if (match) return match[0];
      }
      return "";
    };

    setMapping({
      date: guess(["date", "fecha"]),
      client: guess(["client", "cliente", "customer"]),
      amount: guess(["monto neto", "amount", "monto", "importe", "net_amount"]),
      currency: guess(["currency", "moneda"]) || null,
      tax: guess(["monto iva", "tax", "iva", "tax_amount"]) || null,
    });

    setStep("map");
  }

  const mappingComplete = mapping.date && mapping.client && mapping.amount;

  const previewRows = useMemo(() => {
    return rows.map((row, index) => {
      const dateIso = parseCsvDate(row[mapping.date]);
      const amount = parseAmountPreview(row[mapping.amount]);
      const clientName = row[mapping.client]?.trim() ?? "";
      const clientId = clientName ? resolveClientId(clientName) : null;
      const currency =
        (mapping.currency && row[mapping.currency]?.trim()) || defaultCurrency;
      const tax = mapping.tax ? (parseAmountPreview(row[mapping.tax]) ?? 0) : 0;

      // A name that matches neither an existing client, an alias, nor
      // this session's manual assignments isn't a blocking error -- by
      // default the import creates a client with that exact name (see
      // commitImport). It only shows a non-blocking "Cliente nuevo"
      // badge below so the user can still redirect it to an existing
      // client first if it's actually a near-duplicate/typo.
      const willCreateClient = Boolean(clientName) && !clientId;

      const issues: string[] = [];
      if (!clientName) issues.push("Falta cliente");
      if (!dateIso) issues.push("Fecha inválida");
      if (amount === null || amount <= 0) issues.push("Importe inválido");

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
        willCreateClient,
        date: row[mapping.date],
        amount,
        currency,
        tax,
        issues,
        isDuplicate,
      };
    });
  }, [rows, mapping, defaultCurrency, knownClientsByNameLower, aliasClientIdByName, assignments, existingDocuments]);

  const invalidCount = previewRows.filter((r) => r.issues.length > 0).length;
  const duplicateCount = previewRows.filter(
    (r) => r.issues.length === 0 && r.isDuplicate,
  ).length;
  const importCount = previewRows.length - invalidCount;

  // Distinct unmatched client names across the file -- ask once per
  // name rather than once per row, since the same wrong/unknown name
  // typically repeats across many rows of the same export.
  const unmatchedClientNames = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const row of previewRows) {
      if (row.willCreateClient && !byKey.has(normalizeClientName(row.clientName))) {
        byKey.set(normalizeClientName(row.clientName), row.clientName);
      }
    }
    return Array.from(byKey.entries()).map(([key, rawName]) => ({ key, rawName }));
  }, [previewRows]);

  const [creatingClientFor, setCreatingClientFor] = useState<string | null>(null);
  const [newClientNames, setNewClientNames] = useState<Map<string, string>>(new Map());
  const [assignError, setAssignError] = useState<string | null>(null);

  function assignExistingClient(rawName: string, clientId: string) {
    if (!clientId) {
      setAssignments((prev) => {
        const next = new Map(prev);
        next.delete(normalizeClientName(rawName));
        return next;
      });
      return;
    }
    setAssignments((prev) => {
      const next = new Map(prev);
      next.set(normalizeClientName(rawName), { rawName, clientId });
      return next;
    });
  }

  async function handleCreateClient(rawName: string) {
    const name = (newClientNames.get(rawName) ?? rawName).trim();
    if (!name) return;

    setAssignError(null);
    setCreatingClientFor(rawName);
    const res = await createClientForImport(companyId, name);
    setCreatingClientFor(null);

    if (res.error !== null || !res.client) {
      setAssignError(res.error ?? "No se pudo crear el cliente.");
      return;
    }

    setKnownClients((prev) => [...prev, res.client!]);
    assignExistingClient(rawName, res.client.id);
  }

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
      Array.from(assignments.values()),
    );
    setPending(false);

    if (res.error !== null) {
      setError(res.error);
      return;
    }

    setResult(res);
    setStep("done");
  }

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  if (step === "done" && result && result.error === null) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-muted)] p-4 text-[13px]">
          <p className="font-semibold text-[var(--color-ink)]">
            Importación completa
          </p>
          <p className="mt-1 text-[var(--color-ink-2)]">
            {result.importedRows} de {result.totalRows} filas importadas.{" "}
            {result.duplicateRows} fila{result.duplicateRows === 1 ? "" : "s"} omitida
            {result.duplicateRows === 1 ? "" : "s"} como duplicado. {result.errorRows} fila
            {result.errorRows === 1 ? "" : "s"} con errores.
          </p>
        </div>
        {result.errorRows > 0 ? (
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="font-medium text-[var(--color-ink)]">
              Filas con error
            </span>
            <ul className="flex flex-col gap-1">
              {result.rowResults
                .filter((r) => r.status === "error")
                .map((r) => (
                  <li key={r.rowNumber} className="text-[var(--color-negative-ink)]">
                    Fila {r.rowNumber}: {r.message}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        <LinkButton href={`/companies/${companyId}/sales`} variant="primary">
          Volver a ventas
        </LinkButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-1.5">
        {STEPS.map((s, i) => (
          <span
            key={s.key}
            className={`rounded-md px-2.5 py-1 font-mono text-[10.5px] ${
              i < stepIndex
                ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-strong)]"
                : i === stepIndex
                  ? "bg-[var(--color-ink)] text-[#f2f2ef]"
                  : "bg-[var(--color-row)] text-[var(--color-muted)]"
            }`}
          >
            {s.label}
          </span>
        ))}
      </div>

      {step === "upload" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="file" className={fieldLabel}>
            Archivo CSV
          </label>
          <input
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            disabled={pending}
            className={fieldInput}
          />
        </div>
      ) : null}

      {step === "map" || step === "preview" ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13.5px] font-medium text-[var(--color-ink)]">
            {fileName}
            <span className="ml-1 font-mono text-[11.5px] font-normal text-[var(--color-muted)]">
              · {rows.length} fila{rows.length === 1 ? "" : "s"}
            </span>
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELD_LABELS.map(({ key, label, required }) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label className={fieldLabel}>
                  {label}
                  {required ? " *" : " (opcional)"}
                </label>
                <select
                  value={mapping[key] ?? ""}
                  onChange={(event) =>
                    setMapping((prev) => ({
                      ...prev,
                      [key]: event.target.value || null,
                    }))
                  }
                  className={fieldInput}
                >
                  <option value="">
                    {required ? "Elegí una columna" : "Sin mapear"}
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
              <Button
                type="button"
                disabled={!mappingComplete}
                onClick={() => setStep("preview")}
              >
                Previsualizar
              </Button>
              <Link
                href={`/companies/${companyId}/sales`}
                className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                Cancelar
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === "preview" ? (
        <div className="flex flex-col gap-3">
          {unmatchedClientNames.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-row)] p-4 text-[13px]">
              <p className="font-semibold text-[var(--color-ink)]">
                {unmatchedClientNames.length} cliente
                {unmatchedClientNames.length === 1 ? "" : "s"} del archivo no coincide
                {unmatchedClientNames.length === 1 ? "" : "n"} con ningún cliente existente
              </p>
              <p className="text-[var(--color-ink-2)]">
                Por defecto se van a crear como clientes nuevos con ese mismo nombre al
                importar. Si en realidad son un cliente que ya existe (variación de nombre,
                mayúsculas, etc.), asignalo acá para evitar duplicados -- la asociación
                queda guardada para que la próxima importación lo reconozca sola.
              </p>
              <div className="flex flex-col gap-2">
                {unmatchedClientNames.map(({ key, rawName }) => (
                  <div
                    key={key}
                    className="flex flex-col gap-1.5 rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] p-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-[13px] font-medium text-[var(--color-ink)]">
                      {rawName}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={assignments.get(key)?.clientId ?? ""}
                        onChange={(event) => assignExistingClient(rawName, event.target.value)}
                        className={fieldInput}
                      >
                        <option value="">Asignar a cliente existente…</option>
                        {knownClients.map((client) => (
                          <option key={client.id} value={client.id}>
                            {client.name}
                          </option>
                        ))}
                      </select>
                      <span className="text-[var(--color-muted)]">o</span>
                      <input
                        type="text"
                        defaultValue={rawName}
                        onChange={(event) =>
                          setNewClientNames((prev) => new Map(prev).set(rawName, event.target.value))
                        }
                        className={fieldInput}
                        aria-label={`Nombre del nuevo cliente para "${rawName}"`}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={creatingClientFor === rawName}
                        pending={creatingClientFor === rawName}
                        pendingLabel="Creando…"
                        onClick={() => handleCreateClient(rawName)}
                      >
                        Crear cliente
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {assignError ? (
                <p className="text-[var(--color-negative-ink)]" role="alert">
                  {assignError}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3 rounded-lg border border-[var(--color-hairline)] bg-[var(--color-surface-muted)] px-4 py-3 text-[12.5px]">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[var(--color-accent)]" />
              {importCount} se importan
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[var(--color-warning)]" />
              {duplicateCount} posibles duplicados
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-sm bg-[var(--color-negative)]" />
              {invalidCount} con errores
            </span>
          </div>
          <div className="max-h-96 overflow-auto rounded-[10px] border border-[var(--color-hairline)]">
            <table className="w-full text-left text-[13px]">
              <thead className="sticky top-0 bg-[var(--color-surface-muted)]">
                <tr>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">#</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Cliente</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Fecha</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Importe</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Moneda</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">IVA</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Estado</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Importar igual</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row) => (
                  <tr
                    key={row.rowNumber}
                    className={
                      row.issues.length > 0
                        ? "bg-[var(--color-negative-row)]"
                        : row.isDuplicate || row.willCreateClient
                          ? "bg-[var(--color-warning-row)]"
                          : undefined
                    }
                  >
                    <td className="border-t border-[var(--color-row)] px-3 py-2 font-mono text-[var(--color-faint)]">
                      {row.rowNumber}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 text-[var(--color-ink)]">
                      {row.clientName || "—"}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 font-mono text-[var(--color-ink)]">
                      {row.date || "—"}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 text-right font-mono text-[var(--color-ink)]">
                      {row.amount ?? "—"}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 font-mono text-[var(--color-ink)]">
                      {row.currency}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 text-right font-mono text-[var(--color-ink)]">
                      {row.tax}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2">
                      {row.issues.length > 0 ? (
                        <Badge variant="negative">{row.issues.join(", ")}</Badge>
                      ) : row.isDuplicate ? (
                        <Badge variant="warning">Posible duplicado</Badge>
                      ) : row.willCreateClient ? (
                        <Badge variant="warning">Cliente nuevo</Badge>
                      ) : (
                        <Badge variant="positive">OK</Badge>
                      )}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2">
                      {row.issues.length === 0 && row.isDuplicate ? (
                        <input
                          type="checkbox"
                          checked={forcedRowNumbers.has(row.rowNumber)}
                          onChange={() => toggleForced(row.rowNumber)}
                          aria-label={`Importar igual fila ${row.rowNumber}`}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center gap-3">
            <Button type="button" disabled={pending} onClick={handleCommit} pending={pending} pendingLabel="Importando…">
              Importar {importCount} filas
            </Button>
            <button
              type="button"
              onClick={() => setStep("map")}
              className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              Volver al mapeo
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="text-[13px] text-[var(--color-negative-ink)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
