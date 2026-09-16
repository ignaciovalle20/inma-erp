import { getMcpAccessTokens } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { McpTokensForm } from "./form";

export default async function McpSettingsPage() {
  const tokens = await getMcpAccessTokens();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN IA"
        title="Acceso MCP"
        subtitle="Tokens personales para que un cliente MCP (por ejemplo, una sesión de Claude Code) pueda leer datos y proponer altas en esta app. Toda escritura pasa por tu confirmación antes de guardarse -- nada se crea de un solo llamado."
      />
      <Card padding="0">
        <McpTokensForm tokens={tokens} />
      </Card>
    </div>
  );
}
