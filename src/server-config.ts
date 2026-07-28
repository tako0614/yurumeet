import {
  type ApiTransport,
  setYurucommuApiTransport,
} from "@takosjp/yurucommu-api";

const STORAGE_KEY = "yurumeet.serverOrigin";

function isDevelopmentBuild(): boolean {
  const env = (
    import.meta as unknown as {
      readonly env?: { readonly DEV?: boolean };
    }
  ).env;
  return env?.DEV === true;
}

function readBuildConfiguredOrigin(): string | null {
  const env = (
    import.meta as unknown as {
      readonly env?: Record<string, string | undefined>;
    }
  ).env;
  return normalizeServerOrigin(env?.VITE_YURUME_SERVER_URL);
}

function readQueryConfiguredOrigin(): string | null {
  if (typeof window === "undefined") return null;
  return normalizeServerOrigin(
    new URLSearchParams(window.location.search).get("server"),
  );
}

function readStoredOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeServerOrigin(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function shouldUseSameOriginByDefault(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.protocol === "http:" ||
    window.location.protocol === "https:"
  );
}

export function selectYurumeetServerOrigin(input: {
  readonly appOrigin: string | null | undefined;
  readonly development: boolean;
  readonly queryOverride: string | null | undefined;
  readonly buildOverride: string | null | undefined;
  readonly storedOverride: string | null | undefined;
}): string | null {
  const appOrigin = normalizeServerOrigin(input.appOrigin);
  if (!input.development) return appOrigin;

  return (
    normalizeServerOrigin(input.queryOverride) ??
    normalizeServerOrigin(input.buildOverride) ??
    normalizeServerOrigin(input.storedOverride) ??
    appOrigin
  );
}

export function normalizeServerOrigin(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readYurumeetServerOrigin(): string | null {
  if (typeof window === "undefined") return null;
  return selectYurumeetServerOrigin({
    appOrigin: shouldUseSameOriginByDefault() ? window.location.origin : null,
    development: isDevelopmentBuild(),
    queryOverride: readQueryConfiguredOrigin(),
    buildOverride: readBuildConfiguredOrigin(),
    storedOverride: readStoredOrigin(),
  });
}

export function saveYurumeetServerOrigin(origin: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeServerOrigin(origin);
  if (!normalized) return;
  if (!isDevelopmentBuild() && normalized !== window.location.origin) return;
  window.localStorage.setItem(STORAGE_KEY, normalized);
}

export function clearYurumeetServerOrigin(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

class YurumeetApiTransport implements ApiTransport {
  readonly credentials: RequestCredentials = "include";

  constructor(private readonly serverOrigin: string) {}

  resolveUrl(path: string): string {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
    return new URL(path, this.serverOrigin).toString();
  }

  getAuthHeaders(_path: string): Record<string, string> {
    return {};
  }
}

export function configureYurumeetServerOrigin(origin: string): void {
  setYurucommuApiTransport(new YurumeetApiTransport(origin));
}

export function serverUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}
