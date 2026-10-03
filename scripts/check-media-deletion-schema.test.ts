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

  test("accepts the documented read-only D1 REST metadata and rejects writes or unknown query fields", () => {
    const resultRows = [...columnRows, ...indexRows];
    const accepted = [
      {
        success: true,
        results: resultRows,
        meta: {
          rows_written: 0,
          changes: 0,
          served_by_region: "EEUR",
          timings: { sql_duration_ms: 1 },
        },
      },
      { success: true, results: resultRows },
    ];
    for (const queryResult of accepted) {
      const { run } = fixtureRun(JSON.stringify([queryResult]));
      expect(
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }).scope,
      ).toBe("migration-0030-only");
    }

    const rejected = [
      { success: true, results: resultRows, meta: { rows_written: 1 } },
      { success: true, results: resultRows, meta: { changes: 1 } },
      { success: true, results: resultRows, unexpected: "field" },
    ];
    for (const queryResult of rejected) {
      const { run } = fixtureRun(JSON.stringify([queryResult]));
      expect(() =>
        checkMediaDeletionSchema({
          configText: config,
          configPath: "operator-wrangler.jsonc",
          run,
        }),
      ).toThrow();
    }
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

const fixtureDbId = "00000000-0000-4000-8000-000000000021";
const otherDbId = "00000000-0000-4000-8000-000000000022";
const kvId = "00000000-0000-4000-8000-000000000023";
const predecessorId = "00000000-0000-4000-8000-000000000024";
const candidateId = "00000000-0000-4000-8000-000000000025";
const fixtureToken = "fixture-provider-token";
const fixtureSecretMarker = "fixture-private-auth-material";
const fixtureConfig = JSON.stringify({
  name: "yurumeet",
  account_id: accountId,
  compatibility_date: "2026-07-16",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  observability: { enabled: true },
  vars: { DELIVERY_QUEUE_NAME: "fixture-delivery" },
  secrets: {
    required: [
      "ENCRYPTION_KEY",
      "YURUCOMMU_SESSION_HASH_SALT",
      "AUTH_PASSWORD_HASH",
    ],
  },
  d1_databases: [
    { binding: "DB", database_name: "fixture-db", database_id: fixtureDbId },
  ],
  kv_namespaces: [{ binding: "KV", id: kvId }],
  r2_buckets: [{ binding: "MEDIA", bucket_name: "fixture-media" }],
  queues: {
    producers: [{ binding: "DELIVERY_QUEUE", queue: "fixture-delivery" }],
  },
});

function deployResultFrom(output: string) {
  const markerAt = output.lastIndexOf('"kind": "takos.deploy-result@v1"');
  if (markerAt < 0) throw new Error("deploy result JSON was not printed");
  const start = output.lastIndexOf("{", markerAt);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0)
      return JSON.parse(output.slice(start, index + 1));
  }
  throw new Error("deploy result JSON was not terminated");
}

