export interface OAuthProvider {
  id: string;
  name: string;
  icon: string;
}

export interface AuthConfig {
  providers: OAuthProvider[];
  password_enabled: boolean;
}

const PROVIDER_ID = /^[a-z0-9_-]+$/;

export function parseAuthConfig(value: unknown): AuthConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.password_enabled !== "boolean" ||
    !Array.isArray(record.providers)
  ) {
    return null;
  }

  const providers: OAuthProvider[] = [];
  for (const candidate of record.providers) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const provider = candidate as Record<string, unknown>;
    if (
      typeof provider.id !== "string" ||
      !PROVIDER_ID.test(provider.id) ||
      typeof provider.name !== "string" ||
      provider.name.trim() === "" ||
      typeof provider.icon !== "string"
    ) {
      return null;
    }
    providers.push({
      id: provider.id,
      name: provider.name.trim(),
      icon: provider.icon,
    });
  }

  return { providers, password_enabled: record.password_enabled };
}

export function shouldAutoStartTakosumiOidc(config: AuthConfig): boolean {
  return (
    !config.password_enabled &&
    config.providers.length === 1 &&
    config.providers[0]?.id === "takos"
  );
}

const AUTO_START_KEY = "yurumeet:oidc-auto-start-attempted";

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Claims the one automatic Takosumi OIDC redirect allowed for this browser tab.
 *
 * Auto-start is what makes a passwordless deployment feel like one product, but
 * unguarded it cannot be escaped: the Takosumi session outlives our cookie, so
 * signing out re-renders the signed-out screen, which redirects, which signs
 * the user straight back in. A failed round-trip loops the same way. Returning
 * false leaves the visible provider button as the manual path.
 */
export function claimTakosumiOidcAutoStart(
  storage: Storage | undefined = sessionStorageOrUndefined(),
): boolean {
  if (!storage) return true;
  try {
    if (storage.getItem(AUTO_START_KEY) !== null) return false;
    storage.setItem(AUTO_START_KEY, "1");
    return true;
  } catch {
    return true;
  }
}

/** Arms the breaker so an explicit sign-out lands on the signed-out screen. */
export function suppressTakosumiOidcAutoStart(
  storage: Storage | undefined = sessionStorageOrUndefined(),
): void {
  try {
    storage?.setItem(AUTO_START_KEY, "1");
  } catch {
    // sessionStorage unavailable; the one-shot claim above is the fallback.
  }
}
