import { describe, expect, test } from "bun:test";

import {
  installStaleAssetReload,
  isLikelyStaleAssetError,
} from "./chunk-reload.ts";

describe("stale asset detection", () => {
  // These are the strings the browsers actually produce when a hashed route
  // chunk 404s after a redeploy. The Worker serves embedded assets, so the old
  // chunk is gone the moment a new script is published.
  test("recognises dynamic-import failures", () => {
    for (const message of [
      "TypeError: Failed to fetch dynamically imported module: https://yurumeet.example/assets/SettingsPage-8f21c0.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
      "ChunkLoadError: Loading chunk 3 failed.",
    ]) {
      expect(isLikelyStaleAssetError(new Error(message))).toBe(true);
    }
  });

  // The URL fallback only fires when the asset path ends the extracted text —
  // the same boundary the takosumi implementation has. Kept as a pinned fact so
  // a future widening is a deliberate change in both copies, not a local drift.
  test("recognises a bare asset URL, but only at the end of the text", () => {
    expect(
      isLikelyStaleAssetError(
        "Unable to load https://yurumeet.example/assets/index-3ab991.js",
      ),
    ).toBe(true);
    expect(
      isLikelyStaleAssetError({
        message: "Script error.",
        filename: "https://yurumeet.example/assets/index-3ab991.js",
      }),
    ).toBe(false);
  });

  // Reloading on an ordinary application error would hide the bug behind a
  // refresh loop, which the cooldown only bounds — it must not trigger at all.
  test("leaves ordinary application errors alone", () => {
    for (const value of [
      new Error("投稿の作成に失敗しました"),
      new TypeError("Load failed"),
      { message: "401 Unauthorized" },
      undefined,
    ]) {
      expect(isLikelyStaleAssetError(value)).toBe(false);
    }
  });
});

test("an offline import failure preserves the next online reload slot", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const handlers = new Map<
    string,
    (event: { reason?: Error; message?: string }) => void
  >();
  const storage = new Map<string, string>();
  const navigator = { onLine: false };
  let reloads = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      navigator,
      addEventListener: handlers.set.bind(handlers),
      location: {
        href: "https://yurumeet.example/profile",
        reload: () => reloads++,
      },
      sessionStorage: {
        getItem: storage.get.bind(storage),
        setItem: storage.set.bind(storage),
      },
    },
  });
  try {
    const message = "Failed to fetch dynamically imported module";
    installStaleAssetReload();
    handlers.get("unhandledrejection")!({ reason: new TypeError(message) });
    handlers.get("error")!({ message });
    expect(reloads).toBe(0);
    expect(storage.size).toBe(0);

    navigator.onLine = true;
    handlers.get("error")!({ message });
    handlers.get("unhandledrejection")!({ reason: new TypeError(message) });
    expect(reloads).toBe(1);
    expect(storage.size).toBe(1);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
