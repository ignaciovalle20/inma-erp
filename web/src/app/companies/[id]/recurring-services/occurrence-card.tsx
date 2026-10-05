"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RecurringServiceOccurrenceRow } from "@/lib/dal";
import { Badge } from "@/components/Badge";
import { Money, formatAmount } from "@/components/Money";
import { AmountInput } from "@/components/AmountInput";
import { fieldInput, fieldLabel } from "@/components/FormField";
import { currencyDecimals } from "@/lib/currencies";
import {
  boardBadge,
  describeAge,
  formatDueDate,
  formatPeriod,
  isOverdue,
  relevantDueDate,
} from "@/lib/recurringServicePending";
import { currenciesForCountry, type ServiceCountry } from "@/lib/recurringServiceTypes";
import {
  linkOccurrenceSalesDocument,
  markOccurrenceCollected,
  markOccurrenceInvoiced,
  searchSalesDocumentsForOccurrence,
  undoOccurrenceCollected,
  undoOccurrenceInvoiced,
  updateOccurrenceDetails,
  voidOccurrence,
  type SalesDocumentCandidate,
} from "./occurrence-actions";

type Result = { error: string | null };
type Panel = "link" | "edit" | null;

const primaryButton =
  "min-h-11 flex-1 rounded-lg bg-[var(--color-ink)] px-3 py-2 text-[14px] font-medium text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 md:min-h-9 md:flex-none md:text-[13px]";
const textButton =
  "min-h-11 cursor-pointer px-1 text-[12.5px] font-medium text-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-60 md:min-h-0";

/**
 * One billing cycle as a board card: who, what, how much, its state
 * badge (Facturar / Cobrar / Pagado) and due date (red once overdue and
 * not collected), with one-tap Facturado / Cobrado and their undo.
 */
