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
const config = JSON.stringify({
  name: "yurumeet-preflight-test",
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
}) {
  const root = await mkdtemp(join(tmpdir(), "yurumeet-schema-preflight-"));
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
  ]) {
    await copyFile(new URL(`./${file}`, import.meta.url), join(scripts, file));
  }

  const configPath = join(root, "realized-wrangler.jsonc");
  await writeFile(configPath, options.configText ?? config, "utf8");
  const callLog = join(root, "calls.log");
  const wranglerStub = `#!/bin/sh
printf 'wrangler %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "d1" ] && [ "$2" = "execute" ]; then
  case "$PREFLIGHT_MODE" in
    denied) echo 'raw D1 response'; echo 'D1 access denied' >&2; exit 1 ;;
    invalid-json) printf 'not-json' ;;
    missing-schema) printf '%s' "$MISSING_SCHEMA_RESPONSE" ;;
    *) printf '%s' "$READY_SCHEMA_RESPONSE" ;;
  esac
  exit 0
fi
if [ "$1" = "versions" ]; then
  if [ "$MUTATE_CONFIG_ON_VERSIONS" = "yes" ]; then printf '{"name":"changed","d1_databases":[]}\\n' > "$CONFIG_PATH"; fi
  echo 'previous-version 00000000-0000-4000-8000-000000000002'; exit 0
fi
if [ "$1" = "deploy" ]; then echo 'worker-published'; exit 0; fi
echo "unexpected wrangler command: $*" >&2
exit 90
`;
  const bunStub = `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = "run" ] && [ "$2" = "build:takos-worker" ]; then
  mkdir -p dist
  printf 'worker-fixture' > dist/takos-worker.js
fi
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
    MUTATE_CONFIG_ON_VERSIONS: options.mutateConfigOnVersions ? "yes" : "no",
    CLOUDFLARE_ENV: options.environment ?? "",
    PREFLIGHT_MODE: options.queryMode ?? "valid",
    READY_SCHEMA_RESPONSE: responseFor([...columnRows, ...indexRows]),
    MISSING_SCHEMA_RESPONSE: responseFor(missingRows),
  };
  const processResult = Bun.spawnSync(
    [process.execPath, join(scripts, "deploy.mjs"), "yurumeet-worker"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  const calls = await readFile(callLog, "utf8");
  return {
    root,
    exitCode: processResult.exitCode,
    stdout: processResult.stdout.toString(),
    stderr: processResult.stderr.toString(),
    calls,
  };
}

describe("actual Worker deploy entrypoint schema barrier with isolated command mocks", () => {
  test("blocks malformed config, missing D1 schema, CLI denial, invalid JSON, and selected environments before deploy", async () => {
    const scenarios = [
      { label: "invalid JSON", configText: "{", queryMode: "valid" as const },
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
    ];
    for (const scenario of scenarios) {
      const result = await createIsolatedDeployFixture(scenario);
      expect(result.exitCode, scenario.label).not.toBe(0);
      expect(result.calls, scenario.label).not.toContain("wrangler deploy");
      expect(result.calls, scenario.label).not.toContain(
        "wrangler versions list",
      );
      expect(result.stderr, scenario.label).toContain(
        "Worker publication was not attempted",
      );
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
    }
  });

  test("valid metadata uses the same config path and preserves build, version, publish, and smoke order", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      configEnv: "realized-wrangler.jsonc",
      queryMode: "valid",
    });
    expect(result.exitCode).toBe(0);
    const events = result.calls.split("\n").filter(Boolean);
    const indexOf = (fragment: string) =>
      events.findIndex((event) => event.includes(fragment));
    expect(indexOf("bun run check")).toBeLessThan(
      indexOf("bun run build:takos-worker"),
    );
    expect(indexOf("bun run build:takos-worker")).toBeLessThan(
      indexOf("wrangler d1 execute DB --remote --json --config"),
    );
    expect(
      indexOf("wrangler d1 execute DB --remote --json --config"),
    ).toBeLessThan(indexOf("wrangler versions list"));
    expect(indexOf("wrangler versions list")).toBeLessThan(
      indexOf("wrangler deploy"),
    );
    expect(indexOf("wrangler deploy")).toBeLessThan(
      indexOf("bun run smoke:postdeploy"),
    );
    const preflight = events.find((event) =>
      event.startsWith("wrangler d1 execute"),
    );
    const publish = events.find((event) => event.startsWith("wrangler deploy"));
    const sameConfigPath = join(result.root, "realized-wrangler.jsonc");
    expect(preflight).toContain("--config");
    expect(preflight).toContain(sameConfigPath);
    expect(publish).toContain("--config");
    expect(publish).toContain(sameConfigPath);
    expect(result.stdout).toContain(
      "media_blob_deletion_jobs migration-0030-only",
    );
  });

  test("does not publish if the realized config changes after schema verification", async () => {
    const result = await createIsolatedDeployFixture({
      configText: config,
      queryMode: "valid",
      mutateConfigOnVersions: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.calls).toContain("wrangler d1 execute");
    expect(result.calls).toContain("wrangler versions list");
    expect(result.calls).not.toContain("wrangler deploy");
    expect(result.stderr).toContain("config changed before Worker publication");
    expect(result.stderr).toContain("publication was not attempted");
  });
});
