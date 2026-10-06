import { createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { FormData, Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";

import { createManagedNativeRuntime } from "./native-runtime-stdio.mjs";
import { createSyntheticRestoreIssuer } from "./release-storage-oidc.mjs";

const STORE_NAMES = ["d1", "kv", "r2"];
const ORIGIN = "https://storage-restore.yurumeet.invalid";
const WORKER_NAME = "yurumeet-native-storage-restore";
const CANONICAL_ORIGIN_KV_KEY = "__yurucommu/runtime/canonical-origin/v1";
const PASSWORD = "yurumeet-native-restore-password-fixture";
const PASSWORD_SALT = Buffer.alloc(32, 0x6d);
const PASSWORD_HASH = `${PASSWORD_SALT.toString("hex")}:${pbkdf2Sync(PASSWORD, PASSWORD_SALT, 100000, 32, "sha256").toString("hex")}`;
const SESSION_SALT = "yurumeet-native-restore-dedicated-session-salt";
const ENCRYPTION_KEY = "00".repeat(32);
const CONTENT = "Yurumeet native storage restore fixture note";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
  "base64",
);
const CHECKS = [
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
];

class StorageRestoreAssertion extends Error {}

function requireEffect(condition, label) {
  if (!condition) throw new StorageRestoreAssertion(`storage restore ${label}`);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function storePaths(root) {
  const paths = Object.fromEntries(
    STORE_NAMES.map((name) => [name, join(root, name)]),
  );
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

function inventoryDirectory(root) {
  requireEffect(
    existsSync(root) && statSync(root).isDirectory(),
    "store-root-missing",
  );
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(root, child));
        files.push({ path: child, bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        requireEffect(false, "store-contains-non-file-entry");
      }
    }
  }
  walk("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: sha256(Buffer.from(JSON.stringify(files))),
  };
}

/** Call only after every native runtime using these persistent paths is closed. */
export function inventoryClosedStores(paths) {
  return Object.fromEntries(
    STORE_NAMES.map((name) => [name, inventoryDirectory(paths[name])]),
  );
}

function validInventoryStore(store) {
  if (
    !store ||
    !Array.isArray(store.files) ||
    store.fileCount !== store.files.length ||
    !Number.isSafeInteger(store.totalBytes) ||
    store.totalBytes < 0
  ) {
    return false;
  }
  let previous = "";
  let total = 0;
  for (const file of store.files) {
    if (
      typeof file?.path !== "string" ||
      !file.path ||
      isAbsolute(file.path) ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      file.path <= previous ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(file.sha256)
    ) {
      return false;
    }
    total += file.bytes;
    previous = file.path;
  }
  return (
    total === store.totalBytes &&
    store.sha256 === sha256(Buffer.from(JSON.stringify(store.files)))
  );
}

/** Exact relative path, size, and per-file SHA-256 comparison; no file contents. */
export function assertClosedStoreInventoriesEqual(expected, actual) {
  for (const name of STORE_NAMES) {
    requireEffect(
      validInventoryStore(expected?.[name]) &&
        validInventoryStore(actual?.[name]) &&
        JSON.stringify(expected[name]) === JSON.stringify(actual[name]),
      `${name}-closed-inventory-mismatch`,
    );
  }
}

/** Clone a closed snapshot into a fresh root and prove every copied file. */
export function cloneClosedStores(
  sourcePaths,
  destinationRoot,
  expectedInventory,
) {
  assertClosedStoreInventoriesEqual(
    expectedInventory,
    inventoryClosedStores(sourcePaths),
  );
  requireEffect(!existsSync(destinationRoot), "clone-destination-exists");
  mkdirSync(destinationRoot, { recursive: false });
  const paths = {};
  for (const name of STORE_NAMES) {
    const target = join(destinationRoot, name);
    cpSync(sourcePaths[name], target, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    paths[name] = target;
  }
  const inventory = inventoryClosedStores(paths);
  assertClosedStoreInventoriesEqual(expectedInventory, inventory);
  return { paths, inventory };
}

function nativeWorker(
  artifactPath,
  paths,
  ids,
  wranglerConfig,
  outbound,
  issuer,
  diagnostics,
) {
  const root = dirname(artifactPath);
  const deliveryQueue = "yurumeet-restore-delivery";
  const deadLetterQueue = "yurumeet-restore-dlq";
  return createManagedNativeRuntime(
    (handleRuntimeStdio) =>
      new Miniflare({
        workers: [
          {
            name: WORKER_NAME,
            routes: [ORIGIN + "/*"],
            rootPath: root,
            modules: [{ type: "ESModule", path: artifactPath }],
            modulesRoot: root,
            compatibilityDate: wranglerConfig.compatibility_date,
            compatibilityFlags: wranglerConfig.compatibility_flags,
            bindings: {
              ...(issuer
                ? issuer.bindings
                : { AUTH_PASSWORD_HASH: PASSWORD_HASH }),
              YURUCOMMU_SESSION_HASH_SALT: SESSION_SALT,
              ENCRYPTION_KEY,
              DELIVERY_QUEUE_NAME: deliveryQueue,
              DELIVERY_DLQ_NAME: deadLetterQueue,
            },
            d1Databases: { DB: { id: ids.d1 } },
            kvNamespaces: { KV: { id: ids.kv } },
            r2Buckets: { MEDIA: { id: ids.r2 } },
            queueProducers: {
              DELIVERY_QUEUE: { queueName: deliveryQueue },
              DELIVERY_DLQ: { queueName: deadLetterQueue },
            },
            outboundService: issuer
              ? (request) => issuer.fetch(request)
              : async () => {
                  outbound.blockedFetches += 1;
                  return new Response(null, { status: 502 });
                },
          },
        ],
        compatibilityDate: wranglerConfig.compatibility_date,
        compatibilityFlags: wranglerConfig.compatibility_flags,
        cf: false,
        d1Persist: paths.d1,
        kvPersist: paths.kv,
        r2Persist: paths.r2,
        handleRuntimeStdio,
      }),
    issuer ? { destination: diagnostics } : undefined,
  );
}

async function handles(worker) {
  return {
    fetcher: await worker.getWorker(WORKER_NAME),
    db: await worker.getD1Database("DB", WORKER_NAME),
    kv: await worker.getKVNamespace("KV", WORKER_NAME),
    r2: await worker.getR2Bucket("MEDIA", WORKER_NAME),
  };
}

async function fetchPath(fetcher, path, init = {}) {
  return fetcher.fetch(new URL(path, ORIGIN).href, {
    ...init,
    headers: new Headers(init.headers),
  });
}

async function jsonResponse(response, status, label) {
  requireEffect(response.status === status, `${label}-http-${response.status}`);
  const text = await response.text();
  requireEffect(
    Buffer.byteLength(text) <= 1024 * 1024,
    `${label}-response-large`,
  );
  try {
    return JSON.parse(text);
  } catch {
    requireEffect(false, `${label}-invalid-json`);
  }
}

function cookieFrom(response) {
  const headers = response.headers.getSetCookie();
  const cookies = headers.filter(
    (header) =>
      header.startsWith("session=") &&
      header.split(";", 1)[0].length > "session=".length,
  );
  requireEffect(
    cookies.length === 1 && cookies[0].length <= 4096,
    "login-cookie-count",
  );
  const [pair, ...attributes] = cookies[0]
    .split(";")
    .map((part) => part.trim());
  const raw = decodeURIComponent(pair.slice("session=".length));
  const settings = new Map(
    attributes.map((attribute) => {
      const separator = attribute.indexOf("=");
      return separator < 0
        ? [attribute.toLowerCase(), true]
        : [
            attribute.slice(0, separator).toLowerCase(),
            attribute.slice(separator + 1),
          ];
    }),
  );
  requireEffect(
    raw.length > 0 &&
      raw.length <= 256 &&
      settings.get("httponly") === true &&
      settings.get("secure") === true &&
      settings.get("path") === "/" &&
      String(settings.get("samesite")).toLowerCase() === "strict" &&
      Number(settings.get("max-age")) > 0,
    "login-cookie-policy",
  );
  return raw;
}

async function applySchema(db, repoRoot) {
  const bytes = readFileSync(
    resolve(repoRoot, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const bundle = JSON.parse(bytes.toString("utf8"));
  requireEffect(
    bundle.apiVersion === "takosumi.resource-migrations/v1" &&
      bundle.engine === "sqlite" &&
      Array.isArray(bundle.entries) &&
      bundle.entries.length === 29,
    "schema-bundle-29",
  );
  for (const entry of bundle.entries) {
    requireEffect(
      typeof entry.sql === "string" &&
        entry.sha256 === sha256(Buffer.from(entry.sql, "utf8")),
      "schema-entry-sha256",
    );
    const statements = unstable_splitSqlQuery(entry.sql);
    requireEffect(statements.length > 0, "schema-entry-empty");
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  return {
    schemaSha256: sha256(bytes),
    migrationCount: bundle.entries.length,
  };
}

function actorTimestamp(raw) {
  // Locked Core nowIso() writes UTC with a space separator and no zone suffix.
  requireEffect(
    typeof raw === "string" &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(raw),
    "oidc-actor-login-timestamp-format",
  );
  const timestamp = Date.parse(raw.replace(" ", "T") + "Z");
  requireEffect(
    Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().replace("T", " ").replace("Z", "") ===
        raw,
    "oidc-actor-login-timestamp-valid",
  );
  return timestamp;
}

const RUNTIME_OWNED_ROW_EXCLUSIONS = new Set(["_cf_METADATA"]);

function quotedIdentifier(name) {
  requireEffect(
    typeof name === "string" && !name.includes("\0"),
    "snapshot-identifier",
  );
  return `"${name.replaceAll('"', '""')}"`;
}

function canonicalSqlValue(value) {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "number") {
    requireEffect(Number.isFinite(value), "snapshot-nonfinite-number");
    // D1 exposes SQLite INTEGER through JS numbers. Above 2^53 distinct
    // stored integers can already have collapsed to one value on readback.
    requireEffect(
      !Number.isInteger(value) || Number.isSafeInteger(value),
      "snapshot-unsafe-integer",
    );
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "boolean") return ["boolean", value];
  if (value instanceof ArrayBuffer) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  if (ArrayBuffer.isView(value)) {
    return [
      "blob",
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
        "base64",
      ),
    ];
  }
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return ["blob", Buffer.from(value).toString("base64")];
  }
  requireEffect(false, "snapshot-unsupported-sql-value");
}

function canonicalRows(rows, columns) {
  const names = columns.map((column) => column.name).sort();
  return rows
    .map((row) => {
      requireEffect(
        row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          JSON.stringify(Object.keys(row).sort()) === JSON.stringify(names),
        "snapshot-row-columns",
      );
      return JSON.stringify(
        names.map((name) => [name, canonicalSqlValue(row[name])]),
      );
    })
    .sort();
}

function metadataJson(value) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? ["integer", item.toString()] : item,
  );
}

