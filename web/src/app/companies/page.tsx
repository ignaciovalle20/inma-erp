import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { AppShell } from "@/components/AppShell";

export default async function CompaniesPage() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();
  const sidebarCompanies = companies.map((company) => ({
    id: company.id,
    name: company.name,
    currency: company.currency,
  }));

  return (
    <AppShell companies={sidebarCompanies} userEmail={user.email ?? ""}>
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6">
      <PageHeader
        eyebrow="ADMINISTRACIÓN"
        title="Empresas"
        actions={
          <>
            <Link
              href="/reports/consolidated"
              className="text-[13px] font-medium text-[var(--color-accent-strong)]"
            >
              Consolidado USD
            </Link>
            <LinkButton href="/companies/new" variant="primary">
              Nueva empresa
            </LinkButton>
          </>
        }
      />

      {companies.length === 0 ? (
        <EmptyState message="Todavía no tenés acceso a ninguna empresa." />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {companies.map((company) => (
            <li
              key={company.id}
              className="flex items-center justify-between rounded-[10px] border border-[var(--color-hairline)] bg-white px-4 py-3.5 hover:border-[var(--color-accent)]"
            >
              <Link
                href={`/companies/${company.id}`}
                className="flex flex-1 flex-col gap-1 no-underline"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14.5px] font-semibold text-[var(--color-ink)]">
                    {company.name}
                  </span>
                  <Badge variant={company.active ? "positive" : "neutral"}>
                    {company.active ? "Activa" : "Inactiva"}
                  </Badge>
                </div>
                <span className="text-[11.5px] text-[var(--color-faint)]">
                  {[company.country, company.currency, `rol: ${company.role}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </Link>
              {company.role === "admin" ? (
                <Link
                  href={`/companies/${company.id}/edit`}
                  className="text-[13px] font-medium text-[var(--color-accent-strong)]"
                >
                  Editar
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
    </AppShell>
  );
}
