import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getManagementStartDate } from "@/lib/dal";
import { EditCompanyForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";

export default async function EditCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const result = await getCompanyForEdit(id);

  if (!result || result.role !== "admin") {
    redirect("/companies");
  }

  // Read apart from the company: if the migration is not applied yet, the rest
  // of the form keeps working and says why the date field is missing.
  let managementStartDate: string | null | undefined;
  let managementDateError: string | null = null;

  try {
    managementStartDate = await getManagementStartDate(id);
  } catch (thrown) {
    console.error(thrown);
    managementStartDate = undefined;
    managementDateError = thrown instanceof Error ? thrown.message : "No se pudo leer la fecha de gestión.";
  }

  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <PageHeader eyebrow="ADMINISTRACIÓN" title={`Editar ${result.company.name}`} />
      {managementDateError ? (
        <div
          role="alert"
          className="rounded-lg border border-[var(--color-negative-soft)] bg-[var(--color-negative-soft)] px-3 py-2.5 text-[13px] text-[var(--color-negative-ink)]"
        >
          {managementDateError}
        </div>
      ) : null}
      <Card>
        <EditCompanyForm
          companyId={result.company.id}
          company={result.company}
          managementStartDate={managementStartDate}
        />
      </Card>
    </div>
  );
}
