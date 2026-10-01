export type CloudflareAuthentication =
  | { type: "api_token" | "oauth"; token: string }
  | { type: "api_key"; key: string; email: string };

export type TrafficPart = Readonly<{ versionId: string; percentage: number }>;

export type PredecessorSnapshot = Readonly<{
  deploymentId: string;
  trafficMap: readonly TrafficPart[];
  predecessorVersionId: string;
  activeDatabaseId: string;
  closureDigest: string;
}>;

export type ProviderPhase =
  | "PRE_UPLOAD_FAILURE"
  | "POST_UPLOAD_INDETERMINATE"
  | "POST_DEPLOY_INDETERMINATE";

export class YurumeetProviderFailure extends Error {
  readonly phase: ProviderPhase;
  readonly operation?: string;
  readonly status?: number;
  readonly codes?: readonly number[];
  readonly diagnostic?: string;
  readonly recovery?: {
    deploymentId: string;
    trafficMap: TrafficPart[];
    predecessorVersionId?: string;
    versionId?: string;
    publishedDeploymentId?: string;
  };
}

export function createYurumeetCodeOnlyProvider(options: {
  accountId: string;
  workerName: string;
  authentication: CloudflareAuthentication;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}): {
  readTrafficAndVersion(input: {
    requiredSecretNames: string[];
    expectedConfig: Record<string, unknown>;
  }): Promise<PredecessorSnapshot>;
  revalidate(snapshot: PredecessorSnapshot): Promise<{
    deploymentId: string;
    trafficMap: TrafficPart[];
    predecessorVersionId: string;
    closureDigest: string;
  }>;
  queryReadonlySchema(databaseId: string, sql?: string): Promise<unknown>;
  uploadCodeOnly(input: {
    bundleBytes: Uint8Array;
    snapshot: PredecessorSnapshot;
    expectedConfig: Record<string, unknown>;
    message: string;
  }): Promise<{ versionId: string; sha256: string }>;
  promote(input: {
    snapshot: PredecessorSnapshot;
    versionId: string;
    message: string;
  }): Promise<{
    deploymentId: string;
    trafficMap: TrafficPart[];
    versionId: string;
    sha256: string;
  }>;
  verifyPublished(input: {
    snapshot: PredecessorSnapshot;
    versionId: string;
    deploymentId: string;
  }): Promise<{
    deploymentId: string;
    versionId: string;
    trafficMap: TrafficPart[];
    sha256: string;
  }>;
};
