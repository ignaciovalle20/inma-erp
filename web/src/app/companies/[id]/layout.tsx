import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getUserCompanies } from "@/lib/dal";
import { Sidebar } from "@/components/Sidebar";

export default async function CompanyLayout({
  children,
  params,
}: LayoutProps<"/companies/[id]">) {
  const { id } = await params;

  // getSession/getCompanyForEdit/getUserCompanies are each cached per
  // request (see lib/dal.ts), so running them in parallel here costs
  // one auth round-trip total, shared with whatever the page below
  // also calls -- not three sequential ones.
  const [user, membership, companies] = await Promise.all([
    getSession(),
    getCompanyForEdit(id),
    getUserCompanies(),
  ]);

  if (!user) {
    redirect("/login");
  }

  if (!membership) {
    redirect("/companies");
  }

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
