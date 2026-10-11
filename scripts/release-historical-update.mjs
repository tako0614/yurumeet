import { createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { build, stop } from "esbuild";
import { FormData, Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";

import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";
import { createSyntheticRestoreIssuer } from "./release-storage-oidc.mjs";
import {
  assertClosedStoreInventoriesEqual,
  cloneClosedStores,
  dataSnapshot,
  inventoryClosedStores,
} from "./release-storage-restore.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINS = JSON.parse(
  readFileSync(
    new URL("./historical-v012-fixture.json", import.meta.url),
    "utf8",
  ),
);
const ORIGIN = "https://historical-update.yurumeet.invalid";
const WORKER_NAME = "yurumeet-historical-update";
const DB_ID = "00000000-0000-0000-0000-000000000000";
const PASSWORD = "yurumeet-historical-update-synthetic-password";
const PASSWORD_SALT = Buffer.alloc(32, 0x72);
const PASSWORD_HASH = `${PASSWORD_SALT.toString("hex")}:${pbkdf2Sync(PASSWORD, PASSWORD_SALT, 100000, 32, "sha256").toString("hex")}`;
const NEW_SESSION_SALT = "yurumeet-historical-update-candidate-synthetic-salt";
const OIDC_SESSION_SALT = "yurumeet-historical-oidc-stable-synthetic-salt";
const OIDC_SUBJECT = "historical_owner";
const OIDC_FOREIGN_SUBJECT = "historical_foreign";
const ENCRYPTION_KEY = "00".repeat(32);
const CONTENT = "Yurumeet published v0.1.2 historical update fixture";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);
const KV_KEY = "historical-update/synthetic-kv-v1";
const KV_VALUE = "historical-update-synthetic-value";

export class HistoricalUpdateFailure extends Error {}

function need(condition, label) {
  if (!condition)
    throw new HistoricalUpdateFailure(`historical update ${label}`);
}

function digest(bytes, algorithm = "sha256") {
  return createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
}

function exactFile(path, expectedSha256, expectedBytes, label) {
  need(
    typeof path === "string" && existsSync(path) && statSync(path).isFile(),
    `${label}-missing`,
  );
  const bytes = readFileSync(path);
  need(
    digest(bytes) === expectedSha256 &&
      (expectedBytes === undefined || bytes.length === expectedBytes),
    `${label}-digest`,
  );
  return bytes;
}

export function verifyPinnedFixtureFile(path, expectedSha256, expectedBytes) {
  return exactFile(path, expectedSha256, expectedBytes, "pinned-fixture-file");
}

export function validateHistoricalLedgerRows(rows, pins = PINS) {
  need(
    Array.isArray(rows) && rows.length === pins.migrations.length,
    "physical-old-ledger-count",
  );
  for (const [index, row] of rows.entries()) {
    need(
      row?.id === index + 1 &&
        row.name === pins.migrations[index].name &&
        typeof row.applied_at === "string" &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.applied_at),
      "physical-old-ledger-order-and-metadata",
    );
  }
  return rows.map((row) => row.name);
}

export function validatePushDefinitions(rows, pins = PINS) {
  need(Array.isArray(rows), "old-push-schema-missing");
  const actual = rows.map((row) => ({
    type: row.type,
    name: row.name,
    tblName: row.tbl_name,
    sha256: digest(Buffer.from(row.sql ?? "", "utf8")),
  }));
  need(
    JSON.stringify(actual) ===
      JSON.stringify(pins.wranglerNativeBaseline.pushSchemaDefinitions),
    "old-0019-third-or-custom-shape",
  );
}

export function verifyHistoricalInputs({
  candidateWorkerPath,
  candidateSha256,
  oldWorkerPath,
  oldSqlDir,
  oldCoreTarballPath,
  oldReleaseManifestPath,
}) {
  need(
    /^sha256:[0-9a-f]{64}$/.test(candidateSha256 ?? ""),
    "candidate-digest-required",
  );
  exactFile(
    candidateWorkerPath,
    candidateSha256.slice(7),
    undefined,
    "candidate-worker",
  );
  exactFile(
    oldWorkerPath,
    PINS.provenance.workerSha256,
    PINS.provenance.workerBytes,
    "published-old-worker",
  );
  const manifest = JSON.parse(
    exactFile(
      oldReleaseManifestPath,
      PINS.provenance.releaseManifestSha256,
      undefined,
      "published-old-manifest",
    ).toString("utf8"),
  );
  need(
    manifest.kind === "takosumi.worker-artifact@v1" &&
      manifest.app === "yurumeet" &&
      manifest.commit === PINS.provenance.commit &&
      manifest.ref === PINS.provenance.tag &&
      manifest.artifact?.sha256 === PINS.provenance.workerSha256,
    "published-old-manifest-identity",
  );
  const tarball = exactFile(
    oldCoreTarballPath,
    PINS.provenance.coreTarballSha256,
    undefined,
    "published-old-core-tarball",
  );
  need(
    `sha512-${digest(tarball, "sha512")}` ===
      PINS.provenance.coreTarballIntegrity,
    "published-old-core-integrity",
  );
  need(
    typeof oldSqlDir === "string" &&
      existsSync(oldSqlDir) &&
      statSync(oldSqlDir).isDirectory(),
    "old-sql-dir",
  );
  const names = readdirSync(oldSqlDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  need(
    JSON.stringify(names) ===
      JSON.stringify(PINS.migrations.map((entry) => entry.name)),
    "old-sql-file-set",
  );
  for (const entry of PINS.migrations) {
    exactFile(
      join(oldSqlDir, entry.name),
      entry.sha256,
      entry.bytes,
      `old-sql-${entry.name}`,
    );
  }
  const core = JSON.parse(
    readFileSync(
      resolve(REPO, "node_modules/@takosjp/yurucommu-core/package.json"),
      "utf8",
    ),
  );
  need(
    core.name === "@takosjp/yurucommu-core" &&
      core.version === PINS.candidateCore.version,
    "published-candidate-core-version",
  );
  const wrangler = JSON.parse(
    readFileSync(resolve(REPO, "node_modules/wrangler/package.json"), "utf8"),
  );
  need(
    wrangler.version === PINS.wranglerNativeBaseline.version,
    "native-wrangler-version",
  );
  const migrationsDir = resolve(
    REPO,
    "node_modules/@takosjp/yurucommu-core/migrations",
  );
  const currentNames = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  need(
    JSON.stringify(currentNames) ===
      JSON.stringify(PINS.candidateCore.migrations.map((entry) => entry.name)),
    "candidate-core-migration-set",
  );
  for (const entry of PINS.candidateCore.migrations) {
    exactFile(
      join(migrationsDir, entry.name),
      entry.sha256,
      entry.bytes,
      `candidate-${entry.name}`,
    );
  }
  need(
    PINS.candidateCore.migrations.length ===
      PINS.candidateCore.migrationCount &&
      PINS.candidateCore.migrations.find(
        (entry) => entry.name === "0019_notification_push_delivery.sql",
      )?.sha256 === PINS.candidateCore["0019Sha256"] &&
      PINS.candidateCore.migrations.find(
        (entry) => entry.name === "0036_notification_push_actor_fk_repair.sql",
      )?.sha256 === PINS.candidateCore["0036Sha256"],
    "candidate-core-critical-migration-pins",
  );
  exactFile(
    resolve(
      REPO,
      "node_modules/@takosjp/yurucommu-core/scripts/apply-takosumi-migrations.ts",
    ),
    PINS.candidateCore.runnerSha256,
    undefined,
    "published-core-runner",
  );
  return {
    migrationsDir,
    candidateSha256,
    oldWorkerSha256: `sha256:${PINS.provenance.workerSha256}`,
  };
}

async function rows(db, sql, ...bindings) {
  const result = await db
    .prepare(sql)
    .bind(...bindings)
    .all();
  need(
    result?.success === true && Array.isArray(result.results),
    "native-read-result",
  );
  return result.results;
}

async function historicalLedger(db) {
  const tables = await rows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('d1_migrations', 'yurucommu_migrations') ORDER BY name",
  );
  need(
    JSON.stringify(tables.map((row) => row.name)) ===
      JSON.stringify(["d1_migrations"]),
    "native-old-ledger-table-set",
  );
  const metadata = await rows(db, "PRAGMA table_xinfo('d1_migrations')");
  need(
    JSON.stringify(metadata.map((row) => [row.name, row.type, row.pk])) ===
      JSON.stringify([
        ["id", "INTEGER", 1],
        ["name", "TEXT", 0],
        ["applied_at", "TIMESTAMP", 0],
      ]),
    "native-old-ledger-table-shape",
  );
  return validateHistoricalLedgerRows(
    await rows(
      db,
      "SELECT id, name, applied_at FROM d1_migrations ORDER BY id",
    ),
  );
}

