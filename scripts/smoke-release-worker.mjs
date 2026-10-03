#!/usr/bin/env bun

import { createHash, pbkdf2Sync } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";

import {
  PRODUCT_CLIENT_KEY,
  PRODUCT_WIRE_IDENTITY,
} from "../src/product-identity.ts";
import { qualifyProductJourneys } from "./release-product-journeys.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TEST_PASSWORD = "release-smoke-only";
const TEST_PASSWORD_SALT = Buffer.alloc(32, 0xa1);
const PASSWORD_FIXTURES = [
  {
    method: "pbkdf2-sha256",
    hash: `${TEST_PASSWORD_SALT.toString("hex")}:${pbkdf2Sync(TEST_PASSWORD, TEST_PASSWORD_SALT, 100000, 32, "sha256").toString("hex")}`,
  },
  { method: "bootstrap", hash: TEST_PASSWORD },
];
const APP_ORIGIN = "https://release-smoke.yurumeet.invalid";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DELIVERY_QUEUE = "yurumeet-delivery";
const DELIVERY_DLQ = "yurumeet-delivery-dlq";
const SESSION_HASH_SALT = "release-smoke-session-salt-not-a-credential";
const REQUIRED_SESSION_SALT_ERROR =
  "YURUCOMMU_SESSION_HASH_SALT must be configured with a non-development value";
const PUBLIC_FALLBACK_SESSION_SALT = "yurucommu:dev-only-session-hash-salt";

