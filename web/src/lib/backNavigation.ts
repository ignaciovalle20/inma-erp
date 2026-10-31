/**
 * "Volver": back to the screen the person really came from, with its filters.
 * Filters live in the URL, so that screen is a URL: lists pass theirs to the
 * pages they open as ?volver=, and BackLink goes back through the history when
 * that lands in the right place (which also restores the scroll), or follows the
 * link otherwise. Pure, so it can be tested without a browser.
 */
import { safeRedirect } from "@/lib/costDocumentDeletion";

/** The list's URL with its filters: what its rows pass as ?volver=. */
export function listUrl(path: string, params: Record<string, string | undefined>, omit: string[] = []): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "volver" && !omit.includes(key)) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function withVolver(href: string, volver: string | null | undefined): string {
  if (!volver) return href;
  return `${href}${href.includes("?") ? "&" : "?"}volver=${encodeURIComponent(volver)}`;
}

export type BackTarget = { href: string; label: string; exact?: boolean };

/** What to call the way back to a screen of the company. */
function labelFor(companyId: string, target: string): string {
  const path = target.split("?")[0].replace(`/companies/${companyId}`, "");
  if (path === "/costs") return "Volver a Costos";
  if (path === "/sales") return "Volver a Ventas";
  if (path === "/sales/reconcile") return "Volver a Conciliar";
  if (path === "/projects/board") return "Volver al tablero";
  if (path === "/projects") return "Volver a Proyectos";
  if (/^\/projects\/[^/]+$/.test(path)) return "Volver al trabajo";
  if (/^\/costs\/[^/]+$/.test(path)) return "Volver al documento";
  return "Volver";
}

/**
 * The way back of a page: what ?volver= says when it is a page of this company
 * (the exact screen it was opened from), else the fallback.
 */
export function backTarget(companyId: string, volver: string | null | undefined, fallback: BackTarget): BackTarget {
  const target = safeRedirect(companyId, volver);
  return target ? { href: target, label: labelFor(companyId, target), exact: true } : fallback;
}

/** Same URL, whatever the encoding or the order of its parameters. */
export function sameUrl(a: string, b: string): boolean {
  const normalized = (value: string) => {
    const url = new URL(value, "http://inma.local");
    url.searchParams.sort();
    return `${url.pathname}?${url.searchParams.toString()}`;
  };
  return normalized(a) === normalized(b);
}

/** A form that redirects after saving: going back to it would reopen what was just saved. */
export function isFormPage(url: string): boolean {
  return /\/(edit|new|assign|quick|quick-expense|manual-sale|pay)(\?|$)/.test(url);
}

/**
 * Whether "Volver" goes through the history or follows its link. `previous` is
 * the screen before this one in this tab, if any.
 *   - An exact target: only when the history lands exactly there.
 *   - Otherwise: the history, unless it would reopen a form.
 */
export function backAction(target: { href: string; exact?: boolean }, previous: string | null): "history" | "link" {
  if (!previous) return "link";
  if (target.exact) return sameUrl(previous, target.href) ? "history" : "link";
  return isFormPage(previous) ? "link" : "history";
}