async function oldPushShape(db) {
  const schema = await rows(
    db,
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (instr(lower(name), 'notification_push') > 0 OR instr(lower(sql), 'notification_push') > 0) ORDER BY type, name",
  );
  validatePushDefinitions(schema);
  for (const table of ["notification_pushers", "notification_push_jobs"]) {
    const columns = await rows(db, `PRAGMA table_xinfo('${table}')`);
    need(
      columns.length === (table === "notification_pushers" ? 17 : 13) &&
        columns.every((column) => column.hidden === 0),
      `${table}-old-columns`,
    );
    const fks = await rows(db, `PRAGMA foreign_key_list('${table}')`);
    need(
      fks.length === 1 &&
        Object.entries(PINS.wranglerNativeBaseline.pushForeignKey).every(
          ([key, value]) => fks[0][key] === value,
        ),
      `${table}-old-cascade-fk`,
    );
    const indexes = await rows(db, `PRAGMA index_list('${table}')`);
    const expected = PINS.wranglerNativeBaseline.pushSchemaDefinitions
      .filter((entry) => entry.type === "index" && entry.tblName === table)
      .map((entry) => entry.name);
    need(
      expected.every((name) => indexes.some((index) => index.name === name)),
      `${table}-old-indexes`,
    );
  }
  need(
    (await rows(db, "PRAGMA foreign_key_check")).length === 0,
    "old-fk-check",
  );
}

function pathsFor(root) {
  const paths = {
    d1: join(root, "wrangler", "v3", "d1"),
    kv: join(root, "kv"),
    r2: join(root, "r2"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

function makeRuntime(path, paths, ids, config, outbound, sessionSalt, auth) {
  const silence = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const managed = createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        workers: [
          {
            name: WORKER_NAME,
            routes: [ORIGIN + "/*"],
            rootPath: dirname(path),
            modules: [{ type: "ESModule", path }],
            modulesRoot: dirname(path),
            compatibilityDate: config.compatibility_date,
            compatibilityFlags: config.compatibility_flags,
            bindings: {
              APP_URL: ORIGIN,
              ...(auth ? auth.bindings : { AUTH_PASSWORD_HASH: PASSWORD_HASH }),
              ENCRYPTION_KEY,
              ...(sessionSalt === undefined
                ? {}
                : { YURUCOMMU_SESSION_HASH_SALT: sessionSalt }),
              DELIVERY_QUEUE_NAME: "historical-update-delivery",
              DELIVERY_DLQ_NAME: "historical-update-dlq",
            },
            d1Databases: { DB: { id: ids.d1 } },
            kvNamespaces: { KV: { id: ids.kv } },
            r2Buckets: { MEDIA: { id: ids.r2 } },
            queueProducers: {
              DELIVERY_QUEUE: { queueName: "historical-update-delivery" },
              DELIVERY_DLQ: { queueName: "historical-update-dlq" },
            },
            outboundService: async (request) => {
              if (auth) {
                const url = new URL(request.url);
                const permitted =
                  url.origin === auth.bindings.OIDC_ISSUER_URL &&
                  ((request.method === "POST" &&
                    url.pathname === "/oauth/token") ||
                    (request.method === "GET" &&
                      (url.pathname === "/oauth/jwks" ||
                        url.pathname === "/oauth/userinfo")));
                if (permitted) return auth.fetch(request);
              }
              outbound.blocked++;
              return new Response(null, { status: 502 });
            },
          },
        ],
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        cf: false,
        d1Persist: paths.d1,
        kvPersist: paths.kv,
        r2Persist: paths.r2,
        handleRuntimeStdio,
      }),
    { destination: silence },
  );
  return {
    worker: managed.worker,
    dispose: () => managed.dispose().finally(() => silence.destroy()),
  };
}

