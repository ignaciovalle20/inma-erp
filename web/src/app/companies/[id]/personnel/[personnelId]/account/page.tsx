import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getPersonnelForEdit } from "@/lib/dal";
import {
  getTechnicianAccount,
  getTechnicianSuppliers,
  type TechnicianCharge,
  type TechnicianPayment,
  type TechnicianSupplier,
} from "@/lib/technicianDal";
import {
  PAYMENT_STATUS_LABEL,
  RATE_FIELDS,
  backingLabel,
  documentLabel,
  paymentStatus,
  summarizeByTechnician,
} from "@/lib/technicians";
import { companyConfig } from "@/lib/companyConfig";
import { PageHeader } from "@/components/PageHeader";
import { LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { Money, formatAmount } from "@/components/Money";
import { TableCard, Th, Td, Tr } from "@/components/Table";
import { EmptyState } from "@/components/EmptyState";
import { DataIncompleteBanner } from "@/components/DataIncompleteBanner";
import {
  ChargeBacking,
  ChargeDocumentCell,
} from "../../../projects/[projectId]/technician-charges/charge-document-cell";
import { PaymentForm } from "./payment-form";
import { DeletePaymentForm } from "./delete-payment-form";

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-surface)] p-3">
      <span className="caps-label text-[var(--color-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The cuenta corriente of an external technician (docs/plan-sistema-v3.md,
 * F1): what they charged per job, what was paid and how each payment was
 * split, the saldo, and the boletas still to arrive.
 */
