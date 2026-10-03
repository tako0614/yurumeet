import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MEDIA_DELETION_SCHEMA_QUERY,
  checkMediaDeletionSchema,
  readWorkerD1Target,
} from "./check-media-deletion-schema.mjs";

const repo = new URL("../", import.meta.url);
const dbId = "00000000-0000-4000-8000-000000000001";
const accountId = "a1234567890123456789012345678901";
const defaultApiBaseUrl = "https://api.cloudflare.com/client/v4";
const deploymentId = "00000000-0000-4000-8000-000000000010";
const firstVersionId = "00000000-0000-4000-8000-000000000011";
const secondVersionId = "00000000-0000-4000-8000-000000000012";
const thirdVersionId = "00000000-0000-4000-8000-000000000013";
const config = JSON.stringify({
  name: "yurumeet",
  account_id: accountId,
  secrets: {
    required: [
      "ENCRYPTION_KEY",
      "YURUCOMMU_SESSION_HASH_SALT",
      "AUTH_PASSWORD_HASH",
    ],
  },
  d1_databases: [
    {
      binding: "DB",
      database_name: "yurumeet-preflight-test-db",
      database_id: dbId,
    },
  ],
});

const columnRows = [
  {
    kind: "column",
    ordinal: 0,
    name: "r2_key",
    detail: "TEXT",
    required: 1,
    position: 1,
  },
  {
    kind: "column",
    ordinal: 1,
    name: "uploader_ap_id",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    kind: "column",
    ordinal: 2,
    name: "created_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
  {
    kind: "column",
    ordinal: 3,
    name: "next_attempt_at",
    detail: "TEXT",
    required: 1,
    position: 0,
  },
];
const indexRows = [
  {
    kind: "index",
    ordinal: 0,
    name: "media_blob_deletion_jobs_due_idx",
    detail: "c",
    required: 0,
    position: 0,
  },
  {
    kind: "index-column",
    ordinal: 0,
    name: "next_attempt_at",
    detail: "",
    required: 0,
    position: 3,
  },
  {
    kind: "index-column",
    ordinal: 1,
    name: "created_at",
    detail: "",
    required: 0,
    position: 2,
  },
  {
    kind: "index-column",
    ordinal: 2,
    name: "r2_key",
    detail: "",
    required: 0,
    position: 0,
  },
];

const responseFor = (rows: unknown) =>
  JSON.stringify([{ results: rows, success: true, meta: { duration: 1 } }]);

function parseDeployResult(stdout: string) {
  const marker = '\n{\n  "kind": "takos.deploy-result@v1"';
  const start = stdout.lastIndexOf(marker);
  if (start < 0) throw new Error("deploy result JSON was not printed");
  const end = stdout.indexOf("\n}\n", start + 1);
  if (end < 0) throw new Error("deploy result JSON was not terminated");
  return JSON.parse(stdout.slice(start + 1, end + 2));
}

function fixtureRun(stdout: string) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    return stdout;
  };
  return { calls, run };
}

