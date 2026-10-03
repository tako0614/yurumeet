#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { Miniflare } from "miniflare";
import { unstable_readConfig, unstable_splitSqlQuery } from "wrangler";
import { qualifyBrowserTalk } from "./release-browser-talk.mjs";
import { qualifyBrowserCommunityDeletePreview } from "./release-browser-community-delete-preview.mjs";
import { qualifyBrowserAuthMethodRecovery } from "./release-browser-auth-method-recovery.mjs";
import { qualifyBrowserDraftStorage } from "./release-browser-draft-storage.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const password = " browser-smoke-only ";
const salt = "browser-smoke-session-salt-fixture";
const key = "00".repeat(32);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const check = (condition, reason) => {
  if (!condition) throw new Error(`release-browser ${reason}`);
};

function chromePath() {
  const configured = process.env.BROWSER_SMOKE_CHROME;
  if (configured) {
    try {
      check(
        statSync(configured).isFile(),
        "BROWSER_SMOKE_CHROME is not a file",
      );
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      throw new Error("release-browser BROWSER_SMOKE_CHROME is not executable");
    }
  }
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  ].filter(Boolean)) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking through installed system browsers.
    }
  }
  throw new Error(
    "release-browser requires installed Chrome; set BROWSER_SMOKE_CHROME",
  );
}

async function port() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const address = server.address();
  check(
    address && typeof address === "object",
    "could not allocate a loopback port",
  );
  await new Promise((ok, fail) =>
    server.close((error) => (error ? fail(error) : ok())),
  );
  return address.port;
}

async function rows(db) {
  const actors = await db
    .prepare("SELECT COUNT(*) AS count FROM actors")
    .first();
  const sessions = await db
    .prepare("SELECT COUNT(*) AS count FROM sessions")
    .first();
  return { actors: actors?.count, sessions: sessions?.count };
}

