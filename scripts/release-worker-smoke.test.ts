import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { build, stop } from "esbuild";

import { createEntrySource } from "./build-takos-worker.ts";
import { PRODUCT_WIRE_IDENTITY } from "../src/product-identity.ts";
import {
  assertClosedStoreInventoriesEqual,
  cloneClosedStores,
  dataSnapshot,
  inventoryClosedStores,
} from "./release-storage-restore.mjs";

const repo = new URL("../", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const smokeChildDeadlineMs = 30_000;
const fixtureOrigin = "https://release-smoke.yurumeet.invalid";
const smokeHtml =
  '<!doctype html><html><head><title>Yurumeet</title></head><body><div id="root"></div></body></html>';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function entrySource() {
  return createEntrySource({
    "index.html": {
      contentType: "text/html; charset=utf-8",
      body: Buffer.from(smokeHtml).toString("base64"),
    },
  });
}

async function generatedArtifact(directory: string, source = entrySource()) {
  const artifactPath = join(directory, "yurumeet-worker.js");
  try {
    await build({
      stdin: {
        contents: source,
        resolveDir: join(repo, "scripts"),
        sourcefile: "takos-entry.generated.ts",
        loader: "ts",
      },
      outfile: artifactPath,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"],
    });
  } finally {
    stop();
  }
  return artifactPath;
}

async function smoke(artifactPath: string) {
  const bytes = await Bun.file(artifactPath).bytes();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const started = performance.now();
  const result = Bun.spawnSync(
    [
      "node",
      "scripts/smoke-release-worker.mjs",
      artifactPath,
      `sha256:${digest}`,
    ],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: smokeChildDeadlineMs,
    },
  );
  return requireSmokeProcessExit(
    result,
    Math.round(performance.now() - started),
  );
}

function requireSmokeProcessExit(
  result: Bun.ReadableSyncSubprocess,
  elapsedMs: number,
  deadlineMs = smokeChildDeadlineMs,
) {
  if (
    result.exitCode === null ||
    result.signalCode != null ||
    elapsedMs >= deadlineMs
  ) {
    throw new Error(
      `Native smoke child did not complete after ${elapsedMs}ms: exit=${result.exitCode}, signal=${result.signalCode ?? "none"}; ${result.stderr.toString()}`,
    );
  }
  return result;
}

async function closedFileFixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "yurumeet-closed-store-test-"),
  );
  temporaryDirectories.push(directory);
  const paths = {
    d1: join(directory, "d1"),
    kv: join(directory, "kv"),
    r2: join(directory, "r2"),
  };
  for (const [name, path] of Object.entries(paths)) {
    await mkdir(path);
    await writeFile(join(path, "state"), `native-${name}-data`);
  }
  return { paths, cloneRoot: join(directory, "clone") };
}

describe("closed snapshot inventory validation", () => {
  test("accepts a byte-identical closed copy without changing its source", async () => {
    const { paths, cloneRoot } = await closedFileFixture();
    const expected = inventoryClosedStores(paths);
    const clone = cloneClosedStores(paths, cloneRoot, expected);
    expect(() =>
      assertClosedStoreInventoriesEqual(expected, clone.inventory),
    ).not.toThrow();
    expect(inventoryClosedStores(paths)).toEqual(expected);
  });

  test("refuses a clone missing the KV snapshot file", async () => {
    const { paths, cloneRoot } = await closedFileFixture();
    const expected = inventoryClosedStores(paths);
    const clone = cloneClosedStores(paths, cloneRoot, expected);
    await rm(join(clone.paths.kv, "state"));
    expect(() =>
      assertClosedStoreInventoriesEqual(
        expected,
        inventoryClosedStores(clone.paths),
      ),
    ).toThrow();
  });

  test("refuses changed KV bytes with the same filename and size", async () => {
    const { paths, cloneRoot } = await closedFileFixture();
    const expected = inventoryClosedStores(paths);
    const clone = cloneClosedStores(paths, cloneRoot, expected);
    await writeFile(join(clone.paths.kv, "state"), "broken-kv-data");
    expect(() =>
      assertClosedStoreInventoriesEqual(
        expected,
        inventoryClosedStores(clone.paths),
      ),
    ).toThrow();
  });

  test("refuses a signaled child even when it printed a success marker", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'console.log("storage-restore-marker"); process.kill(process.pid, "SIGTERM");',
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.stdout.toString()).toContain("storage-restore-marker");
    expect(() => requireSmokeProcessExit(result, 0)).toThrow(
      "did not complete",
    );
  });

  test("refuses a timed-out child even when it printed a success marker", () => {
    const deadlineMs = 100;
    const started = performance.now();
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'console.log("storage-restore-marker"); setInterval(() => {}, 1000);',
      ],
      { stdout: "pipe", stderr: "pipe", timeout: deadlineMs },
    );
    const elapsedMs = Math.round(performance.now() - started);
    expect(result.stdout.toString()).toContain("storage-restore-marker");
    expect(() =>
      requireSmokeProcessExit(result, elapsedMs, deadlineMs),
    ).toThrow("did not complete");
  });
});

