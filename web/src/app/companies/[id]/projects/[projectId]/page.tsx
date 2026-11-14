import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProject,
  getProjectCosts,
  getProjectQuotes,
  getPersonnel,
  getProjectChecklist,
  getProjectNotes,
  getCompanyMemberNames,
  type Personnel,
  type ProjectChecklistItem,
  type ProjectNote,
} from "@/lib/dal";
import { getLinkedDocumentIds, getTechnicianCharges, type TechnicianCharge } from "@/lib/technicianDal";
import { getProjectSalesDocuments, getQuoteBilling, projectBillingTotals } from "@/lib/salesAllocations";
import { PAYMENT_STATUS_LABEL, documentLabel, paymentStatus } from "@/lib/technicians";
import { companyConfig } from "@/lib/companyConfig";
import { computeProjectSummary } from "@/lib/projectSummary";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Money, formatAmount } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { Badge } from "@/components/Badge";
import { AddQuoteForm } from "./add-quote-form";
import { ProjectChecklist } from "./project-checklist";
import { ProjectNotes } from "./project-notes";
import { ChargeBacking, ChargeDocumentCell } from "./technician-charges/charge-document-cell";
import { UnassignCostButton } from "./unassign-cost-button";
import { backTarget, withVolver } from "@/lib/backNavigation";
import { costDeletionSummary, technicianChargeHrefs } from "@/lib/costDocumentDeletion";

const CATEGORY_LABEL: Record<string, string> = {
  equipment: "Equipos",
  materials: "Materiales",
  transport: "Traslados",
  labor: "Mano de obra",
  other: "Otros",
};

const STATUS_LABEL: Record<string, string> = {
  provisional: "Provisorio",
  confirmed: "Confirmado",
};

const SALES_DOCUMENT_PREFIX: Record<string, string> = {
  invoice: "FAC",
  credit_note: "N/C",
  receipt: "REC",
  manual: "Manual",
};

/** A read that may fail without failing the page (logged, then said on screen). */
async function settle<T>(read: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read };
  } catch (error) {
    console.error(error);
    return { ok: false };
  }
}

/** Green when positive, red when negative (Margen and Margen %). */
function signTone(value: number | null): string {
  if (value === null || value === 0) return "text-[var(--color-ink)]";
  return value > 0 ? "text-[var(--color-accent-strong)]" : "text-[var(--color-negative-ink)]";
}