async function createIsolatedDeployFixture(
  options: {
    configText?: string;
    configEnv?: string;
    environment?: string;
    apiBaseUrl?: string;
    cfApiBaseUrl?: string;
    wranglerApiEnvironment?: string;
    complianceEnvironment?: string;
    emptyEnvFile?: "missing" | "nonempty";
    pathWithShellChars?: boolean;
    authMode?: "valid" | "denied" | "malformed";
    deployment?: unknown;
    changedDeployment?: boolean;
    activeDbId?: string;
    malformedVersion?: boolean;
    queryMode?: "valid" | "denied" | "invalid-json" | "missing-schema";
    versionPostMode?: "valid" | "denied" | "lost-ack" | "bad-readback";
    deploymentPostMode?: "valid" | "denied" | "lost-ack";
    smokeError?: boolean;
    mutateConfigOnQuery?: boolean;
  } = {},
) {
  const root = await mkdtemp(
    join(
      tmpdir(),
      options.pathWithShellChars
        ? "yurumeet code-only's fixture "
        : "yurumeet-code-only-fixture-",
    ),
  );
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
    "yurumeet-code-only-provider.mjs",
    "worker-publish-empty.env.example",
  ])
    await copyFile(new URL("./" + file, import.meta.url), join(scripts, file));

  const envFilePath = join(scripts, "worker-publish-empty.env.example");
  if (options.emptyEnvFile === "missing") await rm(envFilePath);
  if (options.emptyEnvFile === "nonempty")
    await writeFile(envFilePath, "CLOUDFLARE_ENV=production\n", "utf8");
  const configPath = join(root, "realized-wrangler.jsonc");
  await writeFile(configPath, options.configText ?? fixtureConfig, "utf8");
  const commandLog = join(root, "commands.log");
  const apiLog = join(root, "api.log");
  const runnerPath = join(scripts, "isolated-entrypoint.mjs");
  await Promise.all([
    writeFile(commandLog, "", "utf8"),
    writeFile(apiLog, "", "utf8"),
  ]);

  const runner = String.raw`import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const log = (action, extra = {}) => appendFileSync(process.env.API_LOG, JSON.stringify({ action, ...extra }) + "\n");
const config = JSON.parse(readFileSync(process.env.CONFIG_PATH, "utf8"));
const accountPath = "/accounts/" + config.account_id + "/workers/scripts/yurumeet";
const activeDb = process.env.ACTIVE_DB_ID;
const predecessor = process.env.PREDECESSOR_ID;
const candidate = process.env.CANDIDATE_ID;
const required = config.secrets.required;
const bindings = [
  { name: "DB", type: "d1", database_id: activeDb },
  ...(config.kv_namespaces ?? []).map((entry) => ({ name: entry.binding, type: "kv_namespace", namespace_id: entry.id })),
  ...(config.r2_buckets ?? []).map((entry) => ({ name: entry.binding, type: "r2_bucket", bucket_name: entry.bucket_name })),
  ...(config.queues?.producers ?? []).map((entry) => ({ name: entry.binding, type: "queue", queue_name: entry.queue })),
  ...Object.entries(config.vars ?? {}).map(([name, text]) => ({ name, type: "plain_text", text })),
  ...required.map((name) => ({ name, type: "secret_text" })),
];
const runtime = { compatibility_date: config.compatibility_date + "T00:00:00.000Z", compatibility_flags: config.compatibility_flags };
const settings = { bindings, compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.compatibility_flags };
const scriptSetting = { observability: config.observability };
const versionFor = (id) => ({
  id,
  resources: {
    bindings,
    script: { etag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    script_runtime: runtime,
  },
});
let candidateVersion;
let candidateBytes;
let active = JSON.parse(process.env.DEPLOYMENT_JSON);
let deploymentReads = 0;
let candidateEtagOverride = false;
const response = (result, status = 200) => new Response(JSON.stringify({
  success: status >= 200 && status < 300,
  result,
  ...(status >= 400 ? { errors: [{ code: 9100 }] } : {}),
}), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const path = url.pathname.startsWith("/client/v4") ? url.pathname.slice("/client/v4".length) : url.pathname;
  if (url.origin !== "https://api.cloudflare.com") {
    log("unexpected-origin", { host: url.host, method });
    return response({}, 599);
  }
  if (init.headers?.Authorization !== "Bearer " + process.env.EXPECTED_TOKEN) {
    log("unexpected-auth", { method, path });
    return response({}, 598);
  }
  if (path === accountPath + "/deployments" && method === "GET") {
    deploymentReads += 1;
    log("GET deployments", { read: deploymentReads });
    if (process.env.CHANGED_DEPLOYMENT === "yes" && deploymentReads > 1) {
      return response({ deployments: [{ ...active, id: "00000000-0000-4000-8000-000000000099" }] });
    }
    return response({ deployments: [active] });
  }
  const versionPrefix = accountPath + "/versions/";
  if (path.startsWith(versionPrefix) && method === "GET") {
    const id = path.slice(versionPrefix.length);
    log("GET version", { id });
    if (process.env.MALFORMED_VERSION === "yes" && id === predecessor) return response({ id });
    if (id === candidate && candidateVersion) {
      if (candidateEtagOverride) candidateVersion.resources.script.etag = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      return response(candidateVersion);
    }
    if (id === candidate) return response({}, 404);
    return response(versionFor(id));
  }
  if (path === accountPath + "/settings" && method === "GET") { log("GET settings"); return response(settings); }
  if (path === accountPath + "/script-settings" && method === "GET") { log("GET script-settings"); return response(scriptSetting); }
  if (path === accountPath + "/content/v2" && method === "GET") {
    const versionId = url.searchParams.get("version");
    log("GET content", { versionId });
    if (versionId !== candidate || !candidateBytes) return response({}, 404);
    const deliveredBytes = process.env.VERSION_POST_MODE === "bad-readback"
      ? new Uint8Array([...candidateBytes, 0])
      : candidateBytes;
    const boundary = "fixture-content-boundary";
    const multipart = Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"worker.mjs\"; filename=\"worker.mjs\"\r\nContent-Type: application/javascript+module\r\n\r\n"),
      Buffer.from(deliveredBytes),
      Buffer.from("\r\n--" + boundary + "--\r\n"),
    ]);
    return new Response(multipart, {
      headers: {
        "content-type": "multipart/form-data; boundary=" + boundary,
        "cf-entrypoint": "worker.mjs",
      },
    });
  }
  const d1Prefix = "/accounts/" + config.account_id + "/d1/database/";
  if (path.startsWith(d1Prefix) && path.endsWith("/query") && method === "POST") {
    const databaseId = path.slice(d1Prefix.length, -"/query".length);
    const queryBody = JSON.parse(init.body);
    log("POST D1 query", { databaseId });
    if (queryBody.sql !== process.env.SCHEMA_QUERY || /\\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\\b/i.test(queryBody.sql)) {
      return response({ errors: [{ code: 9104 }] }, 400);
    }
    if (process.env.MUTATE_CONFIG_ON_QUERY === "yes") writeFileSync(process.env.CONFIG_PATH, '{"name":"changed"}\n');
    if (process.env.QUERY_MODE === "denied") return response({ errors: [{ code: 9100 }] }, 403);
    if (process.env.QUERY_MODE === "invalid-json") return new Response("not-json", { status: 200 });
    let rows = JSON.parse(process.env.SCHEMA_ROWS);
    if (process.env.QUERY_MODE === "missing-schema") rows = rows.slice(1);
    return response([{ success: true, meta: {}, results: rows }]);
  }
  if (path === accountPath + "/versions" && url.search === "?bindings_inherit=strict" && method === "POST") {
    const form = init.body;
    const metadataField = form instanceof FormData ? form.get("metadata") : null;
    const metadata = typeof metadataField === "string"
      ? JSON.parse(metadataField)
      : metadataField
        ? JSON.parse(await metadataField.text())
        : {};
    const inherited = Array.isArray(metadata.bindings) && metadata.bindings.every((binding) =>
      binding?.type === "inherit" && binding.version_id === predecessor);
    log("POST version", {
      inheritNames: Array.isArray(metadata.bindings) ? metadata.bindings.map((binding) => binding.name).sort() : [],
      allPinnedToPredecessor: inherited,
    });
    if (!inherited || metadata.main_module !== "worker.mjs") return response({ errors: [{ code: 9101 }] }, 400);
    if (process.env.VERSION_POST_MODE === "denied") return response({ errors: [{ code: 9102 }] }, 403);
    const bytes = new Uint8Array(await form.get("worker.mjs").arrayBuffer());
    candidateBytes = bytes;
    candidateVersion = versionFor(candidate);
    candidateVersion.resources.script.etag = "fixture-opaque-candidate-etag";
    candidateEtagOverride = process.env.VERSION_POST_MODE === "bad-readback";
    if (process.env.VERSION_POST_MODE === "lost-ack") throw new Error("fixture transport loss after Version write");
    return response({ id: candidate });
  }
  if (path === accountPath + "/deployments" && method === "POST") {
    const body = JSON.parse(init.body);
    log("POST deployment", { versionId: body.versions?.[0]?.version_id, percentage: body.versions?.[0]?.percentage });
    if (process.env.DEPLOYMENT_POST_MODE === "denied") return response({ errors: [{ code: 9103 }] }, 403);
    active = { id: "00000000-0000-4000-8000-000000000027", strategy: "percentage", versions: [{ version_id: candidate, percentage: 100 }] };
    if (process.env.DEPLOYMENT_POST_MODE === "lost-ack") throw new Error("fixture transport loss after Deployment write");
    return response(active);
  }
  log("unexpected-api-request", { method, path });
  return response({}, 599);
};
await import(process.env.DEPLOY_MODULE);
`;
  await writeFile(runnerPath, runner.replaceAll("\\`", "`"), "utf8");

  const wranglerStub = `#!/bin/sh
printf 'wrangler %s\\n' "$*" >> "$COMMAND_LOG"
if [ "$#" -eq 7 ] && [ "$1" = "auth" ] && [ "$2" = "token" ] && [ "$3" = "--json" ] && [ "$4" = "--config" ] && [ "$5" = "$CONFIG_PATH" ] && [ "$6" = "--env-file" ] && [ "$7" = "$ENV_FILE_PATH" ]; then
  if [ ! -f "$7" ] || [ "$(wc -c < "$7")" -ne 0 ]; then printf 'bad explicit env file\\n' >&2; exit 93; fi
  case "$AUTH_MODE" in
    denied) printf '%s\\n' "$EXPECTED_TOKEN $PRIVATE_MARKER"; printf '%s\\n' "$EXPECTED_TOKEN $PRIVATE_MARKER" >&2; exit 1 ;;
    malformed) printf '%s\\n' "$EXPECTED_TOKEN $PRIVATE_MARKER"; exit 0 ;;
    *) printf '{"type":"api_token","token":"%s"}\\n' "$EXPECTED_TOKEN" ;;
  esac
  exit 0
fi
printf 'unexpected Wrangler invocation\\n' >&2
exit 91
`;
  const bunStub = `#!/bin/sh
printf 'bun %s\\n' "$*" >> "$COMMAND_LOG"
if [ "$1" = "run" ] && [ "$2" = "build:takos-worker" ]; then mkdir -p dist; printf 'fixture-worker-bytes' > dist/takos-worker.js; fi
if [ "$1" = "run" ] && [ "$2" = "smoke:postdeploy" ] && [ "$SMOKE_ERROR" = "yes" ]; then printf 'postdeploy smoke failed\\n' >&2; exit 1; fi
exit 0
`;
  const gitStub = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  'status --porcelain') exit 0 ;;
  'rev-parse --abbrev-ref HEAD') echo 'fixture-branch' ;;
  'rev-parse HEAD') echo '0123456789abcdef0123456789abcdef01234567' ;;
  *) printf 'unexpected git command\\n' >&2; exit 92 ;;
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

  const deployment = options.deployment ?? {
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: predecessorId, percentage: 100 }],
  };
  const env = {
    PATH: bin + ":" + (process.env.PATH ?? ""),
    COMMAND_LOG: commandLog,
    API_LOG: apiLog,
    DEPLOY_MODULE: join(scripts, "deploy.mjs"),
    CONFIG_PATH: options.configEnv ?? configPath,
    ENV_FILE_PATH: envFilePath,
    YURUMEET_WRANGLER_CONFIG: options.configEnv ?? configPath,
    EXPECTED_TOKEN: fixtureToken,
    PRIVATE_MARKER: fixtureSecretMarker,
    ACTIVE_DB_ID: options.activeDbId ?? fixtureDbId,
    PREDECESSOR_ID: predecessorId,
    CANDIDATE_ID: candidateId,
    DEPLOYMENT_JSON: JSON.stringify(deployment),
    CHANGED_DEPLOYMENT: options.changedDeployment ? "yes" : "no",
    MALFORMED_VERSION: options.malformedVersion ? "yes" : "no",
    QUERY_MODE: options.queryMode ?? "valid",
    SCHEMA_ROWS: JSON.stringify([...columnRows, ...indexRows]),
    SCHEMA_QUERY: MEDIA_DELETION_SCHEMA_QUERY,
    VERSION_POST_MODE: options.versionPostMode ?? "valid",
    DEPLOYMENT_POST_MODE: options.deploymentPostMode ?? "valid",
    AUTH_MODE: options.authMode ?? "valid",
    SMOKE_ERROR: options.smokeError ? "yes" : "no",
    MUTATE_CONFIG_ON_QUERY: options.mutateConfigOnQuery ? "yes" : "no",
    CLOUDFLARE_ENV: options.environment ?? "",
    CLOUDFLARE_API_BASE_URL: options.apiBaseUrl ?? defaultApiBaseUrl,
    CF_API_BASE_URL: options.cfApiBaseUrl ?? defaultApiBaseUrl,
    WRANGLER_API_ENVIRONMENT: options.wranglerApiEnvironment ?? "production",
    CLOUDFLARE_COMPLIANCE_REGION: options.complianceEnvironment ?? "public",
  };
  const proc = Bun.spawnSync(
    [process.execPath, runnerPath, "yurumeet-worker"],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    root,
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    commands: await readFile(commandLog, "utf8"),
    api: await readFile(apiLog, "utf8"),
  };
}