async function applicationDatabaseFixture() {
  const bundle = await Bun.file(
    join(repo, "deploy/takoform/migrations/schema-bundle.json"),
  ).json();
  const initial = bundle.entries.find(
    (entry: { name: string }) => entry.name === "0001_init.sql",
  );
  expect(initial).toBeDefined();
  const database = new Database(":memory:");
  database.exec(initial.sql);
  database.exec("PRAGMA foreign_keys = ON");
  const adapter = {
    prepare(sql: string) {
      return {
        async all() {
          return { results: database.query(sql).all() };
        },
      };
    },
  };
  return { database, adapter };
}

function sqliteAdapter(database: Database) {
  return {
    prepare(sql: string) {
      return {
        async all() {
          return { results: database.query(sql).all() };
        },
      };
    },
  };
}

describe("complete application D1 snapshot", () => {
  test("detects a real delivery_queue row missed by the former five-table oracle", async () => {
    const { database, adapter } = await applicationDatabaseFixture();
    try {
      const legacyTables = [
        "actors",
        "sessions",
        "objects",
        "media_uploads",
        "activities",
      ];
      const oldProjection = () =>
        legacyTables.map((table) =>
          database.query(`SELECT * FROM "${table}"`).all(),
        );
      const oldBefore = oldProjection();
      const before = await dataSnapshot(adapter);
      database.exec(
        "INSERT INTO delivery_queue (id, activity_ap_id, inbox_url) VALUES ('job-1', 'activity-1', 'https://remote.invalid/inbox')",
      );
      const after = await dataSnapshot(adapter);
      expect(oldProjection()).toEqual(oldBefore);
      expect(after.schemaSha256).toBe(before.schemaSha256);
      expect(after.relationshipsSha256).toBe(before.relationshipsSha256);
      expect(after.dataSha256).not.toBe(before.dataSha256);
      expect(before.counts.delivery_queue).toBe(0);
      expect(after.counts.delivery_queue).toBe(1);
      expect(after.tableCoverage.snapshottedTables).toContain("delivery_queue");
    } finally {
      database.close();
    }
  });

  test("includes sqlite_sequence even when its application table rows are unchanged", async () => {
    const { database, adapter } = await applicationDatabaseFixture();
    try {
      database.exec(
        "CREATE TABLE restore_sequence_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
      );
      database.exec(
        "INSERT INTO restore_sequence_probe (value) VALUES ('kept')",
      );
      const before = await dataSnapshot(adapter);
      database.exec(
        "UPDATE sqlite_sequence SET seq = seq + 1 WHERE name = 'restore_sequence_probe'",
      );
      const after = await dataSnapshot(adapter);
      expect(before.tableCoverage.sqliteSequencePresent).toBe(true);
      expect(before.counts.sqlite_sequence).toBe(1);
      expect(after.schemaSha256).toBe(before.schemaSha256);
      expect(after.counts).toEqual(before.counts);
      expect(after.dataSha256).not.toBe(before.dataSha256);
    } finally {
      database.close();
    }
  });

  test("ignores row order while preserving duplicate multiplicity", async () => {
    const { database, adapter } = await applicationDatabaseFixture();
    try {
      database.exec("CREATE TABLE restore_duplicate_probe (value TEXT)");
      database.exec(
        "INSERT INTO restore_duplicate_probe (value) VALUES ('a'), ('a'), ('b')",
      );
      const before = await dataSnapshot(adapter);
      database.exec("DELETE FROM restore_duplicate_probe");
      database.exec(
        "INSERT INTO restore_duplicate_probe (value) VALUES ('b'), ('a'), ('a')",
      );
      const reordered = await dataSnapshot(adapter);
      expect(reordered.dataSha256).toBe(before.dataSha256);
      database.exec("INSERT INTO restore_duplicate_probe (value) VALUES ('a')");
      const additional = await dataSnapshot(adapter);
      expect(additional.dataSha256).not.toBe(before.dataSha256);
      expect(additional.counts.restore_duplicate_probe).toBe(4);
    } finally {
      database.close();
    }
  });

  test("refuses lossy 64-bit integer readback while preserving distinct bigint values", async () => {
    const lossy = new Database(":memory:", { safeIntegers: false });
    const exact = new Database(":memory:", { safeIntegers: true });
    try {
      for (const database of [lossy, exact]) {
        database.exec("CREATE TABLE restore_integer_probe (value INTEGER)");
        database.exec(
          "INSERT INTO restore_integer_probe (value) VALUES (9007199254740992)",
        );
      }
      await expect(dataSnapshot(sqliteAdapter(lossy))).rejects.toThrow(
        "snapshot-unsafe-integer",
      );
      const before = await dataSnapshot(sqliteAdapter(exact));
      exact.exec("UPDATE restore_integer_probe SET value = 9007199254740993");
      const after = await dataSnapshot(sqliteAdapter(exact));
      expect(after.schemaSha256).toBe(before.schemaSha256);
      expect(after.dataSha256).not.toBe(before.dataSha256);
    } finally {
      lossy.close();
      exact.close();
    }
  });

  test("OIDC normalization hides only sessions and the fixture actor login timestamp", async () => {
    const { database, adapter } = await applicationDatabaseFixture();
    try {
      database.exec(`INSERT INTO actors (
        ap_id, preferred_username, inbox, outbox, followers_url,
        following_url, public_key_pem, private_key_pem, updated_at
      ) VALUES (
        'actor', 'actor', 'inbox', 'outbox', 'followers',
        'following', 'public', 'private', '2026-10-06 19:00:00.000'
      )`);
      database.exec(`INSERT INTO sessions
        (id, member_id, access_token, expires_at)
        VALUES ('first', 'actor', 'access-first', '2099-01-01')`);
      const before = await dataSnapshot(adapter, false, true);
      database.exec(
        "UPDATE actors SET updated_at = '2026-10-06 19:00:01.000' WHERE ap_id = 'actor'",
      );
      database.exec("DELETE FROM sessions");
      database.exec(`INSERT INTO sessions
        (id, member_id, access_token, expires_at)
        VALUES ('second', 'actor', 'access-second', '2099-01-01')`);
      const afterLogin = await dataSnapshot(adapter, false, true);
      expect(afterLogin.dataSha256).toBe(before.dataSha256);
      expect(afterLogin.actorUpdatedAt).not.toBe(before.actorUpdatedAt);
      expect(afterLogin.tableCoverage.excludedFromRowComparison).toEqual([
        "sessions",
      ]);
      expect(afterLogin.tableCoverage.normalizedColumns).toEqual([
        "actors.updated_at",
      ]);
      database.exec(
        "UPDATE actors SET name = 'unexpected' WHERE ap_id = 'actor'",
      );
      const unrelatedChange = await dataSnapshot(adapter, false, true);
      expect(unrelatedChange.dataSha256).not.toBe(before.dataSha256);
    } finally {
      database.close();
    }
  });

  test("refuses an orphaned foreign key and an unreadable unknown application table", async () => {
    const { database, adapter } = await applicationDatabaseFixture();
    try {
      database.exec("CREATE TABLE restore_fk_parent (id TEXT PRIMARY KEY)");
      database.exec(
        "CREATE TABLE restore_fk_child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES restore_fk_parent(id))",
      );
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec(
        "INSERT INTO restore_fk_child (id, parent_id) VALUES ('child', 'missing')",
      );
      await expect(dataSnapshot(adapter)).rejects.toThrow(
        "snapshot-foreign-key-violation",
      );
      database.exec("DELETE FROM restore_fk_child");
      database.exec("CREATE TABLE unknown_app_table (value TEXT)");
      const unreadable = {
        prepare(sql: string) {
          if (sql.includes('FROM "unknown_app_table"')) {
            throw new Error("unknown application table query denied");
          }
          return adapter.prepare(sql);
        },
      };
      await expect(dataSnapshot(unreadable)).rejects.toThrow(
        "unknown application table query denied",
      );
    } finally {
      database.close();
    }
  });
});