export default async function TechnicianAccountPage({
  params,
}: {
  params: Promise<{ id: string; personnelId: string }>;
}) {
  const { id, personnelId } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const person = await getPersonnelForEdit(id, personnelId);

  if (!person) {
    redirect(`/companies/${id}/personnel`);
  }

  // Only external technicians have a cuenta corriente; the rest have monthly costs.
  if (person.type !== "contractor") {
    redirect(`/companies/${id}/personnel/${personnelId}/costs`);
  }

  const currency = membership.company.currency;

  // Chile: each charge has its backing, and its factura / boleta is linked.
  const backed = companyConfig(membership.company).country === "CL";

  let charges: TechnicianCharge[] = [];
  let payments: TechnicianPayment[] = [];
  let suppliers: TechnicianSupplier[] = [];
  let readFailed = false;
  try {
    [{ charges, payments }, suppliers] = await Promise.all([
      getTechnicianAccount(id, personnelId),
      backed ? getTechnicianSuppliers(id, personnelId) : Promise.resolve([]),
    ]);
  } catch (error) {
    console.error(error);
    readFailed = true;
  }

  const summary = summarizeByTechnician(charges).get(personnelId);
  const documentName = backed ? "Documentos" : documentLabel(person.payment_document);
  // "Documentos recibidos": each linked factura / boleta with the charges and jobs it covers.
  const received = new Map<string, { document: NonNullable<TechnicianCharge["linked_document"]>; charges: TechnicianCharge[] }>();
  for (const charge of charges) {
    if (!charge.linked_document) continue;
    const entry = received.get(charge.linked_document.id) ?? { document: charge.linked_document, charges: [] };
    entry.charges.push(charge);
    received.set(charge.linked_document.id, entry);
  }
  const receivedDocuments = [...received.values()].sort((a, b) =>
    b.document.document_date.localeCompare(a.document.document_date),
  );
  const chargeById = new Map(charges.map((charge) => [charge.id, charge]));
  const openCharges = charges.filter((charge) => charge.outstanding > 0);
  const rates = RATE_FIELDS.flatMap(({ key, label }) => {
    const value = person.default_rates[key];
    return value ? [`${label} ${formatAmount(value, currency)}`] : [];
  });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        eyebrow="CONFIGURACIÓN / PERSONAL"
        title={`Cuenta corriente de ${person.name}`}
        subtitle="Técnico externo"
        actions={
          <>
            <LinkButton href={`/companies/${id}/personnel/${personnelId}/edit`} variant="secondary">
              Editar ficha
            </LinkButton>
            <LinkButton href={`/companies/${id}/personnel`} variant="secondary">
              Volver a Personal
            </LinkButton>
          </>
        }
      />

      {readFailed ? (
        <DataIncompleteBanner details={["la cuenta corriente del técnico (cargos y pagos)"]} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Cargado">
              <Money value={summary?.charged ?? 0} currency={currency} showCurrency={false} className="text-[15px]" />
            </Kpi>
            <Kpi label="Pagado">
              <Money value={summary?.paid ?? 0} currency={currency} showCurrency={false} className="text-[15px]" />
            </Kpi>
            <Kpi label="Saldo a pagar">
              <Money value={summary?.balance ?? 0} currency={currency} showCurrency={false} className="text-[15px]" />
            </Kpi>
            <Kpi label={backed ? "Documentos pendientes" : `${documentName} pendientes`}>
              <span className="font-mono text-[15px] tabular-nums text-[var(--color-ink)]">
                {summary?.pendingDocuments ?? 0}
              </span>
            </Kpi>
          </div>

          <Card padding="16px">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="caps-label text-[var(--color-muted)]">RUT</dt>
                <dd className="text-[var(--color-ink)]">{person.tax_id ?? "—"}</dd>
              </div>
              {backed ? (
                <>
                  <div>
                    <dt className="caps-label text-[var(--color-muted)]">Respaldo habitual</dt>
                    <dd className="text-[var(--color-ink)]">{backingLabel(person.default_backing)}</dd>
                  </div>
                  <div>
                    <dt className="caps-label text-[var(--color-muted)]">RUT vinculados</dt>
                    <dd className="text-[var(--color-ink)]">
                      {suppliers.length > 0
                        ? suppliers.map((supplier) => `${supplier.tax_id ?? "sin RUT"} (${supplier.supplier_name})`).join(" · ")
                        : "Ninguno: agregalos en la ficha para reconocer sus documentos"}
                    </dd>
                  </div>
                </>
              ) : (
                <div>
                  <dt className="caps-label text-[var(--color-muted)]">
                    Documento que emite
                  </dt>
                  <dd className="text-[var(--color-ink)]">
                    {person.payment_document ? documentName : "Sin definir"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="caps-label text-[var(--color-muted)]">
                  Tarifas habituales
                </dt>
                <dd className="text-[var(--color-ink)]">{rates.length > 0 ? rates.join(" · ") : "—"}</dd>
              </div>
              <div>
                <dt className="caps-label text-[var(--color-muted)]">
                  Datos de pago
                </dt>
                <dd className="whitespace-pre-wrap text-[var(--color-ink)]">{person.payment_details ?? "—"}</dd>
              </div>
            </dl>
          </Card>

          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Cargos por trabajo</h2>
            {charges.length === 0 ? (
              <TableCard>
                <tbody>
                  <tr>
                    <td>
                      <EmptyState message="Este técnico todavía no tiene cargos. Se cargan desde el trabajo, con “+ Cargo de técnico”." />
                    </td>
                  </tr>
                </tbody>
              </TableCard>
            ) : (
              <TableCard>
                <thead>
                  <tr>
                    <Th>Fecha</Th>
                    <Th>Trabajo</Th>
                    <Th>Descripción</Th>
                    <Th align="right">{backed ? "A pagar" : "Cobra"}</Th>
                    <Th align="right">Pagado</Th>
                    <Th align="right">Falta</Th>
                    <Th>{backed ? "Documento" : documentName}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {charges.map((charge) => {
                    const status = paymentStatus(charge.amount, charge.paid);
                    return (
                      <Tr key={charge.id}>
                        <Td>{charge.charge_date}</Td>
                        <Td>
                          <Link
                            href={`/companies/${id}/projects/${charge.project_id}`}
                            className="text-[var(--color-ink)]"
                          >
                            {charge.project_name}
                          </Link>
                        </Td>
                        <Td className="text-[var(--color-ink-2)]">
                          <span className="flex flex-col gap-0.5">
                            <span>{charge.description ?? "—"}</span>
                            <ChargeBacking charge={charge} />
                          </span>
                        </Td>
                        <Td align="right">
                          <Money value={charge.amount} currency={currency} showCurrency={false} />
                        </Td>
                        <Td align="right">
                          <div className="flex flex-col items-end gap-1">
                            <Money value={charge.paid} currency={currency} showCurrency={false} />
                            <Badge
                              variant={status === "pagado" ? "positive" : status === "parcial" ? "warning" : "neutral"}
                            >
                              {PAYMENT_STATUS_LABEL[status]}
                            </Badge>
                          </div>
                        </Td>
                        <Td align="right">
                          <Money value={charge.outstanding} currency={currency} showCurrency={false} />
                        </Td>
                        <Td>
                          <ChargeDocumentCell
                            companyId={id}
                            charge={charge}
                            documentName={documentLabel(person.payment_document)}
                          />
                        </Td>
                        <Td align="right">
                          {charge.paid === 0 && !charge.linked_document ? (
                            <Link
                              href={`/companies/${id}/projects/${charge.project_id}/technician-charges/${charge.id}/edit`}
                              className="text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                            >
                              Corregir
                            </Link>
                          ) : null}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </TableCard>
            )}
          </div>

          {backed ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Documentos recibidos</h2>
              {receivedDocuments.length === 0 ? (
                <TableCard>
                  <tbody>
                    <tr>
                      <td>
                        <EmptyState message="Todavía no hay facturas ni boletas vinculadas a sus cargos. Se vinculan desde el cargo (“Vincular documento”), desde el documento (“Es de un técnico”) o confirmando la sugerencia en Conciliar." />
                      </td>
                    </tr>
                  </tbody>
                </TableCard>
              ) : (
                <TableCard>
                  <thead>
                    <tr>
                      <Th>Fecha</Th>
                      <Th>Documento</Th>
                      <Th align="right">Neto</Th>
                      <Th>Cubre</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {receivedDocuments.map(({ document, charges: covered }) => (
                      <Tr key={document.id}>
                        <Td className="font-mono text-[12.5px]">{document.document_date}</Td>
                        <Td>
                          <Link
                            href={`/companies/${id}/costs/${document.id}/technician`}
                            className="font-mono text-[12.5px] font-medium text-[var(--color-accent-strong)]"
                          >
                            {[document.source_document_type, document.document_number].filter(Boolean).join(" ") ||
                              "Documento"}
                          </Link>
                        </Td>
                        <Td align="right">
                          <Money value={document.net_amount} currency={currency} showCurrency={false} />
                        </Td>
                        <Td>
                          <ul className="flex flex-col gap-0.5 text-[12.5px] text-[var(--color-ink-2)]">
                            {covered.map((charge) => (
                              <li key={charge.id}>
                                <Link href={`/companies/${id}/projects/${charge.project_id}`} className="text-[var(--color-ink)]">
                                  {charge.project_name}
                                </Link>{" "}
                                · {charge.charge_date} ·{" "}
                                <span className="font-mono">{formatAmount(charge.net_amount, currency)}</span>
                              </li>
                            ))}
                          </ul>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </TableCard>
              )}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Pagos</h2>
            {payments.length === 0 ? (
              <TableCard>
                <tbody>
                  <tr>
                    <td>
                      <EmptyState message="Todavía no se le registró ningún pago." />
                    </td>
                  </tr>
                </tbody>
              </TableCard>
            ) : (
              <TableCard>
                <thead>
                  <tr>
                    <Th>Fecha</Th>
                    <Th align="right">Monto</Th>
                    <Th>Medio</Th>
                    <Th>Cubre</Th>
                    <Th>Notas</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((payment) => (
                    <Tr key={payment.id}>
                      <Td>{payment.payment_date}</Td>
                      <Td align="right">
                        <Money value={payment.amount} currency={currency} showCurrency={false} />
                      </Td>
                      <Td>{payment.method ?? "—"}</Td>
                      <Td>
                        <ul className="flex flex-col gap-0.5 text-[12.5px] text-[var(--color-ink-2)]">
                          {payment.applications.map((application) => (
                            <li key={application.charge_id}>
                              {chargeById.get(application.charge_id)?.project_name ?? "Trabajo"}:{" "}
                              <span className="font-mono">{formatAmount(application.amount, currency)}</span>
                            </li>
                          ))}
                        </ul>
                      </Td>
                      <Td className="text-[var(--color-ink-2)]">{payment.notes ?? "—"}</Td>
                      <Td align="right">
                        <DeletePaymentForm companyId={id} personnelId={personnelId} paymentId={payment.id} />
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </TableCard>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-[13px] font-semibold text-[var(--color-ink)]">Registrar un pago</h2>
            <Card padding="20px">
              {openCharges.length === 0 ? (
                <p className="text-[13px] text-[var(--color-muted)]">
                  No hay cargos pendientes de pago: no hay nada que registrar.
                </p>
              ) : (
                <PaymentForm
                  key={`${payments.length}:${summary?.paid ?? 0}`}
                  companyId={id}
                  personnelId={personnelId}
                  currency={currency}
                  openCharges={openCharges.map((charge) => ({
                    id: charge.id,
                    charge_date: charge.charge_date,
                    project_name: charge.project_name,
                    description: charge.description,
                    outstanding: charge.outstanding,
                  }))}
                />
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
