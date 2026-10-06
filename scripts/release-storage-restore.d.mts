export type ClosedStoreFile = {
  path: string;
  bytes: number;
  sha256: string;
};

export type ClosedStoreInventory = {
  files: ClosedStoreFile[];
  fileCount: number;
  totalBytes: number;
  sha256: string;
};

export type StoreNames = "d1" | "kv" | "r2";
export type StorePaths = Record<StoreNames, string>;
export type ClosedStores = Record<StoreNames, ClosedStoreInventory>;

export declare function inventoryClosedStores(paths: StorePaths): ClosedStores;
export declare function assertClosedStoreInventoriesEqual(
  expected: ClosedStores,
  actual: ClosedStores,
): void;
export declare function cloneClosedStores(
  sourcePaths: StorePaths,
  destinationRoot: string,
  expectedInventory: ClosedStores,
): { paths: StorePaths; inventory: ClosedStores };

export type SnapshotDb = {
  prepare(sql: string): {
    all(): Promise<{ results: unknown[] }>;
  };
};

export type SnapshotTableCoverage = {
  applicationTableCount: number;
  snapshottedTables: string[];
  runtimeOwnedExcludedTables: string[];
  sqliteSequencePresent: boolean;
  excludedFromRowComparison: string[];
  normalizedColumns: string[];
  canonicalization: string;
  foreignKeyViolationCount: 0;
};

export type ApplicationDataSnapshot = {
  schemaSha256: string;
  relationshipsSha256: string;
  dataSha256: string;
  counts: Record<string, number>;
  tableCoverage: SnapshotTableCoverage;
  actorUpdatedAt?: string;
};

export declare function dataSnapshot(
  db: SnapshotDb,
  includeSessions?: boolean,
  normalizeLoginTimestamp?: boolean,
): Promise<ApplicationDataSnapshot>;

export type StorageRestoreReceipt = {
  kind: "yurumeet.native-storage-restore@v1";
  status: "PASSED";
  artifactSha256: string;
  physicalIds: Record<StoreNames, string>;
  schemaSha256: string;
  migrationCount: number;
  checks: string[];
  closedStores: ClosedStores;
  clonedStores: ClosedStores;
  schemaFingerprintSha256: string;
  dataFingerprintSha256: string;
  tableCoverage: SnapshotTableCoverage & { rowCounts: Record<string, number> };
  authentication: "password" | "oidc";
  oidc?: {
    issuer: import("./release-storage-oidc.mjs").RestoreOidcEvidence;
    credentials: string;
    limitation: string;
    runtimeDiagnostics: {
      policy: "discard-without-retaining-or-forwarding-raw-output";
      observedBytes: number;
    };
  };
  externalWorkerFetches: {
    policy:
      | "denied-locally-by-miniflare-outbound-service"
      | "local-synthetic-oidc-endpoints-only";
    observedBlockedFetches: 0;
  };
  scope: string;
};

export declare function qualifyStorageRestore(args: {
  artifactPath: string;
  artifactSha256: string;
  repoRoot: string;
  authentication?: "password" | "oidc";
  wranglerConfig: {
    compatibility_date: string;
    compatibility_flags: string[];
  };
}): Promise<StorageRestoreReceipt>;
