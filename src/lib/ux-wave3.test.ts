import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ActorStories } from "@takosjp/yurucommu-api";
import { handleTabListKeyDown } from "./keyboard-shortcut.ts";
import {
  resolveStoryDeepLink,
  syncStoryVideoPlayback,
} from "./story-viewer.ts";

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

describe("tablist roving keyboard navigation", () => {
  test("wraps ArrowRight/ArrowLeft, handles Home/End, and ignores IME events", () => {
    let active: FakeTab | null = null;
    const clicks: string[] = [];

    class FakeTab {
      ownerDocument = {
        get activeElement() {
          return active;
        },
      };
      constructor(public readonly name: string) {}
      focus() {
        active = this;
      }
      click() {
        clicks.push(this.name);
      }
    }

    const tab1 = new FakeTab("myqr");
    const tab2 = new FakeTab("scan");
    const tablist = {
      ownerDocument: tab1.ownerDocument,
      querySelectorAll: () => [tab1, tab2],
    } as unknown as HTMLElement;

    let prevented = 0;
    const keyEvent = (key: string, extra: Partial<KeyboardEvent> = {}) => ({
      key,
      isComposing: false,
      keyCode: 0,
      preventDefault() {
        prevented += 1;
      },
      ...extra,
    });

    active = tab1;
    expect(handleTabListKeyDown(keyEvent("ArrowRight"), tablist)).toBe(true);
    expect(active).toBe(tab2);
    expect(clicks).toEqual(["scan"]);

    expect(handleTabListKeyDown(keyEvent("ArrowRight"), tablist)).toBe(true);
    expect(active).toBe(tab1);
    expect(clicks).toEqual(["scan", "myqr"]);

    expect(handleTabListKeyDown(keyEvent("ArrowLeft"), tablist)).toBe(true);
    expect(active).toBe(tab2);

    expect(handleTabListKeyDown(keyEvent("Home"), tablist)).toBe(true);
    expect(active).toBe(tab1);

    expect(handleTabListKeyDown(keyEvent("End"), tablist)).toBe(true);
    expect(active).toBe(tab2);
    expect(prevented).toBe(5);

    // IME composition must not move tabs.
    expect(
      handleTabListKeyDown(
        keyEvent("ArrowLeft", { isComposing: true, keyCode: 229 }),
        tablist,
      ),
    ).toBe(false);
    expect(
      handleTabListKeyDown(keyEvent("ArrowLeft", { keyCode: 229 }), tablist),
    ).toBe(false);
    expect(active).toBe(tab2);

    // Unrelated keys must not be intercepted.
    expect(handleTabListKeyDown(keyEvent("Enter"), tablist)).toBe(false);
  });
});

