import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getUserCompanies } from "@/lib/dal";
import { Sidebar } from "@/components/Sidebar";

export default async function CompanyLayout({
  children,
  params,
}: LayoutProps<"/companies/[id]">) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const companies = await getUserCompanies();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        companyId={id}
        companyName={membership.company.name}
        companyCurrency={membership.company.currency}
        companies={companies.map((company) => ({
          id: company.id,
          name: company.name,
          currency: company.currency,
        }))}
        userEmail={user.email ?? ""}
        role={membership.role}
      />
      <main className="flex-1 overflow-y-auto bg-[var(--color-canvas)] px-7 py-[22px]">
        {children}
      </main>
    </div>
  );
}