async function qualifyBackgroundEvents(worker) {
  const schemaBytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(schemaBytes);
  if (
    schema.apiVersion !== "takosumi.resource-migrations/v1" ||
    schema.engine !== "sqlite" ||
    !Array.isArray(schema.entries) ||
    schema.entries.length === 0
  ) {
    throw new Error("release smoke requires the product migration bundle");
  }

  const db = await worker.getD1Database("DB");
  for (const entry of schema.entries) {
    if (
      typeof entry.sql !== "string" ||
      entry.sha256 !== `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`
    ) {
      throw new Error(`migration digest mismatch: ${entry.name}`);
    }
    const statements = unstable_splitSqlQuery(entry.sql);
    if (statements.length === 0) {
      throw new Error(`schema migration ${entry.name} contains no SQL`);
    }
    // Apply each product migration atomically. D1 exec() does not support the
    // bundle's comments and multi-statement SQL consistently.
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }

  const actorApId = `${APP_ORIGIN}/ap/users/release-smoke`;
  await db
    .prepare(
      `INSERT INTO actors (
      ap_id, preferred_username, inbox, outbox, followers_url, following_url,
      public_key_pem, private_key_pem, post_count
    ) VALUES (?, 'release-smoke', ?, ?, ?, ?, 'fixture', 'fixture', 2)`,
    )
    .bind(
      actorApId,
      `${actorApId}/inbox`,
      `${actorApId}/outbox`,
      `${actorApId}/followers`,
      `${actorApId}/following`,
    )
    .run();

  const native = await worker.getWorker();
  for (const [label, queueName, expectedStatus, autoDlqAttempt, seedStatus] of [
    ["main-queue-fanout", DELIVERY_QUEUE, "completed", 0, "pending"],
    ["dlq-exhaustion", DELIVERY_DLQ, "failed", 3, "published"],
  ]) {
    const activityId = `${APP_ORIGIN}/ap/activities/${label}`;
    const fanoutId = sha256(`fanout|followers|${activityId}|${actorApId}|`);
    await db.batch([
      db
        .prepare(
          "INSERT INTO activities (ap_id, type, actor_ap_id, raw_json) VALUES (?, 'Create', ?, '{}')",
        )
        .bind(activityId, actorApId),
      db
        .prepare(
          `INSERT INTO delivery_fanouts (
          id, activity_ap_id, kind, target_ap_id, status, publications
        ) VALUES (?, ?, 'followers', ?, ?, 1)`,
        )
        .bind(fanoutId, activityId, actorApId, seedStatus),
    ]);

    const messageId = `release-smoke-${label}`;
    const result = await native.queue(queueName, [
      {
        id: messageId,
        timestamp: new Date(),
        attempts: 1,
        body: {
          version: 1,
          type: "fanout_followers",
          activityId,
          followeeApId: actorApId,
          ...(autoDlqAttempt === 0 ? {} : { autoDlqAttempt }),
          scheduledAt: new Date().toISOString(),
        },
      },
    ]);
    if (
      result.outcome !== "ok" ||
      result.retryBatch?.retry !== false ||
      result.retryMessages.length !== 0 ||
      !result.explicitAcks.includes(messageId)
    ) {
      throw new Error(
        `${label} was not explicitly acknowledged without retry: ${JSON.stringify(result)}`,
      );
    }

    const row = await db
      .prepare(
        "SELECT status, last_error, completed_at FROM delivery_fanouts WHERE id = ?",
      )
      .bind(fanoutId)
      .first();
    if (
      row?.status !== expectedStatus ||
      !row.completed_at ||
      (label === "dlq-exhaustion" &&
        (typeof row.last_error !== "string" || row.last_error.length === 0))
    ) {
      throw new Error(
        `${label} did not persist its ${expectedStatus} fanout result: ${JSON.stringify(row)}`,
      );
    }
  }

  const media = await worker.getR2Bucket("MEDIA");
  const stories = [
    { name: "expired", endTime: "2000-01-01T00:00:00.000Z" },
    { name: "active", endTime: "2999-01-01T00:00:00.000Z" },
  ];
  for (const story of stories) {
    const key = `uploads/release-smoke-${story.name}.webp`;
    await media.put(key, `release-smoke-${story.name}`);
    await db.batch([
      db
        .prepare(
          `INSERT INTO objects (
          ap_id, type, attributed_to, attachments_json, end_time
        ) VALUES (?, 'Story', ?, ?, ?)`,
        )
        .bind(
          `${APP_ORIGIN}/ap/objects/${story.name}`,
          actorApId,
          JSON.stringify([{ r2_key: key }]),
          story.endTime,
        ),
      db
        .prepare(
          `INSERT INTO media_uploads (
          id, r2_key, uploader_ap_id, content_type, size
        ) VALUES (?, ?, ?, 'image/webp', ?)`,
        )
        .bind(
          `release-smoke-${story.name}`,
          key,
          actorApId,
          `release-smoke-${story.name}`.length,
        ),
    ]);
  }

  // Repeat the actual native cron dispatch to prove cleanup is stable and the
  // expired Story's post count is decremented exactly once.
  for (let pass = 0; pass < 2; pass += 1) {
    const result = await native.scheduled({
      cron: "0 * * * *",
      scheduledTime: new Date(),
    });
    if (result.outcome !== "ok") {
      throw new Error(
        `scheduled retention did not complete: ${JSON.stringify(result)}`,
      );
    }
    for (const story of stories) {
      const key = `uploads/release-smoke-${story.name}.webp`;
      const storyId = `${APP_ORIGIN}/ap/objects/${story.name}`;
      const expectedPresent = story.name === "active";
      const object = await db
        .prepare("SELECT ap_id FROM objects WHERE ap_id = ?")
        .bind(storyId)
        .first();
      const upload = await db
        .prepare("SELECT id FROM media_uploads WHERE id = ?")
        .bind(`release-smoke-${story.name}`)
        .first();
      const blob = await media.get(key);
      if (
        Boolean(object) !== expectedPresent ||
        Boolean(upload) !== expectedPresent ||
        Boolean(blob) !== expectedPresent
      ) {
        throw new Error(
          `scheduled retention left the wrong ${story.name} Story/media state`,
        );
      }
      if (blob && (await blob.text()) !== `release-smoke-${story.name}`) {
        throw new Error("scheduled retention changed the active media bytes");
      }
    }
    const actor = await db
      .prepare("SELECT post_count FROM actors WHERE ap_id = ?")
      .bind(actorApId)
      .first();
    if (actor?.post_count !== 1) {
      throw new Error(
        `scheduled retention post_count is ${actor?.post_count}; expected 1`,
      );
    }
  }

  return {
    schemaSha256: `sha256:${sha256(schemaBytes)}`,
    migrationCount: schema.entries.length,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("release smoke response exceeded its byte limit");
        throw new Error(
          `release smoke response exceeds ${MAX_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function requireJson(response, label) {
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} did not return JSON: ${text.slice(0, 200)}`);
  }
}

