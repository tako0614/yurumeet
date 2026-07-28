/**
 * Stale-asset recovery for the lazily-loaded route chunks.
 *
 * WHY: the Worker embeds the built assets in its own script and serves them
 * under hashed `/assets/*.js` names, so a redeploy makes every chunk the open
 * tab still references disappear. `index.html` is `no-cache`, so a full reload
 * fixes it — but a `lazy()` route that resolves to a 404 rejects inside Solid's
 * Suspense boundary and, with no handler, leaves a blank screen the user has no
 * way to interpret. Ported from takosumi/dashboard/src/lib/chunk-reload.ts;
 * kept behaviourally identical so the two do not drift into two theories of the
 * same failure.
 */
const RELOAD_KEY = "yurumeet.stale-asset-reload@v1";
const RELOAD_COOLDOWN_MS = 60_000;

const STALE_ASSET_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Expected a JavaScript-or-Wasm module script",
  'MIME type of "text/html"',
  "ChunkLoadError",
];

export function isLikelyStaleAssetError(value: unknown): boolean {
  const text = errorText(value);
  if (STALE_ASSET_PATTERNS.some((pattern) => text.includes(pattern))) {
    return true;
  }
  return /\/assets\/[^ \n?]+\.js(?:\?|$)/u.test(text);
}

export function installStaleAssetReload(): void {
  if (typeof window === "undefined") return;

  const reload = (value: unknown) => {
    if (!isLikelyStaleAssetError(value)) return;
    // The cooldown is what keeps a genuinely broken deploy from turning into a
    // reload loop: a second failure for the same URL within a minute falls
    // through to the error boundary instead.
    if (!claimReloadSlot(window.location.href, Date.now())) return;
    window.location.reload();
  };

  window.addEventListener("error", (event) => {
    reload(event.error ?? event.message ?? event);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reload(event.reason);
  });
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  }
  if (value && typeof value === "object") {
    const maybe = value as {
      readonly message?: unknown;
      readonly filename?: unknown;
      readonly target?: unknown;
      readonly srcElement?: unknown;
      readonly reason?: unknown;
    };
    const target = maybe.target ?? maybe.srcElement;
    const src =
      target && typeof target === "object" && "src" in target
        ? String((target as { readonly src?: unknown }).src ?? "")
        : "";
    return [
      typeof maybe.message === "string" ? maybe.message : "",
      typeof maybe.filename === "string" ? maybe.filename : "",
      src,
      maybe.reason ? errorText(maybe.reason) : "",
    ].join("\n");
  }
  return String(value ?? "");
}

function claimReloadSlot(href: string, now: number): boolean {
  const previous = readPreviousReload();
  if (
    previous &&
    previous.href === href &&
    Number.isFinite(previous.at) &&
    now - previous.at < RELOAD_COOLDOWN_MS
  ) {
    return false;
  }
  window.sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ href, at: now }));
  return true;
}

function readPreviousReload(): {
  readonly href: string;
  readonly at: number;
} | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      readonly href?: unknown;
      readonly at?: unknown;
    };
    if (typeof parsed.href !== "string" || typeof parsed.at !== "number") {
      return null;
    }
    return { href: parsed.href, at: parsed.at };
  } catch {
    return null;
  }
}
