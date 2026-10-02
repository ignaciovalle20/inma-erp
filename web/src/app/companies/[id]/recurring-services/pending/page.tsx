import { redirect } from "next/navigation";

/** The old "Pendientes" screen is now "Deuda" (every cycle not yet collected). */
export default async function PendingRecurringServiceOccurrencesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/companies/${id}/recurring-services/debt`);
}
