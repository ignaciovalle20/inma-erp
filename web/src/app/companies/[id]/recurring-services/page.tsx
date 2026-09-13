import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getSession,
  getCompanyForEdit,
  getRecurringServices,
  getGeneratedRecurringServicePeriods,
  type RecurringServicePeriodicity,
} from "@/lib/dal";
import { GenerateButton } from "./generate-button";

function currentPeriodStart(periodicity: RecurringServicePeriodicity): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const periodDate =
    periodicity === "annual" ? new Date(year, 0, 1) : new Date(year, month, 1);
  const yyyy = periodDate.getFullYear();
  const mm = String(periodDate.getMonth() + 1).padStart(2, "0");
  const dd = String(periodDate.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default async function RecurringServicesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's recurring
  // services -- getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const services = await getRecurringServices(id);
  const generatedPeriods = await getGeneratedRecurringServicePeriods(
    id,
    services.map((service) => service.id),
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Recurring services
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {membership.company.name}
          </p>
        </div>
        <Link
          href={`/companies/${id}/recurring-services/new`}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          New recurring service
        </Link>
      </div>

      {services.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No recurring services yet for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {services.map((service) => {
            const period = currentPeriodStart(service.periodicity);
            const alreadyGenerated = generatedPeriods.has(
              `${service.id}|${period}`,
            );
            const withinValidity =
              period >= service.start_date &&
              (!service.end_date || period <= service.end_date);
            const canGenerate =
              service.active && withinValidity && !alreadyGenerated;

            return (
              <li
                key={service.id}
                className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-black dark:text-zinc-50">
                      {service.name}
                    </span>
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs font-medium " +
                        (service.active
                          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                          : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                      }
                    >
                      {service.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">
                    {service.client_name ?? "Unknown client"} ·{" "}
                    {service.price} {service.currency} · expected cost{" "}
                    {service.expected_cost} {service.currency} ·{" "}
                    {service.periodicity}
                  </span>
                  <span className="text-sm text-zinc-500 dark:text-zinc-500">
                    Valid {service.start_date} →{" "}
                    {service.end_date ?? "no end date"}
                    {alreadyGenerated
                      ? " · this period already generated"
                      : ""}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {canGenerate ? (
                    <GenerateButton
                      companyId={id}
                      recurringServiceId={service.id}
                      periodicity={service.periodicity}
                    />
                  ) : null}
                  <Link
                    href={`/companies/${id}/recurring-services/${service.id}/edit`}
                    className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                  >
                    Edit
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Link
        href="/companies"
        className="text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
      >
        Back to companies
      </Link>
    </div>
  );
}
