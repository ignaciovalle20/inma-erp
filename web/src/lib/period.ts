/** Formats a "YYYY-MM-01" period date as "septiembre de 2026". */
export function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00Z`);
  return date.toLocaleDateString("es-ES", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
