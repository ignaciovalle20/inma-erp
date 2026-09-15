import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getUserCompanies, getAiSettings } from "@/lib/dal";
import { Sidebar } from "@/components/Sidebar";
import { AssistantChat } from "@/components/assistant/AssistantChat";

export default async function CompanyLayout({
  children,
  params,
}: LayoutProps<"/companies/[id]">) {
  const { id } = await params;

  // getSession/getCompanyForEdit/getUserCompanies/getAiSettings are each
  // cached per request (see lib/dal.ts), so running them in parallel
  // here costs one auth round-trip total, shared with whatever the page
  // below also calls -- not four sequential ones.
  const [user, membership, companies, aiSettings] = await Promise.all([
    getSession(),
    getCompanyForEdit(id),
    getUserCompanies(),
    getAiSettings(),
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
      <AssistantChat companyId={id} hasAiSettings={aiSettings !== null} />
    </div>
  );
}
