export interface IntegrationTarget {
  accountId: string;
  zoneId: string;
  origin: string;
  prefix: string;
  releaseTag: string;
  artifactSha256: string;
  sourceCommit: string;
  stateDir: string;
  expectedUrl: string;
}

export function parseIntegrationArgs(args: string[]): string;
export function isApiSuccess(value: unknown): boolean;
export function loadIntegrationTarget(path?: string): IntegrationTarget;
export function assertPinnedRootDefaults(
  source: string,
  releaseTag: string,
  expectedUrl: string,
  expectedSha256: string,
): void;
export function assertStateAddresses(
  addresses: string[],
  expectedManaged: Set<string>,
  activated: boolean,
): void;
export function assertCreateOnlyPlan(
  shown: unknown,
  allowed: Set<string>,
  existing?: Set<string>,
  expectedReads?: Set<string>,
): void;
export function assertDomainChangeset(changeset: unknown): void;
export function assertWorkerScriptAbsent(value: unknown): void;
export function assertCompleteNativeFull35D1Inventory(
  value: unknown,
): unknown[];
export function withNativeFull35PostCreate<T>(
  action: () => T | Promise<T>,
): Promise<T>;
export function writeNativeFull35CreateReceipt(
  receipt: unknown,
  writer?: (label: string, output: string) => string,
): string;
export function assertInventoryPage(
  body: unknown,
  page: number,
  key: string,
): { page: number; per_page: number; count: number; total_count: number };
export function assertDomainInventory(
  value: unknown,
  field: string,
  expected: string,
): {
  rows: unknown[];
  perPage: number;
  count: number;
  totalCount: number;
  totalPages?: number;
};
export function listFilteredDomains(
  accountId: string,
  field: "hostname" | "service",
  expected: string,
  request: (path: string) => Promise<unknown>,
): Promise<unknown[]>;
export function assertDomainAbsent(
  rows: unknown[],
  field: "hostname" | "service",
): void;
export function deployIntegration(
  args: string[],
): Promise<Record<string, unknown>>;

export function assertSingleSuccessfulQuery(body: unknown): void;