export function OccurrenceCard({
  companyId,
  occurrence,
  today,
  country,
  showClient = true,
}: {
  companyId: string;
  occurrence: RecurringServiceOccurrenceRow;
  today: string;
  country: ServiceCountry | null;
  showClient?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>(null);

  const { status } = occurrence;
  const badge = boardBadge(status);
  const overdue = isOverdue(occurrence, today);
  const due = relevantDueDate(occurrence);
  const noDueDay = occurrence.service_due_day === null || due === null;
  const isOpen = status === "pending_invoice" || status === "invoiced" || status === "pending_collection";
  const canLink = status === "invoiced" || (status === "collected" && occurrence.invoiced_at !== null);

  function run(action: () => Promise<Result>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <li
      className={`flex flex-col gap-2.5 rounded-[10px] border bg-[var(--color-surface)] p-3 ${
        overdue ? "border-[var(--color-negative-soft)]" : "border-[var(--color-hairline)]"
      } ${status === "void" ? "opacity-60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {showClient ? (
            <p className="truncate text-[14px] font-medium text-[var(--color-ink)]">
              {occurrence.client_name ?? "Cliente desconocido"}
            </p>
          ) : null}
          <Link
            href={`/companies/${companyId}/recurring-services/services/${occurrence.recurring_service_id}`}
            className="block truncate text-[12.5px] text-[var(--color-ink-2)] no-underline hover:underline"
          >
            {occurrence.service_name}
          </Link>
          <p className="font-mono text-[11px] uppercase tracking-wide text-[var(--color-faint)]">
            Período {formatPeriod(occurrence.period, occurrence.service_periodicity)}
          </p>
        </div>
        <p className="shrink-0 text-right text-[14px] font-medium">
          <Money value={occurrence.amount} currency={occurrence.currency} />
        </p>
      </div>

      {occurrence.service_notes || occurrence.service_quote_ref || occurrence.note ? (
        <div className="flex flex-col gap-0.5 text-[12px] text-[var(--color-ink-2)]">
          {occurrence.service_notes ? (
            <p className="whitespace-pre-line">{occurrence.service_notes}</p>
          ) : null}
          {occurrence.service_quote_ref ? (
            <p className="font-mono text-[11.5px]">COT# {occurrence.service_quote_ref}</p>
          ) : null}
          {occurrence.note ? <p className="italic">{occurrence.note}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <span
          className={
            overdue ? "font-medium text-[var(--color-negative-ink)]" : "text-[var(--color-ink-2)]"
          }
        >
          {noDueDay ? (
            <span className="mr-1.5 text-[11.5px] text-[var(--color-warning-ink)]">
              sin vencimiento definido ·
            </span>
          ) : null}
          {formatDueDate(due)}
          {isOpen ? ` · ${describeAge(due, today)}` : ""}
        </span>
      </div>

      {occurrence.sales_document_id ? (
        <p className="text-[12px] text-[var(--color-ink-2)]">
          Factura {occurrence.sales_document_number ?? "vinculada"}
        </p>
      ) : null}
      {status === "collected" && occurrence.collected_at ? (
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Cobrado el {formatDueDate(occurrence.collected_at)}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {status === "pending_invoice" ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => markOccurrenceInvoiced(companyId, occurrence.id))}
            className={primaryButton}
          >
            Facturado
          </button>
        ) : null}
        {status === "invoiced" || status === "pending_collection" ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => markOccurrenceCollected(companyId, occurrence.id))}
            className={primaryButton}
          >
            Cobrado
          </button>
        ) : null}
        {status === "invoiced" ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => undoOccurrenceInvoiced(companyId, occurrence.id))}
            className={textButton}
          >
            Deshacer facturado
          </button>
        ) : null}
        {status === "collected" ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => undoOccurrenceCollected(companyId, occurrence.id))}
            className={textButton}
          >
            Deshacer cobrado
          </button>
        ) : null}
        {canLink ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => setPanel(panel === "link" ? null : "link")}
            className={textButton}
          >
            {occurrence.sales_document_id ? "Cambiar factura" : "Vincular factura"}
          </button>
        ) : null}
        {status !== "void" ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => setPanel(panel === "edit" ? null : "edit")}
            className={`${textButton} text-[var(--color-muted)]`}
          >
            Editar
          </button>
        ) : null}
        {isOpen ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              if (
                window.confirm(
                  "¿Anular este ciclo? No se vuelve a generar para este período y no se puede deshacer.",
                )
              ) {
                run(() => voidOccurrence(companyId, occurrence.id));
              }
            }}
            className={`${textButton} text-[var(--color-negative-ink)]`}
          >
            Anular
          </button>
        ) : null}
        {isPending ? <span className="text-[12px] text-[var(--color-muted)]">Guardando…</span> : null}
      </div>

      {error ? (
        <p role="alert" className="text-[12px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}

      {panel === "link" ? (
        <LinkInvoicePanel
          companyId={companyId}
          occurrence={occurrence}
          disabled={isPending}
          onPick={(documentId) =>
            run(() => linkOccurrenceSalesDocument(companyId, occurrence.id, documentId), () => setPanel(null))
          }
        />
      ) : null}
      {panel === "edit" ? (
        <EditOccurrencePanel
          occurrence={occurrence}
          country={country}
          disabled={isPending}
          onSave={(values) =>
            run(() => updateOccurrenceDetails(companyId, occurrence.id, values), () => setPanel(null))
          }
        />
      ) : null}
    </li>
  );
}

/** Search the company's invoices (this client by default, by number or amount) and link one. */
function LinkInvoicePanel({
  companyId,
  occurrence,
  disabled,
  onPick,
}: {
  companyId: string;
  occurrence: RecurringServiceOccurrenceRow;
  disabled: boolean;
  onPick: (documentId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [allClients, setAllClients] = useState(false);
  const [results, setResults] = useState<SalesDocumentCandidate[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();

  function search(nextQuery = query, nextAll = allClients) {
    startSearch(async () => {
      const response = await searchSalesDocumentsForOccurrence(companyId, occurrence.id, nextQuery, nextAll);
      setSearchError(response.error);
      setResults(response.results);
    });
  }

  // Opening the panel lists this client's unlinked invoices right away.
  useEffect(() => {
    startSearch(async () => {
      const response = await searchSalesDocumentsForOccurrence(companyId, occurrence.id, "", false);
      setSearchError(response.error);
      setResults(response.results);
    });
  }, [companyId, occurrence.id]);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-[var(--color-row)] p-2.5">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          search();
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="N° de factura o monto"
          aria-label="Buscar factura"
          className={`${fieldInput} min-w-0 flex-1`}
        />
        <button type="submit" disabled={searching} className={textButton}>
          Buscar
        </button>
      </form>
      <label className="flex items-center gap-2 text-[12px] text-[var(--color-ink-2)]">
        <input
          type="checkbox"
          checked={allClients}
          onChange={(event) => {
            setAllClients(event.target.checked);
            search(query, event.target.checked);
          }}
        />
        Buscar en todos los clientes
      </label>
      {searching ? <p className="text-[12px] text-[var(--color-muted)]">Buscando…</p> : null}
      {searchError ? (
        <p role="alert" className="text-[12px] text-[var(--color-negative-ink)]">
          {searchError}
        </p>
      ) : null}
      {results && !searching ? (
        results.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)]">No hay facturas sin vincular que coincidan.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-hairline)]">
            {results.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-2 py-1.5 text-[12.5px]">
                <span className="min-w-0">
                  <span className="font-medium text-[var(--color-ink)]">N° {doc.document_number ?? "s/n"}</span>
                  <span className="text-[var(--color-muted)]"> · {formatDueDate(doc.document_date)}</span>
                  {allClients ? (
                    <span className="block truncate text-[11.5px] text-[var(--color-muted)]">{doc.client_name}</span>
                  ) : null}
                  <span className="block font-mono text-[11.5px] text-[var(--color-ink-2)]">
                    neto {formatAmount(doc.net_amount, doc.currency)} · total{" "}
                    {formatAmount(doc.total_amount, doc.currency)} {doc.currency}
                  </span>
                </span>
                <button type="button" disabled={disabled} onClick={() => onPick(doc.id)} className={textButton}>
                  Vincular
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {occurrence.sales_document_id ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(null)}
          className={`${textButton} self-start text-[var(--color-negative-ink)]`}
        >
          Desvincular la factura actual
        </button>
      ) : null}
    </div>
  );
}

/** This cycle's own amount / currency / due date / note (copied from the service, editable). */
function EditOccurrencePanel({
  occurrence,
  country,
  disabled,
  onSave,
}: {
  occurrence: RecurringServiceOccurrenceRow;
  country: ServiceCountry | null;
  disabled: boolean;
  onSave: (values: { amount: string; currency: string; dueDate: string; note: string }) => void;
}) {
  const [amount, setAmount] = useState(String(occurrence.amount));
  const [currency, setCurrency] = useState(country === "CL" ? "CLP" : occurrence.currency);
  const [dueDate, setDueDate] = useState(occurrence.invoice_due_date ?? "");
  const [note, setNote] = useState(occurrence.note ?? "");
  const options = currenciesForCountry(country);

  return (
    <form
      className="flex flex-col gap-2 rounded-lg bg-[var(--color-row)] p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ amount, currency, dueDate, note });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>Monto</span>
          <AmountInput
            value={amount}
            onValueChange={setAmount}
            maxDecimals={currencyDecimals(currency)}
            className={`${fieldInput} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={fieldLabel}>Moneda</span>
          {country === "CL" ? (
            <span className="flex min-h-[38px] items-center text-[13.5px] text-[var(--color-ink-2)]">CLP</span>
          ) : (
            <select
              value={options.includes(currency) ? currency : ""}
              onChange={(event) => setCurrency(event.target.value)}
              required
              className={fieldInput}
            >
              <option value="" disabled>
                Elegí moneda
              </option>
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>Vencimiento</span>
        <input
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
          className={`${fieldInput} font-mono`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={fieldLabel}>Nota del ciclo</span>
        <textarea
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className={fieldInput}
        />
      </label>
      <button type="submit" disabled={disabled} className={`${primaryButton} self-start`}>
        Guardar
      </button>
    </form>
  );
}
