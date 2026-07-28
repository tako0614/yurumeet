/**
 * Client-side talk pinning. The set of pinned talks is persisted so pinning a
 * conversation to the top of the talk list survives a reload. Stored as a JSON
 * array of contact AP ids under a single key; membership drives the "pinned
 * above others" sort and the pin indicator.
 *
 * Storage is injectable so the logic is unit-testable without a DOM. In the
 * browser it falls back to `localStorage`, guarded against environments where
 * it throws (Safari private mode) or is absent (SSR / worker). A lost pin set
 * must never break the talk list, so every failure degrades to "nothing
 * pinned".
 */

export type PinStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const PIN_KEY = "yurume:pinned-talks";

function browserStorage(): PinStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The pinned talk ids (pin order), or [] when none / storage is absent. */
export function readPinnedIds(
  store: PinStorage | null = browserStorage(),
): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(PIN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function writePinnedIds(
  ids: string[],
  store: PinStorage | null = browserStorage(),
): void {
  if (!store) return;
  try {
    if (ids.length === 0) store.removeItem(PIN_KEY);
    else store.setItem(PIN_KEY, JSON.stringify(ids));
  } catch {
    /* best-effort */
  }
}

/** Whether a talk is currently pinned. */
export function isPinned(
  apId: string,
  store: PinStorage | null = browserStorage(),
): boolean {
  if (!apId) return false;
  return readPinnedIds(store).includes(apId);
}

/**
 * Toggle a talk's pinned state and return the updated pinned-id list (so the
 * caller can drive a reactive signal from the same source of truth). Newly
 * pinned talks append to the end of the pin order. An empty ap id is a no-op.
 */
export function togglePin(
  apId: string,
  store: PinStorage | null = browserStorage(),
): string[] {
  const ids = readPinnedIds(store);
  if (!apId) return ids;
  const next = ids.includes(apId)
    ? ids.filter((id) => id !== apId)
    : [...ids, apId];
  writePinnedIds(next, store);
  return next;
}

/**
 * Stable partition placing pinned items first (in their given order), then the
 * rest, preserving the original relative order within each group. Returns the
 * input untouched when nothing is pinned.
 */
export function pinnedFirst<T extends { ap_id: string }>(
  items: readonly T[],
  pinned: ReadonlySet<string>,
): readonly T[] {
  if (pinned.size === 0) return items;
  const top: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (pinned.has(item.ap_id) ? top : rest).push(item);
  }
  return [...top, ...rest];
}
