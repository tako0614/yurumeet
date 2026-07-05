import {
  type ApiTransport,
  setYurucommuApiTransport,
} from "@takosjp/yurucommu-api";

const STORAGE_KEY = "yurumeet.serverOrigin";

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

function isPrivateLanIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

function shouldUseSameOriginByDefault(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    isPrivateLanIpv4(host) ||
    host === "yurume.test" ||
    host.endsWith(".yurume.test") ||
    host === "yurumeet.test" ||
    host.endsWith(".yurumeet.test")
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
  const configured =
    readQueryConfiguredOrigin() ??
    readBuildConfiguredOrigin() ??
    readStoredOrigin();
  if (configured) return configured;
  return shouldUseSameOriginByDefault() ? window.location.origin : null;
}

export function saveYurumeetServerOrigin(origin: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, origin);
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
