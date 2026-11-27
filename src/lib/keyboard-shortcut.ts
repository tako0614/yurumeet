import { hasOpenDialog } from "./dialog.tsx";

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

function isEditableElement(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const el = node as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  if (el.tagName && EDITABLE_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role")?.toLowerCase();
  if (role && EDITABLE_ROLES.has(role)) return true;
  if (
    typeof el.closest === "function" &&
    el.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]',
    )
  ) {
    return true;
  }
  return false;
}

export function shouldHandleSearchShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "isComposing"
    | "keyCode"
    | "defaultPrevented"
    | "target"
  >,
  doc: Pick<
    Document,
    "activeElement" | "querySelector"
  > | null = globalThis.document ?? null,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key !== "/") return false;
  if (hasOpenDialog()) return false;
  if (doc?.querySelector('[role="dialog"], [role="alertdialog"]')) return false;
  if (isEditableElement(event.target)) return false;
  if (isEditableElement(doc?.activeElement)) return false;
  return true;
}