async function migrate(worker) {
  const bytes = readFileSync(
    resolve(repo, "deploy/takoform/migrations/schema-bundle.json"),
  );
  const schema = JSON.parse(bytes);
  check(
    schema.apiVersion === "takosumi.resource-migrations/v1" &&
      schema.engine === "sqlite" &&
      Array.isArray(schema.entries) &&
      schema.entries.length > 0,
    "requires a non-empty SQLite product migration bundle",
  );
  const db = await worker.getD1Database("DB");
  for (const entry of schema.entries) {
    check(
      typeof entry.sql === "string" &&
        entry.sha256 === `sha256:${hash(Buffer.from(entry.sql))}`,
      `migration digest mismatch: ${entry.name}`,
    );
    const statements = unstable_splitSqlQuery(entry.sql);
    check(statements.length > 0, `migration contains no SQL: ${entry.name}`);
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  const initial = await rows(db);
  check(
    initial.actors === 0 && initial.sessions === 0,
    "fresh migrated store contains an actor or session",
  );
  return {
    db,
    schemaSha256: `sha256:${hash(bytes)}`,
    migrationCount: schema.entries.length,
  };
}

async function signedIn(page, origin) {
  await page
    .getByText("まだトークはありません", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await page
    .getByText("トークを選ぶと会話が表示されます", { exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  return page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/auth/me`, {
      credentials: "include",
    });
    const body = await response.json();
    return {
      status: response.status,
      apId: body.actor?.ap_id,
      role: body.actor?.role,
      provider: body.provider,
      hasAccess: body.has_takos_access,
    };
  }, origin);
}

async function smoke(artifact, digest) {
  const config = unstable_readConfig(
    { config: resolve(repo, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  check(
    Boolean(config.compatibility_date),
    "wrangler.jsonc lacks compatibility_date",
  );
  const appPort = await port();
  const origin = `http://127.0.0.1:${appPort}`;
  const worker = new Miniflare({
    rootPath: dirname(artifact),
    modules: [{ type: "ESModule", path: artifact }],
    modulesRoot: dirname(artifact),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    host: "127.0.0.1",
    port: appPort,
    cf: false,
    bindings: {
      APP_URL: origin,
      AUTH_PASSWORD_HASH: password,
      DELIVERY_QUEUE_NAME: "yurumeet-browser-smoke-delivery",
      DELIVERY_DLQ_NAME: "yurumeet-browser-smoke-dlq",
      ENCRYPTION_KEY: key,
      YURUCOMMU_SESSION_HASH_SALT: salt,
    },
    d1Databases: ["DB"],
    kvNamespaces: ["KV"],
    r2Buckets: ["MEDIA"],
    queueProducers: ["DELIVERY_QUEUE", "DELIVERY_DLQ"],
    handleRuntimeStdio(stdout, stderr) {
      stdout.pipe(process.stderr, { end: false });
      stderr.pipe(process.stderr, { end: false });
    },
  });
  let browser;
  let context;
  let result;
  let failed = false;
  const pageErrors = [];
  const serverErrors = [];
  try {
    await worker.ready;
    const { db, schemaSha256, migrationCount } = await migrate(worker);
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      locale: "ja-JP",
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.on("pageerror", () => pageErrors.push("pageerror"));
    page.on("response", (response) => {
      if (response.status() >= 500) {
        try {
          serverErrors.push({
            path: new URL(response.url()).pathname,
            status: response.status(),
          });
        } catch {
          serverErrors.push({ path: "invalid-response-url", status: 500 });
        }
      }
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.protocol === "data:" ||
        url.protocol === "blob:" ||
        url.origin === origin
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });

    const input = page.locator('input[type="password"]');
    await input.waitFor({ state: "visible", timeout: 15000 });
    const labels = await input.evaluate((element) =>
      Array.from(element.labels ?? [])
        .filter(
          (label) =>
            label.getClientRects().length > 0 &&
            getComputedStyle(label).visibility !== "hidden" &&
            getComputedStyle(label).display !== "none",
        )
        .map((label) => label.textContent?.trim() ?? ""),
    );
    const submit = page.locator('form button[type="submit"]');
    check(await submit.isDisabled(), "blank password submit was not disabled");
    const checks = ["browser-blank-submit-disabled"];

    await input.fill(`${password}-incorrect`);
    const wrongWait = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/login" &&
        response.request().method() === "POST",
      { timeout: 15000 },
    );
    await submit.click();
    const wrong = await wrongWait;
    check(wrong.status() === 401, "wrong password was not refused");
    const afterWrong = await rows(db);
    check(
      afterWrong.actors === 0 && afterWrong.sessions === 0,
      "wrong password created an actor or session",
    );
    const failure = "ログインできませんでした。";
    const error = page.locator(".p-connect-error").filter({ hasText: failure });
    await error.waitFor({ state: "visible", timeout: 10000 });
    const failureText = await error.first().textContent();
    const alertCount = await page.getByRole("alert").count();
    const failureSemantics = await error.first().evaluate((node) => {
      const field = document.querySelector('input[type="password"]');
      const descriptions = (field?.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      return {
        role: node.getAttribute("role"),
        invalid: field?.getAttribute("aria-invalid"),
        linked: descriptions.some((id) => document.getElementById(id) === node),
      };
    });
    check(
      failureText?.trim() === failure,
      "wrong password did not show the expected failure message",
    );
    checks.push("browser-invalid-password-refused-without-persistence");

    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await input.fill(password);
    const loginWait = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/login" &&
        response.request().method() === "POST",
      { timeout: 15000 },
    );
    const navigationWait = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame === page.mainFrame(),
      timeout: 15000,
    });
    await submit.click();
    const login = await loginWait;
    const wirePassword = login.request().postDataJSON()?.password;
    check(
      login.status() === 200 && wirePassword === password,
      "valid login failed or altered the opaque password",
    );
    await navigationWait;
    await input.waitFor({ state: "hidden", timeout: 15000 });
    check(navigations > 0, "successful login did not reload the product page");
    checks.push("browser-password-login-reloads-product-ui");

    const ownerId = `${origin}/ap/users/tako`;
    const me = await signedIn(page, origin);
    const counts = await rows(db);
    const owner = await db
      .prepare(
        "SELECT ap_id, takos_user_id, role, owner_actor_ap_id, deleted_at FROM actors WHERE ap_id = ?",
      )
      .bind(ownerId)
      .first();
    const cookie = (await context.cookies(origin)).find(
      (item) => item.name === "session",
    );
    const sessionId =
      cookie && `sha256:${hash(Buffer.from(`${salt}:${cookie.value}`))}`;
    const session =
      sessionId &&
      (await db
        .prepare(
          "SELECT id, member_id, access_token, expires_at, provider, provider_access_token, provider_refresh_token, provider_token_expires_at FROM sessions WHERE id = ?",
        )
        .bind(sessionId)
        .first());
    check(
      me.status === 200 &&
        me.apId === ownerId &&
        me.role === "owner" &&
        me.provider === null &&
        me.hasAccess === false &&
        counts.actors === 1 &&
        counts.sessions === 1 &&
        owner?.takos_user_id === "password:owner" &&
        owner.role === "owner" &&
        owner.owner_actor_ap_id === null &&
        owner.deleted_at === null &&
        cookie &&
        session?.id === sessionId &&
        session.member_id === ownerId &&
        session.access_token === sessionId &&
        session.provider === null &&
        session.provider_access_token === null &&
        session.provider_refresh_token === null &&
        session.provider_token_expires_at === null &&
        Number.isFinite(Date.parse(session.expires_at)) &&
        Date.parse(session.expires_at) > Date.now(),
      "browser session did not persist exactly one local owner and salted credential",
    );
    checks.push("browser-owner-session-persisted-with-salted-id");
    check(
      labels.length === 1 && labels[0] === "パスワード",
      "password input lacks one visible associated パスワード label",
    );
    checks.push("browser-password-input-has-visible-associated-label");
    check(
      alertCount === 1,
      "password refusal did not expose exactly one alert role",
    );
    checks.push("browser-password-refusal-has-one-alert");
    check(
      failureSemantics.role === "alert" &&
        failureSemantics.invalid === "true" &&
        failureSemantics.linked,
      "visible password refusal is not an alert linked to the invalid input",
    );
    checks.push("browser-password-refusal-linked-to-invalid-input");

    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
    const refreshed = await signedIn(page, origin);
    check(
      refreshed.status === 200 &&
        refreshed.apId === ownerId &&
        refreshed.role === "owner" &&
        refreshed.provider === null &&
        refreshed.hasAccess === false &&
        !(await page.locator('input[type="password"]').isVisible()),
      "browser refresh lost the persisted signed-in owner",
    );
    checks.push("browser-refresh-keeps-signed-in-owner");
    await page.setViewportSize({ width: 390, height: 844 });
    const width = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    check(
      width.content <= width.viewport,
      "390px signed-in view has horizontal overflow",
    );
    checks.push("browser-mobile-layout-has-no-horizontal-overflow");
    const talk = await qualifyBrowserTalk({
      page,
      worker,
      db,
      origin,
      actorApId: ownerId,
      checks,
    });
    const communityDeletePreview = await qualifyBrowserCommunityDeletePreview({
      page,
      db,
      origin,
      actorApId: ownerId,
      checks,
    });
    check(pageErrors.length === 0, "browser page raised a runtime error");
    check(
      serverErrors.length === 0,
      "artifact returned an unexpected HTTP 5xx response",
    );
    checks.push("browser-page-errors-and-http-5xx-absent");
    const authMethodRecovery = await qualifyBrowserAuthMethodRecovery({
      artifactPath: artifact,
      artifactDigest: digest,
      browser,
      config,
    });
    checks.push(...authMethodRecovery.checks);
    const draftStorage = await qualifyBrowserDraftStorage({
      page,
      db,
      origin,
      actorApId: ownerId,
      checks,
    });
    check(
      pageErrors.length === 0,
      "draft storage browser raised a runtime error",
    );
    check(
      serverErrors.length === 0,
      "draft storage artifact returned HTTP 5xx",
    );
    result = {
      kind: "yurumeet.release-browser-smoke@v1",
      artifact: basename(artifact),
      sha256: `sha256:${digest}`,
      browser: browser.version(),
      runtime: "workerd",
      substrate: "local-http-native-d1-kv-r2",
      schemaSha256,
      migrationCount,
      talk,
      communityDeletePreview,
      authMethodRecovery,
      draftStorage,
      checks,
      status: "PASSED",
    };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    for (const close of [
      () => context?.close(),
      () => browser?.close(),
      () => worker.dispose(),
    ]) {
      try {
        await close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      if (failed) process.stderr.write("release-browser cleanup also failed\n");
      else throw new Error("release-browser cleanup failed");
    }
  }
  return result;
}

async function main() {
  const [argument, expected] = process.argv.slice(2);
  if (!argument || process.argv.length > 4)
    throw new Error(
      "usage: bun scripts/smoke-release-browser.mjs <artifact.js> [sha256:<digest>]",
    );
  const artifact = resolve(process.cwd(), argument);
  check(statSync(artifact).isFile(), "artifact argument is not a file");
  const digest = hash(readFileSync(artifact));
  if (expected !== undefined)
    check(
      expected === `sha256:${digest}`,
      "artifact digest does not match the expected digest",
    );
  process.stdout.write(`${JSON.stringify(await smoke(artifact, digest))}\n`);
}

await main();