function httpHealthyArtifact() {
  return `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const native = typeof env.DB?.prepare === "function" && typeof env.KV?.get === "function" && typeof env.MEDIA?.put === "function";
    if (url.pathname === "/readyz") return Response.json({ status: native ? "ok" : "misconfigured", service: "yurucommu", missingBindings: native ? [] : ["DB", "KV", "MEDIA"] }, { status: native ? 200 : 503 });
    if (url.pathname === "/.well-known/yurucommu") return Response.json({ ...${JSON.stringify({ product: PRODUCT_WIRE_IDENTITY.product, name: PRODUCT_WIRE_IDENTITY.name, clients: PRODUCT_WIRE_IDENTITY.clients })}, server: { id: ${JSON.stringify(PRODUCT_WIRE_IDENTITY.serverId)}, name: ${JSON.stringify(PRODUCT_WIRE_IDENTITY.serverName)}, canonicalOrigin: env.APP_URL } });
    return new Response(${JSON.stringify(smokeHtml)}, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
`;
}

async function writeHttpHealthyArtifact(directory: string) {
  const artifactPath = join(directory, "yurumeet-worker.js");
  await writeFile(artifactPath, httpHealthyArtifact());
  return artifactPath;
}

async function expectSmokeToRejectFakeWrite(handler: string, expected: string) {
  const fetchAnchor = "    const bindings = wrapYurumeetWorkerBindings(env);";
  const source = entrySource();
  expect(source).toContain(fetchAnchor);
  const artifactSource = source.replace(
    fetchAnchor,
    `${handler}${fetchAnchor}`,
  );
  const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
  temporaryDirectories.push(directory);
  const artifactPath = await generatedArtifact(directory, artifactSource);
  const result = await smoke(artifactPath);
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain(expected);
}

