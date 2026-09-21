import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getProjects,
  getProjectCosts,
  getProjectQuotes,
  getPersonnel,
  type Personnel,
} from "@/lib/dal";
import { getTechnicianCharges, type TechnicianCharge } from "@/lib/technicianDal";
import { PAYMENT_STATUS_LABEL, documentLabel, paymentStatus } from "@/lib/technicians";
import { computeProjectProfitability } from "@/lib/reporting";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { Badge } from "@/components/Badge";
import { AddQuoteForm } from "./add-quote-form";
import { DocumentStatusButton } from "./technician-charges/document-status-button";

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

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function SummaryCard({
  label,
  value,
  currency,
}: {
  label: string;
  value: number;
  currency: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
      <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
        {label}
      </span>
      <Money
        value={value}
        currency={currency}
        showCurrency={false}
        className="text-[15px]"
      />
    </div>
  );
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string; projectId: string }>;
}) {
  const { id, projectId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a project's detail --
  // same gate the projects list page uses.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const projects = await getProjects(id);
  const project = projects.find((candidate) => candidate.id === projectId);

  if (!project) {
    notFound();
  }

  const [profitability, costs, quotes] = await Promise.all([
    computeProjectProfitability(id, projectId, currentMonth()),
    getProjectCosts(id, projectId),
    getProjectQuotes(id, projectId),
  ]);

  // The technicians' charges of this job, and who they are (for the document
  // each one issues). A failed read is said on screen: an empty section would
  // read as "no technician worked on this job".
  let technicianCharges: TechnicianCharge[] = [];
  let personnel: Personnel[] = [];
  let technicianReadFailed = false;
  try {
    [technicianCharges, personnel] = await Promise.all([
      getTechnicianCharges(id, { projectId }),
      getPersonnel(id),
    ]);
  } catch (error) {
    console.error(error);
    technicianReadFailed = true;
  }
  const documentByTechnician = new Map(personnel.map((person) => [person.id, person.payment_document]));

  // Life-to-date figures (not just the current month) are what "¿cuánto
  // vendí este trabajo y cuánto gasté?" actually asks -- a project can
  // span several months.
  const marginPct =
    profitability.accumulatedRevenue !== 0
      ? (profitability.accumulatedMargin / profitability.accumulatedRevenue) * 100
      : null;

  const currency = membership.company.currency;

  return (
    <div className="flex flex-col gap-[18px]">
      {profitability.hasError ? <DataIncompleteBanner details={profitability.errors ?? []} /> : null}

      <PageHeader
        eyebrow="GESTIÓN / TRABAJOS"
        title={project.name}
        subtitle={[project.client_name, project.business_area_name]
          .filter(Boolean)
          .join(" · ")}
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
              href={`/companies/${id}/projects/${projectId}/edit`}
              variant="secondary"
            >
              Editar
            </LinkButton>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {quotes.length === 0 ? (
            <Badge variant="neutral">Sin cotización</Badge>
          ) : (
            quotes.map((quote) => (
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          label="Venta"
          value={profitability.accumulatedRevenue}
          currency={currency}
        />
        <SummaryCard
          label="Costos"
          value={profitability.accumulatedCosts}
          currency={currency}
        />
        <SummaryCard
          label="Margen"
          value={profitability.accumulatedMargin}
          currency={currency}
        />
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
          <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Margen %
          </span>
          <span className="font-mono text-[15px] tabular-nums text-[var(--color-ink)]">
            {marginPct === null ? "—" : `${marginPct.toFixed(0)}%`}
          </span>
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
          <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Presupuesto
          </span>
          {profitability.budget === null ? (
            <span className="text-[15px] text-[var(--color-muted)]">Sin presupuesto</span>
          ) : (
            <Money
              value={profitability.budget}
              currency={currency}
              showCurrency={false}
              className="text-[15px]"
            />
          )}
        </div>
        {profitability.budgetVariance !== null ? (
          <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
            <span className="font-mono text-[9.5px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
              Desvío vs. presupuesto
            </span>
            <Money
              value={profitability.budgetVariance}
              currency={currency}
              showCurrency={false}
              className="text-[15px]"
            />
            <span className="text-[11px] text-[var(--color-muted)]">
              {profitability.budgetVariance > 0 ? "por encima del presupuesto" : "por debajo del presupuesto"}
            </span>
          </div>
        ) : null}
      </div>

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
                <Th align="right">Cobra</Th>
                <Th align="right">Costo (sin IVA)</Th>
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
                    <Td className="text-[var(--color-ink-2)]">{charge.description ?? "—"}</Td>
                    <Td align="right">
                      <Money value={charge.amount} currency={currency} showCurrency={false} />
                    </Td>
                    <Td align="right">
                      <Money value={charge.net_amount} currency={currency} showCurrency={false} />
                    </Td>
                    <Td>
                      <DocumentStatusButton
                        companyId={id}
                        projectId={projectId}
                        chargeId={charge.id}
                        status={charge.document_status}
                        documentName={documentName}
                      />
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
                            Falta <Money value={charge.outstanding} currency={currency} showCurrency={false} />
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
        {costs.length === 0 ? (
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
                      showCurrency={false}
                    />
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/companies/${id}/costs/${cost.id}?projectId=${projectId}`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Ver
                    </Link>
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
