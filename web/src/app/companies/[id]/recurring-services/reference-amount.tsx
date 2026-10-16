import { Money } from "@/components/Money";
import type { RecurringService } from "@/lib/dal";

/** A service's reference amount: fixed, per unit (price x quantity), or none. */
export function ReferenceAmount({
  service,
}: {
  service: Pick<RecurringService, "reference_amount" | "pricing_mode" | "unit_price" | "default_quantity" | "currency">;
}) {
  if (service.reference_amount === null) {
    return <span className="text-[var(--color-faint)]">Sin referencial</span>;
  }

  return (
    <span className="inline-flex flex-col items-end">
      <Money value={service.reference_amount} currency={service.currency} />
      {service.pricing_mode === "per_unit" && service.unit_price !== null ? (
        <span className="text-[11px] text-[var(--color-muted)]">
          {service.default_quantity} u. ×{" "}
          <Money value={service.unit_price} currency={service.currency} showCurrency={false} />
        </span>
      ) : null}
    </span>
  );
}
