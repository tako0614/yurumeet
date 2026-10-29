export type FreshIntegrationSchemaOptions = {
  accountId: string;
  databaseId: string;
  token: string;
  repo: string;
  diagnosticsDir: string;
  fetchImpl?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  mode?: "original" | "native-full35";
};

export type FreshIntegrationSchemaResult = {
  status: "APPLIED";
  databaseId: string;
  coreVersion: "4.2.0";
  migrationCount: 35;
  migrations: string[];
  mapSha256: string;
  mode?: "native-full35";
  projectedMigration?: "0034_staged_media_retention.sql";
  evidence?: Array<{ path: string; sha256: string }>;
};

export type RecoverPrefix32IntegrationSchemaResult = {
  status: "APPLIED";
  phase: "recover-prefix32";
  databaseId: string;
  coreVersion: "4.2.0";
  prefixLength: 32;
  migrationCount: 35;
  applied: string[];
  skipped: string[];
  mapSha256: string;
};

export declare function applyFreshIntegrationSchema(
  options: FreshIntegrationSchemaOptions,
): Promise<FreshIntegrationSchemaResult>;

export declare function recoverPrefix32IntegrationSchema(
  options: Omit<FreshIntegrationSchemaOptions, "mode">,
): Promise<RecoverPrefix32IntegrationSchemaResult>;

export declare const integrationSchemaTestSupport: Readonly<{
  migrationNames: readonly string[];
  migrationMapSha256: string;
  probeTable: string;
  probeLogTable: string;
  probeTrigger: string;
  assertMigrationScript(
    sql: string,
    migration: string,
    migrationSql: string,
    mode?: "original" | "native-full35",
  ): string;
  projectNativeFull35Script(
    sql: string,
    migration: string,
    migrationSql: string,
  ): string;
  readNativeFull35Reference(
    repo: string,
    inputs: unknown,
  ): {
    schema: unknown[];
    ledger: unknown[];
    foreignKeyViolations: unknown[];
    backfill: unknown[];
  };
  nativeFull35DatabaseName: "yurumeet-ga-20261012-0938-native-full35";
  nativeFull35SchemaSql: string;
  buildMigrationBatch(sql: string, migration: string): Array<{ sql: string }>;
  splitSqlStatements(sql: string): string[];
  assertEnvelope(
    result: unknown,
    expectedCount: number | undefined,
    label: string,
    context: unknown,
    requireRows?: boolean,
  ): unknown[];
  proveRestBatchAtomicity(context: unknown): Promise<void>;
  verifyCoreInputs(repo: string): Promise<{
    migrationsDir: string;
    applyMigrations: (options: unknown) => Promise<{
      applied: string[];
      skipped: string[];
    }>;
  }>;
  emptySchemaSql: string;
}>;