describe("release Worker smoke", () => {
  test("boots the generated entry and verifies native queue and scheduled effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await generatedArtifact(directory);
    const result = await smoke(artifactPath);

    if (result.exitCode !== 0) {
      throw new Error(`Native smoke failed: ${result.stderr.toString()}`);
    }
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      kind: "yurumeet.release-worker-smoke@v1",
      artifact: "yurumeet-worker.js",
      runtime: "workerd",
      substrate: "runtime-native-bindings",
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "main-queue-fanout",
        "dlq-exhaustion",
        "scheduled-story-retention",
        "scheduled-story-retention-idempotence",
        "password-login",
        "session-rotation",
        "invalid-password-refusal",
        "authenticated-dm",
        "dm-isolation",
        "media-upload",
        "media-readback",
        "private-media-read-refusal",
        "invalid-media-refusal",
        "unauthenticated-api-refusal",
        "post-write-refusal",
        "public-post-persistence",
        "public-post-readback",
        "public-post-media-visibility",
        "followers-post-persistence",
        "followers-post-readback",
        "followers-post-media-visibility",
        "public-post-activitypub",
        "followers-post-activitypub-refusal",
        "logout-revocation",
        "required-session-salt-valid-control",
        "required-session-salt-missing-refusal",
        "required-session-salt-blank-refusal",
        "required-session-salt-public-fallback-refusal",
        "native-persistent-storage-restore",
        "native-persistent-oidc-storage-restore",
      ],
      migrationCount: expect.any(Number),
      authentication: { passwordMethods: ["pbkdf2-sha256", "bootstrap"] },
      sessionSaltGuard: {
        status: "PASSED",
        migrationCount: expect.any(Number),
        validControl: "password-login-persisted-one-owner-and-salted-session",
        invalidCases: ["missing", "blank", "public-fallback"],
        guardClass: "required-nondevelopment-session-salt",
        guardSource: "native-fetch-thrown-error-message",
        identityRowsAfterRefusal: { actors: 0, sessions: 0 },
        externalWorkerFetches: {
          policy: "denied-locally-by-miniflare-outbound-service",
          observedBlockedFetches: 0,
        },
        checks: [
          "required-session-salt-valid-control",
          "required-session-salt-missing-refusal",
          "required-session-salt-blank-refusal",
          "required-session-salt-public-fallback-refusal",
        ],
      },
      storageRestore: {
        kind: "yurumeet.native-storage-restore@v1",
        status: "PASSED",
        artifactSha256: `sha256:${createHash("sha256")
          .update(await Bun.file(artifactPath).bytes())
          .digest("hex")}`,
        migrationCount: 29,
        tableCoverage: {
          applicationTableCount: expect.any(Number),
          snapshottedTables: expect.arrayContaining([
            "actors",
            "sessions",
            "delivery_queue",
          ]),
          runtimeOwnedExcludedTables: ["_cf_METADATA"],
          normalizedColumns: [],
          foreignKeyViolationCount: 0,
        },
        checks: [
          "fixture-auth-post-media",
          "kv-origin-pin",
          "closed-store-inventories",
          "clone-byte-proof",
          "restored-ready",
          "restored-cookie",
          "restored-d1",
          "restored-post-media",
          "restored-kv",
          "original-closed-unchanged",
        ],
      },
      storageRestoreOidc: {
        kind: "yurumeet.native-storage-restore@v1",
        status: "PASSED",
        authentication: "oidc",
        artifactSha256: `sha256:${createHash("sha256")
          .update(await Bun.file(artifactPath).bytes())
          .digest("hex")}`,
        migrationCount: 29,
        tableCoverage: {
          applicationTableCount: expect.any(Number),
          snapshottedTables: expect.arrayContaining([
            "actors",
            "sessions",
            "delivery_queue",
          ]),
          runtimeOwnedExcludedTables: ["_cf_METADATA"],
          normalizedColumns: [],
          foreignKeyViolationCount: 0,
        },
        checks: [
          "fixture-auth-post-media",
          "kv-origin-pin",
          "closed-store-inventories",
          "clone-byte-proof",
          "restored-ready",
          "restored-cookie",
          "restored-d1",
          "restored-post-media",
          "restored-kv",
          "original-closed-unchanged",
          "fixture-oidc-encrypted-access-refresh-and-recovery-controls",
          "restored-exact-oidc-ciphertext-and-recovery-controls",
          "restored-same-subject-reauth-rotates-session-and-bounds-actor-login-time",
          "restored-oidc-logout-removes-row-and-refuses-replay",
          "restored-oidc-relogin-recovers-identity-and-data",
        ],
        oidc: {
          issuer: { jwks: 3, token: 3, userinfo: 3, blocked: 0, logins: 3 },
          runtimeDiagnostics: {
            policy: "discard-without-retaining-or-forwarding-raw-output",
            observedBytes: expect.any(Number),
          },
        },
      },
      status: "PASSED",
    });
  }, 35_000);

  for (const [name, injected, error] of [
    [
      "OIDC callback losing encrypted refresh credentials",
      `    if (request.method === "GET" && new URL(request.url).pathname === "/api/auth/callback/takos") {
      const response = await backendApp.fetch(request, wrapYurumeetWorkerBindings(env) as Env, ctx);
      await env.DB.prepare("UPDATE sessions SET provider_refresh_token = NULL WHERE provider = 'takos'").run();
      return response;
    }
`,
      "restore-oidc-initial-refresh-format",
    ],
    [
      "post attachment followers ActivityPub leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      if (row?.visibility === "followers") {
        const attachment = JSON.parse(row.attachments_json)[0];
        return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name }] }, { headers: { "content-type": "application/activity+json" } });
      }
    }