async function smokeNativeWorker(
  artifactPath,
  artifactDigest,
  passwordFixture,
) {
  const sourceConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  if (!sourceConfig.compatibility_date) {
    throw new Error("wrangler.jsonc must declare compatibility_date");
  }
  const worker = new Miniflare({
    rootPath: dirname(artifactPath),
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: sourceConfig.compatibility_date,
    compatibilityFlags: sourceConfig.compatibility_flags,
    cf: false,
    bindings: {
      APP_URL: APP_ORIGIN,
      AUTH_PASSWORD_HASH: passwordFixture.hash,
      DELIVERY_QUEUE_NAME: DELIVERY_QUEUE,
      DELIVERY_DLQ_NAME: DELIVERY_DLQ,
      ENCRYPTION_KEY: "00".repeat(32),
      YURUCOMMU_SESSION_HASH_SALT: SESSION_HASH_SALT,
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["MEDIA"],
    queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
    // Keep Workerd diagnostics and deliberate dead-letter logs off the pure
    // JSON result stream.
    handleRuntimeStdio(stdout, stderr) {
      stdout.pipe(process.stderr, { end: false });
      stderr.pipe(process.stderr, { end: false });
    },
  });

  try {
    await worker.ready;
    // HTTP middleware can enqueue durable outbox work. Prepare and exercise
    // the product schema before any request reaches those background tasks.
    const background = await qualifyBackgroundEvents(worker);

    const readyResponse = await worker.dispatchFetch(`${APP_ORIGIN}/readyz`, {
      headers: { accept: "application/json" },
    });
    const ready = await requireJson(readyResponse, "/readyz");
    if (
      readyResponse.status !== 200 ||
      ready.status !== "ok" ||
      ready.service !== "yurucommu" ||
      !Array.isArray(ready.missingBindings) ||
      ready.missingBindings.length !== 0
    ) {
      throw new Error(
        `/readyz did not accept the runtime-native bindings: ${JSON.stringify(ready)}`,
      );
    }

    const discoveryResponse = await worker.dispatchFetch(
      `${APP_ORIGIN}/.well-known/yurucommu`,
      { headers: { accept: "application/json" } },
    );
    const discovery = await requireJson(
      discoveryResponse,
      "/.well-known/yurucommu",
    );
    // Compared against src/product-identity.ts rather than against literals
    // spelled again here: the identity has one home and this is the check that
    // the built bytes actually carry it. `product` names the family engine, so
    // it stays "yurucommu"; Yurumeet's own identity is `name`, `server.id`, and
    // the `yurume` client. A Worker that answered with the engine defaults is
    // exactly the failure that once broke every mobile connection.
    if (
      discoveryResponse.status !== 200 ||
      discovery.product !== PRODUCT_WIRE_IDENTITY.product ||
      discovery.name !== PRODUCT_WIRE_IDENTITY.name ||
      discovery.server?.id !== PRODUCT_WIRE_IDENTITY.serverId ||
      discovery.server?.name !== PRODUCT_WIRE_IDENTITY.serverName ||
      !discovery.clients?.some((client) => client.id === PRODUCT_CLIENT_KEY) ||
      discovery.server?.canonicalOrigin !== APP_ORIGIN
    ) {
      throw new Error(
        `discovery did not expose the expected identity: ${JSON.stringify(discovery)}`,
      );
    }

    const uiResponse = await worker.dispatchFetch(`${APP_ORIGIN}/`, {
      headers: { accept: "text/html" },
    });
    const ui = await boundedText(uiResponse);
    if (
      uiResponse.status !== 200 ||
      !uiResponse.headers.get("content-type")?.includes("text/html") ||
      !ui.includes("<title>Yurumeet") ||
      !ui.includes('id="root"')
    ) {
      throw new Error("embedded Yurumeet UI did not boot from the artifact");
    }

    const journeys = await qualifyProductJourneys(worker, {
      origin: APP_ORIGIN,
      password: TEST_PASSWORD,
      sessionSalt: SESSION_HASH_SALT,
      readJson: requireJson,
    });
    return {
      kind: "yurumeet.release-worker-smoke@v1",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      runtime: "workerd",
      compatibilityDate: sourceConfig.compatibility_date,
      compatibilityFlags: sourceConfig.compatibility_flags,
      substrate: "runtime-native-bindings",
      ...background,
      checks: [
        "readyz",
        "discovery",
        "embedded-ui",
        "main-queue-fanout",
        "dlq-exhaustion",
        "scheduled-story-retention",
        "scheduled-story-retention-idempotence",
        ...journeys.checks,
      ],
      status: "PASSED",
    };
  } finally {
    await worker.dispose();
  }
}

async function applyIdentityOnlySchema(db) {
  const schemaBytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(schemaBytes);
  if (
    schema.apiVersion !== "takosumi.resource-migrations/v1" ||
    schema.engine !== "sqlite" ||
    !Array.isArray(schema.entries) ||
    schema.entries.length === 0
  ) {
    throw new Error("session-salt smoke requires the product migration bundle");
  }
  for (const entry of schema.entries) {
    if (
      typeof entry.sql !== "string" ||
      entry.sha256 !== `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`
    ) {
      throw new Error("session-salt smoke migration digest mismatch");
    }
    const statements = unstable_splitSqlQuery(entry.sql);
    if (statements.length === 0) {
      throw new Error("session-salt smoke migration contains no SQL");
    }
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  return {
    schemaSha256: `sha256:${sha256(schemaBytes)}`,
    migrationCount: schema.entries.length,
  };
}

async function identityCounts(db) {
  const actors = await db
    .prepare("SELECT COUNT(*) AS count FROM actors")
    .first();
  const sessions = await db
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .first();
  return { actors: actors?.count ?? null, sessions: sessions?.count ?? null };
}

function createSaltQualificationWorker(artifactPath, config, salt, outbound) {
  const bindings = {
    APP_URL: APP_ORIGIN,
    AUTH_PASSWORD_HASH: PASSWORD_FIXTURES[0].hash,
    ENCRYPTION_KEY: "00".repeat(32),
  };
  if (salt !== undefined) {
    bindings.YURUCOMMU_SESSION_HASH_SALT = salt;
  }
  return new Miniflare({
    rootPath: dirname(artifactPath),
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    cf: false,
    routes: [APP_ORIGIN + "/*"],
    bindings,
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["MEDIA"],
    outboundService: async () => {
      outbound.blockedFetches++;
      return new Response(null, { status: 502 });
    },
  });
}

async function invokePasswordLogin(nativeWorker) {
  return nativeWorker.fetch(`${APP_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
}

async function qualifyRequiredSessionSalt(artifactPath) {
  const sourceConfig = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  if (!sourceConfig.compatibility_date) {
    throw new Error("wrangler.jsonc must declare compatibility_date");
  }
  const outbound = { blockedFetches: 0 };
  const checks = [];

  // This control starts with DDL only and lets the real password route create
  // its owner and salted session through the native Workerd Fetcher.
  let worker = createSaltQualificationWorker(
    artifactPath,
    sourceConfig,
    SESSION_HASH_SALT,
    outbound,
  );
  let schema;
  try {
    await worker.ready;
    const db = await worker.getD1Database("DB");
    schema = await applyIdentityOnlySchema(db);
    const before = await identityCounts(db);
    if (before.actors !== 0 || before.sessions !== 0) {
      throw new Error(
        "session-salt valid control did not start from empty identity tables",
      );
    }
    const native = await worker.getWorker();
    const response = await invokePasswordLogin(native);
    const responseText = await boundedText(response);
    let body;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error("session-salt valid control returned non-JSON");
    }
    const cookies = response.headers
      .getSetCookie()
      .filter((header) => header.trim().toLowerCase().startsWith("session="));
    const cookieValue = cookies[0]?.split(";", 1)[0]?.slice("session=".length);
    const actor = await db
      .prepare("SELECT ap_id, role FROM actors ORDER BY ap_id")
      .first();
    const session = await db
      .prepare("SELECT id, member_id, access_token, expires_at FROM sessions")
      .first();
    const after = await identityCounts(db);
    const rawSession = cookieValue ? decodeURIComponent(cookieValue) : "";
    const expectedSessionId = `sha256:${sha256(Buffer.from(`${SESSION_HASH_SALT}:${rawSession}`, "utf8"))}`;
    if (
      response.status !== 200 ||
      body?.success !== true ||
      cookies.length !== 1 ||
      rawSession.length === 0 ||
      actor?.ap_id !== `${APP_ORIGIN}/ap/users/tako` ||
      actor?.role !== "owner" ||
      after.actors !== 1 ||
      after.sessions !== 1 ||
      session?.id !== expectedSessionId ||
      session?.member_id !== actor.ap_id ||
      session?.access_token !== expectedSessionId ||
      !Number.isFinite(Date.parse(session?.expires_at ?? "")) ||
      Date.parse(session?.expires_at ?? "") <= Date.now()
    ) {
      throw new Error(
        "session-salt valid control did not persist its owner session",
      );
    }
    checks.push("required-session-salt-valid-control");
  } finally {
    await worker.dispose();
  }

  const invalidCases = [
    { name: "missing", value: undefined },
    { name: "blank", value: " \t" },
    { name: "public-fallback", value: PUBLIC_FALLBACK_SESSION_SALT },
  ];
  for (const item of invalidCases) {
    worker = createSaltQualificationWorker(
      artifactPath,
      sourceConfig,
      item.value,
      outbound,
    );
    try {
      await worker.ready;
      const db = await worker.getD1Database("DB");
      await applyIdentityOnlySchema(db);
      const before = await identityCounts(db);
      if (before.actors !== 0 || before.sessions !== 0) {
        throw new Error(`session-salt ${item.name} case did not start empty`);
      }
      const native = await worker.getWorker();
      let observedExactGuard = false;
      try {
        const response = await invokePasswordLogin(native);
        await response.body?.cancel();
      } catch (error) {
        observedExactGuard =
          error instanceof Error &&
          error.message === REQUIRED_SESSION_SALT_ERROR;
      }
      const after = await identityCounts(db);
      if (!observedExactGuard) {
        throw new Error(
          `session-salt ${item.name} case missed the native required-salt guard`,
        );
      }
      if (after.actors !== 0 || after.sessions !== 0) {
        throw new Error(
          `session-salt ${item.name} guard wrote owner or session rows`,
        );
      }
      checks.push(`required-session-salt-${item.name}-refusal`);
    } finally {
      await worker.dispose();
    }
  }
  if (outbound.blockedFetches !== 0) {
    throw new Error(
      "session-salt qualification attempted an external Worker fetch",
    );
  }
  return {
    status: "PASSED",
    schemaSha256: schema.schemaSha256,
    migrationCount: schema.migrationCount,
    validControl: "password-login-persisted-one-owner-and-salted-session",
    invalidCases: invalidCases.map(({ name }) => name),
    guardClass: "required-nondevelopment-session-salt",
    guardSource: "native-fetch-thrown-error-message",
    identityRowsAfterRefusal: { actors: 0, sessions: 0 },
    externalWorkerFetches: {
      policy: "denied-locally-by-miniflare-outbound-service",
      observedBlockedFetches: outbound.blockedFetches,
    },
    checks,
  };
}

async function main() {
  const [artifactArgument, expectedDigestArgument] = process.argv.slice(2);
  if (!artifactArgument || process.argv.length > 4) {
    throw new Error(
      "usage: bun scripts/smoke-release-worker.mjs <worker.js> [sha256:<digest>]",
    );
  }
  const artifactPath = resolve(process.cwd(), artifactArgument);
  if (!statSync(artifactPath).isFile()) {
    throw new Error(`${artifactArgument} is not a Worker artifact file`);
  }
  const artifactDigest = sha256(readFileSync(artifactPath));
  if (
    expectedDigestArgument !== undefined &&
    expectedDigestArgument !== `sha256:${artifactDigest}`
  ) {
    throw new Error(
      `artifact digest sha256:${artifactDigest} does not equal ${expectedDigestArgument}`,
    );
  }
  const results = [];
  for (const fixture of PASSWORD_FIXTURES) {
    // Separate disposable bindings; both auth paths must pass on these bytes.
    results.push(
      await smokeNativeWorker(artifactPath, artifactDigest, fixture),
    );
  }
  const sessionSaltGuard = await qualifyRequiredSessionSalt(artifactPath);
  process.stdout.write(
    `${JSON.stringify({
      ...results[0],
      sessionSaltGuard,
      checks: [...results[0].checks, ...sessionSaltGuard.checks],
      authentication: {
        passwordMethods: PASSWORD_FIXTURES.map((fixture) => fixture.method),
        actor: "preexisting-fixture-owner",
        revocation: "salted SQL disappearance and replay refusal",
      },
    })}\n`,
  );
}

await main();