const SNAPSHOT_BATCH_SIZE = 50;

async function queryRowSets(db, statements) {
  const rowSets = [];
  const nativeBatch = typeof db.batch === "function";
  for (let start = 0; start < statements.length; start += SNAPSHOT_BATCH_SIZE) {
    const chunk = statements.slice(start, start + SNAPSHOT_BATCH_SIZE);
    // All statements are constructed locally from SELECT or read-only PRAGMA
    // and quoted schema identifiers. A failed native batch must propagate;
    // retrying it serially could hide a partial or changed snapshot.
    requireEffect(
      chunk.every((sql) =>
        /^(?:SELECT\b|PRAGMA (?:table_xinfo|foreign_key_list|foreign_key_check)\b)/u.test(
          sql,
        ),
      ),
      "snapshot-non-readonly-statement",
    );
    let results;
    if (nativeBatch) {
      results = await db.batch(chunk.map((sql) => db.prepare(sql)));
    } else {
      results = [];
      for (const sql of chunk) results.push(await db.prepare(sql).all());
    }
    requireEffect(
      Array.isArray(results) && results.length === chunk.length,
      "snapshot-batch-result-count",
    );
    for (const result of results) {
      requireEffect(
        result &&
          (nativeBatch ? result.success === true : result.success !== false) &&
          Array.isArray(result.results),
        "snapshot-query-result",
      );
      rowSets.push(result.results);
    }
  }
  return rowSets;
}

