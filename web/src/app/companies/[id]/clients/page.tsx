import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getClients } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

export default async function ClientsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's clients --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const clients = await getClients(id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="CONFIGURACIÓN / CLIENTES"
        title="Clientes"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/clients/new`} variant="primary">
            Nuevo cliente
          </LinkButton>
        }
      />

      {clients.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message="No hay clientes todavía para esta empresa."
                  action={
                    <LinkButton href={`/companies/${id}/clients/new`}>
                      Nuevo cliente
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
              <Th>Cliente</Th>
              <Th>RUT/RUC</Th>
              <Th>País</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <Tr key={client.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {client.name}
                </Td>
                <Td className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                  {client.tax_id ?? "—"}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {client.country ?? "—"}
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <StatusDot status={client.active ? "active" : "inactive"} />
                    <span
                      className={
                        client.active
                          ? "text-[var(--color-accent-strong)]"
                          : "text-[var(--color-muted)]"
                      }
                    >
                      {client.active ? "Activo" : "Inactivo"}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  <Link
                    href={`/companies/${id}/clients/${client.id}/edit`}
                    className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                  >
                    Editar
                  </Link>
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableCard>
      )}
    </div>
  );
}
