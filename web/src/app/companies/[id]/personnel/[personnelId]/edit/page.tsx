import { redirect } from "next/navigation";
import { getSession, getPersonnelForEdit, getCompanyForEdit, getSuppliers } from "@/lib/dal";
import { companyConfig } from "@/lib/companyConfig";
import { getTechnicianSuppliers, type TechnicianSupplier } from "@/lib/technicianDal";
import { EditPersonnelForm } from "./form";
import { TechnicianSuppliers } from "./technician-suppliers";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";

export default async function EditPersonnelPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string }>;
}) {
  const { id, personnelId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [person, membership] = await Promise.all([
    getPersonnelForEdit(id, personnelId),
    getCompanyForEdit(id),
  ]);

  if (!person || !membership) {
    redirect(`/companies/${id}/personnel`);
  }

  // Chile: the technician's RUTs (suppliers) are part of the ficha.
  const backed = companyConfig(membership.company).country === "CL";
  const showSuppliers = backed && person.type === "contractor";
  let linked: TechnicianSupplier[] = [];
  let available: { id: string; name: string; tax_id: string | null }[] = [];
  let suppliersFailed = false;
  if (showSuppliers) {
    try {
      const [allLinks, suppliers] = await Promise.all([getTechnicianSuppliers(id), getSuppliers(id)]);
      linked = allLinks.filter((link) => link.personnel_id === personnelId);
      const taken = new Set(allLinks.map((link) => link.supplier_id));
      available = suppliers
        .filter((supplier) => supplier.active && !taken.has(supplier.id))
        .map((supplier) => ({ id: supplier.id, name: supplier.name, tax_id: supplier.tax_id }));
    } catch (error) {
      console.error(error);
      suppliersFailed = true;
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN / PERSONAL"
        title={`Editar ${person.name}`}
        back={{ href: `/companies/${id}/personnel`, label: "Volver a Personal" }}
      />
      <Card>
        <EditPersonnelForm companyId={id} person={person} currency={membership.company.currency} backed={backed} />
      </Card>
      {showSuppliers ? (
        suppliersFailed ? (
          <DataIncompleteBanner details={["los RUT vinculados al técnico"]} />
        ) : (
          <Card>
            <TechnicianSuppliers companyId={id} personnelId={personnelId} linked={linked} available={available} />
          </Card>
        )
      ) : null}
    </div>
  );
}
