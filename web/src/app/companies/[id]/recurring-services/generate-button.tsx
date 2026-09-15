"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RecurringServicePeriodicity } from "@/lib/dal";
import { generateRecurringServiceEntry } from "./actions";

function currentPeriodStart(periodicity: RecurringServicePeriodicity): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const periodDate =
    periodicity === "annual" ? new Date(year, 0, 1) : new Date(year, month, 1);
  // Local YYYY-MM-DD, not toISOString() (which would shift by timezone).
  const yyyy = periodDate.getFullYear();
  const mm = String(periodDate.getMonth() + 1).padStart(2, "0");
  const dd = String(periodDate.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function GenerateButton({
  companyId,
  recurringServiceId,
  periodicity,
}: {
  companyId: string;
  recurringServiceId: string;
  periodicity: RecurringServicePeriodicity;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    const period = currentPeriodStart(periodicity);

    startTransition(async () => {
      const result = await generateRecurringServiceEntry(
        companyId,
        recurringServiceId,
        period,
      );

      if (result.error) {
        setError(result.error);
        return;
      }

      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-lg border border-[var(--color-hairline)] bg-white px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink-2)] hover:border-[#d5d5d0] disabled:opacity-60"
      >
        {isPending ? "Generando…" : "Generar este período"}
      </button>
      {error ? (
        <p role="alert" className="max-w-[220px] text-right text-[11.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
