import { Sidebar, type SidebarCompany } from "@/components/Sidebar";
import { AssistantChat } from "@/components/assistant/AssistantChat";
import { ShellFrame } from "@/components/ShellFrame";
import { getAiSettings } from "@/lib/dal";

/**
 * Sidebar + canvas wrapper for authenticated pages that aren't scoped
 * to one company (e.g. /companies, /reports/consolidated) -- pages
 * under /companies/[id]/** get the same chrome from that segment's own
 * layout.tsx instead, with the active company wired in.
 */
export async function AppShell({
  companies,
  userEmail,
  children,
}: {
  companies: SidebarCompany[];
  userEmail: string;
  children: React.ReactNode;
}) {
  const settings = await getAiSettings();

  return (
    <ShellFrame
      sidebar={<Sidebar companies={companies} userEmail={userEmail} />}
      chat={<AssistantChat hasAiSettings={settings !== null} />}
    >
      {children}
    </ShellFrame>
  );
}
