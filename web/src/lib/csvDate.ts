// Parses a date string from an imported CSV. Chilean exports (e.g. the
// sales/costs "documentos" export) use dd/mm/yyyy, which the native
// `Date` constructor misreads as mm/dd/yyyy (or rejects outright when
// the day exceeds 12) -- see the sales import spec. Also accepts a
// plain ISO yyyy-mm-dd in case the source already normalized it.
// Returns YYYY-MM-DD, or null if the input matches neither shape or
// isn't a real calendar date.
export function parseCsvDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return isValidCalendarDate(+year, +month, +day) ? trimmed : null;
  }

  const dmyMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmyMatch) {
    const [, dayStr, monthStr, yearStr] = dmyMatch;
    const day = +dayStr;
    const month = +monthStr;
    const year = +yearStr;
    if (!isValidCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return null;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}