/** All application-table rows, including duplicates, plus SQLite sequence state. */
export async function dataSnapshot(
  db,
  includeSessions = true,
  normalizeLoginTimestamp = false,
) {
  const [schema] = await queryRowSets(db, [
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
  ]);
  const tableNames = schema
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name)
    .sort();
  requireEffect(
    tableNames.every((name) => typeof name === "string") &&
      new Set(tableNames).size === tableNames.length,
    "snapshot-table-list",
  );
  const runtimeOwnedExcludedTables = tableNames.filter((name) =>
    RUNTIME_OWNED_ROW_EXCLUSIONS.has(name),
  );
  const applicationTables = tableNames.filter(
    (name) => !RUNTIME_OWNED_ROW_EXCLUSIONS.has(name),
  );
  const rowTables = applicationTables.filter(
    (name) => includeSessions || name !== "sessions",
  );
  const rows = [];
  const relationships = [];
  let actorUpdatedAt;
  const metadataSql = applicationTables.flatMap((table) => {
    const identifier = quotedIdentifier(table);
    return [
      `PRAGMA table_xinfo(${identifier})`,
      `PRAGMA foreign_key_list(${identifier})`,
      `PRAGMA foreign_key_check(${identifier})`,
    ];
  });
  const metadata = await queryRowSets(db, metadataSql);
  const columnsByTable = new Map();
  for (const [index, table] of applicationTables.entries()) {
    const columns = metadata[index * 3];
    const selectedColumns = columns.filter(
      (column) => column.hidden !== 1 && column.hidden !== 1n,
    );
    requireEffect(selectedColumns.length > 0, "snapshot-table-without-columns");
    const foreignKeys = metadata[index * 3 + 1];
    const violations = metadata[index * 3 + 2];
    requireEffect(violations.length === 0, "snapshot-foreign-key-violation");
    relationships.push({ table, columns, foreignKeys });
    columnsByTable.set(table, selectedColumns);
  }
  const rowSql = rowTables.map(
    (table) =>
      `SELECT ${columnsByTable
        .get(table)
        .map((column) => quotedIdentifier(column.name))
        .join(", ")} FROM ${quotedIdentifier(table)}`,
  );
  const tableRowSets = await queryRowSets(db, rowSql);
  for (const [index, table] of rowTables.entries()) {
    const selectedColumns = columnsByTable.get(table);
    const tableRows = tableRowSets[index];
    if (normalizeLoginTimestamp && table === "actors") {
      requireEffect(tableRows.length === 1, "oidc-exact-one-product-actor");
      actorUpdatedAt = tableRows[0].updated_at;
      actorTimestamp(actorUpdatedAt);
      // Only this known Core login write is normalized; every other value and
      // every other application table remains in the fingerprint.
      tableRows[0] = { ...tableRows[0], updated_at: "login-timestamp" };
    }
    const canonical = canonicalRows(tableRows, selectedColumns);
    rows.push({
      table,
      count: canonical.length,
      rowsSha256: sha256(Buffer.from(JSON.stringify(canonical))),
    });
  }
  requireEffect(
    !normalizeLoginTimestamp || actorUpdatedAt !== undefined,
    "oidc-actor-table-missing",
  );
  const counts = Object.fromEntries(
    rows.map((entry) => [entry.table, entry.count]),
  );
  return {
    schemaSha256: sha256(Buffer.from(JSON.stringify(schema))),
    relationshipsSha256: sha256(Buffer.from(metadataJson(relationships))),
    dataSha256: sha256(Buffer.from(JSON.stringify(rows))),
    counts,
    tableCoverage: {
      applicationTableCount: applicationTables.filter(
        (name) => name !== "sqlite_sequence",
      ).length,
      snapshottedTables: rowTables,
      runtimeOwnedExcludedTables,
      sqliteSequencePresent: tableNames.includes("sqlite_sequence"),
      excludedFromRowComparison: includeSessions ? [] : ["sessions"],
      normalizedColumns: normalizeLoginTimestamp ? ["actors.updated_at"] : [],
      canonicalization:
        "all visible/generated columns; typed SQL values; sorted complete rows with duplicates retained",
      foreignKeyViolationCount: 0,
    },
    ...(normalizeLoginTimestamp ? { actorUpdatedAt } : {}),
  };
}

