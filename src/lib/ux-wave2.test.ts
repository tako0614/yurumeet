import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyThemeToDocument,
  detectInitialTheme,
  parseThemePreference,
  THEME_STORAGE_KEY,
} from "./theme.ts";
import {
  acquireInert,
  getInertLockCount,
  restoreOverlayFocus,
} from "./mobile-overlay.ts";
import { shouldHandleSearchShortcut } from "./keyboard-shortcut.ts";
import { handleMenuKeyDown } from "./dialog.tsx";

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function parseYmTokens(cssBlock: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of cssBlock.matchAll(
    /(--ym-[a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g,
  )) {
    tokens[match[1]!] = match[2]!.toLowerCase();
  }
  return tokens;
}

describe("theme helpers", () => {
  test("parses preferences safely and toggles document data-theme", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("invalid")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");

    expect(
      detectInitialTheme({
        getItem: (key) => (key === THEME_STORAGE_KEY ? "dark" : null),
      }),
    ).toBe("dark");
    expect(
      detectInitialTheme({
        getItem: () => {
          throw new Error("storage blocked");
        },
      }),
    ).toBe("system");

    const doc = {
      documentElement: { dataset: {} as Record<string, string | undefined> },
    } as unknown as Document;
    applyThemeToDocument("dark", doc);
    expect(doc.documentElement.dataset.theme).toBe("dark");
    applyThemeToDocument("light", doc);
    expect(doc.documentElement.dataset.theme).toBe("light");
    applyThemeToDocument("system", doc);
    expect(doc.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("mobile overlay inert ref-counting and focus restoration", () => {
  test("acquireInert ref-counts overlapping locks and preserves already-inert elements", () => {
    const normal = { inert: false } as unknown as HTMLElement;
    const preInert = { inert: true } as unknown as HTMLElement;

    const release1 = acquireInert(normal);
    const release2 = acquireInert(normal);
    expect(normal.inert).toBe(true);
    expect(getInertLockCount(normal)).toBe(2);

    release1();
    release1(); // idempotent
    expect(normal.inert).toBe(true);
    expect(getInertLockCount(normal)).toBe(1);

    release2();
    expect(normal.inert).toBe(false);
    expect(getInertLockCount(normal)).toBe(0);

    const releasePre = acquireInert(preInert);
    expect(preInert.inert).toBe(true);
    releasePre();
    expect(preInert.inert).toBe(true);
  });

  test("restoreOverlayFocus falls back to #main when opener is disconnected or inert", () => {
    const origHTMLElement = globalThis.HTMLElement;
    let focused: unknown = null;

    class FakeEl {
      isConnected = true;
      inert = false;
      disabled = false;
      focus() {
        focused = this;
      }
      hasAttribute(name: string) {
        return name === "disabled" && this.disabled;
      }
      closest(selector: string) {
        return selector.includes("[inert]") && this.inert ? this : null;
      }
    }

    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = FakeEl;
    try {
      const opener = new FakeEl();
      const main = new FakeEl();
      const doc = {
        getElementById: (id: string) =>
          id === "main" ? (main as unknown as HTMLElement) : null,
      };

      restoreOverlayFocus(opener as unknown as Element, doc);
      expect(focused).toBe(opener);

      opener.isConnected = false;
      focused = null;
      restoreOverlayFocus(opener as unknown as Element, doc);
      expect(focused).toBe(main);

      opener.isConnected = true;
      opener.inert = true;
      focused = null;
      restoreOverlayFocus(opener as unknown as Element, doc);
      expect(focused).toBe(main);
    } finally {
      (globalThis as unknown as { HTMLElement: unknown }).HTMLElement =
        origHTMLElement;
    }
  });
});

describe("guarded `/` search shortcut", () => {
  const plainDoc = {
    activeElement: { tagName: "BODY" } as unknown as Element,
    querySelector: () => null,
  };

  test("allows bare `/` when outside editable controls and dialogs", () => {
    expect(
      shouldHandleSearchShortcut(
        {
          key: "/",
          ctrlKey: false,
          metaKey: false,
          altKey: false,
          isComposing: false,
          keyCode: 191,
          defaultPrevented: false,
          target: { tagName: "BODY" } as unknown as EventTarget,
        },
        plainDoc,
      ),
    ).toBe(true);
  });

  test("blocks modifiers, IME composition, editable targets, and open dialogs", () => {
    const base = {
      key: "/",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      keyCode: 191,
      defaultPrevented: false,
      target: { tagName: "BODY" } as unknown as EventTarget,
    };

    expect(
      shouldHandleSearchShortcut({ ...base, ctrlKey: true }, plainDoc),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut({ ...base, metaKey: true }, plainDoc),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut({ ...base, altKey: true }, plainDoc),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut({ ...base, isComposing: true }, plainDoc),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut({ ...base, keyCode: 229 }, plainDoc),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut(
        { ...base, target: { tagName: "INPUT" } as unknown as EventTarget },
        plainDoc,
      ),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut(
        { ...base, target: { tagName: "TEXTAREA" } as unknown as EventTarget },
        plainDoc,
      ),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut(
        { ...base, target: { tagName: "SELECT" } as unknown as EventTarget },
        plainDoc,
      ),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut(
        {
          ...base,
          target: {
            tagName: "DIV",
            isContentEditable: true,
          } as unknown as EventTarget,
        },
        plainDoc,
      ),
    ).toBe(false);
    expect(
      shouldHandleSearchShortcut(base, {
        activeElement: { tagName: "BODY" } as unknown as Element,
        querySelector: () => ({}) as Element,
      }),
    ).toBe(false);
  });
});

describe("dropdown menu keyboard navigation", () => {
  test("handles ArrowDown/ArrowUp/Home/End wrapping, skips disabled items, and handles IME-safe Escape", () => {
    let active: FakeItem | null = null;
    class FakeItem {
      ownerDocument = {
        get activeElement() {
          return active;
        },
        defaultView: {
          getComputedStyle: () => ({ visibility: "visible", display: "block" }),
        },
      };
      constructor(
        public readonly label: string,
        public disabled = false,
      ) {}
      focus() {
        active = this;
      }
      hasAttribute(name: string) {
        return name === "disabled" && this.disabled;
      }
      closest() {
        return null;
      }
      getClientRects() {
        return [{ width: 100, height: 32 }];
      }
    }

    const item1 = new FakeItem("copy");
    const item2 = new FakeItem("disabled", true);
    const item3 = new FakeItem("delete");
    const menu = {
      ownerDocument: item1.ownerDocument,
      querySelectorAll: () => [item1, item2, item3],
    } as unknown as HTMLElement;

    const closed: boolean[] = [];
    const keyEvent = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
      key,
      isComposing: false,
      keyCode: 0,
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    });

    active = item1;
    handleMenuKeyDown(keyEvent("ArrowDown"), menu, (r) => closed.push(r));
    expect(active).toBe(item3);

    handleMenuKeyDown(keyEvent("ArrowDown"), menu, (r) => closed.push(r));
    expect(active).toBe(item1);

    handleMenuKeyDown(keyEvent("ArrowUp"), menu, (r) => closed.push(r));
    expect(active).toBe(item3);

    handleMenuKeyDown(keyEvent("Home"), menu, (r) => closed.push(r));
    expect(active).toBe(item1);

    handleMenuKeyDown(keyEvent("End"), menu, (r) => closed.push(r));
    expect(active).toBe(item3);

    // IME Escape must not close the menu
    handleMenuKeyDown(
      keyEvent("Escape", { isComposing: true, keyCode: 229 }),
      menu,
      (r) => closed.push(r),
    );
    expect(closed).toEqual([]);

    handleMenuKeyDown(keyEvent("Escape"), menu, (r) => closed.push(r));
    expect(closed).toEqual([true]);

    handleMenuKeyDown(keyEvent("Tab"), menu, (r) => closed.push(r));
    expect(closed).toEqual([true, false]);
  });
});

describe("design tokens WCAG AA contrast", () => {
  test("--ym-* light and dark token blocks match and satisfy >= 4.5:1 contrast", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const darkMediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkMediaStart).toBeGreaterThan(0);

    const lightTokens = parseYmTokens(css.slice(0, darkMediaStart));
    const darkMediaEnd = css.indexOf("\n}\n", darkMediaStart + 100);
    const darkMediaTokens = parseYmTokens(
      css.slice(darkMediaStart, darkMediaEnd),
    );

    const explicitDarkStart = css.indexOf(':root[data-theme="dark"]');
    expect(explicitDarkStart).toBeGreaterThan(darkMediaEnd);
    const explicitDarkEnd = css.indexOf("\n}\n", explicitDarkStart);
    const explicitDarkTokens = parseYmTokens(
      css.slice(explicitDarkStart, explicitDarkEnd),
    );
    expect(explicitDarkTokens).toEqual(darkMediaTokens);

    const darkTokens = { ...lightTokens, ...darkMediaTokens };

    for (const [mode, tokens] of [
      ["light", lightTokens],
      ["dark", darkTokens],
    ] as const) {
      const pairs: Array<[string, string, string]> = [
        ["text on bg", tokens["--ym-text"]!, tokens["--ym-bg"]!],
        ["text on surface", tokens["--ym-text"]!, tokens["--ym-surface"]!],
        [
          "text-secondary on bg",
          tokens["--ym-text-secondary"]!,
          tokens["--ym-bg"]!,
        ],
        [
          "text-secondary on surface",
          tokens["--ym-text-secondary"]!,
          tokens["--ym-surface"]!,
        ],
        [
          "text-muted on bg-chat",
          tokens["--ym-text-muted"]!,
          tokens["--ym-bg-chat"]!,
        ],
        [
          "text-faint on surface",
          tokens["--ym-text-faint"]!,
          tokens["--ym-surface"]!,
        ],
        [
          "text-faint on surface-muted",
          tokens["--ym-text-faint"]!,
          tokens["--ym-surface-muted"]!,
        ],
        [
          "accent-text on surface",
          tokens["--ym-accent-text"]!,
          tokens["--ym-surface"]!,
        ],
        [
          "accent-text on accent-soft",
          tokens["--ym-accent-text"]!,
          tokens["--ym-accent-soft"]!,
        ],
        [
          "accent-fg on accent-btn-bg",
          tokens["--ym-accent-fg"]!,
          tokens["--ym-accent-btn-bg"]!,
        ],
        [
          "bubble-other-fg on bubble-other-bg",
          tokens["--ym-bubble-other-fg"]!,
          tokens["--ym-bubble-other-bg"]!,
        ],
        [
          "bubble-self-fg on bubble-self-bg",
          tokens["--ym-bubble-self-fg"]!,
          tokens["--ym-bubble-self-bg"]!,
        ],
        ["danger on surface", tokens["--ym-danger"]!, tokens["--ym-surface"]!],
        [
          "danger on danger-soft",
          tokens["--ym-danger"]!,
          tokens["--ym-danger-soft"]!,
        ],
        [
          "warning-text on warning-bg",
          tokens["--ym-warning-text"]!,
          tokens["--ym-warning-bg"]!,
        ],
        [
          "success-text on success-bg",
          tokens["--ym-success-text"]!,
          tokens["--ym-success-bg"]!,
        ],
        [
          "inverted-fg on inverted-bg",
          tokens["--ym-inverted-fg"]!,
          tokens["--ym-inverted-bg"]!,
        ],
        [
          "highlight-fg on highlight-bg",
          tokens["--ym-highlight-fg"]!,
          tokens["--ym-highlight-bg"]!,
        ],
      ];

      for (const [label, fg, bg] of pairs) {
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${mode} ${label} (${fg} on ${bg})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
