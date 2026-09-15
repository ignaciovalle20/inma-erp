import { redirect } from "next/navigation";
import { getSession, getUserCompanies, getAiSettings } from "@/lib/dal";
import { AppShell } from "@/components/AppShell";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { AiSettingsForm } from "./form";

export default async function AiSettingsPage() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const [companies, settings] = await Promise.all([getUserCompanies(), getAiSettings()]);

  return (
    <AppShell companies={companies} userEmail={user.email ?? ""}>
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-5">
        <PageHeader
          eyebrow="CUENTA"
          title="Asistente de IA"
          subtitle="Configurá el proveedor, modelo y API key que va a usar la burbuja de chat. Es una configuración personal: vale para todas las empresas a las que tenés acceso."
        />
        <Card padding="0">
          <AiSettingsForm settings={settings} />
        </Card>
      </div>
    </AppShell>
  );
}
