import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSuppliers } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";

export default async function SuppliersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's suppliers --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const suppliers = await getSuppliers(id);

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        eyebrow="MAESTROS / PROVEEDORES"
        title="Proveedores"
        subtitle={membership.company.name}
        actions={
          <LinkButton href={`/companies/${id}/suppliers/new`} variant="primary">
            Nuevo proveedor
          </LinkButton>
        }
      />

      {suppliers.length === 0 ? (
        <TableCard>
          <tbody>
            <tr>
              <td>
                <EmptyState
                  message="No hay proveedores todavía para esta empresa."
                  action={
                    <LinkButton href={`/companies/${id}/suppliers/new`}>
                      Nuevo proveedor
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
              <Th>Proveedor</Th>
              <Th>RUT/RUC</Th>
              <Th>País</Th>
              <Th>Estado</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {suppliers.map((supplier) => (
              <Tr key={supplier.id}>
                <Td className="font-medium text-[var(--color-ink)]">
                  {supplier.name}
                </Td>
                <Td className="font-mono text-[12.5px] text-[var(--color-ink-2)]">
                  {supplier.tax_id ?? "—"}
                </Td>
                <Td className="text-[var(--color-ink-2)]">
                  {supplier.country ?? "—"}
                </Td>
                <Td>
                  <span className="flex items-center gap-1.5 text-[12.5px]">
                    <StatusDot status={supplier.active ? "active" : "inactive"} />
                    <span
                      className={
                        supplier.active
                          ? "text-[var(--color-accent-strong)]"
                          : "text-[var(--color-muted)]"
                      }
                    >
                      {supplier.active ? "Activo" : "Inactivo"}
                    </span>
                  </span>
                </Td>
                <Td align="right">
                  <Link
                    href={`/companies/${id}/suppliers/${supplier.id}/edit`}
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