describe("Core 4.1.11 migration 0030 D1 readiness contract", () => {
  test("executes the fixed metadata query against empty DB and actual migration 0030 SQL", async () => {
    const db = new Database(":memory:");
    const run = () =>
      JSON.stringify([
        {
          results: db.query(MEDIA_DELETION_SCHEMA_QUERY).all(),
          success: true,
          meta: {},
        },
      ]);
    try {
      expect(() =>
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toThrow(/migration 0030/u);

      const migration = await readFile(
        new URL(
          "../deploy/takoform/migrations/sql/0030_media_blob_deletion_jobs.sql",
          import.meta.url,
        ),
        "utf8",
      );
      db.exec(migration);
      expect(
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toEqual({
        kind: "yurumeet.core-media-deletion-schema@v1",
        table: "media_blob_deletion_jobs",
        index: "media_blob_deletion_jobs_due_idx",
        scope: "migration-0030-only",
      });
    } finally {
      db.close();
    }
  });

  test("uses the realized DB binding and verifies only migration 0030 metadata", () => {
    expect(readWorkerD1Target(config, "operator-wrangler.jsonc")).toEqual({
      binding: "DB",
      databaseName: "yurumeet-preflight-test-db",
      databaseId: dbId,
    });
    const { calls, run } = fixtureRun(
      responseFor([...columnRows, ...indexRows]),
    );
    const result = checkMediaDeletionSchema({
      configText: config,
      configPath: "operator-wrangler.jsonc",
      run,
    });
    expect(result).toEqual({
      kind: "yurumeet.core-media-deletion-schema@v1",
      table: "media_blob_deletion_jobs",
      index: "media_blob_deletion_jobs_due_idx",
      scope: "migration-0030-only",
    });
    expect(calls).toEqual([
      {
        command: "wrangler",
        args: [
          "d1",
          "execute",
          "DB",
          "--remote",
          "--json",
          "--config",
          "operator-wrangler.jsonc",
          "--command",
          MEDIA_DELETION_SCHEMA_QUERY,
        ],
      },
    ]);
    expect(MEDIA_DELETION_SCHEMA_QUERY).not.toMatch(
      /_cf_migrations|yurucommu_migrations/iu,
    );
    expect(MEDIA_DELETION_SCHEMA_QUERY).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/iu,
    );
  });

  test("fails before the CLI for malformed config, missing binding, bad id, collisions, or selected Wrangler env", () => {
    const invalidConfigs = [
      ["invalid JSON", "{"],
      ["missing DB", JSON.stringify({ d1_databases: [] })],
      [
        "missing database id",
        JSON.stringify({
          d1_databases: [{ binding: "DB", database_name: "test" }],
        }),
      ],
      [
        "malformed database id",
        JSON.stringify({
          d1_databases: [
            {
              binding: "DB",
              database_name: "test",
              database_id: "template-id",
            },
          ],
        }),
      ],
      [
        "duplicate DB bindings",
        JSON.stringify({
          d1_databases: [
            { binding: "DB", database_name: "one", database_id: dbId },
            { binding: "DB", database_name: "two", database_id: dbId },
          ],
        }),
      ],
      [
        "database-name collision",
        JSON.stringify({
          d1_databases: [
            { binding: "DB", database_name: "test", database_id: dbId },
            { binding: "OTHER", database_name: "DB", database_id: dbId },
          ],
        }),
      ],
    ] as const;
    for (const [label, configText] of invalidConfigs) {
      const { calls, run } = fixtureRun(
        responseFor([...columnRows, ...indexRows]),
      );
      expect(() =>
        checkMediaDeletionSchema({
          configText,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toThrow();
      expect(calls, label).toHaveLength(0);
    }

    const { calls, run } = fixtureRun(
      responseFor([...columnRows, ...indexRows]),
    );
    expect(() =>
      checkMediaDeletionSchema({
        configText: config,
        configPath: "operator-wrangler.jsonc",
        cloudflareEnv: "production",
        run,
      }),
    ).toThrow(/CLOUDFLARE_ENV/u);
    expect(calls).toHaveLength(0);
  });

  test("rejects missing, malformed, reordered, unique, partial, duplicate, or unexpected metadata", () => {
    const badRows = [
      [...columnRows.slice(1), ...indexRows],
      [
        ...columnRows.map((row) =>
          row.name === "r2_key" ? { ...row, position: 0 } : row,
        ),
        ...indexRows,
      ],
      [
        ...columnRows.map((row) =>
          row.name === "uploader_ap_id" ? { ...row, detail: "INTEGER" } : row,
        ),
        ...indexRows,
      ],
      [
        ...columnRows.map((row) =>
          row.name === "created_at" ? { ...row, required: 0 } : row,
        ),
        ...indexRows,
      ],
      [
        ...columnRows,
        ...indexRows.map((row) =>
          row.kind === "index" ? { ...row, required: 1 } : row,
        ),
      ],
      [
        ...columnRows,
        ...indexRows.map((row) =>
          row.kind === "index" ? { ...row, position: 1 } : row,
        ),
      ],
      [
        ...columnRows,
        ...indexRows.map((row) =>
          row.kind === "index-column" && row.ordinal === 0
            ? { ...row, name: "created_at" }
            : row,
        ),
      ],
      [...columnRows, ...indexRows, indexRows[0]],
      [...columnRows, ...indexRows, { kind: "unknown" }],
    ];

    for (const rows of badRows) {
      const { run } = fixtureRun(responseFor(rows));
      expect(() =>
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toThrow(/migration 0030/u);
    }
  });

  test("rejects command failures, invalid JSON, and unexpected or unsuccessful response envelopes", () => {
    const commandError = Object.assign(new Error("D1 access denied"), {
      stdout: Buffer.from("raw D1 response"),
      stderr: Buffer.from("permission denied"),
    });
    const failingRun = () => {
      throw commandError;
    };
    let thrown: (Error & { stdout?: Buffer; stderr?: Buffer }) | undefined;
    try {
      checkMediaDeletionSchema({
        configText: config,
        configPath: "operator-wrangler.jsonc",
        run: failingRun,
      });
    } catch (error) {
      thrown = error as Error & { stdout?: Buffer; stderr?: Buffer };
    }
    expect(thrown?.message).toMatch(/D1 access denied/u);
    expect(thrown?.stdout?.toString()).toBe("raw D1 response");
    expect(thrown?.stderr?.toString()).toBe("permission denied");

    for (const stdout of [
      "not-json",
      JSON.stringify({ results: [...columnRows, ...indexRows] }),
      JSON.stringify([
        { results: [...columnRows, ...indexRows], success: false, meta: {} },
      ]),
      JSON.stringify([
        { results: [...columnRows, ...indexRows], success: true },
      ]),
      JSON.stringify([
        { results: [...columnRows, ...indexRows], success: true, meta: {} },
        { results: [], success: true, meta: {} },
      ]),
    ]) {
      const { run } = fixtureRun(stdout);
      expect(() =>
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toThrow();
    }
  });
});

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createIsolatedDeployFixture(options: {
  configText?: string;
  configEnv?: string;
  queryMode?: "valid" | "denied" | "invalid-json" | "missing-schema";
  environment?: string;
  mutateConfigOnVersions?: boolean;
  deploymentFirst?: unknown;
  deploymentSecond?: unknown;
  deploymentError?: boolean;
  deploymentMalformed?: boolean;
  deploymentSecondError?: boolean;
  deploymentSecondMalformed?: boolean;
  publishError?: boolean;
  smokeError?: boolean;
  pathWithShellChars?: boolean;
  emptyEnvFile?: "missing" | "nonempty";
  mutateEmptyEnvAfterD1?: boolean;
  apiBaseUrl?: string;
  cfApiBaseUrl?: string;
  wranglerApiEnvironment?: string;
  complianceEnvironment?: string;
  poisonDefaultEnvFiles?: boolean;
}) {
  const tempPrefix = options.pathWithShellChars
    ? "yurumeet active's fixture-"
    : "yurumeet-schema-preflight-";
  const root = await mkdtemp(join(tmpdir(), tempPrefix));
  tempRoots.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "mock-bin");
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(join(root, "dist"), { recursive: true }),
  ]);

  for (const file of [
    "deploy.mjs",
    "check-media-deletion-schema.mjs",
    "release-artifact-manifest.mjs",
    "release-identity.mjs",
    "worker-publish-empty.env.example",
  ]) {
    await copyFile(new URL(`./${file}`, import.meta.url), join(scripts, file));
  }
  const emptyEnvPath = join(scripts, "worker-publish-empty.env.example");
  if (options.emptyEnvFile === "missing") await rm(emptyEnvPath);
  if (options.emptyEnvFile === "nonempty") {
    await writeFile(emptyEnvPath, "CLOUDFLARE_ENV=production\n", "utf8");
  }

  const configPath = join(root, "realized-wrangler.jsonc");
  await writeFile(configPath, options.configText ?? config, "utf8");
  const callLog = join(root, "calls.log");
  await writeFile(callLog, "", "utf8");
  const statusCounter = join(root, "status-count");
  await writeFile(statusCounter, "0", "utf8");
  if (options.poisonDefaultEnvFiles) {
    await writeFile(
      join(root, ".env"),
      "CLOUDFLARE_ENV=production\nCF_API_BASE_URL=https://poison.invalid\n",
      "utf8",
    );
    await writeFile(
      join(root, ".env.local"),
      "CLOUDFLARE_API_BASE_URL=https://poison.local.invalid\n",
      "utf8",
    );
  }
  const firstDeployment = options.deploymentFirst ?? {
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: firstVersionId, percentage: 100 }],
  };
  const secondDeployment = options.deploymentSecond ?? firstDeployment;
  const wranglerStub = `#!/bin/sh
printf 'wrangler %s\\n' "$*" >> "$CALL_LOG"
ENV_FILE=
PREVIOUS=
CONFIG_ARG=
WORKER_NAME=
for ARG in "$@"; do
  if [ "$PREVIOUS" = "--env-file" ]; then ENV_FILE=$ARG; fi
  if [ "$PREVIOUS" = "--config" ]; then CONFIG_ARG=$ARG; fi
  if [ "$PREVIOUS" = "--name" ]; then WORKER_NAME=$ARG; fi
  PREVIOUS=$ARG
done
if [ "$CONFIG_ARG" != "$CONFIG_PATH" ]; then echo 'unexpected config target' >&2; exit 84; fi
if ! grep -F '"account_id":"'$EXPECTED_ACCOUNT'"' "$CONFIG_ARG" >/dev/null; then echo 'unexpected account target' >&2; exit 83; fi
if { [ "$1" = "versions" ] || [ "$1" = "deploy" ]; } && [ "$WORKER_NAME" != "yurumeet" ]; then echo 'unexpected Worker target' >&2; exit 82; fi
if [ -z "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then echo 'missing explicit env file' >&2; exit 89; fi
if [ "$(wc -c < "$ENV_FILE")" -ne 0 ]; then echo 'explicit env file is not empty' >&2; exit 88; fi
if [ "$1" = "d1" ] && [ "$2" = "execute" ]; then
  case "$PREFLIGHT_MODE" in
    denied) echo 'raw D1 response'; echo 'D1 access denied' >&2; exit 1 ;;
    invalid-json) printf 'not-json' ;;
    missing-schema) printf '%s' "$MISSING_SCHEMA_RESPONSE" ;;
    *) printf '%s' "$READY_SCHEMA_RESPONSE" ;;
  esac
  if [ "$MUTATE_CONFIG_ON_VERSIONS" = "yes" ]; then printf '{"name":"changed","d1_databases":[]}\\n' > "$CONFIG_PATH"; fi
  if [ "$MUTATE_EMPTY_ENV_AFTER_D1" = "yes" ]; then printf 'CLOUDFLARE_ENV=production\\n' > "$ENV_FILE"; fi
  exit 0
fi
if [ "$1" = "versions" ]; then
    if [ "$2" = "deployments" ] && [ "$3" = "status" ]; then
    STATUS_COUNT=$(cat "$STATUS_COUNTER")
    STATUS_COUNT=$((STATUS_COUNT + 1)); printf '%s' "$STATUS_COUNT" > "$STATUS_COUNTER"
    if [ "$STATUS_COUNT" -eq 1 ] && [ "$DEPLOYMENT_ERROR" = "yes" ]; then echo 'no active deployment' >&2; exit 87; fi
    if [ "$STATUS_COUNT" -gt 1 ] && [ "$DEPLOYMENT_SECOND_ERROR" = "yes" ]; then echo 'deployment status denied' >&2; exit 86; fi
    if [ "$STATUS_COUNT" -eq 1 ] && [ "$DEPLOYMENT_MALFORMED" = "yes" ]; then printf '{malformed'; exit 0; fi
    if [ "$STATUS_COUNT" -gt 1 ] && [ "$DEPLOYMENT_SECOND_MALFORMED" = "yes" ]; then printf '{second-malformed'; exit 0; fi
    if [ "$STATUS_COUNT" -eq 1 ]; then printf '%s' "$DEPLOYMENT_FIRST"; else printf '%s' "$DEPLOYMENT_SECOND"; fi
    printf '\\n'
    exit 0
  fi
  if [ "$2" = "deploy" ]; then echo 'mock rollback completed'; exit 0; fi
  echo "unexpected versions command: $*" >&2; exit 86
fi
if [ "$1" = "deploy" ]; then
  if [ "$PUBLISH_ERROR" = "yes" ]; then echo 'publish response stdout'; echo 'publish response stderr' >&2; exit 1; fi
  echo 'worker-published'; exit 0
fi
echo "unexpected wrangler command: $*" >&2
exit 90
`;
  const bunStub = `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "run" ] && [ "$2" = "build:takos-worker" ]; then
  mkdir -p dist
  printf 'worker-fixture' > dist/takos-worker.js
fi
if [ "$1" = "run" ] && [ "$2" = "smoke:postdeploy" ] && [ "$SMOKE_ERROR" = "yes" ]; then echo 'postdeploy smoke response'; exit 1; fi
exit 0
`;
  const gitStub = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  'status --porcelain') exit 0 ;;
  'rev-parse --abbrev-ref HEAD') echo 'fixture-branch' ;;
  'rev-parse HEAD') echo '0123456789abcdef0123456789abcdef01234567' ;;
  *) echo "unexpected git command: $*" >&2; exit 91 ;;
