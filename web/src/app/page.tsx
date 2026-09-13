import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, getUserCompanies } from "@/lib/dal";
import { signOut } from "@/app/logout/actions";

export default async function Home() {
  const user = await getSession();

  if (!user) {
    redirect("/login");
  }

  const companies = await getUserCompanies();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-zinc-50 px-4 text-center dark:bg-black">
      {companies.length === 0 ? (
        <>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            No company access
          </h1>
          <p className="max-w-md text-zinc-600 dark:text-zinc-400">
            Your account isn&apos;t linked to any company yet. Contact an
            administrator to request access.
          </p>
        </>
      ) : companies.length === 1 ? (
        <>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            {companies[0].name}
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Signed in as {user.email}
          </p>
          <Link
            href={`/companies/${companies[0].id}/sales`}
            className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
          >
            Go to {companies[0].name}
          </Link>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Select a company
          </h1>
          <ul className="flex flex-col gap-2 text-zinc-800 dark:text-zinc-200">
            {companies.map((company) => (
              <li key={company.id}>
                <Link
                  href={`/companies/${company.id}/sales`}
                  className="underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
                >
                  {company.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <Link
        href="/companies"
        className="text-sm font-medium text-zinc-700 underline underline-offset-2 hover:text-black dark:text-zinc-300 dark:hover:text-zinc-50"
      >
        Manage companies
      </Link>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded-full border border-black/[.08] px-5 py-2 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
        >
          Log out
        </button>
      </form>
    </div>
  );
}