function apiLines(
  result: Awaited<ReturnType<typeof createIsolatedDeployFixture>>,
) {
  return result.api
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function commandLines(
  result: Awaited<ReturnType<typeof createIsolatedDeployFixture>>,
) {
  return result.commands.split("\n").filter(Boolean);
}

describe("actual Worker deploy entrypoint with isolated Cloudflare API/auth fixtures", () => {
  test("rejects invalid config, target, endpoint, environment, or empty env-file before any command or API request", async () => {
    const wrongTarget = JSON.stringify({
      ...JSON.parse(fixtureConfig),
      name: "other-worker",
    });
    const wrongAccount = JSON.stringify({
      ...JSON.parse(fixtureConfig),
      account_id: undefined,
    });
    const parsedConfig = JSON.parse(fixtureConfig);
    const missingSalt = JSON.stringify({
      ...parsedConfig,
      secrets: { required: ["ENCRYPTION_KEY", "AUTH_PASSWORD_HASH"] },
    });
    const duplicateSalt = JSON.stringify({
      ...parsedConfig,
      secrets: {
        required: [
          "ENCRYPTION_KEY",
          "YURUCOMMU_SESSION_HASH_SALT",
          "YURUCOMMU_SESSION_HASH_SALT",
        ],
      },
    });
    const plaintextSalt = JSON.stringify({
      ...parsedConfig,
      vars: {
        ...parsedConfig.vars,
        YURUCOMMU_SESSION_HASH_SALT: "do-not-echo",
      },
    });
    const scenarios = [
      { label: "invalid JSON", configText: "{" },
      { label: "wrong Worker", configText: wrongTarget },
      { label: "missing account", configText: wrongAccount },
      { label: "missing session salt", configText: missingSalt },
      { label: "duplicate session salt", configText: duplicateSalt },
      { label: "plaintext session salt", configText: plaintextSalt },
      { label: "selected Wrangler environment", environment: "production" },
      {
        label: "endpoint override",
        apiBaseUrl: "https://override.invalid/client/v4",
      },
      {
        label: "endpoint alias override",
        cfApiBaseUrl: "https://override.invalid/client/v4",
      },
      { label: "Wrangler API environment", wranglerApiEnvironment: "staging" },
      {
        label: "non-public compliance environment",
        complianceEnvironment: "fedramp_high",
      },
      { label: "missing empty env file", emptyEnvFile: "missing" as const },
      { label: "nonempty empty env file", emptyEnvFile: "nonempty" as const },
    ];
    for (const scenario of scenarios) {
      const result = await createIsolatedDeployFixture(scenario);
      expect(result.exitCode, scenario.label).not.toBe(0);
      expect(result.commands, scenario.label).toBe("");
      expect(result.api, scenario.label).toBe("");
      expect(result.stdout + result.stderr, scenario.label).not.toContain(
        "override.invalid",
      );
      if (scenario.label === "plaintext session salt") {
        expect(result.stdout + result.stderr).not.toContain("do-not-echo");
      }
    }
  });

  test("suppresses malformed or denied auth-token output and makes no API request", async () => {
    for (const authMode of ["denied", "malformed"] as const) {
      const result = await createIsolatedDeployFixture({ authMode });
      expect(result.exitCode).not.toBe(0);
      expect(result.api).toBe("");
      expect(result.commands).toContain("wrangler auth token --json");
      expect(result.stdout + result.stderr).not.toContain(fixtureToken);
      expect(result.stdout + result.stderr).not.toContain(fixtureSecretMarker);
    }
  });

  test("pins every uploaded binding to the exact serving predecessor and promotes one verified Version", async () => {
    const result = await createIsolatedDeployFixture();
    expect(result.exitCode).toBe(0);
    const commands = commandLines(result);
    const api = apiLines(result);
    expect(commands).toContain("bun run check");
    expect(commands).toContain("bun run build:takos-worker");
    expect(commands).toContain("bun run smoke:postdeploy");
    expect(
      commands.filter((line) => line.startsWith("wrangler auth token --json")),
    ).toHaveLength(1);
    expect(api[0].action).toBe("GET deployments");
    expect(api.find((event) => event.action === "POST D1 query")).toEqual({
      action: "POST D1 query",
      databaseId: fixtureDbId,
    });
    const uploads = api.filter((event) => event.action === "POST version");
    const promotions = api.filter(
      (event) => event.action === "POST deployment",
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0].allPinnedToPredecessor).toBe(true);
    expect(uploads[0].inheritNames).toEqual([
      "AUTH_PASSWORD_HASH",
      "DB",
      "DELIVERY_QUEUE",
      "DELIVERY_QUEUE_NAME",
      "ENCRYPTION_KEY",
      "KV",
      "MEDIA",
      "YURUCOMMU_SESSION_HASH_SALT",
    ]);
    expect(promotions).toEqual([
      { action: "POST deployment", versionId: candidateId, percentage: 100 },
    ]);
    const contentReadbacks = api.filter(
      (event) => event.action === "GET content",
    );
    expect(contentReadbacks.map((event) => event.versionId)).toEqual([
      candidateId,
      candidateId,
      candidateId,
    ]);
    expect(api.some((event) => event.action.startsWith("unexpected-"))).toBe(
      false,
    );
    expect(result.commands).not.toContain(fixtureToken);
    expect(result.api).not.toContain(fixtureToken);
    expect(result.api).not.toContain(fixtureSecretMarker);
    expect(result.stdout + result.stderr).not.toContain(fixtureToken);
    expect(api.some((event) => event.action.startsWith("unexpected-"))).toBe(
      false,
    );
    expect(result.commands).not.toContain(fixtureToken);
  });

  test("accepts an OIDC-only declared secret profile without requiring a password binding", async () => {
    const oidcConfig = JSON.parse(fixtureConfig);
    oidcConfig.secrets.required = [
      "ENCRYPTION_KEY",
      "YURUCOMMU_SESSION_HASH_SALT",
      "OIDC_CLIENT_SECRET",
    ];
    oidcConfig.vars = {
      ...oidcConfig.vars,
      TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://accounts.fixture.invalid",
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "fixture-oidc-client",
      OIDC_OWNER_SUB: "fixture-pairwise-subject",
    };

    const result = await createIsolatedDeployFixture({
      configText: JSON.stringify(oidcConfig),
    });
    expect(result.exitCode).toBe(0);
    const api = apiLines(result);
    const uploads = api.filter((event) => event.action === "POST version");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].allPinnedToPredecessor).toBe(true);
    expect(uploads[0].inheritNames).toEqual([
      "DB",
      "DELIVERY_QUEUE",
      "DELIVERY_QUEUE_NAME",
      "ENCRYPTION_KEY",
      "KV",
      "MEDIA",
      "OIDC_CLIENT_SECRET",
      "OIDC_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "YURUCOMMU_SESSION_HASH_SALT",
    ]);
    expect(uploads[0].inheritNames).not.toContain("AUTH_PASSWORD_HASH");
    expect(api.find((event) => event.action === "POST D1 query")).toEqual({
      action: "POST D1 query",
      databaseId: fixtureDbId,
    });
    expect(api.filter((event) => event.action === "POST deployment")).toEqual([
      { action: "POST deployment", versionId: candidateId, percentage: 100 },
    ]);
  });

  test("refuses split traffic, active/config DB mismatch, or incomplete predecessor metadata before writes", async () => {
    const split = {
      id: deploymentId,
      strategy: "percentage",
      versions: [
        { version_id: predecessorId, percentage: 40 },
        { version_id: secondVersionId, percentage: 60 },
      ],
    };
    const mismatchConfig = JSON.stringify({
      ...JSON.parse(fixtureConfig),
      d1_databases: [
        {
          binding: "DB",
          database_name: "different-db",
          database_id: otherDbId,
        },
      ],
    });
    for (const [label, options] of [
      ["split traffic", { deployment: split }],
      ["realized DB differs from active DB", { configText: mismatchConfig }],
      ["malformed Version metadata", { malformedVersion: true }],
    ] as const) {
      const result = await createIsolatedDeployFixture(options);
      const api = apiLines(result);
      expect(result.exitCode, label).not.toBe(0);
      expect(
        api.some((event) => event.action === "POST D1 query"),
        label,
      ).toBe(false);
      expect(
        api.some((event) => event.action === "POST version"),
        label,
      ).toBe(false);
      expect(
        api.some((event) => event.action === "POST deployment"),
        label,
      ).toBe(false);
      expect(commandLines(result), label).not.toContain("bun run check");
      expect(commandLines(result), label).not.toContain(
        "bun run build:takos-worker",
      );
      expect(
        api.some((event) => event.action.startsWith("unexpected-")),
        label,
      ).toBe(false);
      if (label === "split traffic") {
        const record = deployResultFrom(result.stderr);
        expect(record.previousDeployment.versions).toEqual([
          { version_id: predecessorId, percentage: 40 },
          { version_id: secondVersionId, percentage: 60 },
        ]);
      }
    }
  });

  test("fails closed on active-state changes and 0030 query failures", async () => {
    for (const options of [
      { label: "deployment changed", changedDeployment: true },
      { label: "D1 denied", queryMode: "denied" as const },
      { label: "D1 invalid JSON", queryMode: "invalid-json" as const },
      {
        label: "D1 missing migration 0030",
        queryMode: "missing-schema" as const,
      },
      { label: "config changed after query", mutateConfigOnQuery: true },
    ]) {
      const result = await createIsolatedDeployFixture(options);
      const api = apiLines(result);
      expect(result.exitCode, options.label).not.toBe(0);
      expect(
        api.some((event) => event.action === "POST version"),
        options.label,
      ).toBe(false);
      expect(
        api.some((event) => event.action === "POST deployment"),
        options.label,
      ).toBe(false);
      if (options.label !== "deployment changed") {
        expect(
          api.some((event) => event.action === "POST D1 query"),
          options.label,
        ).toBe(true);
      }
    }
  });

  test("does not retry Version POST after denial, lost acknowledgement, or invalid readback", async () => {
    for (const versionPostMode of [
      "denied",
      "lost-ack",
      "bad-readback",
    ] as const) {
      const result = await createIsolatedDeployFixture({ versionPostMode });
      const api = apiLines(result);
      expect(result.exitCode).not.toBe(0);
      expect(
        api.filter((event) => event.action === "POST version"),
      ).toHaveLength(1);
      expect(
        api.filter((event) => event.action === "POST deployment"),
      ).toHaveLength(0);
      expect(result.stdout + result.stderr).not.toContain(fixtureToken);
      const record = deployResultFrom(result.stderr);
      expect(record.phase).toBe("POST_UPLOAD_INDETERMINATE");
      expect(record.previousDeployment.versions).toEqual([
        { version_id: predecessorId, percentage: 100 },
      ]);
      expect(record.rollbackRequest).toMatchObject({
        method: "POST",
        path: `/accounts/${accountId}/workers/scripts/yurumeet/deployments`,
        body: {
          strategy: "percentage",
          versions: [{ version_id: predecessorId, percentage: 100 }],
        },
      });
    }
  });

  test("does not retry Deployment POST after denial or lost acknowledgement", async () => {
    for (const deploymentPostMode of ["denied", "lost-ack"] as const) {
      const result = await createIsolatedDeployFixture({ deploymentPostMode });
      const api = apiLines(result);
      expect(result.exitCode).not.toBe(0);
      expect(
        api.filter((event) => event.action === "POST version"),
      ).toHaveLength(1);
      expect(
        api.filter((event) => event.action === "POST deployment"),
      ).toHaveLength(1);
      expect(result.stdout + result.stderr).not.toContain(fixtureToken);
      const record = deployResultFrom(result.stderr);
      expect(record.phase).toBe("POST_DEPLOY_INDETERMINATE");
      expect(record.status).toBe("INDETERMINATE");
      expect(record.previousDeployment.versions).toEqual([
        { version_id: predecessorId, percentage: 100 },
      ]);
      expect(record.rollbackRequest).toMatchObject({
        method: "POST",
        path: `/accounts/${accountId}/workers/scripts/yurumeet/deployments`,
        body: { versions: [{ version_id: predecessorId, percentage: 100 }] },
      });
    }
  });

  test("reports post-smoke failure without retry and retains recovery context under a quoted temp path", async () => {
    const result = await createIsolatedDeployFixture({
      pathWithShellChars: true,
      smokeError: true,
    });
    const api = apiLines(result);
    expect(result.exitCode).not.toBe(0);
    expect(result.root).toContain(" ");
    expect(result.root).toContain("'");
    expect(api.filter((event) => event.action === "POST version")).toHaveLength(
      1,
    );
    expect(
      api.filter((event) => event.action === "POST deployment"),
    ).toHaveLength(1);
    expect(
      commandLines(result).filter(
        (line) => line === "bun run smoke:postdeploy",
      ),
    ).toHaveLength(1);
    const record = deployResultFrom(result.stderr);
    expect(record.phase).toBe("POST_CONDITION_INDETERMINATE");
    expect(record.status).toBe("INDETERMINATE");
    expect(record.postConditions).toBe("FAILED");
    expect(record.operatorSerializationRequired).toBe(true);
    expect(record.previousDeployment.versions).toEqual([
      { version_id: predecessorId, percentage: 100 },
    ]);
    expect(record.rollbackRequest).toMatchObject({
      method: "POST",
      path: `/accounts/${accountId}/workers/scripts/yurumeet/deployments`,
      body: { versions: [{ version_id: predecessorId, percentage: 100 }] },
    });
    expect(record).not.toHaveProperty("rollbackCommand");
    expect(result.stdout + result.stderr).not.toContain(fixtureToken);
  });
});
