import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getPersonnel } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

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

  const personnel = await getPersonnel(id);

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

      {personnel.length === 0 ? (
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
                  {person.type === "employee" ? "Empleado" : "Socio"}
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
                    <Link
                      href={`/companies/${id}/personnel/${person.id}/costs`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Costos
                    </Link>
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
