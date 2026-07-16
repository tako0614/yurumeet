import { createEffect, onCleanup, onMount } from "solid-js";

/**
 * Shared dialog accessibility helper. Rendered INSIDE a modal's subtree (so it
 * mounts/unmounts with the dialog), it:
 *
 * - moves focus into the dialog (respecting an `[autofocus]` element),
 * - traps Tab / Shift+Tab inside the dialog,
 * - closes on Escape,
 * - restores focus to the previously focused element on close.
 *
 * Stacked dialogs (e.g. a confirm on top of a composer) are handled with a
 * module-level stack: only the topmost dialog reacts to Escape/Tab.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const dialogStack: symbol[] = [];

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) => el.getClientRects().length > 0 || el === document.activeElement,
  );
}

export function DialogA11y(props: {
  /** Accessor for the dialog's root element (set via `ref`). */
  root: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  onMount(() => {
    const token = Symbol("dialog");
    dialogStack.push(token);
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    queueMicrotask(() => {
      const root = props.root();
      if (!root) return;
      if (
        document.activeElement instanceof HTMLElement &&
        root.contains(document.activeElement)
      ) {
        return; // an [autofocus] element already took focus
      }
      const preferred =
        root.querySelector<HTMLElement>("[autofocus]") ?? focusableIn(root)[0];
      preferred?.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      const root = props.root();
      if (!root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = focusableIn(root);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && root.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey, true);
      const index = dialogStack.indexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      previous?.focus();
    });
  });
  return null;
}

/**
 * Close a lightweight popup menu on Escape while `active()` is truthy.
 * (Menus use a scrim button for pointer dismissal; this adds the keyboard
 * path without full dialog semantics.)
 */
export function createEscapeClose(
  active: () => boolean,
  close: () => void,
): void {
  createEffect(() => {
    if (!active()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });
}
