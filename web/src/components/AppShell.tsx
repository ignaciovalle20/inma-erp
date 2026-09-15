import { Sidebar, type SidebarCompany } from "@/components/Sidebar";
import { AssistantChat } from "@/components/assistant/AssistantChat";
import { TopBar } from "@/components/TopBar";
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
    <div className="flex h-screen overflow-hidden">
      <Sidebar companies={companies} userEmail={userEmail} />
      <main className="flex-1 overflow-y-auto bg-[var(--color-canvas)]">
        <TopBar />
        <div className="px-7 py-[22px]">{children}</div>
      </main>
      <AssistantChat hasAiSettings={settings !== null} />
    </div>
  );
}
