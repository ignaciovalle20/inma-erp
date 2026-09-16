"use client";

import Link from "next/link";
import { useMemo, useState, type ChangeEvent } from "react";
import {
  parseImportFile,
  commitImport,
  createSupplierForImport,
  type ColumnMapping,
  type CommitImportResult,
} from "./actions";
import { parseCsvDate } from "@/lib/csvDate";
import type { ProvisionalCostDocument } from "@/lib/dal";
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
  { key: "supplier", label: "Proveedor", required: true },
  { key: "taxId", label: "RUT proveedor", required: false },
  { key: "amount", label: "Importe neto", required: true },
  { key: "currency", label: "Moneda", required: false },
  { key: "tax", label: "IVA", required: false },
];

function normalizeSupplierName(raw: string): string {
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
  supplier_id: string | null;
  document_date: string;
  total_amount: number;
};

export function ImportCostsForm({
  companyId,
  defaultCurrency,
  activeSuppliers,
  existingDocuments,
  provisionalCosts,
}: {
  companyId: string;
  defaultCurrency: string;
  activeSuppliers: { id: string; name: string }[];
  existingDocuments: ExistingDocument[];
  provisionalCosts: ProvisionalCostDocument[];
}) {
  // Suppliers known this session: the ones passed from the server, plus
  // any created inline from the "proveedor no encontrado" prompt below.
  // No persisted alias table for suppliers (unlike sales' client_aliases)
  // -- this session-only map covers the "same import file" case; a
  // future import of the same source still needs its exact name to
  // match, or a manual re-assignment here.
  const [knownSuppliers, setKnownSuppliers] = useState(activeSuppliers);
  const knownSuppliersByNameLower = useMemo(
    () => new Map(knownSuppliers.map((s) => [normalizeSupplierName(s.name), s.id])),
    [knownSuppliers],
  );
  const [assignments, setAssignments] = useState<Map<string, string>>(new Map());

  const resolveSupplierId = (rawName: string): string | null => {
    const key = normalizeSupplierName(rawName);
    if (!key) return null;
    return knownSuppliersByNameLower.get(key) ?? assignments.get(key) ?? null;
  };

  const [forcedRowNumbers, setForcedRowNumbers] = useState<Set<number>>(new Set());
  // Row number -> cost_document_id to link instead of creating a new
  // document. A linked row always wins over the duplicate/new-supplier
  // heuristics below (see import_cost_rows_batch's own precedence).
  const [linkedRows, setLinkedRows] = useState<Map<number, string>>(new Map());
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);

  const [mapping, setMapping] = useState<ColumnMapping>({
    date: "",
    supplier: "",
    amount: "",
    currency: null,
    tax: null,
    taxId: null,
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
      supplier: guess(["supplier", "proveedor", "razon social", "razón social"]),
      amount: guess(["monto neto", "amount", "monto", "importe", "net_amount", "neto"]),
      currency: guess(["currency", "moneda"]) || null,
      tax: guess(["monto iva", "tax", "iva", "tax_amount"]) || null,
      taxId: guess(["rut proveedor", "rut", "tax_id", "tax id"]) || null,
    });

    setStep("map");
  }

  const mappingComplete = mapping.date && mapping.supplier && mapping.amount;

  const previewRows = useMemo(() => {
    return rows.map((row, index) => {
      const rowNumber = index + 1;
      const dateIso = parseCsvDate(row[mapping.date]);
      const amount = parseAmountPreview(row[mapping.amount]);
      const supplierName = row[mapping.supplier]?.trim() ?? "";
      const supplierId = supplierName ? resolveSupplierId(supplierName) : null;
      const supplierTaxId = mapping.taxId ? (row[mapping.taxId]?.trim() ?? "") : "";
      const currency =
        (mapping.currency && row[mapping.currency]?.trim()) || defaultCurrency;
      const tax = mapping.tax ? (parseAmountPreview(row[mapping.tax]) ?? 0) : 0;

      const willCreateSupplier = Boolean(supplierName) && !supplierId;

      const issues: string[] = [];
      if (!supplierName) issues.push("Falta proveedor");
      if (!dateIso) issues.push("Fecha inválida");
      if (amount === null || amount <= 0) issues.push("Importe inválido");

      const linkedTo = linkedRows.get(rowNumber) ?? null;

      let isDuplicate = false;
      if (!linkedTo && supplierId && dateIso && amount !== null && amount > 0) {
        const total = round2(amount + tax);
        isDuplicate = existingDocuments.some(
          (doc) =>
            doc.supplier_id === supplierId &&
            doc.document_date === dateIso &&
            round2(doc.total_amount) === total,
        );
      }

      return {
        rowNumber,
        supplierName,
        supplierId,
        supplierTaxId,
        willCreateSupplier,
        date: row[mapping.date],
        amount,
        currency,
        tax,
        issues,
        isDuplicate,
        linkedTo,
      };
    });
  }, [rows, mapping, defaultCurrency, knownSuppliersByNameLower, assignments, existingDocuments, linkedRows]);

  const invalidCount = previewRows.filter((r) => r.issues.length > 0).length;
  const duplicateCount = previewRows.filter(
    (r) => r.issues.length === 0 && r.isDuplicate && !r.linkedTo,
  ).length;
  const importCount = previewRows.length - invalidCount;

  const unmatchedSupplierNames = useMemo(() => {
    const byKey = new Map<string, { rawName: string; taxId: string }>();
    for (const row of previewRows) {
      const key = normalizeSupplierName(row.supplierName);
      if (row.willCreateSupplier && !byKey.has(key)) {
        byKey.set(key, { rawName: row.supplierName, taxId: row.supplierTaxId });
      }
    }
    return Array.from(byKey.entries()).map(([key, value]) => ({ key, ...value }));
  }, [previewRows]);

  const [creatingSupplierFor, setCreatingSupplierFor] = useState<string | null>(null);
  const [newSupplierNames, setNewSupplierNames] = useState<Map<string, string>>(new Map());
  const [assignError, setAssignError] = useState<string | null>(null);

  function assignExistingSupplier(rawName: string, supplierId: string) {
    if (!supplierId) {
      setAssignments((prev) => {
        const next = new Map(prev);
        next.delete(normalizeSupplierName(rawName));
        return next;
      });
      return;
    }
    setAssignments((prev) => new Map(prev).set(normalizeSupplierName(rawName), supplierId));
  }

  async function handleCreateSupplier(rawName: string, taxId: string) {
    const name = (newSupplierNames.get(rawName) ?? rawName).trim();
    if (!name) return;

    setAssignError(null);
    setCreatingSupplierFor(rawName);
    const res = await createSupplierForImport(companyId, name, taxId || null);
    setCreatingSupplierFor(null);

    if (res.error !== null || !res.supplier) {
      setAssignError(res.error ?? "No se pudo crear el proveedor.");
      return;
    }

    setKnownSuppliers((prev) => [...prev, res.supplier!]);
    assignExistingSupplier(rawName, res.supplier.id);
  }

  function toggleForced(rowNumber: number) {
    setForcedRowNumbers((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  function setLinkedRow(rowNumber: number, costDocumentId: string) {
    setLinkedRows((prev) => {
      const next = new Map(prev);
      if (!costDocumentId) next.delete(rowNumber);
      else next.set(rowNumber, costDocumentId);
      return next;
    });
  }

  async function handleCommit() {
    setPending(true);
    setError(null);
    const linkedRowsObject: Record<number, string> = {};
    for (const [rowNumber, costDocumentId] of linkedRows) {
      linkedRowsObject[rowNumber] = costDocumentId;
    }
    const res = await commitImport(
      companyId,
      fileName,
      rows,
      mapping,
      Array.from(forcedRowNumbers),
      linkedRowsObject,
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
          <p className="mt-1 text-[var(--color-ink-2)]">
            Las facturas importadas quedan sin asignar a un trabajo -- asignalas
            desde la lista de costos.
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
        <LinkButton href={`/companies/${companyId}/costs?classification=general&unassigned=1`} variant="primary">
          Ver facturas sin asignar
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
                  ? "bg-[var(--color-ink)] text-[var(--color-on-ink)]"
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
                href={`/companies/${companyId}/costs`}
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
          {unmatchedSupplierNames.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-row)] p-4 text-[13px]">
              <p className="font-semibold text-[var(--color-ink)]">
                {unmatchedSupplierNames.length} proveedor
                {unmatchedSupplierNames.length === 1 ? "" : "es"} del archivo no coincide
                {unmatchedSupplierNames.length === 1 ? "" : "n"} con ningún proveedor existente
              </p>
              <p className="text-[var(--color-ink-2)]">
                Por defecto se van a crear como proveedores nuevos con ese mismo nombre al
                importar. Si en realidad son un proveedor que ya existe (variación de
                nombre, mayúsculas, etc.), asignalo acá para evitar duplicados.
              </p>
              <div className="flex flex-col gap-2">
                {unmatchedSupplierNames.map(({ key, rawName, taxId }) => (
                  <div
                    key={key}
                    className="flex flex-col gap-1.5 rounded-md border border-[var(--color-hairline)] bg-[var(--color-surface)] p-2.5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="text-[13px] font-medium text-[var(--color-ink)]">
                      {rawName}
                      {taxId ? (
                        <span className="ml-1.5 font-mono text-[11.5px] font-normal text-[var(--color-muted)]">
                          {taxId}
                        </span>
                      ) : null}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={assignments.get(key) ?? ""}
                        onChange={(event) => assignExistingSupplier(rawName, event.target.value)}
                        className={fieldInput}
                      >
                        <option value="">Asignar a proveedor existente…</option>
                        {knownSuppliers.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
                      <span className="text-[var(--color-muted)]">o</span>
                      <input
                        type="text"
                        defaultValue={rawName}
                        onChange={(event) =>
                          setNewSupplierNames((prev) => new Map(prev).set(rawName, event.target.value))
                        }
                        className={fieldInput}
                        aria-label={`Nombre del nuevo proveedor para "${rawName}"`}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={creatingSupplierFor === rawName}
                        pending={creatingSupplierFor === rawName}
                        pendingLabel="Creando…"
                        onClick={() => handleCreateSupplier(rawName, taxId)}
                      >
                        Crear proveedor
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
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Proveedor</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Fecha</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Importe</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Moneda</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">IVA</th>
                  <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">Estado</th>
                  {provisionalCosts.length > 0 ? (
                    <th className="px-3 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
                      ¿Corresponde a un gasto ya cargado?
                    </th>
                  ) : null}
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
                        : row.linkedTo
                          ? undefined
                          : row.isDuplicate || row.willCreateSupplier
                            ? "bg-[var(--color-warning-row)]"
                            : undefined
                    }
                  >
                    <td className="border-t border-[var(--color-row)] px-3 py-2 font-mono text-[var(--color-faint)]">
                      {row.rowNumber}
                    </td>
                    <td className="border-t border-[var(--color-row)] px-3 py-2 text-[var(--color-ink)]">
                      {row.supplierName || "—"}
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
                      ) : row.linkedTo ? (
                        <Badge variant="positive">Vincular</Badge>
                      ) : row.isDuplicate ? (
                        <Badge variant="warning">Posible duplicado</Badge>
                      ) : row.willCreateSupplier ? (
                        <Badge variant="warning">Proveedor nuevo</Badge>
                      ) : (
                        <Badge variant="positive">OK</Badge>
                      )}
                    </td>
                    {provisionalCosts.length > 0 ? (
                      <td className="border-t border-[var(--color-row)] px-3 py-2">
                        {row.issues.length === 0 ? (
                          <select
                            value={row.linkedTo ?? ""}
                            onChange={(event) => setLinkedRow(row.rowNumber, event.target.value)}
                            className={fieldInput}
                          >
                            <option value="">Crear nuevo</option>
                            {provisionalCosts.map((cost) => (
                              <option key={cost.id} value={cost.id}>
                                {cost.document_date} · {cost.project_name ?? "Sin trabajo"} ·{" "}
                                {cost.total_amount} {cost.currency}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </td>
                    ) : null}
                    <td className="border-t border-[var(--color-row)] px-3 py-2">
                      {row.issues.length === 0 && row.isDuplicate && !row.linkedTo ? (
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