`,
      "followers-post-activitypub-refusal exposed",
    ],
    [
      "post attachment success without persistence",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const body = await request.clone().json();
      const origin = env.APP_URL;
      return Response.json({ post: { ap_id: origin + "/ap/objects/no-write", type: "Note", author: { ap_id: origin + "/ap/users/release-smoke-sender" }, content: body.content, visibility: body.visibility || "public", attachments: body.attachments } });
    }
`,
      "post-persistence did not persist",
    ],
    [
      "post attachment missing durable fanout",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie")) {
      const response = await backendApp.fetch(request, wrapYurumeetWorkerBindings(env) as Env, ctx);
      if (response.status === 200) {
        const body = await response.clone().json();
        await env.DB.prepare("DELETE FROM delivery_fanouts WHERE activity_ap_id IN (SELECT ap_id FROM activities WHERE object_ap_id = ?)").bind(body.post.ap_id).run();
      }
      return response;
    }
`,
      "post-fanout did not persist",
    ],
    [
      "post attachment readback losing attachments",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/posts/")) {
      const id = decodeURIComponent(new URL(request.url).pathname.slice("/api/posts/".length));
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(id).first();
      return Response.json({ post: { ap_id: row.ap_id, type: row.type, author: { ap_id: row.attributed_to }, content: row.content, visibility: row.visibility, attachments: [] } });
    }
`,
      "post-readback disagrees",
    ],
    [
      "post attachment public media bytes changed",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'public' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(new Uint8Array([0]), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "public-post-media-readback disagrees",
    ],
    [
      "post attachment followers media leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM objects WHERE type = 'Note' AND visibility = 'followers' AND instr(attachments_json, ?) > 0").bind(new URL(request.url).pathname).first()).count > 0) {
      return new Response(Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000" } });
    }
`,
      "followers-post-media-refusal exposed",
    ],
    [
      "post attachment ActivityPub internal storage key leaked",
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/ap/objects/")) {
      const row = await env.DB.prepare("SELECT * FROM objects WHERE ap_id = ?").bind(env.APP_URL + new URL(request.url).pathname).first();
      const attachment = JSON.parse(row.attachments_json)[0];
      return Response.json({ id: row.ap_id, type: "Note", attributedTo: row.attributed_to, content: row.content, attachment: [{ type: "Document", mediaType: attachment.content_type, url: env.APP_URL + attachment.url, name: attachment.name, r2_key: attachment.r2_key }] }, { headers: { "content-type": "application/activity+json" } });
    }
`,
      "post-activitypub disagrees",
    ],
    [
      "post attachment accepted anonymous write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && !request.headers.get("cookie")) {
      return Response.json({ success: true });
    }
