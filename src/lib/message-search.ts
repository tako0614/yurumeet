/**
 * Client-side, in-conversation search over the messages already loaded into
 * the open thread. This never hits the network: it filters the message window
 * the chat pane is holding, so results are limited to loaded history (paging
 * older pages widens the searchable set). Matching is a case-insensitive
 * substring over the message text.
 */

/** Minimal message shape the search needs (id + text body). */
export type SearchableMessage = {
  id: string;
  content?: string | null;
};

/**
 * Ids of the messages whose text contains `query` (case-insensitive),
 * preserving the input order (oldest → newest). An empty / whitespace-only
 * query matches nothing.
 */
export function searchMessages(
  messages: readonly SearchableMessage[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: string[] = [];
  for (const message of messages) {
    const content = message.content ?? "";
    if (content.toLowerCase().includes(needle)) hits.push(message.id);
  }
  return hits;
}

/** A run of text tagged with whether it is part of a search match. */
export type HighlightSegment = { text: string; hit: boolean };

/**
 * Split `text` into alternating non-match / match runs for `query`
 * (case-insensitive), so a renderer can wrap the matches in `<mark>` while
 * leaving the rest untouched. The match runs preserve the ORIGINAL casing of
 * `text` (only the comparison is case-folded). An empty query — or no match —
 * yields a single non-hit run (or nothing for empty text).
 */
export function splitHighlight(
  text: string,
  query: string,
): HighlightSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !text) return text ? [{ text, hit: false }] : [];
  const haystack = text.toLowerCase();
  const out: HighlightSegment[] = [];
  let from = 0;
  let idx = haystack.indexOf(needle);
  if (idx < 0) return [{ text, hit: false }];

  // Lowercasing may expand one original character (e.g. İ -> i + dot).
  // Search in the folded text, but slice only at original UTF-16 offsets.
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(offset)!)!;
    const end = offset + char.length;
    for (let n = char.toLowerCase().length; n > 0; n--) {
      starts.push(offset);
      ends.push(end);
    }
    offset = end;
  }

  let cursor = 0;
  while (idx >= 0) {
    const start = starts[idx]!;
    const end = ends[idx + needle.length - 1]!;
    if (start > cursor)
      out.push({ text: text.slice(cursor, start), hit: false });
    if (end > cursor)
      out.push({ text: text.slice(Math.max(start, cursor), end), hit: true });
    cursor = Math.max(cursor, end);
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
}
