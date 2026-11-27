import { createEffect, onCleanup, onMount } from "solid-js";
import { restoreOverlayFocus } from "./mobile-overlay.ts";

/**
 * Shared dialog accessibility helper. Rendered INSIDE a modal's subtree (so it
 * mounts/unmounts with the dialog), it:
 *
 * - moves focus into the dialog (respecting an `[autofocus]` element),
 * - traps Tab / Shift+Tab inside the dialog,
 * - closes on Escape,
 * - restores focus to the previously focused element on close (falling back to `#main`).
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
  "details > summary:first-of-type",
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(", ");

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

const dialogStack: symbol[] = [];

export function hasOpenDialog(): boolean {
  return dialogStack.length > 0;
}

function isVisibleFocusable(el: HTMLElement): boolean {
  if (el.closest("[inert], [hidden], details:not([open]) > :not(summary)")) {
    return false;
  }
  const view = el.ownerDocument?.defaultView;
  if (view?.getComputedStyle) {
    const style = view.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
  }
  if (typeof el.getClientRects === "function") {
    return (
      el.getClientRects().length > 0 || el === el.ownerDocument?.activeElement
    );
  }
  return true;
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isVisibleFocusable);
}

/**
 * Full-surface dismiss scrims (`*-dismiss` / `*-scrim` buttons) render before
 * the panel, so they'd win initial focus — an invisible landing spot. They
 * stay in the Tab order; they just don't get focus first.
 */
function isScrimControl(el: HTMLElement): boolean {
  const cls = typeof el.className === "string" ? el.className : "";
  return cls.includes("dismiss") || cls.includes("scrim");
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
      const candidates = focusableIn(root);
      const preferred =
        root.querySelector<HTMLElement>("[autofocus]") ??
        candidates.find((el) => !isScrimControl(el)) ??
        candidates[0];
      preferred?.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
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
        if (!inside || active === root || active === first) {
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
      restoreOverlayFocus(previous, document);
    });
  });
  return null;
}

export function getMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR),
  ).filter((el) => !el.hasAttribute("disabled") && isVisibleFocusable(el));
}

/**
 * Pure keyboard handler for dropdown `role="menu"` lists:
 * ArrowDown / ArrowUp wrap through enabled items, Home / End jump to ends,
 * Escape (IME-safe) closes and returns focus to trigger, Tab closes cleanly.
 */
export function handleMenuKeyDown(
  event: Pick<
    KeyboardEvent,
    "key" | "isComposing" | "keyCode" | "preventDefault" | "stopPropagation"
  >,
  menu: HTMLElement,
  onClose: (restoreTriggerFocus: boolean) => void,
): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
    return true;
  }
  if (event.key === "Tab") {
    onClose(false);
    return true;
  }
  const items = getMenuItems(menu);
  if (items.length === 0) return false;

  const doc = menu.ownerDocument;
  const active = doc?.activeElement;
  const currentIndex = items.findIndex((item) => item === active);

  let nextIndex: number | null = null;
  if (event.key === "ArrowDown") {
    nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  } else if (event.key === "ArrowUp") {
    nextIndex =
      currentIndex <= 0 ? items.length - 1 : (currentIndex - 1) % items.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = items.length - 1;
  }

  if (nextIndex === null) return false;
  event.preventDefault();
  event.stopPropagation();
  items[nextIndex]?.focus();
  return true;
}

/**
 * Keyboard navigation for dropdown `role="menu"` containers.
 * Mounts inside the menu's `<Show>` so it automatically moves focus to the
 * first item on open, handles ArrowDown/ArrowUp/Home/End/Escape/Tab, and
 * restores focus to the trigger button when closed via Escape.
 */
export function MenuA11y(props: {
  menu: () => HTMLElement | undefined;
  trigger?: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  onMount(() => {
    const fallbackTrigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let active = true;

    queueMicrotask(() => {
      if (!active) return;
      const menu = props.menu();
      if (!menu) return;
      const items = getMenuItems(menu);
      items[0]?.focus();
    });

    const closeMenu = (restoreTriggerFocus: boolean) => {
      props.onClose();
      if (!restoreTriggerFocus) return;
      queueMicrotask(() => {
        const trigger = props.trigger?.() ?? fallbackTrigger;
        if (
          trigger &&
          trigger.isConnected &&
          !trigger.hasAttribute("disabled") &&
          !trigger.closest("[inert]")
        ) {
          trigger.focus();
        }
      });
    };

    const onKey = (event: KeyboardEvent) => {
      const menu = props.menu();
      if (!menu) return;
      handleMenuKeyDown(event, menu, closeMenu);
    };

    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      active = false;
      document.removeEventListener("keydown", onKey, true);
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
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });
}
