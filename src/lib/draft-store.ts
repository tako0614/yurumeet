/**
 * Per-talk unsent-message drafts, persisted so switching away from a
 * conversation (or reloading the tab) restores the text you had typed. Keyed
 * by the contact's AP id; text-only (staged media is intentionally NOT
 * persisted — object URLs don't survive a reload and re-sending a stale upload
 * to the wrong thread would be worse than losing it).
 *
 * Storage is injectable so the logic is unit-testable without a DOM. In the
 * browser it falls back to `localStorage`, guarded against environments where
 * it throws (Safari private mode) or is absent (SSR / worker).
 */

export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const DRAFT_PREFIX = "yurume:draft:";

export function draftKey(apId: string): string {
  return `${DRAFT_PREFIX}${apId}`;
}

function browserStorage(): DraftStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The saved draft for a talk, or "" when there is none / storage is absent. */
export function readDraft(
  apId: string,
  store: DraftStorage | null = browserStorage(),
): string {
  if (!apId || !store) return "";
  try {
    return store.getItem(draftKey(apId)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Save (or, when the text is empty/whitespace-only, clear) a talk's draft.
 * Storage failures (quota, private mode) are swallowed — a lost draft must
 * never break sending.
 */
export function writeDraft(
  apId: string,
  text: string,
  store: DraftStorage | null = browserStorage(),
): void {
  if (!apId || !store) return;
  try {
    if (text.trim().length === 0) store.removeItem(draftKey(apId));
    else store.setItem(draftKey(apId), text);
  } catch {
    /* best-effort */
  }
}

/** Drop a talk's draft (called after a successful send). */
export function clearDraft(
  apId: string,
  store: DraftStorage | null = browserStorage(),
): void {
  if (!apId || !store) return;
  try {
    store.removeItem(draftKey(apId));
  } catch {
    /* best-effort */
  }
}
