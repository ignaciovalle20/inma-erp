import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getBusinessAreas } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

export default async function BusinessAreasPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's business
  // areas -- getCompanyForEdit doubles as the membership check here.
  // Only admins get the New/Edit links (write is admin-only via RLS).
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const isAdmin = membership.role === "admin";
  const areas = await getBusinessAreas(id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / ÁREAS DE NEGOCIO"
        title="Áreas de negocio"
        subtitle={membership.company.name}
        actions={
          isAdmin ? (
            <LinkButton href={`/companies/${id}/areas/new`} variant="primary">
              Nueva área
            </LinkButton>
          ) : undefined
        }
      />

      {areas.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState message="No hay áreas de negocio todavía para esta empresa." />
              </td>
            </tr>
          </tbody>
        </TableCard>
      ) : (
        <TableCard>
          <thead>
            <tr>
              <Th>Área</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {areas.map((area) => (
              <Tr key={area.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {area.name}
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <StatusDot status={area.active ? "active" : "inactive"} />
                    <span
                      className={
                        area.active
                          ? "text-[var(--color-accent-strong)]"
                          : "text-[var(--color-muted)]"
                      }
                    >
                      {area.active ? "Activa" : "Inactiva"}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  {isAdmin ? (
                    <Link
                      href={`/companies/${id}/areas/${area.id}/edit`}
                      className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                    >
                      Editar
                    </Link>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