async function ready(fetcher) {
  const response = await fetchPath(fetcher, "/readyz", {
    headers: { accept: "application/json" },
  });
  const body = await jsonResponse(response, 200, "readyz");
  requireEffect(
    body.status === "ok" &&
      body.service === "yurucommu" &&
      Array.isArray(body.missingBindings) &&
      body.missingBindings.length === 0,
    "readyz-body",
  );
}

async function assertCookie(fetcher, cookie, actorApId) {
  const response = await fetchPath(fetcher, "/api/auth/me", {
    headers: { cookie: `session=${cookie}` },
  });
  const body = await jsonResponse(response, 200, "cookie-me");
  requireEffect(
    body.actor?.ap_id === actorApId && body.actor.role === "owner",
    "cookie-owner-identity",
  );
}

async function assertContent(handles, expected) {
  const postResponse = await fetchPath(
    handles.fetcher,
    "/api/posts/" + encodeURIComponent(expected.postApId),
    { headers: { cookie: `session=${expected.cookie}` } },
  );
  const post = await jsonResponse(postResponse, 200, "post-readback");
  requireEffect(
    post.post?.ap_id === expected.postApId &&
      post.post.type === "Note" &&
      post.post.author?.ap_id === expected.actorApId &&
      post.post.content === CONTENT &&
      post.post.visibility === "public" &&
      JSON.stringify(post.post.attachments) ===
        JSON.stringify([expected.attachment]),
    "post-readback-body",
  );
  const mediaRow = await handles.db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE id = ?",
    )
    .bind(expected.mediaId)
    .first();
  const blob = await handles.r2.get(expected.attachment.r2_key);
  requireEffect(
    mediaRow?.r2_key === expected.attachment.r2_key &&
      mediaRow.uploader_ap_id === expected.actorApId &&
      mediaRow.content_type === "image/png" &&
      mediaRow.size === PNG.length &&
      blob &&
      Buffer.from(await blob.arrayBuffer()).equals(PNG),
    "native-media-bytes",
  );
  const response = await fetchPath(handles.fetcher, expected.attachment.url, {
    headers: { cookie: `session=${expected.cookie}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  requireEffect(
    response.status === 200 &&
      response.headers.get("content-type") === "image/png" &&
      bytes.equals(PNG),
    "http-media-bytes",
  );
}

async function oidcRow(db, credential, issuer, label) {
  const sessionKey = sha256(
    Buffer.from(`${SESSION_SALT}:${credential.cookie}`),
  );
  const row = await db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(sessionKey)
    .first();
  requireEffect(
    row?.id === sessionKey &&
      row.access_token === sessionKey &&
      row.member_id === `${ORIGIN}/ap/users/restore_fixture` &&
      Date.parse(row.expires_at) > Date.now() &&
      Date.parse(row.provider_token_expires_at) > Date.now(),
    label + "-salted-session",
  );
  await issuer.assertEncrypted(row, credential, ENCRYPTION_KEY, label);
  return row;
}

async function assertOidcPresence(fetcher, cookie, expectedActor) {
  const response = await fetchPath(fetcher, "/api/auth/me", {
    headers: { cookie: `session=${cookie}` },
  });
  const body = await jsonResponse(response, 200, "oidc-provider-presence");
  requireEffect(
    body.actor?.ap_id === expectedActor &&
      body.actor.role === "owner" &&
      body.provider === "takos" &&
      body.has_takos_access === true,
    "oidc-provider-ciphertext-presence",
  );
}

async function createFixture(handles, issuer) {
  // No APP_URL binding: the first real HTTPS /readyz request must establish
  // the canonical-origin KV pin through Core's public-origin middleware.
  await ready(handles.fetcher);
  requireEffect(
    (await handles.kv.get(CANONICAL_ORIGIN_KV_KEY)) === ORIGIN,
    "initial-origin-pin",
  );

  const credential = issuer
    ? await issuer.login(
        handles.fetcher,
        (_worker, path, init) => fetchPath(handles.fetcher, path, init),
        cookieFrom,
      )
    : undefined;
  const response = issuer
    ? undefined
    : await fetchPath(handles.fetcher, "/api/auth/login", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
  if (!issuer) {
    const body = await jsonResponse(response, 200, "password-login");
    requireEffect(body.success === true, "password-login-body");
  }
  const cookie = credential?.cookie ?? cookieFrom(response);
  const meResponse = await fetchPath(handles.fetcher, "/api/auth/me", {
    headers: { cookie: `session=${cookie}` },
  });
  const me = await jsonResponse(meResponse, 200, "initial-me");
  const actorApId = `${ORIGIN}/ap/users/${issuer ? "restore_fixture" : "tako"}`;
  requireEffect(
    me.actor?.ap_id === actorApId && me.actor.role === "owner",
    "initial-owner",
  );
  const sessionKey = sha256(Buffer.from(`${SESSION_SALT}:${cookie}`));
  const session = await handles.db
    .prepare(
      "SELECT id, member_id, access_token, expires_at FROM sessions WHERE id = ?",
    )
    .bind(sessionKey)
    .first();
  requireEffect(
    session?.member_id === actorApId &&
      session.access_token === sessionKey &&
      Date.parse(session.expires_at) > Date.now(),
    "salted-session-row",
  );
  const encryptedRow = issuer
    ? await oidcRow(handles.db, credential, issuer, "restore-oidc-initial")
    : undefined;
  if (issuer) {
    requireEffect(
      me.provider === "takos" && me.has_takos_access === true,
      "initial-oidc-provider-presence",
    );
  }

  const form = new FormData();
  form.set(
    "file",
    new File([PNG], "restore-fixture.png", { type: "image/png" }),
  );
  const uploadResponse = await fetchPath(handles.fetcher, "/api/media/upload", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: `session=${cookie}` },
    body: form,
  });
  const upload = await jsonResponse(uploadResponse, 200, "media-upload");
  requireEffect(
    typeof upload.id === "string" &&
      upload.url === `/media/${upload.id}.png` &&
      upload.r2_key === `uploads/${upload.id}.png` &&
      upload.content_type === "image/png",
    "media-upload-body",
  );
  const attachment = {
    url: upload.url,
    r2_key: upload.r2_key,
    content_type: upload.content_type,
    name: "storage restore image",
  };
  const postResponse = await fetchPath(handles.fetcher, "/api/posts", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie: `session=${cookie}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: CONTENT, attachments: [attachment] }),
  });
  const posted = await jsonResponse(postResponse, 200, "post-create");
  const postApId = posted.post?.ap_id;
  requireEffect(
    typeof postApId === "string" &&
      postApId.startsWith(`${ORIGIN}/ap/objects/`) &&
      posted.post.author?.ap_id === actorApId &&
      posted.post.visibility === "public",
    "post-create-body",
  );
  const expected = {
    cookie,
    actorApId,
    postApId,
    mediaId: upload.id,
    attachment,
  };
  await assertContent(handles, expected);
  const snapshot = await dataSnapshot(handles.db);
  requireEffect(
    snapshot.counts.actors === 1 &&
      snapshot.counts.sessions === 1 &&
      snapshot.counts.objects === 1 &&
      snapshot.counts.media_uploads === 1 &&
      snapshot.counts.activities === 1,
    "fixture-d1-row-counts",
  );
  return { expected, snapshot, credential, encryptedRow };
}