async function handles(runtime) {
  return {
    fetcher: await runtime.worker.getWorker(WORKER_NAME),
    db: await runtime.worker.getD1Database("DB", WORKER_NAME),
    kv: await runtime.worker.getKVNamespace("KV", WORKER_NAME),
    r2: await runtime.worker.getR2Bucket("MEDIA", WORKER_NAME),
  };
}

async function request(fetcher, path, init = {}) {
  const url = new URL(path, ORIGIN);
  need(url.origin === ORIGIN, "request-local-origin-only");
  return fetcher.fetch(url.href, {
    ...init,
    headers: new Headers(init.headers),
  });
}

async function json(response, expectedStatus, label) {
  need(response.status === expectedStatus, `${label}-http-${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  need(bytes.length <= 1024 * 1024, `${label}-response-bound`);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HistoricalUpdateFailure(`historical update ${label}-json`);
  }
}

function cookie(response) {
  const values = response.headers
    .getSetCookie()
    .filter((value) => value.startsWith("session="));
  need(values.length === 1, "password-session-cookie-count");
  const raw = decodeURIComponent(values[0].split(";", 1)[0].slice(8));
  need(raw.length > 0 && raw.length <= 256, "password-session-cookie-shape");
  return raw;
}

function oidcCookie(response) {
  const values = response.headers
    .getSetCookie()
    .filter(
      (value) =>
        value.startsWith("session=") &&
        value.split(";", 1)[0].length > "session=".length,
    );
  need(values.length === 1, "oidc-session-cookie-count");
  const raw = decodeURIComponent(values[0].split(";", 1)[0].slice(8));
  need(raw.length > 0 && raw.length <= 256, "oidc-session-cookie-shape");
  return raw;
}

async function login(fetcher) {
  const response = await request(fetcher, "/api/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  need(
    (await json(response, 200, "password-login")).success === true,
    "password-login-body",
  );
  return cookie(response);
}

async function actor(fetcher, value) {
  const me = await json(
    await request(fetcher, "/api/auth/me", {
      headers: { cookie: `session=${value}` },
    }),
    200,
    "actor-me",
  );
  need(
    me.actor?.role === "owner" && typeof me.actor.ap_id === "string",
    "fixture-actor",
  );
  return me.actor.ap_id;
}

function oidcSessionKey(rawCookie) {
  need(
    typeof rawCookie === "string" && rawCookie.length > 0,
    "oidc-cookie-shape",
  );
  return `sha256:${digest(Buffer.from(`${OIDC_SESSION_SALT}:${rawCookie}`))}`;
}

async function oidcSessionRow(db, rawCookie, expectedActorApId) {
  const found = await rows(
    db,
    "SELECT * FROM sessions WHERE id = ?",
    oidcSessionKey(rawCookie),
  );
  need(
    found.length === 1 &&
      found[0].id === found[0].access_token &&
      found[0].member_id === expectedActorApId &&
      found[0].provider === "takos" &&
      Date.parse(found[0].expires_at) > Date.now() &&
      Date.parse(found[0].provider_token_expires_at) >
        Date.parse(found[0].created_at),
    "oidc-session-row",
  );
  return found[0];
}

async function oidcActor(fetcher, rawCookie, expectedActorApId) {
  const me = await json(
    await request(fetcher, "/api/auth/me", {
      headers: { cookie: `session=${rawCookie}` },
    }),
    200,
    "oidc-me",
  );
  need(
    me.actor?.role === "owner" &&
      typeof me.actor.ap_id === "string" &&
      (expectedActorApId === undefined ||
        me.actor.ap_id === expectedActorApId) &&
      me.provider === "takos" &&
      me.has_takos_access === true,
    "oidc-owner-provider",
  );
  return me.actor.ap_id;
}

async function oidcAuthRows(db) {
  return {
    actors: await rows(
      db,
      "SELECT ap_id, takos_user_id, role FROM actors ORDER BY ap_id",
    ),
    sessions: await rows(db, "SELECT * FROM sessions ORDER BY id"),
  };
}

async function rejectOidcCallback(h, issuer, options, error, label) {
  const before = await oidcAuthRows(h.db);
  const counts = issuer.evidence();
  const attempt = await issuer.attempt(h.fetcher, request, options);
  need(
    attempt.callback.status === 302 &&
      attempt.callback.headers.get("location") === `/?error=${error}` &&
      !attempt.callback.headers
        .getSetCookie()
        .some((value) => value.startsWith("session=")),
    `${label}-callback-refused`,
  );
  await attempt.callback.body?.cancel();
  const after = issuer.evidence();
  need(
    after.token === counts.token + 1 &&
      after.userinfo === counts.userinfo + 1 &&
      after.jwks === counts.jwks + 1 &&
      JSON.stringify(await oidcAuthRows(h.db)) === JSON.stringify(before),
    `${label}-verified-token-and-no-auth-write`,
  );
  return attempt;
}

async function content(handles, fixture, session) {
  const post = await json(
    await request(
      handles.fetcher,
      `/api/posts/${encodeURIComponent(fixture.postApId)}`,
      { headers: { cookie: `session=${session}` } },
    ),
    200,
    "post-readback",
  );
  need(
    post.post?.ap_id === fixture.postApId &&
      post.post?.content === CONTENT &&
      post.post?.type === "Note",
    "post-preserved",
  );
  const object = await handles.r2.get(fixture.r2Key);
  need(
    object && Buffer.from(await object.arrayBuffer()).equals(PNG),
    "r2-png-preserved",
  );
  const http = await request(handles.fetcher, fixture.mediaUrl, {
    headers: { cookie: `session=${session}` },
  });
  need(
    http.status === 200 && Buffer.from(await http.arrayBuffer()).equals(PNG),
    "http-png-preserved",
  );
  need((await handles.kv.get(KV_KEY)) === KV_VALUE, "kv-sentinel-preserved");
}

async function bindingSnapshot(h) {
  const listedKv = await h.kv.list({ limit: 1000 });
  need(
    listedKv.list_complete === true && Array.isArray(listedKv.keys),
    "complete-kv-key-list",
  );
  const kv = [];
  for (const entry of listedKv.keys) {
    const bytes = await h.kv.get(entry.name, "arrayBuffer");
    need(bytes instanceof ArrayBuffer, "kv-key-bytes");
    kv.push({
      key: entry.name,
      bytes: bytes.byteLength,
      sha256: digest(Buffer.from(bytes)),
    });
  }
  kv.sort((a, b) => a.key.localeCompare(b.key));
  const listedR2 = await h.r2.list({ limit: 1000 });
  need(
    listedR2.truncated === false && Array.isArray(listedR2.objects),
    "complete-r2-key-list",
  );
  const r2 = [];
  for (const entry of listedR2.objects) {
    const object = await h.r2.get(entry.key);
    need(object !== null, "r2-key-bytes");
    const bytes = Buffer.from(await object.arrayBuffer());
    r2.push({ key: entry.key, bytes: bytes.length, sha256: digest(bytes) });
  }
  r2.sort((a, b) => a.key.localeCompare(b.key));
  return { kv, r2 };
}

async function createOldFixture(h, issuer) {
  const ready = await json(
    await request(h.fetcher, "/readyz"),
    200,
    "old-readyz",
  );
  need(ready.status === "ok", "old-readyz-body");
  let oldCookie;
  let actorApId;
  let oidcTokens;
  if (issuer) {
    const methods = await json(
      await request(h.fetcher, "/api/auth/providers"),
      200,
      "old-oidc-providers",
    );
    need(
      methods.password_enabled === false &&
        methods.providers?.some((provider) => provider.id === "takos"),
      "old-oidc-only-methods",
    );
    oidcTokens = await issuer.login(h.fetcher, request, oidcCookie);
    oldCookie = oidcTokens.cookie;
    actorApId = await oidcActor(h.fetcher, oldCookie);
    const linked = await rows(
      h.db,
      "SELECT ap_id, takos_user_id, role FROM actors",
    );
    need(
      linked.length === 1 &&
        linked[0].ap_id === actorApId &&
        linked[0].takos_user_id === `takos:${OIDC_SUBJECT}` &&
        linked[0].role === "owner",
      "old-oidc-linked-owner",
    );
    await issuer.assertEncrypted(
      await oidcSessionRow(h.db, oldCookie, actorApId),
      oidcTokens,
      ENCRYPTION_KEY,
      "historical-old-oidc",
    );
  } else {
    oldCookie = await login(h.fetcher);
    actorApId = await actor(h.fetcher, oldCookie);
  }
  const form = new FormData();
  form.set("file", new File([PNG], "historical.png", { type: "image/png" }));
  const upload = await json(
    await request(h.fetcher, "/api/media/upload", {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `session=${oldCookie}` },
      body: form,
    }),
    200,
    "old-media-upload",
  );
  need(
    typeof upload.id === "string" &&
      typeof upload.r2_key === "string" &&
      typeof upload.url === "string",
    "old-media-result",
  );
  const attachment = {
    url: upload.url,
    r2_key: upload.r2_key,
    content_type: "image/png",
    name: "historical fixture image",
  };
  const posted = await json(
    await request(h.fetcher, "/api/posts", {
      method: "POST",
      headers: {
        origin: ORIGIN,
        cookie: `session=${oldCookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: CONTENT, attachments: [attachment] }),
    }),
    200,
    "old-post",
  );
  const postApId = posted.post?.ap_id;
  need(
    typeof postApId === "string" && posted.post?.type === "Note",
    "old-post-result",
  );
  await h.kv.put(KV_KEY, KV_VALUE);
  const fixture = {
    actorApId,
    postApId,
    mediaUrl: upload.url,
    r2Key: upload.r2_key,
    oldCookie,
    ...(oidcTokens ? { oidcTokens } : {}),
  };
  await content(h, fixture, oldCookie);
  await seedOldPushState(h.db, actorApId, postApId);
  return { ...fixture, binding: await bindingSnapshot(h) };
}

