export type ParserProbeVariant = "bare" | "parenthesized" | "values";

export interface ParserProbeStatementDigest {
  index: number;
  bytes: number;
  sha256: string;
}

export interface ParserProbeVariantResult {
  variant: ParserProbeVariant;
  databaseName: string;
  databaseId: string;
  outcome: "INCOMPLETE_INPUT_OBSERVED" | "EXPECTED_LATE_CONSTRAINT_FAILURE";
  schemaReadback: "UNCHANGED";
  bodySha256: string;
  bodyBytes: number;
  statementManifest: ParserProbeStatementDigest[];
  privateResponse: string;
}

export interface ParserProbeResult {
  phase: "probe-case-parser";
  status: "DIAGNOSTIC_ONLY";
  databaseCount: number;
  variants: ParserProbeVariantResult[];
  noRetry: true;
  noDelete: true;
  noWorkerOrDomainMutation: true;
}

export interface RunCaseParserProbeOptions {
  accountId: string;
  zoneId: string;
  token: string;
  diagnosticsDir: string;
  fetchImpl?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
}

export function runCaseParserProbe(
  options: RunCaseParserProbeOptions,
): Promise<ParserProbeResult>;

export const parserProbeTestSupport: {
  variants: readonly {
    readonly name: ParserProbeVariant;
    readonly databaseName: string;
  }[];
  buildParserProbeBatch(variant: ParserProbeVariant): { sql: string }[];
  triggerSql(variant: ParserProbeVariant): string;
  queryRequestBody(batch: { sql: string }[]): {
    body: { batch: { sql: string }[] };
    bytes: Uint8Array;
    bodySha256: string;
    bodyBytes: number;
  };
  sqlManifest(batch: { sql: string }[]): ParserProbeStatementDigest[];
  isApiSuccess(value: unknown): boolean;
  assertD1InventoryPage(
    result: { ok: boolean; value: unknown },
    page: number,
    expectedPerPage: number,
  ): { rows: Record<string, unknown>[]; info: Record<string, number> };
  assertDatabaseIdentity(body: unknown, name: string, uuid: string): void;
  assertFreshSchema(rows: unknown[]): unknown[];
  assertSchemaUnchanged(before: unknown[], after: unknown[]): unknown[];
  classifyWrite(
    result: Record<string, unknown>,
    variant: ParserProbeVariant,
  ): string;
  RAW_SCHEMA_SQL: string;
};
