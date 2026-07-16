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
