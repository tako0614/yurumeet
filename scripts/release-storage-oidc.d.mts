export type RestoreOidcTokens = {
  cookie: string;
  access: string;
  refresh: string;
};

export type RestoreOidcSessionRow = {
  provider: string | null;
  provider_access_token: string | null;
  provider_refresh_token: string | null;
};

export type RestoreOidcEvidence = {
  jwks: number;
  token: number;
  userinfo: number;
  blocked: number;
  logins: number;
};

export type RestoreOidcIssuer = {
  bindings: {
    OIDC_ISSUER_URL: "https://restore-issuer.yurumeet.invalid";
    OIDC_CLIENT_ID: "native-restore-synthetic-public-client";
    OIDC_OWNER_SUB: "restore_fixture";
  };
  fetch(request: Request): Promise<Response>;
  login<MF>(
    mf: MF,
    fetchPath: (
      mf: MF,
      path: string,
      init?: RequestInit & { redirect?: RequestRedirect },
    ) => Promise<Response>,
    activeCookieParser: (response: Response, label: string) => string,
    existingRawCookie?: string,
  ): Promise<RestoreOidcTokens>;
  evidence(): RestoreOidcEvidence;
  assertEncrypted(
    row: RestoreOidcSessionRow,
    tokens: Pick<RestoreOidcTokens, "access" | "refresh">,
    keyHex: string,
    safeLabel: string,
  ): Promise<true>;
};

export declare function createSyntheticRestoreIssuer(args: {
  origin: string;
  need: (condition: unknown, safeLabel: string) => void;
}): Promise<RestoreOidcIssuer>;
