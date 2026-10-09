"use client";

import { useSyncExternalStore } from "react";

const FORMAT = new Intl.DateTimeFormat("es", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function subscribe() {
  return () => {};
}

/**
 * A timestamp in the viewer's own time zone (the browser's), e.g. "06 oct
 * 2026, 21:44". The server does not know that zone, so it renders an
 * empty <time> and the text appears once the page hydrates -- rendering it
 * in the server's zone would show the wrong hour for a moment and trip a
 * hydration mismatch.
 */
export function LocalDateTime({ value, className }: { value: string; className?: string }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);

  return (
    <time dateTime={value} className={className}>
      {hydrated ? FORMAT.format(new Date(value)) : ""}
    </time>
  );
}