/** One number card of the summary; null is "unknown" and shows "—", never 0. */
function SummaryCard({
  label,
  value,
  currency,
  signed = false,
  hint,
}: {
  label: string;
  value: number | null;
  currency: string;
  /** Colors the figure by its sign. */
  signed?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
      <span className="caps-label text-[var(--color-muted)]" title={hint}>
        {label}
      </span>
      {value === null ? (
        <span className="font-mono text-[15px] text-[var(--color-muted)]">—</span>
      ) : (
        <Money
          value={value}
          currency={currency}
          showCurrency={false}
          className={`text-[15px] ${signed ? signTone(value) : ""}`}
          negativeClassName={signed ? "" : undefined}
        />
      )}
    </div>
  );
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; projectId: string }>;
  searchParams: Promise<{ volver?: string }>;
}) {
  const { id, projectId } = await params;
  const { volver } = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a project's detail --
  // same gate the projects list page uses. The project is read alongside
  // (only this one, RLS-scoped and filtered by company): a non-member
  // simply gets null, and is redirected before it is looked at.
  const [membership, project] = await Promise.all([
    getCompanyForEdit(id),
    getProject(id, projectId),
  ]);

  if (!membership) {
    redirect("/companies");
  }

  if (!project) {
    notFound();
  }

  // Every read of the page at once (each one is a round trip to Supabase).
  // The technicians' charges of this job, and who they are (for the document
  // each one issues), and the checklist + notes timeline: a failed read is
  // said on screen, never shown as an empty section ("no technician worked
  // on this job", "no notes").
  const [costsRead, quotes, quoteBilling, salesRead, technicianRead, linkedDocsRead, logRead] = await Promise.all([
    // A failed read shows "—" in Gastos and the margin, never a lower total.
    settle(getProjectCosts(id, projectId)),
    getProjectQuotes(id, projectId),
    getQuoteBilling(id, projectId),
    settle(getProjectSalesDocuments(id, projectId)),
    settle(Promise.all([getTechnicianCharges(id, { projectId }), getPersonnel(id)])),
    // Facturas / boletas linked to any technician charge: they count in
    // Técnicos, never also in Gastos (lib/projectSummary).
    settle(getLinkedDocumentIds(id)),
    settle(
      Promise.all([
        getProjectChecklist(id, projectId),
        getProjectNotes(id, projectId),
        getCompanyMemberNames(id),
      ]),
    ),
  ]);

  const costs = costsRead.ok ? costsRead.value : [];

  let technicianCharges: TechnicianCharge[] = [];
  let personnel: Personnel[] = [];
  const technicianReadFailed = !technicianRead.ok;
  if (technicianRead.ok) [technicianCharges, personnel] = technicianRead.value;
  const documentByTechnician = new Map(personnel.map((person) => [person.id, person.payment_document]));
  // An expense that is a technician's charge is fixed in Técnicos, not taken
  // off the job from "Últimos gastos" (the database refuses it too).
  const chargeHrefByCost = technicianChargeHrefs(id, technicianCharges);

  let checklist: ProjectChecklistItem[] = [];
  let notes: ProjectNote[] = [];
  let memberNames = new Map<string, string>();
  const logReadFailed = !logRead.ok;
  if (logRead.ok) [checklist, notes, memberNames] = logRead.value;
  // Author names only matter when more than one person uses the company.
  const authorNames = memberNames.size > 1 ? Object.fromEntries(memberNames) : null;

  const currency = membership.company.currency;
  // The job's own currency: the quote and what is billed against it
  // (project_quote_billing_summary converts every invoice into it), and the
  // summary cards.
  const projectCurrency = project.currency || currency;
  const showProjectCurrency = projectCurrency !== currency;
  // Chile records the backing of each charge (factura, boleta, sin respaldo).
  const backedCompany = companyConfig(membership.company).country === "CL";

  // A placeholder quote (created so invoices of a job without a quote
  // number can be allocated) is not a real quote number: hidden from the
  // badges, and from the billing table once it holds nothing.
  const realQuotes = quotes.filter((quote) => !quote.placeholder);
  const billingRows = quoteBilling
    .filter((row) => !row.placeholder)
    .sort((a, b) => a.quote_number.localeCompare(b.quote_number));
  // Invoices of the job that went to no quote number (its internal quote).
  const billedWithoutQuote = quoteBilling
    .filter((row) => row.placeholder)
    .reduce((sum, row) => sum + row.billed_amount, 0);
  const billingTotals = projectBillingTotals(quoteBilling, project.quoted_amount);

  // Life-to-date figures of the job, net of IVA, in its currency.
  const summary = computeProjectSummary({
    currency: projectCurrency,
    quoted: billingTotals.quoted,
    billed: billingTotals.billed,
    costs: costsRead.ok
      ? costs.map((cost) => ({ costDocumentId: cost.id, currency: cost.currency, amount: cost.amount }))
      : null,
    // Without the charges or their documents there is no telling which costs
    // are a technician's: Gastos, Técnicos and the margin show "—".
    technicianCharges: technicianReadFailed || !linkedDocsRead.ok
      ? null
      : technicianCharges.map((charge) => ({
          costDocumentId: charge.cost_document_id,
          linkedDocumentIds: charge.document_links.map((link) => link.document.id),
          netAmount: charge.net_amount,
          currency: charge.currency,
        })),
    technicianDocumentIds: linkedDocsRead.ok ? linkedDocsRead.value : null,
  });
  const EXCLUDED_KIND_LABEL = { gastos: "gastos", tecnicos: "técnicos" } as const;

  // Where this page was opened from, and this page itself as the way back of
  // the ones it opens (with that origin, so coming back keeps it).
  const back = backTarget(id, volver, { href: `/companies/${id}/projects/board`, label: "Volver al tablero" });
  const thisPage = withVolver(`/companies/${id}/projects/${projectId}`, back.exact ? back.href : null);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title={project.name}
        subtitle={[project.client_name, project.business_area_name]
          .filter(Boolean)
          .join(" · ")}
        back={back}
        actions={
          <>
            {project.client_monthly ? (
              <LinkButton
                href={`/companies/${id}/projects/new?repeat_from=${projectId}`}
                variant="secondary"
              >
                Repetir del mes anterior
              </LinkButton>
            ) : null}
            <LinkButton
              href={`/companies/${id}/projects/${projectId}/manual-sale`}
              variant="secondary"
            >
              Registrar venta sin factura
            </LinkButton>
            <LinkButton
              href={`/companies/${id}/projects/${projectId}/quick-expense`}
              variant="primary"
            >
              + Agregar gasto
            </LinkButton>
            <LinkButton
              href={withVolver(`/companies/${id}/projects/${projectId}/edit`, thisPage)}
              variant="secondary"
            >
              Editar
            </LinkButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {realQuotes.length === 0 ? (
            <Badge variant="neutral">Sin cotización</Badge>
          ) : (
            realQuotes.map((quote) => (
              <Badge key={quote.id} variant="outline">
                {quote.quote_number}
              </Badge>
            ))
          )}
          <Badge variant={project.invoiceable ? "positive" : "neutral"}>
            {project.invoiceable ? "Facturable" : "No facturable"}
          </Badge>
        </div>
        <AddQuoteForm companyId={id} projectId={projectId} />
      </div>

      <section aria-label="Facturado vs. cotizado" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
            Facturado vs. cotizado
          </h2>
          <span className="text-[12.5px] text-[var(--color-ink-2)]">
            <Money value={billingTotals.billed} currency={projectCurrency} showCurrency={false} /> de{" "}
            {billingTotals.quoted === null ? (
              "sin monto cotizado"
            ) : (
              <Money value={billingTotals.quoted} currency={projectCurrency} showCurrency={showProjectCurrency} />
            )}
            {billingTotals.pct !== null ? (
              <span className="ml-1.5 font-mono font-semibold text-[var(--color-ink)]">
                {billingTotals.pct.toLocaleString("es", { maximumFractionDigits: 1 })}%
              </span>
            ) : null}
            {billingTotals.suggested > 0 ? (
              <span className="ml-1.5 text-[var(--color-warning-ink)]">
                (+<Money value={billingTotals.suggested} currency={projectCurrency} showCurrency={false} /> sugerido sin confirmar)
              </span>
            ) : null}
          </span>
        </div>
        {billingRows.length === 0 ? null : (
          <TableCard>
            <thead>
              <tr>
                <Th>Cotización</Th>
                <Th align="right">Cotizado</Th>
                <Th align="right">Facturado</Th>
                <Th align="right">%</Th>
              </tr>
            </thead>
            <tbody>
              {billingRows.map((row) => (
                <Tr key={row.project_quote_id}>
                  <Td className="font-mono text-[12.5px]">{row.quote_number}</Td>
                  <Td align="right">
                    {row.quoted_amount === null ? (
                      <span className="text-[var(--color-faint)]">—</span>
                    ) : (
                      <Money value={row.quoted_amount} currency={projectCurrency} showCurrency={false} />
                    )}
                  </Td>
                  <Td align="right">
                    <Money value={row.billed_amount} currency={projectCurrency} showCurrency={false} />
                    {row.suggested_amount > 0 ? (
                      <span className="block text-[11px] text-[var(--color-warning-ink)]">
                        + <Money value={row.suggested_amount} currency={projectCurrency} showCurrency={false} /> sugerido
                      </span>
                    ) : null}
                  </Td>
                  <Td align="right" className="font-mono text-[12.5px]">
                    {row.billed_pct === null ? "—" : `${row.billed_pct.toLocaleString("es", { maximumFractionDigits: 1 })}%`}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
        {billedWithoutQuote > 0 ? (
          <p className="text-[12.5px] text-[var(--color-ink-2)]">
            Facturado al trabajo sin cotización:{" "}
            <Money value={billedWithoutQuote} currency={projectCurrency} showCurrency={showProjectCurrency} />
          </p>
        ) : null}
        <p className="text-[11.5px] text-[var(--color-muted)]">
          Lo facturado sale de las facturas asignadas a este trabajo (Ventas → Asignar).
        </p>
        {!salesRead.ok ? (
          <DataIncompleteBanner details={["las facturas de este trabajo"]} />
        ) : salesRead.value.length > 0 ? (
          <div
            aria-label="Facturas del trabajo"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--color-ink-2)]"
          >
            <span className="font-medium">Facturas:</span>
            {salesRead.value.map((document) => (
              <Link
                key={document.id}
                href={withVolver(`/companies/${id}/sales/${document.id}/edit`, thisPage)}
                title={`${document.document_date} · neto ${formatAmount(document.net_amount, document.currency)} ${document.currency}`}
                className={`font-mono font-medium text-[var(--color-accent-strong)] ${document.voided ? "line-through opacity-70" : ""}`}
              >
                {[SALES_DOCUMENT_PREFIX[document.document_type] ?? document.document_type, document.document_number]
                  .filter(Boolean)
                  .join(" ")}
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-label="Resumen del proyecto" className="flex flex-col gap-2">
        <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-[var(--color-muted)]">
          Resumen del proyecto
          <span className="ml-1.5 font-normal normal-case tracking-normal">
            · neto sin IVA, en {projectCurrency}
          </span>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryCard
            label="Total cotizado"
            value={summary.quoted}
            currency={projectCurrency}
            hint="Suma neta de las cotizaciones del trabajo."
          />
          <SummaryCard
            label="Total facturado"
            value={summary.billed}
            currency={projectCurrency}
            hint="Facturas y ventas asignadas al trabajo, netas (confirmadas)."
          />
          <SummaryCard
            label="Total gastos"
            value={summary.expenses}
            currency={projectCurrency}
            hint="Gastos asignados al trabajo, netos, sin los de técnicos."
          />
          <SummaryCard
            label="Total técnicos"
            value={summary.technicians}
            currency={projectCurrency}
            hint="Cargos de técnicos: factura neta, boleta bruta (líquido + retención), sin respaldo el monto cargado."
          />
          <SummaryCard
            label="Margen"
            value={summary.margin}
            currency={projectCurrency}
            signed
            hint="Facturado − (gastos + técnicos)."
          />
          <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
            <span className="caps-label text-[var(--color-muted)]" title="Margen / facturado × 100.">
              Margen %
            </span>
            <span className={`font-mono text-[15px] tabular-nums ${summary.marginPct === null ? "text-[var(--color-muted)]" : signTone(summary.marginPct)}`}>
              {summary.marginPct === null
                ? "—"
                : `${summary.marginPct.toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
            </span>
          </div>
        </div>
        {summary.excluded.length > 0 ? (
          <p className="text-[11.5px] text-[var(--color-warning-ink)]">
            No incluye montos en otra moneda:{" "}
            {summary.excluded.map((item, index) => (
              <span key={`${item.kind}-${item.currency}`}>
                {index > 0 ? "; " : ""}
                {EXCLUDED_KIND_LABEL[item.kind]} <Money value={item.amount} currency={item.currency} />
              </span>
            ))}
            .
          </p>
        ) : null}
      </section>

      {logReadFailed ? (
        <DataIncompleteBanner details={["el checklist y las notas de este trabajo"]} />
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ProjectChecklist companyId={id} projectId={projectId} items={checklist} />
          <ProjectNotes
            companyId={id}
            projectId={projectId}
            notes={notes}
            currentUserId={user.id}
            authorNames={authorNames}
          />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Técnicos</h2>
          <LinkButton href={`/companies/${id}/projects/${projectId}/technician-charges/new`} variant="secondary">
            + Cargo de técnico
          </LinkButton>
        </div>
        {technicianReadFailed ? (
          <DataIncompleteBanner details={["los cargos de los técnicos de este trabajo"]} />
        ) : technicianCharges.length === 0 ? (
          <TableCard>
            <tbody>
              <tr>
                <td>
                  <EmptyState message="Ningún técnico externo cargó este trabajo todavía." />
                </td>
              </tr>
            </tbody>
          </TableCard>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th>Técnico</Th>
                <Th>Descripción</Th>
                <Th align="right">{backedCompany ? "Total a pagar" : "Cobra"}</Th>
                <Th align="right">{backedCompany ? "Costo (neto)" : "Costo (sin IVA)"}</Th>
                <Th>Documento</Th>
                <Th>Pago</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {technicianCharges.map((charge) => {
                const status = paymentStatus(charge.amount, charge.paid);
                const documentName = documentLabel(documentByTechnician.get(charge.personnel_id) ?? null);

                return (
                  <Tr key={charge.id}>
                    <Td>{charge.charge_date}</Td>
                    <Td>
                      <Link
                        href={`/companies/${id}/personnel/${charge.personnel_id}/account`}
                        className="text-[var(--color-ink)]"
                      >
                        {charge.personnel_name}
                      </Link>
                    </Td>
                    <Td className="text-[var(--color-ink-2)]">
                      <span className="flex flex-col gap-0.5">
                        <span>{charge.description ?? "—"}</span>
                        <ChargeBacking charge={charge} />
                      </span>
                    </Td>
                    <Td align="right">
                      <Money value={charge.amount} currency={charge.currency} showCurrency={charge.currency !== currency} />
                    </Td>
                    <Td align="right">
                      <Money
                        value={charge.net_amount}
                        currency={charge.currency}
                        showCurrency={charge.currency !== currency}
                      />
                    </Td>
                    <Td>
                      <ChargeDocumentCell companyId={id} charge={charge} documentName={documentName} />
                    </Td>
                    <Td>
                      <div className="flex flex-col gap-1">
                        <Badge
                          variant={status === "pagado" ? "positive" : status === "parcial" ? "warning" : "neutral"}
                        >
                          {PAYMENT_STATUS_LABEL[status]}
                        </Badge>
                        {status === "parcial" ? (
                          <span className="text-[11px] text-[var(--color-muted)]">
                            Falta <Money value={charge.outstanding} currency={charge.currency} showCurrency={charge.currency !== currency} />
                          </span>
                        ) : null}
                      </div>
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-3">
                        {charge.outstanding > 0 ? (
                          <Link
                            href={`/companies/${id}/projects/${projectId}/technician-charges/${charge.id}/pay`}
                            className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                          >
                            Registrar pago
                          </Link>
                        ) : null}
                        <Link
                          href={`/companies/${id}/projects/${projectId}/technician-charges/${charge.id}/edit`}
                          className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                        >
                          Corregir
                        </Link>
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableCard>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">
          Últimos gastos
        </h2>
        {!costsRead.ok ? (
          <DataIncompleteBanner details={["los gastos de este trabajo"]} />
        ) : costs.length === 0 ? (
          <TableCard>
            <tbody>
              <tr>
                <td>
                  <EmptyState
                    message="Todavía no hay gastos cargados en este trabajo."
                    action={
                      <LinkButton
                        href={`/companies/${id}/projects/${projectId}/quick-expense`}
                        variant="primary"
                      >
                        + Agregar gasto
                      </LinkButton>
                    }
                  />
                </td>
              </tr>
            </tbody>
          </TableCard>
        ) : (
          <TableCard>
            <thead>
              <tr>
                <Th>Fecha</Th>
                <Th>Documento</Th>
                <Th>Categoría</Th>
                <Th>Descripción</Th>
                <Th>Proveedor</Th>
                <Th>Estado</Th>
                <Th align="right">Monto</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {costs.map((cost, index) => (
                <Tr key={`${cost.id}-${index}`}>
                  <Td>{cost.document_date}</Td>
                  <Td className="whitespace-nowrap font-mono text-[12.5px]">{cost.document_label ?? "—"}</Td>
                  <Td>
                    {cost.category
                      ? (CATEGORY_LABEL[cost.category] ?? cost.category)
                      : "—"}
                  </Td>
                  <Td className="text-[var(--color-ink-2)]">{cost.description ?? "—"}</Td>
                  <Td>{cost.supplier_name ?? "—"}</Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <Badge
                        variant={
                          cost.status === "provisional" ? "warning" : "positive"
                        }
                      >
                        {STATUS_LABEL[cost.status] ?? cost.status}
                      </Badge>
                      {cost.status === "provisional" && !cost.has_attachment ? (
                        <span className="text-[11px] text-[var(--color-muted)]">
                          Sin comprobante
                        </span>
                      ) : null}
                      {cost.is_allocated_share ? (
                        <span className="text-[11px] text-[var(--color-muted)]">
                          Prorrateo de costo general
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td align="right">
                    <Money
                      value={cost.amount}
                      currency={cost.currency}
                      showCurrency={cost.currency !== currency}
                    />
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                      <Link
                        href={withVolver(`/companies/${id}/costs/${cost.id}?projectId=${projectId}`, thisPage)}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Ver
                      </Link>
                      <UnassignCostButton
                        companyId={id}
                        projectId={projectId}
                        costDocumentId={cost.id}
                        summary={costDeletionSummary({
                          description: cost.description,
                          supplierName: cost.supplier_name,
                          date: cost.document_date,
                        })}
                        amount={cost.amount}
                        currency={cost.currency}
                        isAllocatedShare={cost.is_allocated_share}
                        technicianChargeHref={chargeHrefByCost.get(cost.id) ?? null}
                      />
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </div>
    </div>
  );
}
