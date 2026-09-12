import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getCompanyForEdit, getSuppliers } from "@/lib/dal";

export default async function SuppliersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  // Any membership (any role) is enough to view a company's suppliers --
  // getCompanyForEdit doubles as the membership check here.
  const membership = await getCompanyForEdit(id);

  if (!membership) {
    redirect("/companies");
  }

  const suppliers = await getSuppliers(id);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Suppliers
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            {membership.company.name}
          </p>
        </div>
        <Link
          href={`/companies/${id}/suppliers/new`}
          className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          New supplier
        </Link>
      </div>

      {suppliers.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">
          No suppliers yet for this company.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {suppliers.map((supplier) => (
            <li
              key={supplier.id}
              className="flex items-center justify-between rounded-lg border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-black dark:text-zinc-50">
                    {supplier.name}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-xs font-medium " +
                      (supplier.active
                        ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                        : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                    }
                  >
                    {supplier.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <span className="text-sm text-zinc-500 dark:text-zinc-500">
                  {[supplier.tax_id, supplier.country]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <Link
                href={`/companies/${id}/suppliers/${supplier.id}/edit`}
                className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
              >
                Edit
              </Link>
            </li>
          ))}
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
