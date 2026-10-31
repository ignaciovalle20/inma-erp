"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { previousScreen } from "@/components/NavigationTracker";
import { backAction, type BackTarget } from "@/lib/backNavigation";

/**
 * "Volver": goes back through the history when that lands in the right place
 * (filters and scroll as they were), or follows its link. A real link, so
 * opening it in a new tab still works.
 */
export function BackLink({ target, className }: { target: BackTarget; className?: string }) {
  const router = useRouter();

  return (
    <Link
      href={target.href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (backAction(target, previousScreen()) === "history") {
          event.preventDefault();
          router.back();
        }
      }}
      className={className}
    >
      ← {target.label}
    </Link>
  );
}
