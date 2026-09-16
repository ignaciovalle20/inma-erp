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
      <Card className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-[var(--color-muted)]">
          Cómo conectar
        </span>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          La URL del servidor es <code className="rounded bg-[var(--color-row)] px-1.5 py-0.5">https://tu-dominio/api/mcp</code>.
        </p>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          <strong className="text-[var(--color-ink)]">Claude Code</strong> y clientes que dejan poner un
          header propio: mandá el token como{" "}
          <code className="rounded bg-[var(--color-row)] px-1.5 py-0.5">Authorization: Bearer &lt;token&gt;</code>.
        </p>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-2)]">
          <strong className="text-[var(--color-ink)]">ChatGPT</strong> y otros conectores sin ese campo
          (solo &quot;Sin autenticación&quot; u OAuth): elegí &quot;Sin autenticación&quot; y agregá el token
          directamente en la URL como{" "}
          <code className="rounded bg-[var(--color-row)] px-1.5 py-0.5">
            https://tu-dominio/api/mcp?token=&lt;token&gt;
          </code>
          . Si lo compartís sin querer, revocalo acá y generá uno nuevo.
        </p>
      </Card>
    </div>
  );
}
