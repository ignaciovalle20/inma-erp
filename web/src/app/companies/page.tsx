import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";

export default async function CompaniesPage() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Companies
        </h1>
        <Link
          href="/companies/new"
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          New company
        </Link>
      </div>

      {companies.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          You don&apos;t have access to any company yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {companies.map((company) => (
            <li
              key={company.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {company.name}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-medium " +
                      (company.active
                        ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                    }
                  >
                    {company.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <span className="text-sm text-zinc-500 dark:text-zinc-500">
                  {[company.country, company.currency, `role: ${company.role}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <Link
                  href={`/companies/${company.id}/clients`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  Clients
                </Link>
                <Link
                  href={`/companies/${company.id}/suppliers`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  Suppliers
                </Link>
                <Link
                  href={`/companies/${company.id}/areas`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  Areas
                </Link>
                <Link
                  href={`/companies/${company.id}/projects`}
                  className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  Projects
                </Link>
                {company.role === "admin" ? (
                  <Link
                    href={`/companies/${company.id}/edit`}
                    className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
                  >
                    Edit
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