export async function qualifyStorageRestore({
  artifactPath,
  artifactSha256,
  repoRoot,
  wranglerConfig,
  authentication = "password",
}) {
  requireEffect(
    typeof artifactPath === "string" &&
      existsSync(artifactPath) &&
      statSync(artifactPath).isFile() &&
      typeof artifactSha256 === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(artifactSha256) &&
      sha256(readFileSync(artifactPath)) === artifactSha256 &&
      typeof repoRoot === "string" &&
      typeof wranglerConfig?.compatibility_date === "string" &&
      Array.isArray(wranglerConfig.compatibility_flags),
    "input-artifact-and-config",
  );
  requireEffect(
    authentication === "password" || authentication === "oidc",
    "supported-authentication-fixture",
  );
  const issuer =
    authentication === "oidc"
      ? await createSyntheticRestoreIssuer({
          origin: ORIGIN,
          need: requireEffect,
        })
      : undefined;
  const fixtureRoot = mkdtempSync(join(tmpdir(), "yurumeet-storage-restore-"));
  const originalPaths = storePaths(join(fixtureRoot, "original"));
  const ids = Object.fromEntries(
    STORE_NAMES.map((name) => [
      name,
      `yurumeet-restore-${randomUUID()}-${name}`,
    ]),
  );
  const outbound = { blockedFetches: 0 };
  let diagnosticBytes = 0;
  const diagnostics = issuer
    ? new Writable({
        write(chunk, _encoding, callback) {
          // Never retain or forward runtime output from credential-bearing
          // requests. A bounded count is sufficient diagnostic evidence.
          diagnosticBytes = Math.min(
            Number.MAX_SAFE_INTEGER,
            diagnosticBytes + chunk.length,
          );
          callback();
        },
      })
    : undefined;
  let original;
  let clone;
  let primaryFailure = false;
  try {
    original = nativeWorker(
      artifactPath,
      originalPaths,
      ids,
      wranglerConfig,
      outbound,
      issuer,
      diagnostics,
    );
    await original.worker.ready;
    const first = await handles(original.worker);
    const schema = await applySchema(first.db, repoRoot);
    const preFixture = await dataSnapshot(first.db);
    requireEffect(
      preFixture.counts.actors === 0 &&
        preFixture.counts.sessions === 0 &&
        preFixture.counts.objects === 0 &&
        preFixture.counts.media_uploads === 0,
      "fresh-schema-empty",
    );
    const fixture = await createFixture(first, issuer);
    requireEffect(
      (await first.kv.get(CANONICAL_ORIGIN_KV_KEY)) === ORIGIN,
      "fixture-origin-pin",
    );

    await original.dispose();
    original = undefined;
    const closedStores = inventoryClosedStores(originalPaths);
    for (const name of STORE_NAMES) {
      requireEffect(
        closedStores[name].fileCount > 0 && closedStores[name].totalBytes > 0,
        `${name}-closed-store-empty`,
      );
    }
    const copied = cloneClosedStores(
      originalPaths,
      join(fixtureRoot, "clone"),
      closedStores,
    );
    requireEffect(
      sha256(readFileSync(artifactPath)) === artifactSha256,
      "artifact-drift-before-reopen",
    );

    clone = nativeWorker(
      artifactPath,
      copied.paths,
      ids,
      wranglerConfig,
      outbound,
      issuer,
      diagnostics,
    );
    await clone.worker.ready;
    const restored = await handles(clone.worker);
    // No DDL or data seeding occurs on the clone.
    await ready(restored.fetcher);
    await (issuer ? assertOidcPresence : assertCookie)(
      restored.fetcher,
      fixture.expected.cookie,
      fixture.expected.actorApId,
    );
    const restoredSnapshot = await dataSnapshot(restored.db);
    requireEffect(
      JSON.stringify(restoredSnapshot) === JSON.stringify(fixture.snapshot),
      "restored-d1-schema-and-rows",
    );
    await assertContent(restored, fixture.expected);
    requireEffect(
      (await restored.kv.get(CANONICAL_ORIGIN_KV_KEY)) === ORIGIN,
      "restored-origin-pin",
    );
    const oidcChecks = [];
    if (issuer) {
      const preserved = await oidcRow(
        restored.db,
        fixture.credential,
        issuer,
        "restore-oidc-preserved",
      );
      requireEffect(
        JSON.stringify(preserved) === JSON.stringify(fixture.encryptedRow),
        "oidc-exact-original-encrypted-row",
      );
      requireEffect(
        JSON.stringify(await dataSnapshot(restored.db)) ===
          JSON.stringify(fixture.snapshot),
        "oidc-readback-does-not-change-any-row",
      );
      let stableProduct = await dataSnapshot(restored.db, false, true);
      async function assertProductAfterLogin(label, started, completed) {
        const next = await dataSnapshot(restored.db, false, true);
        const previousTimestamp = actorTimestamp(stableProduct.actorUpdatedAt);
        const nextTimestamp = actorTimestamp(next.actorUpdatedAt);
        requireEffect(
          JSON.stringify({
            ...next,
            actorUpdatedAt: stableProduct.actorUpdatedAt,
          }) === JSON.stringify(stableProduct),
          label + "-product-rows-and-schema-unchanged",
        );
        requireEffect(
          nextTimestamp >= previousTimestamp &&
            nextTimestamp >= started &&
            nextTimestamp <= completed,
          label + "-actor-login-timestamp-monotonic-and-bounded",
        );
        await assertContent(restored, fixture.expected);
        requireEffect(
          (await restored.kv.get(CANONICAL_ORIGIN_KV_KEY)) === ORIGIN,
          label + "-kv-origin-unchanged",
        );
        stableProduct = next;
      }
      async function refused(cookie, label) {
        const response = await fetchPath(restored.fetcher, "/api/auth/me", {
          headers: { cookie: `session=${cookie}` },
        });
        await response.body?.cancel();
        requireEffect(response.status === 401, label + "-cookie-refused");
      }
      async function reauthenticate(existingCookie, label) {
        const started = Date.now();
        const next = await issuer.login(
          restored.fetcher,
          (_worker, path, init) => fetchPath(restored.fetcher, path, init),
          cookieFrom,
          existingCookie,
        );
        const completed = Date.now();
        requireEffect(
          next.cookie !== existingCookie &&
            next.access !== fixture.credential.access &&
            next.refresh !== fixture.credential.refresh,
          label + "-fresh-credentials",
        );
        const row = await oidcRow(restored.db, next, issuer, label);
        const sessionIds = (
          await restored.db.prepare("SELECT id FROM sessions ORDER BY id").all()
        ).results;
        requireEffect(
          sessionIds.length === 1 && sessionIds[0].id === row.id,
          label + "-exact-one-recovered-session",
        );
        await assertOidcPresence(
          restored.fetcher,
          next.cookie,
          fixture.expected.actorApId,
        );
        fixture.expected.cookie = next.cookie;
        await assertProductAfterLogin(label, started, completed);
        return { credential: next, row };
      }
      const rotated = await reauthenticate(
        fixture.credential.cookie,
        "restore-oidc-rotated",
      );
      requireEffect(
        rotated.row.provider_access_token !== preserved.provider_access_token &&
          rotated.row.provider_refresh_token !==
            preserved.provider_refresh_token,
        "oidc-rotated-encrypted-values",
      );
      await refused(fixture.credential.cookie, "restore-oidc-old-replay");
      const logout = await fetchPath(restored.fetcher, "/api/auth/logout", {
        method: "POST",
        headers: {
          origin: ORIGIN,
          cookie: `session=${rotated.credential.cookie}`,
        },
      });
      const loggedOut = await jsonResponse(logout, 200, "oidc-logout");
      requireEffect(
        loggedOut.success === true &&
          (
            await restored.db
              .prepare("SELECT COUNT(*) AS count FROM sessions")
              .first()
          ).count === 0,
        "oidc-logout-removes-all-fixture-sessions",
      );
      await refused(rotated.credential.cookie, "restore-oidc-logout-replay");
      // Verify durable data directly while unauthenticated; content is rechecked
      // through HTTP after the next actual OIDC login.
      requireEffect(
        JSON.stringify(await dataSnapshot(restored.db, false, true)) ===
          JSON.stringify(stableProduct),
        "oidc-logout-product-data-preserved",
      );
      const recovered = await reauthenticate(
        undefined,
        "restore-oidc-recovered",
      );
      requireEffect(
        recovered.credential.cookie !== rotated.credential.cookie &&
          recovered.credential.access !== rotated.credential.access &&
          recovered.credential.refresh !== rotated.credential.refresh,
        "oidc-after-logout-fresh-credentials",
      );
      await refused(
        rotated.credential.cookie,
        "restore-oidc-after-relogin-old-replay",
      );
      oidcChecks.push(
        "fixture-oidc-encrypted-access-refresh-and-recovery-controls",
        "restored-exact-oidc-ciphertext-and-recovery-controls",
        "restored-same-subject-reauth-rotates-session-and-bounds-actor-login-time",
        "restored-oidc-logout-removes-row-and-refuses-replay",
        "restored-oidc-relogin-recovers-identity-and-data",
      );
      requireEffect(
        issuer.evidence().blocked === 0,
        "oidc-unexpected-outbound-request",
      );
    }
    await clone.dispose();
    clone = undefined;
    requireEffect(
      sha256(readFileSync(artifactPath)) === artifactSha256,
      "artifact-drift-after-reopen",
    );
    assertClosedStoreInventoriesEqual(
      closedStores,
      inventoryClosedStores(originalPaths),
    );
    requireEffect(outbound.blockedFetches === 0, "outbound-fetch-attempted");
    return {
      kind: "yurumeet.native-storage-restore@v1",
      status: "PASSED",
      artifactSha256,
      physicalIds: ids,
      schemaSha256: schema.schemaSha256,
      migrationCount: schema.migrationCount,
      checks: [...CHECKS, ...oidcChecks],
      authentication,
      ...(issuer
        ? {
            oidc: {
              issuer: issuer.evidence(),
              credentials:
                "exact opaque ciphertext retained; independent AES-GCM access/refresh recovery and wrong-key/tamper refusal",
              limitation:
                "Core has no provider-token decrypt-and-use or refresh path",
              runtimeDiagnostics: {
                policy: "discard-without-retaining-or-forwarding-raw-output",
                observedBytes: diagnosticBytes,
              },
            },
          }
        : {}),
      closedStores,
      clonedStores: copied.inventory,
      schemaFingerprintSha256: fixture.snapshot.schemaSha256,
      dataFingerprintSha256: fixture.snapshot.dataSha256,
      tableCoverage: {
        ...fixture.snapshot.tableCoverage,
        rowCounts: fixture.snapshot.counts,
      },
      externalWorkerFetches: {
        policy: issuer
          ? "local-synthetic-oidc-endpoints-only"
          : "denied-locally-by-miniflare-outbound-service",
        observedBlockedFetches: 0,
      },
      scope:
        "same current artifact and physical D1/KV/R2 IDs; fresh 29-migration fixture actor, cookie, public Note and PNG; closed-store byte clone and reopen; no public v0.1.2 upgrade, real OIDC/token use or live custody; no product ownership policy inferred from fixture identity count",
    };
  } catch (error) {
    primaryFailure = true;
    if (issuer && !(error instanceof StorageRestoreAssertion)) {
      throw new StorageRestoreAssertion("storage restore oidc-runtime-failed");
    }
    throw error;
  } finally {
    let cleanupError;
    for (const managed of [clone, original]) {
      if (!managed) continue;
      try {
        await managed.dispose();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    diagnostics?.destroy();
    if (cleanupError !== undefined) {
      if (issuer) {
        if (!primaryFailure) {
          throw new StorageRestoreAssertion(
            "storage restore oidc-cleanup-failed",
          );
        }
        process.stderr.write("storage restore oidc-cleanup-also-failed\n");
      } else {
        if (!primaryFailure) throw cleanupError;
        process.stderr.write(
          `storage restore cleanup also failed: ${cleanupError}\n`,
        );
      }
    }
  }
}
