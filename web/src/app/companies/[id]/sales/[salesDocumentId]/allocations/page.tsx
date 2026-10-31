import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSalesDocumentForEdit, getClients } from "@/lib/dal";
import {
  describeAllocationTargets,
  getAllocationTargets,
  getAllocationsForDocument,
  getDocumentAllocationSummary,
} from "@/lib/salesAllocations";
import { PageHeader } from "@/components/PageHeader";
import { backTarget, withVolver } from "@/lib/backNavigation";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { formatDisplayDate, paymentStatusLabel, paymentStatusVariant } from "@/lib/paymentStatus";
import { SalesAllocationForm } from "./form";

const DOCUMENT_PREFIX: Record<string, string> = {
  invoice: "FAC",
  credit_note: "N/C",
  receipt: "REC",
  manual: "Manual",
};

/**
 * Editor de asignaciones de una factura: which recurring service periods
 * and job quotes it pays for, and how much of it goes to each (whole
 * document, manual amounts). By default the destinations offered are the
 * document client's; ?todos=1 offers every client's.
 */
export default async function SalesDocumentAllocationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; salesDocumentId: string }>;
  searchParams: Promise<{ todos?: string; volver?: string }>;
}) {
  const { id, salesDocumentId } = await params;
  const sp = await searchParams;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const [document, summary, allocations, clients] = await Promise.all([
    getSalesDocumentForEdit(id, salesDocumentId),
    getDocumentAllocationSummary(id, salesDocumentId),
    getAllocationsForDocument(id, salesDocumentId),
    getClients(id),
  ]);

  if (!document) {
    redirect(`/companies/${id}/sales`);
  }

  const allClients = sp.todos === "1";
  const basePath = `/companies/${id}/sales/${salesDocumentId}/allocations`;
  const back = backTarget(
    id,
    sp.volver,
    sp.volver === "conciliar"
      ? { href: `/companies/${id}/sales/reconcile`, label: "Pendientes de conciliar" }
      : { href: `/companies/${id}/sales`, label: "Ventas" },
  );
  const clientName = clients.find((client) => client.id === document.client_id)?.name ?? "Cliente desconocido";
  const label = `${DOCUMENT_PREFIX[document.document_type] ?? document.document_type}${
    summary?.document_number ? ` ${summary.document_number}` : ""
  }`;

  const [targets, known] = await Promise.all([
    summary
      ? getAllocationTargets(id, {
          clientId: allClients ? null : document.client_id,
          documentMonth: document.document_date.slice(0, 7),
        })
      : Promise.resolve([]),
    describeAllocationTargets(id, allocations),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <PageHeader
        eyebrow="GESTIÓN / VENTAS / ASIGNACIÓN"
        title={`Asignar ${label}`}
        subtitle={`${clientName} · ${formatDisplayDate(document.document_date)}`}
        back={back}
        actions={
          <LinkButton href={`/companies/${id}/sales/${salesDocumentId}/edit`} variant="secondary">
            Ver documento
          </LinkButton>
        }
      />

      {!summary ? (
        <Card>
          <p className="text-[13px] text-[var(--color-ink-2)]">
            Las notas de crédito y los documentos anulados no se asignan a servicios ni cotizaciones.
          </p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={paymentStatusVariant(summary.payment_status)}>
                {paymentStatusLabel(summary.payment_status)}
              </Badge>
              <span className="text-[var(--color-muted)]">
                El estado de pago de la factura es el que pasa a los períodos asignados.
              </span>
            </div>
            <Link
              href={withVolver(allClients ? basePath : `${basePath}?todos=1`, sp.volver)}
              className="text-[var(--color-accent-strong)]"
            >
              {allClients ? "Solo destinos de este cliente" : "Ver destinos de todos los clientes"}
            </Link>
          </div>
          <Card>
            <SalesAllocationForm
              companyId={id}
              document={{
                id: document.id,
                net_amount: document.net_amount,
                currency: document.currency,
                client_id: document.client_id,
              }}
              allocations={allocations}
              targets={targets}
              knownTargets={Object.fromEntries(known)}
            />
          </Card>
        </>
      )}
    </div>
  );
}
