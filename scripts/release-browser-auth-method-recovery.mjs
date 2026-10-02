import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import {
  createBrowserOidcErrorIssuer,
  qualifyBrowserOidcRecovery,
} from "./release-browser-oidc.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_SALT = "meet-auth-recovery-session-salt-fixture";
const ENCRYPTION_KEY = "00".repeat(32);
const ROUTE_TIMEOUT_MS = 12_000;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function requireEffect(condition, reason) {
  if (!condition) throw new Error(`meet-auth-recovery:${reason}`);
}
async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  requireEffect(
    address && typeof address === "object",
    "loopback-port-allocation-failed",
  );
  await new Promise((ok, fail) =>
    server.close((error) => (error ? fail(error) : ok())),
  );
  return address.port;
}
async function applySchema(worker) {
  const bytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(bytes.toString("utf8"));
  requireEffect(
    schema.apiVersion === "takosumi.resource-migrations/v1" &&
      schema.engine === "sqlite" &&
      Array.isArray(schema.entries) &&
      schema.entries.length > 0,
    "product-schema-bundle-invalid",
  );
  const db = await worker.getD1Database("DB");
  for (const entry of schema.entries) {
    requireEffect(
      typeof entry.sql === "string" &&
        entry.sha256 === `sha256:${sha256(Buffer.from(entry.sql, "utf8"))}`,
      `migration-digest-mismatch-${entry.name}`,
    );
    const statements = unstable_splitSqlQuery(entry.sql);
    requireEffect(statements.length > 0, `migration-empty-${entry.name}`);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  const counts = await identityCounts(db);
  requireEffect(
    counts.actors === 0 && counts.sessions === 0,
    "fresh-store-not-empty",
  );
  return {
    db,
    schemaSha256: `sha256:${sha256(bytes)}`,
    migrationCount: schema.entries.length,
  };
}
async function identityCounts(db) {
  const [actors, sessions] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM actors").first(),
    db.prepare("SELECT COUNT(*) AS count FROM sessions").first(),
  ]);
  return {
    actors: Number(actors?.count ?? -1),
    sessions: Number(sessions?.count ?? -1),
  };
}
function makeWorker(
  artifactPath,
  origin,
  config,
  { bindings = {}, outboundService } = {},
) {
  let runtimeDiagnosticBytes = 0;
  const worker = new Miniflare({
    rootPath: dirname(artifactPath),
    modules: [{ type: "ESModule", path: artifactPath }],
    modulesRoot: dirname(artifactPath),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    host: "127.0.0.1",
    port: Number(new URL(origin).port),
    cf: false,
    bindings: {
      APP_URL: origin,
      YURUCOMMU_SESSION_HASH_SALT: SESSION_SALT,
      DELIVERY_QUEUE_NAME: "meet-auth-recovery-delivery",
      DELIVERY_DLQ_NAME: "meet-auth-recovery-dlq",
      ENCRYPTION_KEY,
      ...bindings,
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["MEDIA"],
    queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
    ...(outboundService ? { outboundService } : {}),
    handleRuntimeStdio(stdout, stderr) {
      for (const stream of [stdout, stderr]) {
        stream.on("data", (chunk) => {
          runtimeDiagnosticBytes = Math.min(
            Number.MAX_SAFE_INTEGER,
            runtimeDiagnosticBytes + chunk.length,
          );
        });
        stream.resume();
      }
    },
  });
  worker.runtimeDiagnosticBytes = () => runtimeDiagnosticBytes;
  return worker;
}
async function providerRetryLane({
  artifactPath,
  artifactDigest,
  browser,
  config,
}) {
  const origin = `http://127.0.0.1:${await freeLoopbackPort()}`;
  const issuer = await createBrowserOidcErrorIssuer({ origin });
  let outboundRequests = 0;
  const worker = makeWorker(artifactPath, origin, config, {
    bindings: {
      ...issuer.bindings,
      AUTH_PASSWORD_HASH: "meet-provider-recovery-fixture",
    },
    outboundService: async () => {
      outboundRequests += 1;
      return new Response(null, { status: 502 });
    },
  });
  let context;
  let primaryError;
  let cleanupFailure = false;
  try {
    await worker.ready;
    const { db, schemaSha256, migrationCount } = await applySchema(worker);
    context = await browser.newContext({
      locale: "ja-JP",
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    let providerReads = 0;
    let failedRequestAborted = false;
    let pageErrors = 0;
    page.on("pageerror", () => {
      pageErrors += 1;
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      let url;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort();
        return;
      }
      if (url.origin !== origin) {
        await route.abort();
        return;
      }
      if (
        url.pathname === "/api/auth/providers" &&
        request.method() === "GET"
      ) {
        providerReads += 1;
        if (providerReads === 1) {
          failedRequestAborted = true;
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: ROUTE_TIMEOUT_MS,
    });
    const password = page.locator('input[type="password"]');
    const alert = page.getByRole("alert");
    const failureText =
      "認証方法を取得できませんでした。接続を確認して再試行してください。";
    await alert.waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
    const retry = page.getByRole("button", { name: "再試行", exact: true });
    requireEffect(
      failedRequestAborted && providerReads === 1,
      "provider-read-was-not-aborted-before-retry",
    );
    requireEffect(
      (await alert.innerText()).trim() === failureText,
      "provider-read-error-alert-mismatch",
    );
    requireEffect(
      await retry.isVisible(),
      "provider-read-manual-retry-not-visible",
    );
    requireEffect(
      !(await password.isVisible()),
      "password-input-visible-before-valid-retry",
    );
    requireEffect(
      (await page.locator('input[type="password"]').count()) === 0,
      "password-input-exists-before-valid-retry",
    );
    const beforeRetry = await identityCounts(db);
    requireEffect(
      beforeRetry.actors === 0 && beforeRetry.sessions === 0,
      "provider-read-failure-created-identity-state",
    );
    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url() === `${origin}/api/auth/providers` &&
          candidate.status() === 200,
        { timeout: ROUTE_TIMEOUT_MS },
      ),
      retry.click(),
    ]);
    const providers = await response.json();
    requireEffect(
      providerReads === 2,
      "manual-retry-did-not-read-real-route-once",
    );
    requireEffect(
      providers.password_enabled === true &&
        Array.isArray(providers.providers) &&
        providers.providers.length === 1 &&
        providers.providers[0]?.id === "takos",
      "manual-retry-did-not-use-real-password-enabled-provider-config",
    );
    await page
      .locator('a[href$="/api/auth/login/takos"]')
      .waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
    await password.waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
    requireEffect(
      (await password.count()) === 1,
      "password-input-missing-after-valid-password-enabled-retry",
    );
    requireEffect(
      (await alert.count()) === 0,
      "provider-read-alert-remained-after-recovery",
    );
    requireEffect(pageErrors === 0, "provider-recovery-page-error");
    const finalCounts = await identityCounts(db);
    requireEffect(
      finalCounts.actors === 0 && finalCounts.sessions === 0,
      "provider-retry-created-identity-state",
    );
    requireEffect(
      outboundRequests === 0,
      "provider-recovery-worker-attempted-outbound-fetch",
    );
    return {
      kind: "yurumeet.release-browser-auth-method-recovery@v1",
      lane: "provider",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      browser: browser.version(),
      schemaSha256,
      migrationCount,
      providerReads,
      runtimeDiagnosticBytes: worker.runtimeDiagnosticBytes(),
      externalWorkerFetches: { denied: true, attempted: outboundRequests },
      firstProviderRead: "aborted-before-worker",
      countsBeforeRetry: beforeRetry,
      finalCounts,
      checks: [
        "provider-read-aborted-before-worker",
        "required-visible-provider-error",
        "required-manual-retry",
        "no-password-input-before-valid-retry",
        "empty-identity-store-before-retry",
        "retry-uses-real-native-password-enabled-route",
        "empty-identity-store-after-retry",
      ],
      status: "PASSED",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await context?.close();
    } catch {
      cleanupFailure = true;
    }
    try {
      await worker.dispose();
    } catch {
      cleanupFailure = true;
    }
    try {
      await issuer.close();
    } catch {
      cleanupFailure = true;
    }
    if (cleanupFailure) {
      if (primaryError)
        process.stderr.write(
          "meet-auth-recovery:provider-secondary-cleanup-failure\n",
        );
      else throw new Error("meet-auth-recovery:provider-cleanup-failure");
    }
  }
}
async function oidcLane({ artifactPath, artifactDigest, browser, config }) {
  const origin = `http://127.0.0.1:${await freeLoopbackPort()}`;
  const issuer = await createBrowserOidcErrorIssuer({ origin });
  let outboundRequests = 0;
  const worker = makeWorker(artifactPath, origin, config, {
    bindings: issuer.bindings,
    outboundService: async () => {
      outboundRequests += 1;
      return new Response(null, { status: 502 });
    },
  });
  let primaryError;
  let cleanupFailures = [];
  let result;
  try {
    await worker.ready;
    const { db, schemaSha256, migrationCount } = await applySchema(worker);
    const checks = [];
    const recovery = await qualifyBrowserOidcRecovery({
      browser,
      worker,
      db,
      origin,
      issuer,
      checks,
    });
    requireEffect(outboundRequests === 0, "worker-attempted-outbound-fetch");
    result = {
      ...recovery,
      lane: "oidc",
      artifact: basename(artifactPath),
      sha256: `sha256:${artifactDigest}`,
      schemaSha256,
      migrationCount,
      externalWorkerFetches: { denied: true, attempted: outboundRequests },
      status: "PASSED",
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const [label, close] of [
      ["worker", () => worker.dispose()],
      ["issuer", () => issuer.close()],
    ]) {
      try {
        await close();
      } catch {
        cleanupFailures.push(label);
      }
    }
  }
  if (primaryError) {
    if (cleanupFailures.length)
      process.stderr.write(
        "meet-auth-recovery:oidc-secondary-cleanup-failure\n",
      );
    throw primaryError;
  }
  requireEffect(cleanupFailures.length === 0, "oidc-cleanup-failure");
  return result;
}

/** Uses the caller's one Chrome lifetime; each auth policy has isolated local storage. */
export async function qualifyBrowserAuthMethodRecovery({
  artifactPath,
  artifactDigest,
  browser,
  config,
}) {
  const provider = await providerRetryLane({
    artifactPath,
    artifactDigest,
    browser,
    config,
  });
  const oidc = await oidcLane({
    artifactPath,
    artifactDigest,
    browser,
    config,
  });
  return {
    provider,
    oidc,
    checks: [...provider.checks, ...oidc.checks],
    status: "PASSED",
  };
}
