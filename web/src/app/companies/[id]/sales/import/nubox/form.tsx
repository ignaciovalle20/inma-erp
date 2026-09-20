"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { fieldInput, fieldLabel } from "@/components/FormField";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { orderJobsForInvoice, jobBalance } from "@/lib/nubox";
import {
  formatAmount,
  formatDisplayDate,
  paymentStatusLabel,
  paymentStatusVariant,
} from "@/lib/paymentStatus";
import type { ImportRowStatus } from "@/lib/dal";
import {
  analyzeNuboxFile,
  commitNuboxImport,
  type CommitNuboxResult,
  type NuboxDecisions,
  type NuboxPreview,
} from "./actions";

type Done = Extract<CommitNuboxResult, { error: null }>;

const ROW_STATUS_LABEL: Record<ImportRowStatus, string> = {
  imported: "Nueva",
  updated: "Cobro actualizado",
  unchanged: "Sin cambios",
  review: "A revisar",
  error: "Error",
  duplicate: "Duplicada",
};

const ROW_STATUS_VARIANT: Record<ImportRowStatus, "positive" | "neutral" | "warning" | "negative" | "outline"> = {
  imported: "positive",
  updated: "outline",
  unchanged: "neutral",
  review: "warning",
  error: "negative",
  duplicate: "warning",
};

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
    >
      {children}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
        {hint ? <p className="text-[12px] text-[var(--color-muted)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

const typeLabel = (type: "invoice" | "credit_note") => (type === "invoice" ? "Factura" : "N/C");

export function NuboxImportForm({ companyId }: { companyId: string }) {
  const [preview, setPreview] = useState<NuboxPreview | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairChoices, setPairChoices] = useState<Record<string, string | null>>({});
  const [linkChoices, setLinkChoices] = useState<Record<string, string | null>>({});
  const [pending, startTransition] = useTransition();

  function analyze(formData: FormData) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await analyzeNuboxFile(companyId, formData);
        if (result.error !== null) {
          setError(result.error);
          return;
        }
        setPreview(result);
        setPairChoices({});
        setLinkChoices({});
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : "No se pudo analizar el archivo.");
      }
    });
  }

  // The invoice a credit note will annul: the user's choice, else the
  // automatic pairing (null = leave it unpaired).
  const effectivePairs = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of preview?.creditNotes ?? []) {
      if (note.state === "paired" || note.state === "none") continue;
      const choice = pairChoices[note.documentNumber];
      const invoice = choice === undefined ? note.autoPairedWith : choice;
      if (invoice) map.set(note.documentNumber, invoice);
    }
    return map;
  }, [preview, pairChoices]);

  const annulledInvoices = useMemo(() => new Set(effectivePairs.values()), [effectivePairs]);

  const effectiveLinks = useMemo(() => {
    const map = new Map<string, string>();
    for (const link of preview?.invoiceLinks ?? []) {
      if (annulledInvoices.has(link.documentNumber)) continue;
      const choice = linkChoices[link.documentNumber];
      const projectId = choice === undefined ? link.suggestedProjectId : choice;
      if (projectId) map.set(link.documentNumber, projectId);
    }
    return map;
  }, [preview, linkChoices, annulledInvoices]);

  const hasWork = preview
    ? preview.summary.new + preview.summary.adopted + preview.summary.updated > 0 || effectivePairs.size > 0
    : false;

  function confirmImport() {
    if (!preview) return;
    setError(null);

    const decisions: NuboxDecisions = { pairs: pairChoices, links: linkChoices };

    startTransition(async () => {
      try {
        const result = await commitNuboxImport(companyId, preview.fileName, preview.rows, decisions);
        if (result.error !== null) {
          setError(result.error);
          return;
        }
        setDone(result);
        setPreview(null);
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : "No se pudo completar la importación.");
      }
    });
  }

  function reset() {
    setPreview(null);
    setDone(null);
    setError(null);
    setPairChoices({});
    setLinkChoices({});
  }

  // --- Step 3: result -------------------------------------------------
  if (done) {
    const problems = done.rowResults.filter(
      (row) => row.status === "error" || row.status === "review" || row.message?.includes("No se pudo emparejar"),
    );

    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">Importación terminada</h2>
          <p className="text-[13px] text-[var(--color-ink-2)]">{done.summaryText}</p>
          <p className="text-[12px] text-[var(--color-muted)]">
            {done.createdClients} cliente(s) creado(s)
            {done.completedClients > 0 ? ` · ${done.completedClients} cliente(s) con RUT completado` : ""} ·{" "}
            {done.pairedCreditNotes} nota(s) de crédito emparejada(s)
            {done.skipped > 0 ? ` · ${done.skipped} fila(s) omitida(s) por no estar emitidas` : ""}
          </p>
        </div>

        {done.warnings.map((warning) => (
          <ErrorBox key={warning}>{warning}</ErrorBox>
        ))}

        {problems.length > 0 ? (
          <Section title="Filas que requieren atención" hint="No se modificaron o no se pudieron procesar.">
            <TableCard>
              <thead>
                <tr>
                  <Th>Fila</Th>
                  <Th>Folio</Th>
                  <Th>Resultado</Th>
                  <Th>Detalle</Th>
                </tr>
              </thead>
              <tbody>
                {problems.map((row) => (
                  <Tr key={`${row.rowNumber}-${row.status}`}>
                    <Td className="font-mono">{row.rowNumber}</Td>
                    <Td className="font-mono">{row.folio}</Td>
                    <Td>
                      <Badge variant={ROW_STATUS_VARIANT[row.status]}>{ROW_STATUS_LABEL[row.status]}</Badge>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">{row.message}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableCard>
          </Section>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <LinkButton href={`/companies/${companyId}/sales`} variant="primary">
            Ver ventas
          </LinkButton>
          <LinkButton href={`/companies/${companyId}/sales/pending`} variant="secondary">
            Ver pendientes
          </LinkButton>
          <Link
            href={`/companies/${companyId}/sales/import-history/${done.batchId}`}
            className="text-[13px] text-[var(--color-accent-strong)]"
          >
            Detalle del lote
          </Link>
          <button type="button" onClick={reset} className="text-[13px] text-[var(--color-muted)]">
            Importar otro archivo
          </button>
        </div>
      </div>
    );
  }

  // --- Step 1: upload -------------------------------------------------
  if (!preview) {
    return (
      <form
        action={analyze}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="nubox_file" className={fieldLabel}>
            Archivo de Nubox (.csv)
          </label>
          <input
            id="nubox_file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className={fieldInput}
          />
          <p className="text-[12px] text-[var(--color-muted)]">
            Exportá los documentos desde Nubox. El archivo trae los últimos documentos, no un mes: los que ya
            existen no se duplican, solo se actualiza su estado de cobro. Las ventas cargadas antes sin folio se
            vinculan a su factura (mismo cliente, fecha y neto) en vez de crearse de nuevo.
          </p>
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <div>
          <Button type="submit" pending={pending} pendingLabel="Analizando…">
            Analizar archivo
          </Button>
        </div>
      </form>
    );
  }

  // --- Step 2: preview --------------------------------------------------
  const takenInvoices = new Set(effectivePairs.values());
  const assignedNets = new Map<string, number>();
  for (const link of preview.invoiceLinks) {
    const projectId = effectiveLinks.get(link.documentNumber);
    if (projectId) assignedNets.set(projectId, (assignedNets.get(projectId) ?? 0) + link.netAmount);
  }
  const visibleLinks = preview.invoiceLinks.filter((link) => !annulledInvoices.has(link.documentNumber));
  const choosableNotes = preview.creditNotes.filter((note) => note.state !== "paired");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
          {preview.fileName}
        </span>
        <p className="text-[15px] font-semibold text-[var(--color-ink)]">{preview.summaryText}</p>
        {preview.skipped.length > 0 ? (
          <p className="text-[12px] text-[var(--color-muted)]">
            {preview.skipped.length} fila(s) omitida(s): {preview.skipped[0].message}
          </p>
        ) : null}
      </div>

      {preview.errors.length > 0 ? (
        <Section
          title={`${preview.errors.length} fila(s) con error`}
          hint="Estas filas no se importan. Corregí el archivo (o el dato en Nubox) y volvé a subirlo."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>Fila</Th>
                <Th>Folio</Th>
                <Th>Motivo</Th>
              </tr>
            </thead>
            <tbody>
              {preview.errors.map((row) => (
                <Tr key={row.rowNumber}>
                  <Td className="font-mono">{row.rowNumber}</Td>
                  <Td className="font-mono">{row.folio || "—"}</Td>
                  <Td className="text-[var(--color-negative-ink)]">{row.message}</Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      {preview.reviewDocuments.length > 0 ? (
        <Section
          title={`${preview.reviewDocuments.length} documento(s) a revisar`}
          hint="Ya existen con datos distintos. No se tocan: revisalos en Nubox y en las ventas."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>Tipo</Th>
                <Th>Folio</Th>
                <Th>Cliente</Th>
                <Th align="right">Neto</Th>
                <Th>Motivo</Th>
              </tr>
            </thead>
            <tbody>
              {preview.reviewDocuments.map((doc) => (
                <Tr key={doc.rowNumber}>
                  <Td>{typeLabel(doc.documentType)}</Td>
                  <Td className="font-mono">{doc.documentNumber}</Td>
                  <Td>{doc.clientName}</Td>
                  <Td align="right" className="font-mono">
                    {formatAmount(doc.netAmount)}
                  </Td>
                  <Td className="text-[var(--color-warning-ink)]">{doc.reason}</Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      {preview.adoptedDocuments.length > 0 ? (
        <Section
          title={`${preview.adoptedDocuments.length} venta(s) ya cargada(s) se vinculan a su documento`}
          hint="Ya están en las ventas sin folio (mismo cliente, fecha y neto). No se crean de nuevo: se les asigna el tipo, el folio, el vencimiento y el estado de cobro. Una nota de crédito cargada antes como venta pasa a ser esa nota."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>Tipo</Th>
                <Th>Folio</Th>
                <Th>Fecha</Th>
                <Th>Cliente</Th>
                <Th align="right">Neto</Th>
                <Th>Vence</Th>
                <Th>Cobro</Th>
              </tr>
            </thead>
            <tbody>
              {preview.adoptedDocuments.map((doc) => (
                <Tr key={doc.rowNumber}>
                  <Td>{typeLabel(doc.documentType)}</Td>
                  <Td className="font-mono">{doc.documentNumber}</Td>
                  <Td className="font-mono">{formatDisplayDate(doc.documentDate)}</Td>
                  <Td>{doc.clientName}</Td>
                  <Td align="right" className="font-mono">
                    {formatAmount(doc.netAmount)}
                  </Td>
                  <Td className="font-mono">{formatDisplayDate(doc.dueDate)}</Td>
                  <Td>
                    <Badge variant={paymentStatusVariant(doc.paymentStatus)}>
                      {paymentStatusLabel(doc.paymentStatus)}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      <Section
        title={`Documentos nuevos (${preview.newDocuments.length})`}
        hint="Solo se listan los nuevos; los que ya existen y no cambiaron no aparecen."
      >
        {preview.newDocuments.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)]">No hay documentos nuevos en este archivo.</p>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Tipo</Th>
                <Th>Folio</Th>
                <Th>Fecha</Th>
                <Th>Cliente</Th>
                <Th align="right">Neto</Th>
                <Th align="right">Total</Th>
                <Th>Vence</Th>
                <Th>Cobro</Th>
              </tr>
            </thead>
            <tbody>
              {preview.newDocuments.map((doc) => (
                <Tr key={doc.rowNumber}>
                  <Td>{typeLabel(doc.documentType)}</Td>
                  <Td className="font-mono">{doc.documentNumber}</Td>
                  <Td className="font-mono">{formatDisplayDate(doc.documentDate)}</Td>
                  <Td>
                    {doc.clientName}
                    {doc.clientIsNew ? (
                      <Badge variant="warning" className="ml-2">
                        Cliente nuevo
                      </Badge>
                    ) : null}
                  </Td>
                  <Td align="right" className="font-mono">
                    {formatAmount(doc.netAmount)}
                  </Td>
                  <Td align="right" className="font-mono">
                    {formatAmount(doc.totalAmount)}
                  </Td>
                  <Td className="font-mono">{formatDisplayDate(doc.dueDate)}</Td>
                  <Td>
                    <Badge variant={paymentStatusVariant(doc.paymentStatus)}>
                      {paymentStatusLabel(doc.paymentStatus)}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </Section>

      {preview.newClients.length > 0 ? (
        <Section
          title={`Se crearán ${preview.newClients.length} cliente(s)`}
          hint="No hay un cliente con ese RUT; se crea con el nombre del archivo."
        >
          <ul className="flex flex-col gap-0.5 text-[13px] text-[var(--color-ink-2)]">
            {preview.newClients.map((client) => (
              <li key={client.rut}>
                {client.name} <span className="font-mono text-[12px] text-[var(--color-muted)]">{client.rut}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.clientsToComplete.length > 0 ? (
        <Section
          title={`Se completará el RUT de ${preview.clientsToComplete.length} cliente(s) existente(s)`}
          hint="No tenían RUT y coinciden por nombre con el archivo. Revisá que sea el mismo cliente: si no, corregilo después en Clientes."
        >
          <ul className="flex flex-col gap-0.5 text-[13px] text-[var(--color-ink-2)]">
            {preview.clientsToComplete.map((client) => (
              <li key={client.id}>
                {client.storedName}
                {client.storedName !== client.fileName ? ` (en Nubox: ${client.fileName})` : ""}{" "}
                <span className="font-mono text-[12px] text-[var(--color-muted)]">{client.rut}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.leftoverSales.length > 0 ? (
        <Section
          title={`${preview.leftoverSales.length} venta(s) ya cargada(s) sin factura en este archivo`}
          hint="Son del mismo cliente y período pero ninguna factura del archivo las respalda (mismo neto y fecha). No se tocan: pueden ser duplicados cargados a mano o ventas sin factura. Revisalas en Ventas."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th>Cliente</Th>
                <Th align="right">Neto</Th>
              </tr>
            </thead>
            <tbody>
              {preview.leftoverSales.map((sale, index) => (
                <Tr key={`${sale.documentDate}-${sale.clientName}-${sale.netAmount}-${index}`}>
                  <Td className="font-mono">{formatDisplayDate(sale.documentDate)}</Td>
                  <Td>{sale.clientName}</Td>
                  <Td align="right" className="font-mono">
                    {formatAmount(sale.netAmount)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      {choosableNotes.length > 0 ? (
        <Section
          title="Notas de crédito"
          hint="Cada N/C anula la factura que corrige: ambas quedan fuera de las ventas y los reportes."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>N/C</Th>
                <Th>Cliente</Th>
                <Th>Fecha</Th>
                <Th align="right">Neto</Th>
                <Th>Factura que anula</Th>
              </tr>
            </thead>
            <tbody>
              {choosableNotes.map((note) => {
                const chosen = effectivePairs.get(note.documentNumber) ?? "";
                const options =
                  note.state === "auto" && note.autoPairedWith
                    ? [{ documentNumber: note.autoPairedWith, documentDate: "", inFile: true }]
                    : note.candidates;

                return (
                  <Tr key={note.documentNumber}>
                    <Td className="font-mono">{note.documentNumber}</Td>
                    <Td>{note.clientName}</Td>
                    <Td className="font-mono">{formatDisplayDate(note.documentDate)}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(note.netAmount)}
                    </Td>
                    <Td>
                      {options.length === 0 ? (
                        <span className="text-[12.5px] text-[var(--color-warning-ink)]">
                          Sin factura candidata: queda en pendientes
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <select
                            value={chosen}
                            aria-label={`Factura que anula la N/C ${note.documentNumber}`}
                            onChange={(event) =>
                              setPairChoices((current) => ({
                                ...current,
                                [note.documentNumber]: event.target.value || null,
                              }))
                            }
                            className={`${fieldInput} py-[6px] text-[12.5px]`}
                          >
                            <option value="">Sin emparejar (queda en pendientes)</option>
                            {options.map((option) => (
                              <option
                                key={option.documentNumber}
                                value={option.documentNumber}
                                disabled={
                                  takenInvoices.has(option.documentNumber) && chosen !== option.documentNumber
                                }
                              >
                                Factura {option.documentNumber}
                                {option.documentDate ? ` · ${formatDisplayDate(option.documentDate)}` : ""}
                                {option.inFile ? "" : " · ya cargada"}
                              </option>
                            ))}
                          </select>
                          {note.state === "auto" ? (
                            <span className="text-[11.5px] text-[var(--color-muted)]">
                              Única candidata: se empareja sola.
                            </span>
                          ) : null}
                        </div>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      {visibleLinks.length > 0 ? (
        <Section
          title="Vincular facturas a trabajos"
          hint="Se pre-marca el trabajo del cliente cuyo saldo por facturar coincide con el neto. Si no hay uno, elegilo de la lista o dejala sin vincular."
        >
          <TableCard>
            <thead>
              <tr>
                <Th>Factura</Th>
                <Th>Cliente</Th>
                <Th align="right">Neto</Th>
                <Th>Trabajo</Th>
              </tr>
            </thead>
            <tbody>
              {visibleLinks.map((link) => {
                const chosen = effectiveLinks.get(link.documentNumber) ?? "";
                // Balance shown per job excludes this invoice's own assignment.
                const others = new Map(assignedNets);
                if (chosen) others.set(chosen, (others.get(chosen) ?? 0) - link.netAmount);
                const ordered = orderJobsForInvoice(preview.jobs, link.clientId, others);

                return (
                  <Tr key={link.documentNumber}>
                    <Td className="font-mono">{link.documentNumber}</Td>
                    <Td>{link.clientName}</Td>
                    <Td align="right" className="font-mono">
                      {formatAmount(link.netAmount)}
                    </Td>
                    <Td>
                      <select
                        value={chosen}
                        aria-label={`Trabajo de la factura ${link.documentNumber}`}
                        onChange={(event) =>
                          setLinkChoices((current) => ({
                            ...current,
                            [link.documentNumber]: event.target.value || null,
                          }))
                        }
                        className={`${fieldInput} py-[6px] text-[12.5px]`}
                      >
                        <option value="">Sin vincular (queda en pendientes)</option>
                        {ordered.map((job) => {
                          const balance = jobBalance(job, others.get(job.projectId) ?? 0);
                          return (
                            <option key={job.projectId} value={job.projectId}>
                              {job.name}
                              {balance === null ? " · sin monto cotizado" : ` · saldo ${formatAmount(balance)}`}
                              {job.projectId === link.suggestedProjectId ? " · sugerido" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableCard>
        </Section>
      ) : null}

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {!hasWork ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          No hay nada para importar: todo lo del archivo ya está cargado y sin cambios.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={confirmImport} pending={pending} pendingLabel="Importando…" disabled={!hasWork}>
          Confirmar importación
        </Button>
        <button type="button" onClick={reset} disabled={pending} className="text-[13px] text-[var(--color-muted)]">
          Cancelar
        </button>
      </div>
    </div>
  );
}
