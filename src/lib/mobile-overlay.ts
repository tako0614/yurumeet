type InertRecord = {
  count: number;
  initial: boolean;
};

const inertCounts = new WeakMap<HTMLElement, InertRecord>();

/**
 * Reference-counted `inert` lock on an element so nested or overlapping
 * overlays never clobber an element that was already `inert` before locking.
 */
export function acquireInert(el: HTMLElement | null | undefined): () => void {
  if (!el) return () => {};
  const existing = inertCounts.get(el);
  if (existing) {
    existing.count += 1;
  } else {
    inertCounts.set(el, { count: 1, initial: el.inert });
    el.inert = true;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const record = inertCounts.get(el);
    if (!record) return;
    record.count -= 1;
    if (record.count <= 0) {
      inertCounts.delete(el);
      el.inert = record.initial;
    }
  };
}

export function getInertLockCount(el: HTMLElement): number {
  return inertCounts.get(el)?.count ?? 0;
}

export function restoreOverlayFocus(
  previous: Element | null,
  doc: Pick<Document, "getElementById"> | null = globalThis.document ?? null,
): void {
  if (
    previous instanceof HTMLElement &&
    previous.isConnected &&
    !previous.hasAttribute("disabled") &&
    !previous.closest("[inert]")
  ) {
    previous.focus();
    return;
  }
  const main = doc?.getElementById("main");
  if (main instanceof HTMLElement && !main.closest("[inert]")) {
    main.focus();
  }
}
