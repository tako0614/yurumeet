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
  let idx = haystack.indexOf(needle, from);
  if (idx < 0) return [{ text, hit: false }];
  while (idx >= 0) {
    if (idx > from) out.push({ text: text.slice(from, idx), hit: false });
    out.push({ text: text.slice(idx, idx + needle.length), hit: true });
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false });
  return out;
}