async function seedOldPushState(db, actorApId, activityApId) {
  // Published old Worker creates identity/content via HTTP. These native rows
  // exercise the old 0019 schema's supported push states without delivery.
  for (const [id, hash] of [
    ["pusher-a", "hash-a"],
    ["pusher-b", "hash-b"],
  ]) {
    await db
      .prepare(
        `INSERT INTO notification_pushers
      (id, actor_ap_id, product, app_id, pushkey, pushkey_hash, gateway_url, data_json)
      VALUES (?, ?, 'yurumeet', 'fixture-app', ?, ?, 'https://gateway.invalid/push', '{}')`,
      )
      .bind(id, actorApId, id, hash)
      .run();
  }
  for (const [id, status, attempts, pending, error] of [
    ["job-pending", "pending", 0, '["pusher-a","pusher-b"]', null],
    ["job-retry", "retry_wait", 3, '["pusher-b"]', "synthetic retry"],
    ["job-queued", "queued", 1, '["pusher-a"]', null],
  ]) {
    await db
      .prepare(
        `INSERT INTO notification_push_jobs
      (id, actor_ap_id, activity_ap_id, product, status, attempts, pending_pusher_ids_json, next_attempt_at, last_error)
      VALUES (?, ?, ?, 'yurumeet', ?, ?, ?, '2099-01-01T00:00:00.000Z', ?)`,
      )
      .bind(
        id,
        actorApId,
        `${activityApId}#${id}`,
        status,
        attempts,
        pending,
        error,
      )
      .run();
  }
  need(
    (await rows(db, "SELECT id FROM notification_pushers")).length === 2 &&
      (await rows(db, "SELECT id FROM notification_push_jobs")).length === 3,
    "push-seed-rows",
  );
}

function quoted(name) {
  return `"${name.replaceAll('"', '""')}"`;
}
/** Preserve SQL value type while comparing every column of the old schema. */
export function canonicalProjectionSqlValue(value) {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "number") {
    need(Number.isFinite(value), "row-nonfinite-number");
    // D1 already exposes SQLite INTEGER as a JS number. A larger integer
    // may have lost precision before it reaches this comparison.
    need(
      !Number.isInteger(value) || Number.isSafeInteger(value),
      "row-unsafe-integer",
    );
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "boolean") return ["boolean", value];
  if (value instanceof ArrayBuffer)
    return ["blob", Buffer.from(value).toString("base64")];
  if (ArrayBuffer.isView(value))
    return [
      "blob",
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        "base64",
      ),
    ];
  if (
    Array.isArray(value) &&
    Object.keys(value).length === value.length &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  need(false, "row-value-supported");
}

