"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { allocateCostPool } from "./actions";

export function AllocateButton({
  companyId,
  costPoolId,
}: {
  companyId: string;
  costPoolId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const result = await allocateCostPool(companyId, costPoolId);
      if (result.error) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-on-ink)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
      >
        {isPending ? "Repartiendo…" : "Repartir"}
      </button>
      {error ? (
        <p role="alert" className="text-[12.5px] text-[var(--color-negative-ink)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
