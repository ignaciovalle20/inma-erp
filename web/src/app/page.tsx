import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { signOut } from "@/app/logout/actions";
import { computeMonthlyResult } from "@/lib/reporting";
import { Money } from "@/components/Money";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export default async function Home() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();

  if (companies.length === 1) {
    redirect(`/companies/${companies[0].id}`);
  }

  const period = currentMonth();
  const results =
    companies.length > 0
      ? await Promise.all(
          companies.map(async (company) => {
            try {
              return await computeMonthlyResult(company.id, period);
            } catch {
              return null;
            }
          }),
        )
      : [];

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-[var(--color-canvas)] px-4 py-16">
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        {companies.length === 0 ? (
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-[21px] font-semibold text-[var(--color-ink)]">
              Sin acceso a empresas
            </h1>
            <p className="text-[13px] text-[var(--color-muted)]">
              Tu cuenta todavía no está vinculada a ninguna empresa. Contactá
              a un administrador para solicitar acceso.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-center">
              <h1 className="text-[21px] font-semibold text-[var(--color-ink)]">
                Elegí una empresa
              </h1>
              <p className="text-[13px] text-[var(--color-muted)]">
                {user.email} · {companies.length}{" "}
                {companies.length === 1 ? "empresa" : "empresas"}
              </p>
            </div>
            <div className="flex flex-col gap-2.5">
              {companies.map((company, i) => {
                const result = results[i];
                return (
                  <Link
                    key={company.id}
                    href={`/companies/${company.id}`}
                    className="flex items-center justify-between rounded-[10px] border border-[var(--color-hairline)] bg-white px-4 py-[15px] no-underline hover:border-[var(--color-accent)]"
                  >
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[14.5px] font-semibold text-[var(--color-ink)]">
                          {company.name}
                        </span>
                        <span className="rounded border border-[var(--color-hairline)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-muted)]">
                          {company.country} · {company.currency}
                        </span>
                      </div>
                      <span className="text-[11.5px] text-[var(--color-faint)]">
                        rol: {company.role}
                      </span>
                    </div>
                    {result ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <Money
                          value={result.operatingResult}
                          currency={company.currency}
                          className="text-[14px] font-semibold text-[var(--color-accent-strong)]"
                        />
                        <span className="font-mono text-[10.5px] text-[var(--color-faint)]">
                          RESULTADO {period.slice(5, 7)}/{period.slice(0, 4)}
                        </span>
                      </div>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </>
        )}
        <div className="flex flex-col items-center gap-3 pt-2">
          <Link
            href="/reports/consolidated"
            className="text-[13px] font-medium text-[var(--color-accent-strong)]"
          >
            Ver consolidado en USD →
          </Link>
          <Link
            href="/companies"
            className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
          >
            Gestionar empresas
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="text-[13px] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
