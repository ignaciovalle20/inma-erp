import { redirect } from "next/navigation";
import { getSession, getUserCompanies, getMcpAccessTokens } from "@/lib/dal";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { McpTokensForm } from "./form";

export default async function McpSettingsPage() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [companies, tokens] = await Promise.all([getUserCompanies(), getMcpAccessTokens()]);

  return (
    <AppShell companies={companies} userEmail={user.email ?? ""}>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-5">
        <PageHeader
          eyebrow="CUENTA"
          title="Acceso MCP"
          subtitle="Tokens personales para que un cliente MCP (por ejemplo, una sesión de Claude Code) pueda leer datos y proponer altas en esta app. Toda escritura pasa por tu confirmación antes de guardarse -- nada se crea de un solo llamado."
        />
        <Card padding="0">
          <McpTokensForm tokens={tokens} />
        </Card>
      </div>
    </AppShell>
  );
}
