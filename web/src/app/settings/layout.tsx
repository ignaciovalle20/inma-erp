import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { AppShell } from "@/components/AppShell";
import { SettingsNav } from "@/components/SettingsNav";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();

  return (
    <AppShell companies={companies} userEmail={user.email ?? ""}>
      <div className="mx-auto flex w-full max-w-[820px] gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </AppShell>
  );
}
