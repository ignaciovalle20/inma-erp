import { getAiSettings } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/Card";
import { AiSettingsForm } from "./form";

export default async function AiSettingsPage() {
  const settings = await getAiSettings();

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN IA"
        title="Asistente de IA"
        subtitle="Configurá el proveedor, modelo y API key que va a usar la burbuja de chat. Es una configuración personal: vale para todas las empresas a las que tenés acceso."
      />
      <Card padding="0">
        <AiSettingsForm settings={settings} />
      </Card>
    </div>
  );
}