esac
`;

  for (const [name, source] of [
    ["wrangler", wranglerStub],
    ["bun", bunStub],
    ["git", gitStub],
  ] as const) {
    const path = join(bin, name);
    await writeFile(path, source, "utf8");
    await chmod(path, 0o755);
  }

  const missingRows = [...columnRows.slice(1), ...indexRows];
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    CALL_LOG: callLog,
    YURUMEET_WRANGLER_CONFIG: options.configEnv ?? configPath,
    CONFIG_PATH: configPath,
    EXPECTED_ACCOUNT: accountId,
    STATUS_COUNTER: statusCounter,
    MUTATE_CONFIG_ON_VERSIONS: options.mutateConfigOnVersions ? "yes" : "no",
    MUTATE_EMPTY_ENV_AFTER_D1: options.mutateEmptyEnvAfterD1 ? "yes" : "no",
    CLOUDFLARE_ENV: options.environment ?? "",
    CLOUDFLARE_API_BASE_URL: options.apiBaseUrl ?? defaultApiBaseUrl,
    CF_API_BASE_URL: options.cfApiBaseUrl ?? defaultApiBaseUrl,
    WRANGLER_API_ENVIRONMENT: options.wranglerApiEnvironment ?? "production",
    CLOUDFLARE_COMPLIANCE_REGION: options.complianceEnvironment ?? "public",
    PREFLIGHT_MODE: options.queryMode ?? "valid",
    READY_SCHEMA_RESPONSE: responseFor([...columnRows, ...indexRows]),
    MISSING_SCHEMA_RESPONSE: responseFor(missingRows),
    DEPLOYMENT_FIRST: JSON.stringify(firstDeployment),
    DEPLOYMENT_SECOND: JSON.stringify(secondDeployment),
    DEPLOYMENT_ERROR: options.deploymentError ? "yes" : "no",
    DEPLOYMENT_MALFORMED: options.deploymentMalformed ? "yes" : "no",
    DEPLOYMENT_SECOND_ERROR: options.deploymentSecondError ? "yes" : "no",
    DEPLOYMENT_SECOND_MALFORMED: options.deploymentSecondMalformed
      ? "yes"
      : "no",
    PUBLISH_ERROR: options.publishError ? "yes" : "no",
    SMOKE_ERROR: options.smokeError ? "yes" : "no",
  };
  const processResult = Bun.spawnSync(
    [process.execPath, join(scripts, "deploy.mjs"), "yurumeet-worker"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const calls = await readFile(callLog, "utf8");
  return {
    root,
    bin,
    callLog,
    exitCode: processResult.exitCode,
    stdout: processResult.stdout.toString(),
    stderr: processResult.stderr.toString(),
    calls,
  };
}

describe("actual Worker deploy entrypoint schema barrier with isolated command mocks", () => {
  test("blocks malformed config, missing salt declaration, D1 failures, and selected environments before any gate or publish", async () => {
    const scenarios = [
      { label: "invalid JSON", configText: "{", queryMode: "valid" as const },
      {
        label: "missing salt declaration",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["ENCRYPTION_KEY", "AUTH_PASSWORD_HASH"] },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "missing secrets object",
        configText: JSON.stringify({
          name: "fixture",
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "secrets is not an object",
        configText: JSON.stringify({
          name: "fixture",
          secrets: ["YURUCOMMU_SESSION_HASH_SALT"],
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required is empty",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: [] },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required is not an array",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: "YURUCOMMU_SESSION_HASH_SALT" },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required contains a non-string entry",
        configText: JSON.stringify({
          name: "fixture",
          secrets: {
            required: ["YURUCOMMU_SESSION_HASH_SALT", null],
          },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required has an empty entry",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["YURUCOMMU_SESSION_HASH_SALT", "  "] },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required has duplicate salt declarations",
        configText: JSON.stringify({
          name: "fixture",
          secrets: {
            required: [
              "YURUCOMMU_SESSION_HASH_SALT",
              "YURUCOMMU_SESSION_HASH_SALT",
            ],
          },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "required has duplicate declarations",
        configText: JSON.stringify({
          name: "fixture",
          secrets: {
            required: [
              "YURUCOMMU_SESSION_HASH_SALT",
              "ENCRYPTION_KEY",
              "ENCRYPTION_KEY",
            ],
          },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "environment-only salt declaration",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["ENCRYPTION_KEY"] },
          env: {
            production: {
              secrets: { required: ["YURUCOMMU_SESSION_HASH_SALT"] },
            },
          },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      ...["", null].map((salt) => ({
        label: `plaintext salt var ${salt === null ? "null" : "empty"}`,
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["YURUCOMMU_SESSION_HASH_SALT"] },
          vars: { YURUCOMMU_SESSION_HASH_SALT: salt },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      })),
      {
        label: "plaintext salt var value",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["YURUCOMMU_SESSION_HASH_SALT"] },
          vars: { YURUCOMMU_SESSION_HASH_SALT: "do-not-echo" },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "environment plaintext salt var",
        configText: JSON.stringify({
          name: "fixture",
          secrets: { required: ["YURUCOMMU_SESSION_HASH_SALT"] },
          env: {
            production: {
              vars: { YURUCOMMU_SESSION_HASH_SALT: "must-not-echo" },
            },
          },
          d1_databases: JSON.parse(config).d1_databases,
        }),
      },
      {
        label: "missing table columns",
        configText: config,
        queryMode: "missing-schema" as const,
      },
      {
        label: "denied D1 query",
        configText: config,
        queryMode: "denied" as const,
      },
      {
        label: "invalid query JSON",
        configText: config,
        queryMode: "invalid-json" as const,
      },
      {
        label: "selected Wrangler environment",
        configText: config,
        queryMode: "valid" as const,
        environment: "production",
      },
      {
        label: "wrong Worker name",
        configText: JSON.stringify({
          ...JSON.parse(config),
          name: "another-worker",
        }),
      },
      {
        label: "missing pinned account ID",
        configText: JSON.stringify({
          ...JSON.parse(config),
          account_id: undefined,
        }),
      },
      {
        label: "malformed pinned account ID",
        configText: JSON.stringify({
          ...JSON.parse(config),
          account_id: "not-an-account-id",
        }),
      },
      {
        label: "Cloudflare API endpoint override",
        configText: config,
        apiBaseUrl: "https://override.invalid/client/v4",
      },
      {
        label: "Cloudflare API endpoint alias override",
        configText: config,
        cfApiBaseUrl: "https://override.invalid/client/v4",
      },
      {
        label: "empty Cloudflare API endpoint override",
        configText: config,
        apiBaseUrl: "",
      },
      {
        label: "Wrangler staging API environment",
        configText: config,
        wranglerApiEnvironment: "staging",
      },
      {
        label: "FedRAMP compliance environment",
        configText: config,
        complianceEnvironment: "fedramp_high",
      },
      {
        label: "FedRAMP config region",
        configText: JSON.stringify({
          ...JSON.parse(config),
          compliance_region: "fedramp_high",
        }),
      },
      {
        label: "missing explicit empty env-file",
        configText: config,
        emptyEnvFile: "missing" as const,
      },
      {
        label: "nonempty explicit env-file",
        configText: config,
        emptyEnvFile: "nonempty" as const,
      },
    ];
    for (const scenario of scenarios) {
      const result = await createIsolatedDeployFixture(scenario);
      expect(result.exitCode, scenario.label).not.toBe(0);
      expect(result.calls, scenario.label).not.toContain("wrangler deploy");
      expect(result.calls, scenario.label).not.toContain(
        "wrangler versions list",
      );
      expect(result.stderr, scenario.label).toContain(
        "publication was not attempted",
      );
      if (scenario.label === "malformed status JSON") {
        expect(result.stderr).toContain("{malformed");
      }
      if (
        scenario.label === "invalid JSON" ||
        scenario.label === "missing salt declaration" ||
        scenario.label === "missing secrets object" ||
        scenario.label === "secrets is not an object" ||
        scenario.label === "required is empty" ||
        scenario.label === "required is not an array" ||
        scenario.label === "required contains a non-string entry" ||
        scenario.label === "required has an empty entry" ||
        scenario.label === "required has duplicate declarations" ||
        scenario.label === "required has duplicate salt declarations" ||
        scenario.label === "environment-only salt declaration" ||
        scenario.label.startsWith("plaintext salt var") ||
        scenario.label === "environment plaintext salt var" ||
        scenario.label === "wrong Worker name" ||
        scenario.label === "missing pinned account ID" ||
        scenario.label === "malformed pinned account ID" ||
        scenario.label === "Cloudflare API endpoint override" ||
        scenario.label === "Cloudflare API endpoint alias override" ||
        scenario.label === "empty Cloudflare API endpoint override" ||
        scenario.label === "Wrangler staging API environment" ||
        scenario.label === "FedRAMP compliance environment" ||
        scenario.label === "FedRAMP config region" ||
        scenario.label === "missing explicit empty env-file" ||
        scenario.label === "nonempty explicit env-file"
      ) {
        expect(result.calls, scenario.label).toBe("");
      }
      if (scenario.label === "invalid JSON") {
        expect(result.calls).not.toContain("wrangler d1 execute");
      }
      if (scenario.label === "denied D1 query") {
        expect(result.stderr).toContain("raw D1 response");
        expect(result.stderr).toContain("D1 access denied");
      }
      if (scenario.label === "invalid query JSON") {
        expect(result.stderr).toContain("not-json");
      }
      if (scenario.label === "environment plaintext salt var") {
        expect(result.stderr).not.toContain("must-not-echo");
      }
      if (
        scenario.label === "Cloudflare API endpoint override" ||
        scenario.label === "Cloudflare API endpoint alias override" ||
        scenario.label === "empty Cloudflare API endpoint override"
      ) {
        expect(result.stderr).not.toContain("override.invalid");
      }
      if (scenario.label === "plaintext salt var value") {
        expect(result.stderr).not.toContain("do-not-echo");
      }
    }
  });

  test("accepts both password and OIDC-only realized auth configurations", async () => {
    const password = await createIsolatedDeployFixture({
      configText: config,
      queryMode: "valid",
    });
    const oidcConfig = JSON.stringify({
      name: "yurumeet",
      account_id: accountId,
      secrets: {
        required: ["ENCRYPTION_KEY", "YURUCOMMU_SESSION_HASH_SALT"],
      },
      vars: {
        TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.example.invalid",
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "yurumeet-public-client",
        OIDC_OWNER_SUB: "pairwise-owner-subject",
      },
      d1_databases: JSON.parse(config).d1_databases,
    });
    const oidc = await createIsolatedDeployFixture({
      configText: oidcConfig,
      queryMode: "valid",
    });

    for (const [label, result] of [
      ["password", password],
      ["OIDC-only", oidc],
    ] as const) {
      expect(result.exitCode, label).toBe(0);
      expect(result.calls, label).toContain("wrangler deploy");
      expect(result.stdout, label).toContain("worker-published");
    }
    expect(oidc.calls).not.toContain("AUTH_PASSWORD_HASH");
  });

  test("valid metadata uses the same config and empty env-file, captures the active Deployment, and preserves gate/build/publish/smoke order", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      configEnv: "realized-wrangler.jsonc",
      queryMode: "valid",
      poisonDefaultEnvFiles: true,
    });
    expect(result.exitCode).toBe(0);
    const events = result.calls.split("\n").filter(Boolean);
    const indexOf = (fragment: string) =>
      events.findIndex((event) => event.includes(fragment));
    expect(indexOf("git status --porcelain")).toBeLessThan(
      indexOf("wrangler versions deployments status"),
    );
    expect(indexOf("wrangler versions deployments status")).toBeLessThan(
      indexOf("bun run check"),
    );
    expect(indexOf("bun run check")).toBeLessThan(
      indexOf("bun run build:takos-worker"),
    );
    expect(indexOf("bun run build:takos-worker")).toBeLessThan(
      indexOf("wrangler d1 execute DB --remote --json --config"),
    );
    const statusEvents = events.filter((event) =>
      event.startsWith("wrangler versions deployments status"),
    );
    expect(statusEvents).toHaveLength(2);
    const d1Index = indexOf("wrangler d1 execute DB --remote --json --config");
    const secondStatusIndex = events.findIndex(
      (event, index) =>
        index > d1Index &&
        event.startsWith("wrangler versions deployments status"),
    );
    expect(indexOf("wrangler versions deployments status")).toBeLessThan(
      indexOf("bun run check"),
    );
    expect(indexOf("bun run build:takos-worker")).toBeLessThan(d1Index);
    expect(d1Index).toBeLessThan(secondStatusIndex);
    expect(secondStatusIndex).toBeLessThan(indexOf("wrangler deploy"));
    expect(indexOf("wrangler deploy")).toBeLessThan(
      indexOf("bun run smoke:postdeploy"),
    );
    const preflight = events.find((event) =>
      event.startsWith("wrangler d1 execute"),
    );
    const publish = events.find((event) => event.startsWith("wrangler deploy"));
    const sameConfigPath = join(result.root, "realized-wrangler.jsonc");
    const sameEnvPath = join(
      result.root,
      "scripts",
      "worker-publish-empty.env.example",
    );
    expect(preflight).toContain("--config");
    expect(preflight).toContain(sameConfigPath);
    expect(publish).toContain("--config");
    expect(publish).toContain(sameConfigPath);
    for (const event of [...statusEvents, publish]) {
      expect(event).toContain("--name yurumeet");
      expect(event).toContain("--config");
      expect(event).toContain(sameConfigPath);
      expect(event).toContain("--env-file");
      expect(event).toContain(sameEnvPath);
    }
    expect(preflight).toContain("--config");
    expect(preflight).toContain(sameConfigPath);
    expect(preflight).toContain("--env-file");
    expect(preflight).toContain(sameEnvPath);
    expect(events.some((event) => event.includes("versions list"))).toBe(false);
    expect(result.stdout).toContain(
      `active Deployment {"id":"${deploymentId}","versions":[{"version_id":"${firstVersionId}","percentage":100}]}`,
    );
    const deployResult = parseDeployResult(result.stdout);
    expect(deployResult.previousDeployment).toEqual({
      id: deploymentId,
      versions: [{ version_id: firstVersionId, percentage: 100 }],
    });
    expect(deployResult.accountId).toBe(accountId);
    expect(deployResult.rollbackArgs).toEqual([
      "versions",
      "deploy",
      `${firstVersionId}@100`,
      "--name",
      "yurumeet",
      "--config",
      sameConfigPath,
      "--env-file",
      sameEnvPath,
      "--yes",
    ]);
    expect(result.stdout).toContain(
      `wrangler 'versions' 'deploy' '${firstVersionId}@100'`,
    );
    expect(result.stdout).toContain(
      "media_blob_deletion_jobs migration-0030-only",
    );
  });

  test("preserves an active split Deployment map and tolerates API array reordering", async () => {
    const first = {
      id: deploymentId,
      strategy: "percentage",
      versions: [
        { version_id: secondVersionId, percentage: 75 },
        { version_id: firstVersionId, percentage: 25 },
      ],
    };
    const second = {
      ...first,
      versions: [...first.versions].reverse(),
    };
    const result = await createIsolatedDeployFixture({
      configText: config,
      deploymentFirst: first,
      deploymentSecond: second,
    });
    expect(result.exitCode).toBe(0);
    const deployResult = parseDeployResult(result.stdout);
    expect(deployResult.previousDeployment).toEqual({
      id: deploymentId,
      versions: [
        { version_id: firstVersionId, percentage: 25 },
        { version_id: secondVersionId, percentage: 75 },
      ],
    });
    expect(deployResult.rollbackArgs).toContain(`${firstVersionId}@25`);
    expect(deployResult.rollbackArgs).toContain(`${secondVersionId}@75`);
    expect(deployResult.rollbackCommand).toContain(
      `wrangler 'versions' 'deploy' '${firstVersionId}@25' '${secondVersionId}@75'`,
    );
  });

  test("fails closed before gate/build for missing, malformed, or invalid active Deployment state", async () => {
    const invalidDeployment = (versions: unknown[]) => ({
      id: deploymentId,
      strategy: "percentage",
      versions,
    });
    const cases = [
      { label: "no deployment", deploymentError: true },
      { label: "malformed status JSON", deploymentMalformed: true },
      {
        label: "missing deployment id",
        deploymentFirst: {
          strategy: "percentage",
          versions: [{ version_id: firstVersionId, percentage: 100 }],
        },
      },
      {
        label: "bad deployment id",
        deploymentFirst: {
          id: "not-a-uuid",
          strategy: "percentage",
          versions: [{ version_id: firstVersionId, percentage: 100 }],
        },
      },
      {
        label: "wrong strategy",
        deploymentFirst: {
          id: deploymentId,
          strategy: "rollback",
          versions: [{ version_id: firstVersionId, percentage: 100 }],
        },
      },
      { label: "empty traffic", deploymentFirst: invalidDeployment([]) },
      {
        label: "too many versions",
        deploymentFirst: invalidDeployment([
          { version_id: firstVersionId, percentage: 34 },
          { version_id: secondVersionId, percentage: 33 },
          { version_id: thirdVersionId, percentage: 33 },
        ]),
      },
      {
        label: "bad version id",
        deploymentFirst: invalidDeployment([
          { version_id: "bad", percentage: 100 },
        ]),
      },
      {
        label: "duplicate version id",
        deploymentFirst: invalidDeployment([
          { version_id: firstVersionId, percentage: 50 },
          { version_id: firstVersionId.toUpperCase(), percentage: 50 },
        ]),
      },
      {
        label: "zero percentage",
        deploymentFirst: invalidDeployment([
          { version_id: firstVersionId, percentage: 0 },
          { version_id: secondVersionId, percentage: 100 },
        ]),
      },
      {
        label: "percentage over one hundred",
        deploymentFirst: invalidDeployment([
          { version_id: firstVersionId, percentage: 101 },
        ]),
      },
      {
        label: "traffic total mismatch",
        deploymentFirst: invalidDeployment([
          { version_id: firstVersionId, percentage: 70 },
          { version_id: secondVersionId, percentage: 29 },
        ]),
      },
    ];
    for (const scenario of cases) {
      const result = await createIsolatedDeployFixture({
        configText: config,
        ...scenario,
      });
      expect(result.exitCode, scenario.label).not.toBe(0);
      expect(result.calls, scenario.label).toContain(
        "wrangler versions deployments status",
      );
      expect(result.calls, scenario.label).not.toContain("bun run check");
      expect(result.calls, scenario.label).not.toContain("wrangler d1 execute");
      expect(result.calls, scenario.label).not.toContain("wrangler deploy");
      expect(result.stderr, scenario.label).toContain(
        "publication was not attempted",
      );
    }
  });

  test("refuses a changed active Deployment id or map before publishing", async () => {
    for (const deploymentSecond of [
      {
        id: thirdVersionId,
        strategy: "percentage",
        versions: [{ version_id: firstVersionId, percentage: 100 }],
      },
      {
        id: deploymentId,
        strategy: "percentage",
        versions: [{ version_id: secondVersionId, percentage: 100 }],
      },
    ]) {
      const result = await createIsolatedDeployFixture({
        configText: config,
        deploymentSecond,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.calls).toContain("wrangler d1 execute");
      expect(
        result.calls.match(/wrangler versions deployments status/g),
      ).toHaveLength(2);
      expect(result.calls).not.toContain("wrangler deploy");
      expect(result.stderr).toContain("Deployment changed during preflight");
    }
  });

  test("keeps provider diagnostics and refuses an invalid or denied pre-publication Deployment re-read", async () => {
    for (const options of [
      { deploymentSecondMalformed: true },
      { deploymentSecondError: true },
      {
        deploymentSecond: {
          id: deploymentId,
          strategy: "percentage",
          versions: [{ version_id: firstVersionId, percentage: 99 }],
        },
      },
    ]) {
      const result = await createIsolatedDeployFixture({
        configText: config,
        ...options,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.calls).toContain("wrangler d1 execute");
      expect(
        result.calls.match(/wrangler versions deployments status/g),
      ).toHaveLength(2);
      expect(result.calls).not.toContain("wrangler deploy");
      expect(result.stderr).toContain("publication was not attempted");
      if (options.deploymentSecondMalformed) {
        expect(result.stderr).toContain("{second-malformed");
      }
      if (options.deploymentSecondError) {
        expect(result.stderr).toContain("deployment status denied");
      }
    }
  });

  test("rechecks the explicit empty env-file before every later Wrangler invocation", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      mutateEmptyEnvAfterD1: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.calls).toContain("wrangler d1 execute");
    expect(
      result.calls.match(/wrangler versions deployments status/g),
    ).toHaveLength(1);
    expect(result.calls).not.toContain("wrangler deploy");
    expect(result.stderr).toContain(
      "zero bytes before pre-publication active Deployment recheck",
    );
    expect(result.stderr).toContain("publication was not attempted");
  });

  test("prints a structured full-map recovery record after a publish command failure without retrying", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      deploymentFirst: {
        id: deploymentId,
        strategy: "percentage",
        versions: [
          { version_id: firstVersionId, percentage: 40 },
          { version_id: secondVersionId, percentage: 60 },
        ],
      },
      publishError: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("publish response stdout");
    expect(result.stderr).toContain("publish response stderr");
    const recovery = parseDeployResult(result.stderr);
    expect(recovery).toMatchObject({
      kind: "takos.deploy-result@v1",
      target: "cloudflare-worker:yurumeet",
      accountId,
      previousDeployment: {
        id: deploymentId,
        versions: [
          { version_id: firstVersionId, percentage: 40 },
          { version_id: secondVersionId, percentage: 60 },
        ],
      },
      postConditions: "NOT_RUN",
      status: "INDETERMINATE",
    });
    expect(recovery.rollbackArgs).toContain(`${firstVersionId}@40`);
    expect(recovery.rollbackArgs).toContain(`${secondVersionId}@60`);
    expect(recovery.rollbackArgs).toContain("--env-file");
    expect(recovery.rollbackCommand).toContain("--yes");
    expect(result.calls.match(/wrangler deploy/g)).toHaveLength(1);
  });

  test("reports post-smoke failure as indeterminate with full-map recovery and no automatic rollback", async () => {
    const activeSplit = {
      id: deploymentId,
      strategy: "percentage",
      versions: [
        { version_id: firstVersionId, percentage: 40 },
        { version_id: secondVersionId, percentage: 60 },
      ],
    };
    const result = await createIsolatedDeployFixture({
      configText: config,
      deploymentFirst: activeSplit,
      smokeError: true,
    });
    expect(result.exitCode).not.toBe(0);
    const deployResult = parseDeployResult(result.stdout);
    expect(deployResult).toMatchObject({
      previousDeployment: {
        id: deploymentId,
        versions: activeSplit.versions,
      },
      postConditions: "FAILED",
      status: "INDETERMINATE",
    });
    expect(deployResult.rollbackArgs).toContain(`${firstVersionId}@40`);
    expect(deployResult.rollbackArgs).toContain(`${secondVersionId}@60`);
    expect(result.stderr).toContain("serving Deployment has not been verified");
    expect(result.stderr).toContain("versions deployments status");
    expect(result.stderr).toContain("--env-file");
    expect(result.stderr).toContain(deployResult.rollbackCommand);
    expect(result.calls.match(/wrangler deploy /g)).toHaveLength(1);
    expect(
      result.calls
        .split("\n")
        .filter((event) => event.startsWith("wrangler versions deploy ")),
    ).toHaveLength(0);
  });

  test("shell-quoted full-map rollback args round-trip paths with spaces and apostrophes through only the local mock", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      pathWithShellChars: true,
      deploymentFirst: {
        id: deploymentId,
        strategy: "percentage",
        versions: [
          { version_id: firstVersionId, percentage: 40 },
          { version_id: secondVersionId, percentage: 60 },
        ],
      },
    });
    expect(result.exitCode).toBe(0);
    const deployResult = parseDeployResult(result.stdout);
    const configPath = join(result.root, "realized-wrangler.jsonc");
    const envFilePath = join(
      result.root,
      "scripts",
      "worker-publish-empty.env.example",
    );
    expect(configPath).toMatch(/ /u);
    expect(configPath).toContain("'");
    expect(deployResult.rollbackArgs).toContain(configPath);
    expect(deployResult.rollbackArgs).toContain(envFilePath);
    expect(deployResult.rollbackCommand).toContain("'\\''");

    const replay = Bun.spawnSync(["sh", "-c", deployResult.rollbackCommand], {
      cwd: result.root,
      env: {
        PATH: `${result.bin}:${process.env.PATH ?? ""}`,
        CALL_LOG: result.callLog,
        CONFIG_PATH: configPath,
        EXPECTED_ACCOUNT: accountId,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(replay.exitCode).toBe(0);
    const events = (await readFile(result.callLog, "utf8")).trim().split("\n");
    const rollback = events.at(-1);
    expect(rollback).toContain(`--config ${configPath}`);
    expect(rollback).toContain(`--env-file ${envFilePath}`);
    expect(rollback).toContain(`${firstVersionId}@40`);
    expect(rollback).toContain(`${secondVersionId}@60`);
  });

  test("does not publish if the realized config changes after schema verification", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      queryMode: "valid",
      mutateConfigOnVersions: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.calls).toContain("wrangler d1 execute");
    expect(result.calls).toContain("wrangler versions deployments status");
    expect(
      result.calls.match(/wrangler versions deployments status/g),
    ).toHaveLength(1);
    expect(result.calls).not.toContain("wrangler deploy");
    expect(result.stderr).toContain(
      "config changed before pre-publication active Deployment recheck",
    );
    expect(result.stderr).toContain("publication was not attempted");
  });
});