async function preservedRows(db, columnsByTable) {
  const result = {};
  for (const [table, columns] of Object.entries(columnsByTable)) {
    const selected = await rows(
      db,
      `SELECT ${columns.map(quoted).join(", ")} FROM ${quoted(table)}`,
    );
    result[table] = selected
      .map((row) =>
        JSON.stringify(
          columns.map((column) => [
            column,
            canonicalProjectionSqlValue(row[column]),
          ]),
        ),
      )
      .sort();
  }
  return result;
}

async function originalRowProjection(db) {
  const tables = (
    await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY name",
    )
  ).map((row) => row.name);
  const columns = {};
  for (const table of tables) {
    columns[table] = (await rows(db, `PRAGMA table_xinfo(${quoted(table)})`))
      .filter((row) => row.hidden === 0)
      .map((row) => row.name);
    need(columns[table].length > 0, "old-table-column-coverage");
  }
  return { columns, rows: await preservedRows(db, columns) };
}

async function pushRows(db) {
  const result = {};
  for (const table of ["notification_pushers", "notification_push_jobs"]) {
    result[table] = await rows(db, `SELECT * FROM ${table} ORDER BY id`);
  }
  return result;
}

async function nativeBatch(db, sql, label) {
  const statements = unstable_splitSqlQuery(sql);
  need(
    statements.length > 0 &&
      !statements.some((statement) =>
        /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(statement),
      ),
    `${label}-split-or-explicit-transaction`,
  );
  // D1.batch is the native transactional boundary. Keep every trigger body and
  // the runner's ledger mark in the same batch; never use exec() or prefixes.
  const result = await db.batch(
    statements.map((statement) => db.prepare(statement)),
  );
  need(
    Array.isArray(result) &&
      result.length === statements.length &&
      result.every(
        (entry) => entry?.success === true && Array.isArray(entry.results),
      ),
    `${label}-native-batch-result`,
  );
  return result;
}

async function canonicalLedger(db) {
  return (
    await rows(db, "SELECT name FROM yurucommu_migrations ORDER BY id")
  ).map((row) => row.name);
}

async function migrationExecutor(
  db,
  sql,
  context,
  { failFirstMigration = false } = {},
) {
  if (context.purpose === "ledger-init") {
    const oldNames = await historicalLedger(db);
    const physicalRows = await rows(
      db,
      "SELECT id, name, applied_at FROM d1_migrations ORDER BY id",
    );
    validateHistoricalLedgerRows(physicalRows);
    await oldPushShape(db);
    const expectedInit =
      /^\s*CREATE TABLE IF NOT EXISTS yurucommu_migrations\s*\(/u;
    need(expectedInit.test(sql), "published-runner-ledger-init-sql");
    const inserts = physicalRows.map((row) =>
      db
        .prepare(
          "INSERT INTO yurucommu_migrations (name, applied_at) VALUES (?, ?)",
        )
        .bind(row.name, row.applied_at),
    );
    const split = unstable_splitSqlQuery(sql);
    need(split.length === 1, "runner-ledger-init-one-statement");
    const batch = await db.batch([db.prepare(split[0]), ...inserts]);
    need(
      batch.length === 1 + inserts.length &&
        batch.every((entry) => entry?.success === true),
      "historical-ledger-import-atomic",
    );
    need(
      JSON.stringify(await canonicalLedger(db)) === JSON.stringify(oldNames),
      "historical-ledger-import-readback",
    );
    const imported = await rows(
      db,
      "SELECT name, applied_at FROM yurucommu_migrations ORDER BY id",
    );
    need(
      JSON.stringify(imported) ===
        JSON.stringify(
          physicalRows.map((row) => ({
            name: row.name,
            applied_at: row.applied_at,
          })),
        ),
      "historical-ledger-metadata-readback",
    );
    return batch;
  }
  if (context.purpose === "ledger-read") {
    need(
      /^\s*SELECT name FROM yurucommu_migrations\s*$/u.test(sql),
      "published-runner-ledger-read-sql",
    );
    return {
      rows: await rows(db, "SELECT name FROM yurucommu_migrations ORDER BY id"),
    };
  }
  need(
    context.purpose === "migration" && typeof context.migration === "string",
    "runner-migration-context",
  );
  const script =
    failFirstMigration && context.migration === "0020_call_sessions.sql"
      ? `${sql}\nSELECT * FROM historical_update_forced_failure_absent;`
      : sql;
  return nativeBatch(db, script, `migration-${context.migration}`);
}

async function migrate(db, migrationsDir, runner, failFirstMigration = false) {
  const oldLog = console.log;
  const oldWarn = console.warn;
  try {
    // Runner logs names. The CLI prints one bounded JSON result and no SQL or
    // synthetic credential values, including on a native exception.
    console.log = () => {};
    console.warn = () => {};
    return await runner({
      resource: DB_ID,
      migrationsDir,
      wrapTransactions: false,
      batchPendingMigrations: false,
      retryAttempts: 1,
      executeSql: (sql, context) =>
        migrationExecutor(db, sql, context, { failFirstMigration }),
    });
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
  }
}

function writeMigrationOnlyModule(root) {
  const path = join(root, "historical-migration-only.mjs");
  writeFileSync(
    path,
    "export default { fetch() { return new Response(null, { status: 404 }); } };\n",
  );
  return path;
}

async function loadPublicRunner(root) {
  const source = resolve(
    REPO,
    "node_modules/@takosjp/yurucommu-core/scripts/apply-takosumi-migrations.ts",
  );
  exactFile(
    source,
    PINS.candidateCore.runnerSha256,
    undefined,
    "public-runner-before-compile",
  );
  const output = join(root, "published-core-runner.mjs");
  try {
    await build({
      entryPoints: [source],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      define: { "import.meta.main": "false" },
    });
  } finally {
    stop();
  }
  const module = await import(pathToFileURL(output).href);
  need(
    typeof module.applyMigrations === "function" &&
      module.MIGRATION_LEDGER_TABLE === "yurucommu_migrations",
    "published-core-runner-api",
  );
  return module.applyMigrations;
}

async function withRuntime(
  path,
  paths,
  ids,
  config,
  outbound,
  action,
  sessionSalt,
  auth,
) {
  const runtime = makeRuntime(
    path,
    paths,
    ids,
    config,
    outbound,
    sessionSalt,
    auth,
  );
  let failed = false;
  try {
    await runtime.worker.ready;
    return await action(await handles(runtime));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await runtime.dispose();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

function applyOldWranglerMigrations(root, oldSqlDir) {
  const config = join(root, "old-wrangler-local.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "yurumeet-historical-native-local-only",
      compatibility_date: "2026-07-16",
      d1_databases: [
        {
          binding: "DB",
          database_name: "yurumeet-historical-native-local-only",
          database_id: DB_ID,
          migrations_dir: oldSqlDir,
        },
      ],
    }),
  );
  const wrangler = resolve(REPO, "node_modules/wrangler/bin/wrangler.js");
  need(existsSync(wrangler), "local-wrangler-missing");
  const environment = {
    ...process.env,
    WRANGLER_SEND_METRICS: "false",
    DO_NOT_TRACK: "1",
  };
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CF_API_TOKEN",
    "CF_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
  ])
    delete environment[name];
  const result = spawnSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      join(root, "wrangler"),
      "--config",
      config,
    ],
    {
      cwd: REPO,
      env: environment,
      encoding: "utf8",
      timeout: 420_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  need(
    !result.error && result.status === 0 && !result.signal,
    "local-wrangler-old19-apply-failed",
  );
  return {
    localOnly: true,
    command: "wrangler d1 migrations apply DB --local",
    version: PINS.wranglerNativeBaseline.version,
  };
}