`,
      "post-write-refusal accepted",
    ],
    [
      "post attachment accepted revoked write",
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/posts" && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ success: true });
    }
`,
      "logout-revocation accepted a post write",
    ],
  ] as const) {
    test(`rejects ${name}`, async () => {
      await expectSmokeToRejectFakeWrite(injected, error);
    }, 30_000);
  }

  test("rejects private media denial with image bytes", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && !request.headers.get("cookie")) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "private-media-refusal included non-error content",
    );
  }, 30_000);

  test("rejects revoked private media denial with image bytes", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/media/") && request.headers.get("cookie") && (await env.DB.prepare("SELECT COUNT(*) AS count FROM sessions").first()).count === 2) {
      return Response.json({ error: "Authentication required", bytes: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==" }, { status: 403, headers: { "cache-control": "no-store" } });
    }\n`,
      "logout-revocation included non-error content",
    );
  }, 30_000);

  test("rejects a fake successful DM response without persistence", async () => {
    await expectSmokeToRejectFakeWrite(
      `    const journeyUrl = new URL(request.url);
    if (request.method === "POST" && journeyUrl.pathname.startsWith("/api/dm/user/")) {
      return Response.json({
        message: { id: "${fixtureOrigin}/ap/objects/fake-dm", content: "release smoke direct message", created_at: new Date().toISOString() },
        conversation_id: "${fixtureOrigin}/ap/conversations/fake-dm",
      }, { status: 201 });
    }
`,
      "DM object was not persisted",
    );
  }, 30_000);

  test("rejects login success without a session row", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    );
  }, 30_000);

  test("rejects bootstrap login success without a session row", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && !env.AUTH_PASSWORD_HASH.includes(":") && (await request.clone().json()).password === "release-smoke-only") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=fake-native-login-session; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000" } });
    }\n`,
      "password-login did not persist",
    );
  }, 30_000);

  test("rejects an accepted invalid password", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/login" && (await request.clone().json()).password === "release-smoke-only-incorrect") {
      return Response.json({ success: true });
    }\n`,
      "invalid-password-refusal",
    );
  }, 30_000);

  test("rejects logout success without session revocation", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "POST" && new URL(request.url).pathname === "/api/auth/logout") {
      return Response.json({ success: true }, { headers: { "set-cookie": "session=; Path=/; Max-Age=0" } });
    }\n`,
      "logout-revocation left",
    );
  }, 30_000);

  test("rejects a fake successful media response without persistence", async () => {
    await expectSmokeToRejectFakeWrite(
      `    const journeyUrl = new URL(request.url);
    if (request.method === "POST" && journeyUrl.pathname === "/api/media/upload") {
      return Response.json({ url: "/media/abcdef.png", r2_key: "uploads/abcdef.png", content_type: "image/png", id: "abcdef" });
    }
`,
      "media upload was not persisted",
    );
  }, 60_000);

  test("rejects a DM read by an unrelated session", async () => {
    await expectSmokeToRejectFakeWrite(
      `    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/api/dm/user/") && request.headers.get("cookie") === "session=release-smoke-session-unrelated-ecf49f83") {
      const headers = new Headers(request.headers);
      headers.set("cookie", "session=release-smoke-session-recipient-a108328f");
      request = new Request(request, { headers });
    }\n`,
      "DM isolation exposed a message to an unrelated actor",
    );
  }, 30_000);

  test("rejects an HTTP-healthy artifact without background handlers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await writeHttpHealthyArtifact(directory);

    const result = await smoke(artifactPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("main-queue-fanout");
  }, 30_000);

  test("rejects no-op main queue, DLQ, and scheduled handlers", async () => {
    const noOpMutations = [
      {
        label: "main queue",
        find: "    const lane = resolveYurumeetRuntimeLane(env);",
        replacement:
          '    if (batch.queue === "yurumeet-delivery") { for (const message of batch.messages) message.ack(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
        expected: "main-queue-fanout",
      },
      {
        label: "DLQ",
        find: "    const lane = resolveYurumeetRuntimeLane(env);",
        replacement:
          '    if (batch.queue === "yurumeet-delivery-dlq") { for (const message of batch.messages) message.ack(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
        expected: "dlq-exhaustion",
      },
      {
        label: "scheduled",
        find: "    await runRetention(runtimeEnv);",
        replacement: "    void runtimeEnv;",
        expected: "expired Story/media state",
      },
    ];

    for (const mutation of noOpMutations) {
      const source = entrySource();
      expect(source, `${mutation.label} mutation anchor`).toContain(
        mutation.find,
      );
      const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
      temporaryDirectories.push(directory);
      const artifactPath = await generatedArtifact(
        directory,
        source.replace(mutation.find, mutation.replacement),
      );
      const result = await smoke(artifactPath);
      expect(result.exitCode, mutation.label).not.toBe(0);
      expect(result.stdout.toString(), mutation.label).toBe("");
      expect(result.stderr.toString(), mutation.label).toContain(
        mutation.expected,
      );
    }
  }, 60_000);

  test("rejects a queue handler that retries the main message", async () => {
    const source = entrySource();
    const anchor = "    const lane = resolveYurumeetRuntimeLane(env);";
    expect(source).toContain(anchor);
    const retrying = source.replace(
      anchor,
      '    if (batch.queue === "yurumeet-delivery") { batch.messages[0]?.retry(); return; }\n    const lane = resolveYurumeetRuntimeLane(env);',
    );
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = await generatedArtifact(directory, retrying);
    const result = await smoke(artifactPath);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("main-queue-fanout");
  }, 30_000);

  test("rejects bytes that do not match the release digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yurumeet-smoke-test-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "yurumeet-worker.js");
    await writeFile(
      artifactPath,
      'export default { fetch() { return new Response("changed"); } };\n',
    );

    const result = Bun.spawnSync(
      [
        "node",
        "scripts/smoke-release-worker.mjs",
        artifactPath,
        `sha256:${"0".repeat(64)}`,
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("does not equal sha256:");
  });
});
