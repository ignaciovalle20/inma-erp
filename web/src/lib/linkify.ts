/**
 * Splits plain text into text and link segments, for notes that show
 * http(s):// and www. addresses as clickable links (no rich text). The
 * punctuation that usually ends a sentence right after a link ("ver
 * https://x.com/a.") stays out of the link, as does a closing parenthesis
 * that has no opening one inside the address.
 */
export type TextSegment = { type: "text"; value: string } | { type: "link"; value: string; href: string };

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"»”’]+$/;

function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCTUATION, "");
    if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
    }
    if (url === before) return url;
  }
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const value = trimUrl(match[0]);
    if (!value || /^(?:https?:\/\/|www\.)$/i.test(value)) continue;

    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    const href = /^www\./i.test(value) ? `https://${value}` : value;
    segments.push({ type: "link", value, href });
    cursor = start + value.length;
  }

  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}