async function assertRepairedPushShape(db, original) {
  need(
    JSON.stringify(await pushRows(db)) === JSON.stringify(original),
    "push-rows-and-retry-state-preserved",
  );
  for (const table of ["notification_pushers", "notification_push_jobs"]) {
    need(
      (await rows(db, `PRAGMA foreign_key_list('${table}')`)).length === 0,
      `${table}-actor-fk-removed`,
    );
  }
  const oldIndex = await rows(
    db,
    "SELECT name FROM sqlite_master WHERE name = 'notification_pushers_actor_product_app_pushkey_idx'",
  );
  need(oldIndex.length === 0, "actor-scoped-pusher-index-removed");
  const device = await rows(db, "PRAGMA index_list('notification_pushers')");
  need(
    device.some(
      (entry) =>
        entry.name === "notification_pushers_device_idx" && entry.unique === 1,
    ),
    "global-device-uniqueness-retained",
  );
  const expectedTriggers = [
    "account_deletion_notification_push_jobs_insert",
    "account_deletion_notification_pushers_insert",
    "account_deletion_notification_pushers_update",
    "notification_push_jobs_after_inbox_delete",
    "notification_push_jobs_after_inbox_insert",
  ];
  const triggers = (
    await rows(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND instr(name, 'notification_push') > 0 ORDER BY name",
    )
  ).map((entry) => entry.name);
  need(
    JSON.stringify(triggers) === JSON.stringify(expectedTriggers),
    "push-guards-and-inbox-triggers-retained",
  );
  need(
    (await rows(db, "PRAGMA foreign_key_check")).length === 0,
    "candidate-fk-check",
  );
}