describe("Wave 3 dark-mode QR, disabled buttons, note bubbles, and landing contrast", () => {
  test("QR code keeps a pure white quiet zone in both light and dark themes", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const qrSvg = readFileSync(
      new URL("../components/QrSvg.tsx", import.meta.url),
      "utf8",
    );

    const darkMediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
    const lightTokens = parseYmTokens(css.slice(0, darkMediaStart));
    const darkMediaEnd = css.indexOf("\n}\n", darkMediaStart + 100);
    const darkMediaTokens = parseYmTokens(
      css.slice(darkMediaStart, darkMediaEnd),
    );
    const explicitDarkStart = css.indexOf(':root[data-theme="dark"]');
    const explicitDarkEnd = css.indexOf("\n}\n", explicitDarkStart);
    const explicitDarkTokens = parseYmTokens(
      css.slice(explicitDarkStart, explicitDarkEnd),
    );

    expect(lightTokens["--ym-qr-bg"]).toBe("#ffffff");
    expect(darkMediaTokens["--ym-qr-bg"]).toBe("#ffffff");
    expect(explicitDarkTokens["--ym-qr-bg"]).toBe("#ffffff");
    expect(contrastRatio("#000000", darkMediaTokens["--ym-qr-bg"]!)).toBe(21);

    const qrCodeBlock = css.match(/\.p-qr-code\s*\{[^}]*\}/)?.[0] ?? "";
    expect(qrCodeBlock).toContain("background: var(--ym-qr-bg);");
    expect(qrSvg).toContain('fill="#ffffff"');
  });

  test("Wave 3 disabled-button and note-bubble tokens meet WCAG AA contrast", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const darkMediaStart = css.indexOf("@media (prefers-color-scheme: dark)");
    const lightTokens = parseYmTokens(css.slice(0, darkMediaStart));
    const darkMediaEnd = css.indexOf("\n}\n", darkMediaStart + 100);
    const darkTokens = {
      ...lightTokens,
      ...parseYmTokens(css.slice(darkMediaStart, darkMediaEnd)),
    };

    for (const [mode, tokens] of [
      ["light", lightTokens],
      ["dark", darkTokens],
    ] as const) {
      const pairs: Array<[string, string, string]> = [
        [
          "disabled primary button fg on bg",
          tokens["--ym-accent-btn-disabled-fg"]!,
          tokens["--ym-accent-btn-disabled-bg"]!,
        ],
        [
          "note bubble fg on bg",
          tokens["--ym-note-bubble-fg"]!,
          tokens["--ym-note-bubble-bg"]!,
        ],
        [
          "note bubble fg on hover bg",
          tokens["--ym-note-bubble-fg"]!,
          tokens["--ym-note-bubble-hover-bg"]!,
        ],
        [
          "inverted link on inverted bg",
          tokens["--ym-inverted-link"]!,
          tokens["--ym-inverted-bg"]!,
        ],
      ];

      for (const [label, fg, bg] of pairs) {
        expect(
          contrastRatio(fg, bg),
          `${mode} ${label} (${fg} on ${bg})`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    // Destructive confirms and error toasts must override --ym-inverted-fg
    // with --ym-accent-fg so dark mode never renders dark text on red.
    const dangerConfirmBlock =
      css.match(/\.yc-confirm-ok\.is-danger\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dangerConfirmBlock).toContain("color: var(--ym-accent-fg);");
    const errorToastBlock =
      css.match(/\.yc-toast\.is-error\s*\{[^}]*\}/)?.[0] ?? "";
    expect(errorToastBlock).toContain("color: var(--ym-accent-fg);");

    // Toast action buttons must re-enable pointer events inside pointer-events:none host.
    const toastActionBlock =
      css.match(/\.yc-toast-action\s*\{[^}]*\}/)?.[0] ?? "";
    expect(toastActionBlock).toContain("pointer-events: auto;");
    expect(toastActionBlock).toContain("color: var(--ym-inverted-link);");

    // No hardcoded light-pink disabled button backgrounds remain.
    expect(css).not.toContain("background: #f3a5a5;");
    expect(css).not.toContain("background: #f0b1b1;");

    // File input inside story composer stays keyboard-reachable (no display:none).
    expect(css).not.toMatch(/\.p-story-file\s+input\s*\{[^}]*display:\s*none/);
  });

  test("landing page buttons, footer, code comments, and skip link meet AA and JA consistency", () => {
    const site = readFileSync(
      new URL("../../site/index.html", import.meta.url),
      "utf8",
    );
    expect(site).toContain(">本文へスキップ<");
    expect(site).not.toContain(">Skip to content<");
    expect(site).toContain('aria-label="サイト内メニュー"');
    expect(site).toContain('aria-label="フッターメニュー"');

    const accentBtn =
      site.match(/--accent-btn:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "";
    const accentInk =
      site.match(/--accent-ink:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "";
    const faint = site.match(/--faint:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "";

    expect(contrastRatio("#ffffff", accentBtn)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", accentInk)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(faint, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("Wave 3 review fixes: StoryViewer video/ARIA, stories.error, QR tabpanel, and focus/mobile layout", () => {
  test("syncStoryVideoPlayback pauses and resumes videos safely", () => {
    const calls: string[] = [];
    const video = {
      pause() {
        calls.push("pause");
      },
      play() {
        calls.push("play");
        return Promise.reject(new Error("autoplay blocked"));
      },
    };

    syncStoryVideoPlayback(undefined, true);
    syncStoryVideoPlayback(null, false);
    syncStoryVideoPlayback(video, true);
    syncStoryVideoPlayback(video, false);
    expect(calls).toEqual(["pause", "play"]);
  });

  test("resolveStoryDeepLink never reads stories() while errored or loading", () => {
    let reads = 0;
    const throwingResource = {
      loading: false,
      error: new Error("500 /api/stories"),
      read() {
        reads += 1;
        throw new Error("must not read errored resource");
      },
    };
    expect(
      resolveStoryDeepLink(
        "https://example.test/ap/stories/1",
        throwingResource,
      ),
    ).toEqual({ kind: "wait" });
    expect(reads).toBe(0);

    expect(
      resolveStoryDeepLink("https://example.test/ap/stories/1", {
        loading: true,
        error: undefined,
        read() {
          reads += 1;
          return [];
        },
      }),
    ).toEqual({ kind: "wait" });
    expect(reads).toBe(0);

    expect(
      resolveStoryDeepLink(undefined, {
        loading: false,
        error: undefined,
        read() {
          reads += 1;
          return [];
        },
      }),
    ).toEqual({ kind: "wait" });
    expect(reads).toBe(0);

    const groups = [
      {
        actor: { ap_id: "https://example.test/ap/users/a" },
        has_unviewed: true,
        stories: [
          { ap_id: "https://example.test/ap/stories/s1" },
          { ap_id: "https://example.test/ap/stories/s2" },
        ],
      },
    ] as unknown as ActorStories[];

    expect(
      resolveStoryDeepLink("https://example.test/ap/stories/s2", {
        loading: false,
        error: undefined,
        read: () => groups,
      }),
    ).toEqual({ kind: "open", actorIndex: 0, storyIndex: 1 });

    expect(
      resolveStoryDeepLink("https://example.test/ap/stories/missing", {
        loading: false,
        error: undefined,
        read: () => groups,
      }),
    ).toEqual({ kind: "clear" });
  });

  test("StoryViewerModal keeps constant ARIA toggle name, visible counts, and video pause sync", () => {
    const appSrc = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const pauseBtn =
      appSrc.match(/<button\s+class="p-story-pause"[\s\S]*?>/)?.[0] ?? "";
    expect(pauseBtn).toContain("autofocus");
    expect(pauseBtn).toContain("aria-pressed={userPaused()}");
    expect(pauseBtn).toContain('aria-label="一時停止"');
    expect(pauseBtn).not.toContain("再生を再開");

    const actionsBlock =
      appSrc.match(
        /<div class="p-story-actions">[\s\S]*?<Show when=\{!isOwnStory\(\)/,
      )?.[0] ?? "";
    expect(actionsBlock).toContain("aria-pressed={!!story().liked}");
    expect(actionsBlock).not.toContain("aria-label=");
    expect(appSrc).toContain("syncStoryVideoPlayback(videoEl(), paused())");
  });

  test("QRCodeModal uses a persistent tabpanel id so inactive tab aria-controls never dangles", () => {
    const qrSrc = readFileSync(
      new URL("../components/QRCodeModal.tsx", import.meta.url),
      "utf8",
    );
    const controls = Array.from(
      qrSrc.matchAll(/aria-controls="([^"]+)"/g),
      (m) => m[1],
    );
    expect(controls).toEqual(["qr-tabpanel", "qr-tabpanel"]);
    expect(qrSrc).toContain('id="qr-tabpanel"');
    expect(qrSrc).toContain('role="tabpanel"');
  });

  test("CSS fixes mobile story header clearance, inset banner focus ring, and visible sheet close icon", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 768px)"));
    expect(mobileBlock).toContain(
      ".p-story-viewer-head {\n    padding-right: 52px;",
    );
    expect(mobileBlock).toContain(
      ".p-story-progress {\n    margin-right: 52px;",
    );
    expect(mobileBlock).toContain(".p-sheet-head button,");
    expect(mobileBlock).toContain(".yc-toast-action,");

    const bannerFocus =
      css.match(/\.p-edit-banner:focus-within\s*\{[^}]*\}/)?.[0] ?? "";
    expect(bannerFocus).toContain("outline-offset: -2px;");

    const sheetCloseSvg =
      css.match(/\.p-sheet-head button svg\s*\{[^}]*\}/)?.[0] ?? "";
    expect(sheetCloseSvg).toContain("width: 18px;");
    expect(sheetCloseSvg).toContain("height: 18px;");
  });
});
