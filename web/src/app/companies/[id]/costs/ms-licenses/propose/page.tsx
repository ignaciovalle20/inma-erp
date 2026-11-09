import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getMsLicensePoolProposal } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { Money } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { ConfirmProposalButton } from "./confirm-button";

const MONTH_LABELS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTH_LABELS[Number(month) - 1]} ${year}`;
}

/**
 * The split of one month's MS licenses supplier invoices (Intcomex / TGM)
 * before it is saved (fix-math 2026-11, point 2): every client of the
 * pooled MS services takes a part in proportion to what was sold to it that
 * month (billed, else expected); the parts add up exactly to the invoices'
 * net. "Confirmar reparto" saves this same split.
 */
export default async function MsLicenseProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period: periodParam } = await searchParams;
  const user = await getSession();
  if (!user) redirect("/login");

  const membership = await getCompanyForEdit(id);
  if (!membership) redirect("/companies");

  const listHref = `/companies/${id}/costs/ms-licenses`;
  if (!periodParam || !/^\d{4}-\d{2}$/.test(periodParam)) redirect(listHref);
  const period = `${periodParam}-01`;

  const proposal = await getMsLicensePoolProposal(id, period);
  const month = proposal.month;
  const total = proposal.shares.reduce((sum, row) => sum + row.share, 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / COSTOS / REPARTO LICENCIAS MS"
        title={`Reparto propuesto -- ${formatPeriod(period)}`}
        subtitle={membership.company.name}
        back={{ href: listHref, label: "Reparto licencias MS" }}
      />

      {proposal.error ? (
        <p role="alert" className="text-[13px] text-[var(--color-negative-ink)]">
          {proposal.error}
        </p>
      ) : null}

      {!month ? (
        <Card>
          <p className="text-[13px] text-[var(--color-muted)]">
            No hay facturas del proveedor de licencias en {formatPeriod(period)}.
          </p>
        </Card>
      ) : month.poolId ? (
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            {formatPeriod(period)} ya tiene su reparto.{" "}
            <Link href={`${listHref}/${month.poolId}`} className="font-medium text-[var(--color-accent-strong)]">
              Abrirlo
            </Link>{" "}
            (desde ahí se puede volver a repartir).
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-[13px]">
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Proveedor</span>
                <span>{month.supplierName}</span>
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Facturas del mes</span>
                <span>{month.documentCount}</span>
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Neto a repartir (sin IVA)</span>
                <Money value={month.netTotal} currency={month.currency} />
              </div>
              <div className="flex flex-col">
                <span className="caps-label text-[var(--color-muted)]">Se reconoce en</span>
                <span>{formatPeriod(period)}, el mes de la factura</span>
              </div>
            </div>
          </Card>

          {proposal.unpooledServices.length > 0 ? (
            <p className="text-[12.5px] text-[var(--color-warning-ink)]">
              No entran en el reparto porque no usan el pool de licencias: {proposal.unpooledServices.join(", ")}.
              Si su costo es esta factura, activá &quot;Usa pool de costo compartido&quot; en cada servicio (Servicios
              recurrentes → editar) antes de confirmar.
            </p>
          ) : null}

          {proposal.shares.length === 0 ? (
            <Card>
              <p className="text-[13px] text-[var(--color-muted)]">
                Ningún servicio de licencias MS que use el pool tiene ciclo en {formatPeriod(period)}, en{" "}
                {month.currency}: no hay entre quiénes repartir.
              </p>
            </Card>
          ) : (
            <>
              <TableCard>
                <thead>
                  <tr>
                    <Th>Cliente</Th>
                    <Th>Servicio</Th>
                    <Th align="right">Vendido en el mes</Th>
                    <Th align="right">Costo que le toca</Th>
                  </tr>
                </thead>
                <tbody>
                  {proposal.shares.map((row) => (
                    <Tr key={row.occurrenceId}>
                      <Td className="font-medium text-[var(--color-ink)]">{row.clientName ?? "—"}</Td>
                      <Td className="text-[var(--color-ink-2)]">{row.serviceName}</Td>
                      <Td align="right">
                        <Money value={row.weight} currency={month.currency} showCurrency={false} />
                        {row.basis === "expected" ? (
                          <span className="block text-[11px] text-[var(--color-faint)]">esperado, sin facturar</span>
                        ) : null}
                      </Td>
                      <Td align="right">
                        <Money value={row.share} currency={month.currency} showCurrency={false} />
                      </Td>
                    </Tr>
                  ))}
                  <Tr className="hover:bg-transparent">
                    <Td className="font-semibold text-[var(--color-ink)]" colSpan={3}>
                      Total
                    </Td>
                    <Td align="right" className="font-semibold text-[var(--color-ink)]">
                      <Money value={total} currency={month.currency} showCurrency={false} />
                    </Td>
                  </Tr>
                </tbody>
              </TableCard>
              <ConfirmProposalButton companyId={id} period={period} />
            </>
          )}
        </>
      )}
    </div>
  );
}
