import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getPersonnel, type Personnel } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { Money } from "@/components/Money";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import { getTechnicianCharges } from "@/lib/technicianDal";
import { summarizeByTechnician, type TechnicianSummary } from "@/lib/technicians";

const TYPE_LABEL: Record<string, string> = {
  employee: "Empleado",
  partner: "Socio",
  contractor: "Técnico externo",
};

export default async function PersonnelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's personnel --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  // A failed read must not look like "there is no personnel yet": it is said on
  // screen, with the reason, instead of the empty state.
  let personnel: Personnel[] = [];
  let loadError: string | null = null;
  try {
    personnel = await getPersonnel(id);
  } catch (thrown) {
    console.error(thrown);
    loadError = thrown instanceof Error ? thrown.message : "No se pudo leer el personal.";
  }

  // The saldo of the external technicians. A failed read must not look like
  // "we owe nothing": the list still shows, with the failure said above it.
  let balances = new Map<string, TechnicianSummary>();
  let balancesFailed = false;
  if (personnel.some((person) => person.type === "contractor")) {
    try {
      balances = summarizeByTechnician(await getTechnicianCharges(id));
    } catch (error) {
      console.error(error);
      balancesFailed = true;
    }
  }
  const currency = membership.company.currency;

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / PERSONAL"
        title="Personal"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/personnel/new`} variant="primary">
            Nueva persona
          </LinkButton>
        }
      />

      {balancesFailed ? <DataIncompleteBanner details={["los cargos de los técnicos (los saldos no se muestran)"]} /> : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
        >
          {loadError}
        </div>
      ) : personnel.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay personal todavía para esta empresa." />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Nombre</Th>
              <Th>Tipo</Th>
              <Th align="right">Saldo a pagar</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {personnel.map((person) => (
              <Tr key={person.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {person.name}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {TYPE_LABEL[person.type] ?? person.type}
                </Td>
                <Td align="right">
                  {person.type !== "contractor" || balancesFailed ? (
                    <span className="text-[var(--color-faint)]">—</span>
                  ) : (
                    <Money value={balances.get(person.id)?.balance ?? 0} currency={currency} showCurrency={false} />
                  )}
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <StatusDot status={person.active ? "active" : "inactive"} />
                    <span
                      className={
                        person.active
                          ? "text-[var(--color-accent-strong)]"
                          : "text-[var(--color-muted)]"
                      }
                    >
                      {person.active ? "Activo" : "Inactivo"}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-3">
                    {person.type === "contractor" ? (
                      <Link
                        href={`/companies/${id}/personnel/${person.id}/account`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Cuenta corriente
                      </Link>
                    ) : (
                      <Link
                        href={`/companies/${id}/personnel/${person.id}/costs`}
                        className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                      >
                        Costos
                      </Link>
                    )}
                    <Link
                      href={`/companies/${id}/personnel/${person.id}/edit`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Editar
                    </Link>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