export async function qualifyHistoricalUpdate(input, profile = "password") {
  need(profile === "password" || profile === "oidc", "auth-profile-supported");
  const verified = verifyHistoricalInputs(input);
  const root = mkdtempSync(join(tmpdir(), "yurumeet-historical-update-"));
  try {
    const originalPaths = pathsFor(join(root, "old-original"));
    const ids = {
      d1: DB_ID,
      kv: `historical-kv-${randomUUID()}`,
      r2: `historical-r2-${randomUUID()}`,
    };
    const config = unstable_readConfig(
      { config: resolve(REPO, "wrangler.jsonc") },
      { hideWarnings: true },
    );
    need(
      config.compatibility_date === "2026-07-16" &&
        Array.isArray(config.compatibility_flags),
      "current-worker-compatibility-config",
    );
    const oldConfig = {
      compatibility_date: "2026-07-16",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    };
    const outbound = { blocked: 0 };
    const migrationPath = writeMigrationOnlyModule(root);
    const issuer =
      profile === "oidc"
        ? await createSyntheticRestoreIssuer({
            origin: ORIGIN,
            need,
            subject: OIDC_SUBJECT,
            ownerPin: `takos:${OIDC_SUBJECT}`,
          })
        : null;
    const sessionSalt = issuer ? OIDC_SESSION_SALT : undefined;
    const runner = await loadPublicRunner(root);
    const wrangler = applyOldWranglerMigrations(
      join(root, "old-original"),
      input.oldSqlDir,
    );
    let initial;
    await withRuntime(
      migrationPath,
      originalPaths,
      ids,
      oldConfig,
      outbound,
      async ({ db }) => {
        await historicalLedger(db);
        await oldPushShape(db);
        initial = await dataSnapshot(db);
        need(
          initial.counts.actors === 0 &&
            initial.counts.notification_pushers === 0,
          "native-old19-empty-baseline",
        );
      },
    );
    if (issuer) {
      const emptyClosed = inventoryClosedStores(originalPaths);
      const refused = cloneClosedStores(
        originalPaths,
        join(root, "old-oidc-refusals"),
        emptyClosed,
      );
      await withRuntime(
        input.oldWorkerPath,
        refused.paths,
        ids,
        oldConfig,
        outbound,
        async (h) => {
          const invalidNonce = await rejectOidcCallback(
            h,
            issuer,
            { wrongIdTokenNonce: true },
            "id_token_invalid",
            "old-oidc-wrong-id-token-nonce",
          );
          const tokenExchanges = issuer.evidence().token;
          const replay = await invalidNonce.replay();
          need(
            replay.status === 302 &&
              replay.headers.get("location") === "/?error=invalid_state" &&
              issuer.evidence().token === tokenExchanges,
            "old-oidc-replayed-state-refused",
          );
          await replay.body?.cancel();
          await rejectOidcCallback(
            h,
            issuer,
            { tokenSubject: OIDC_FOREIGN_SUBJECT },
            "actor_creation_failed",
            "old-oidc-foreign-owner-pin",
          );
          const authRows = await oidcAuthRows(h.db);
          need(
            authRows.actors.length === 0 && authRows.sessions.length === 0,
            "old-oidc-refusals-created-no-identity",
          );
        },
        sessionSalt,
        issuer,
      );
      assertClosedStoreInventoriesEqual(
        emptyClosed,
        inventoryClosedStores(originalPaths),
      );
    }
    const fixture = await withRuntime(
      input.oldWorkerPath,
      originalPaths,
      ids,
      oldConfig,
      outbound,
      async (h) => {
        const result = await createOldFixture(h, issuer);
        await historicalLedger(h.db);
        await oldPushShape(h.db);
        return {
          ...result,
          ...(issuer
            ? {
                oidcSession: await oidcSessionRow(
                  h.db,
                  result.oldCookie,
                  result.actorApId,
                ),
              }
            : {}),
          snapshot: await dataSnapshot(h.db),
          projection: await originalRowProjection(h.db),
          push: await pushRows(h.db),
        };
      },
      sessionSalt,
      issuer,
    );
    const oldClosed = inventoryClosedStores(originalPaths);
    need(
      Object.values(oldClosed).every(
        (entry) => entry.fileCount > 0 && entry.totalBytes > 0,
      ),
      "old-closed-stores-present",
    );
    const backup = cloneClosedStores(
      originalPaths,
      join(root, "old-backup"),
      oldClosed,
    );
    await withRuntime(
      input.oldWorkerPath,
      backup.paths,
      ids,
      oldConfig,
      outbound,
      async (h) => {
        need(
          JSON.stringify(await dataSnapshot(h.db)) ===
            JSON.stringify(fixture.snapshot),
          "independent-old-backup-schema-and-rows",
        );
        need(
          JSON.stringify(await bindingSnapshot(h)) ===
            JSON.stringify(fixture.binding),
          "independent-old-backup-all-kv-r2-keys",
        );
        if (issuer) {
          need(
            JSON.stringify(
              await oidcSessionRow(h.db, fixture.oldCookie, fixture.actorApId),
            ) === JSON.stringify(fixture.oidcSession),
            "independent-old-backup-oidc-session",
          );
          await oidcActor(h.fetcher, fixture.oldCookie, fixture.actorApId);
          await issuer.assertEncrypted(
            fixture.oidcSession,
            fixture.oidcTokens,
            ENCRYPTION_KEY,
            "historical-backup-oidc",
          );
        }
        await content(h, fixture, fixture.oldCookie);
      },
      sessionSalt,
      issuer,
    );
    const failureClone = cloneClosedStores(
      originalPaths,
      join(root, "atomic-failure"),
      oldClosed,
    );
    await withRuntime(
      migrationPath,
      failureClone.paths,
      ids,
      oldConfig,
      outbound,
      async ({ db }) => {
        let rejected = false;
        try {
          await migrate(db, verified.migrationsDir, runner, true);
        } catch {
          rejected = true;
        }
        need(rejected, "injected-migration-failure-observed");
        need(
          JSON.stringify(await canonicalLedger(db)) ===
            JSON.stringify(PINS.wranglerNativeBaseline.names),
          "failed-migration-ledger-did-not-advance",
        );
        need(
          (
            await rows(
              db,
              "SELECT name FROM sqlite_master WHERE name = 'call_sessions'",
            )
          ).length === 0,
          "failed-migration-schema-rolled-back",
        );
      },
    );
    const update = cloneClosedStores(
      originalPaths,
      join(root, "update"),
      oldClosed,
    );
    let upgraded;
    await withRuntime(
      migrationPath,
      update.paths,
      ids,
      oldConfig,
      outbound,
      async ({ db }) => {
        need(
          JSON.stringify(await dataSnapshot(db)) ===
            JSON.stringify(fixture.snapshot),
          "pre-update-full-snapshot",
        );
        const result = await migrate(db, verified.migrationsDir, runner);
        need(
          result.skipped.length === 19 && result.applied.length === 16,
          "runner-19-skipped-16-applied",
        );
        const expected = readdirSync(verified.migrationsDir)
          .filter((name) => name.endsWith(".sql"))
          .sort();
        need(
          JSON.stringify(await canonicalLedger(db)) ===
            JSON.stringify(expected),
          "complete-ordered-35-ledger",
        );
        need(
          JSON.stringify(
            await preservedRows(db, fixture.projection.columns),
          ) === JSON.stringify(fixture.projection.rows),
          "all-old-table-rows-preserved",
        );
        if (issuer) {
          need(
            JSON.stringify(
              await oidcSessionRow(db, fixture.oldCookie, fixture.actorApId),
            ) === JSON.stringify(fixture.oidcSession),
            "native-migration-oidc-session-ciphertext-preserved",
          );
          await issuer.assertEncrypted(
            fixture.oidcSession,
            fixture.oidcTokens,
            ENCRYPTION_KEY,
            "historical-migrated-oidc",
          );
        }
        await assertRepairedPushShape(db, fixture.push);
        upgraded = await dataSnapshot(db);
      },
    );
    const migratedClosed = inventoryClosedStores(update.paths);
    const candidateClone = cloneClosedStores(
      update.paths,
      join(root, "candidate-reopen"),
      migratedClosed,
    );
    verifyHistoricalInputs(input);
    await withRuntime(
      input.candidateWorkerPath,
      candidateClone.paths,
      ids,
      config,
      outbound,
      async (h) => {
        need(
          JSON.stringify(await dataSnapshot(h.db)) === JSON.stringify(upgraded),
          "candidate-reopen-full-schema-and-rows",
        );
        need(
          JSON.stringify(await bindingSnapshot(h)) ===
            JSON.stringify(fixture.binding),
          "candidate-all-kv-r2-keys-and-bytes",
        );
        need((await h.kv.get(KV_KEY)) === KV_VALUE, "candidate-kv-readback");
        need((await h.r2.get(fixture.r2Key)) !== null, "candidate-r2-readback");
        if (issuer) {
          need(
            JSON.stringify(
              await oidcSessionRow(h.db, fixture.oldCookie, fixture.actorApId),
            ) === JSON.stringify(fixture.oidcSession),
            "candidate-pre-http-oidc-session-preserved",
          );
          const originalLinks = await rows(
            h.db,
            "SELECT ap_id, takos_user_id, role FROM actors ORDER BY ap_id",
          );
          need(
            originalLinks.length === 1 &&
              originalLinks[0].ap_id === fixture.actorApId &&
              originalLinks[0].takos_user_id === `takos:${OIDC_SUBJECT}` &&
              originalLinks[0].role === "owner",
            "candidate-pre-http-oidc-linked-owner",
          );
          await oidcActor(h.fetcher, fixture.oldCookie, fixture.actorApId);
          need(
            JSON.stringify(
              await oidcSessionRow(h.db, fixture.oldCookie, fixture.actorApId),
            ) === JSON.stringify(fixture.oidcSession),
            "candidate-old-cookie-read-no-write",
          );
          await rejectOidcCallback(
            h,
            issuer,
            { tokenSubject: OIDC_FOREIGN_SUBJECT },
            "actor_creation_failed",
            "candidate-oidc-foreign-subject",
          );
          await oidcActor(h.fetcher, fixture.oldCookie, fixture.actorApId);
          const fresh = await issuer.login(
            h.fetcher,
            request,
            oidcCookie,
            fixture.oldCookie,
          );
          need(
            fresh.cookie !== fixture.oldCookie &&
              (await oidcActor(h.fetcher, fresh.cookie, fixture.actorApId)) ===
                fixture.actorApId &&
              JSON.stringify(
                await rows(
                  h.db,
                  "SELECT ap_id, takos_user_id, role FROM actors ORDER BY ap_id",
                ),
              ) === JSON.stringify(originalLinks),
            "candidate-same-subject-oidc-relogin",
          );
          const oldRow = await rows(
            h.db,
            "SELECT id FROM sessions WHERE id = ?",
            oidcSessionKey(fixture.oldCookie),
          );
          need(oldRow.length === 0, "candidate-old-oidc-session-rotated");
          const oldCookie = await request(h.fetcher, "/api/auth/me", {
            headers: { cookie: `session=${fixture.oldCookie}` },
          });
          need(oldCookie.status === 401, "candidate-rotated-cookie-denied");
          await oldCookie.body?.cancel();
          const newRow = await oidcSessionRow(
            h.db,
            fresh.cookie,
            fixture.actorApId,
          );
          need(
            (await rows(h.db, "SELECT id FROM sessions")).length === 1,
            "candidate-one-rotated-oidc-session",
          );
          await issuer.assertEncrypted(
            newRow,
            fresh,
            ENCRYPTION_KEY,
            "historical-candidate-oidc",
          );
          await content(h, fixture, fresh.cookie);
        } else {
          const stale = await request(h.fetcher, "/api/auth/me", {
            headers: { cookie: `session=${fixture.oldCookie}` },
          });
          await stale.body?.cancel();
          need(stale.status === 401, "old-cookie-explicit-denial");
          const fresh = await login(h.fetcher);
          need(
            fresh !== fixture.oldCookie &&
              (await actor(h.fetcher, fresh)) === fixture.actorApId,
            "candidate-password-relogin",
          );
          await content(h, fixture, fresh);
        }
        need(
          JSON.stringify(await pushRows(h.db)) === JSON.stringify(fixture.push),
          "candidate-push-state-preserved",
        );
      },
      issuer ? OIDC_SESSION_SALT : NEW_SESSION_SALT,
      issuer,
    );
    assertClosedStoreInventoriesEqual(
      oldClosed,
      inventoryClosedStores(originalPaths),
    );
    assertClosedStoreInventoriesEqual(
      migratedClosed,
      inventoryClosedStores(update.paths),
    );
    exactFile(
      input.oldWorkerPath,
      PINS.provenance.workerSha256,
      PINS.provenance.workerBytes,
      "old-worker-after-run",
    );
    need(
      outbound.blocked === 0 && (!issuer || issuer.evidence().blocked === 0),
      "outbound-worker-request-attempted",
    );
    if (issuer) {
      const observed = issuer.evidence();
      need(
        observed.token === 5 &&
          observed.userinfo === 5 &&
          observed.jwks === 5 &&
          observed.logins === 2,
        "oidc-old-and-new-callbacks-observed",
      );
    }
    return {
      kind: issuer
        ? "yurumeet.native-historical-oidc-update@v1"
        : "yurumeet.native-historical-update@v1",
      status: "PASSED",
      predecessor: {
        tag: PINS.provenance.tag,
        commit: PINS.provenance.commit,
        workerSha256: verified.oldWorkerSha256,
        coreVersion: PINS.provenance.coreVersion,
      },
      candidate: {
        workerSha256: verified.candidateSha256,
        coreVersion: PINS.candidateCore.version,
      },
      wrangler,
      ledger: { physicalOld: 19, skipped: 19, applied: 16, canonicalNew: 35 },
      oldClosed,
      migratedClosed,
      oldSchemaSha256: fixture.snapshot.schemaSha256,
      migratedSchemaSha256: upgraded.schemaSha256,
      oldRowCoverage: Object.keys(fixture.projection.columns).length,
      checks: [
        "verified-published-bytes",
        "native-wrangler-old19-ledger",
        issuer
          ? "old-worker-oidc-only-owner-post-png"
          : "old-worker-password-post-png",
        "old-push-retry-state",
        "independent-old-backup-reopen",
        "atomic-batch-failure-rollback",
        "physical-ledger-import",
        "published-core-19-skip-16-apply",
        "0036-push-fk-repair",
        "all-old-row-projection",
        "closed-store-clone",
        "all-kv-r2-keys-and-bytes",
        issuer
          ? "candidate-old-oidc-cookie-retained-salt"
          : "candidate-old-cookie-denial",
        issuer
          ? "candidate-same-subject-oidc-rotation-and-content"
          : "candidate-password-relogin-and-content",
        ...(issuer
          ? [
              "old-wrong-nonce-and-foreign-subject-refused",
              "current-foreign-subject-refused",
              "old-and-new-encrypted-session-rows",
            ]
          : []),
      ],
      boundaries: {
        oldSchemaBundleDigest: "unreproduced; exact 19 SQL hashes verified",
        oldWorkerOnNewSchema: "not exercised",
        oidc: issuer
          ? "synthetic issuer only; no real issuer, grants, or token refresh"
          : "not exercised; no old supported synthetic route established",
        liveOperatorLedger: "not inspected",
        productionMigrationAdapter: "not provided",
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function qualifyHistoricalOidcUpdate(input) {
  return qualifyHistoricalUpdate(input, "oidc");
}
