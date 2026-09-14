import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { NewCompanyForm } from "./form";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { AppShell } from "@/components/AppShell";

export default async function NewCompanyPage() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();
  const sidebarCompanies = companies.map((company) => ({
    id: company.id,
    name: company.name,
    currency: company.currency,
  }));

  return (
    <AppShell companies={sidebarCompanies} userEmail={user.email ?? ""}>
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
        <PageHeader
          eyebrow="ADMINISTRACIÓN"
          title="Nueva empresa"
          subtitle="Vas a ser el administrador de esta empresa."
        />
        <Card>
          <NewCompanyForm />
        </Card>
      </div>
    </AppShell>
  );
}
