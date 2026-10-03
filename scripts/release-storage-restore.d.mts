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
  externalWorkerFetches: {
    policy: "denied-locally-by-miniflare-outbound-service";
    observedBlockedFetches: 0;
  };
  scope: string;
};

export declare function qualifyStorageRestore(args: {
  artifactPath: string;
  artifactSha256: string;
  repoRoot: string;
  wranglerConfig: {
    compatibility_date: string;
    compatibility_flags: string[];
  };
}): Promise<StorageRestoreReceipt>;
