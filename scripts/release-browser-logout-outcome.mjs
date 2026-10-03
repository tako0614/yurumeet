import { createHash, webcrypto } from "node:crypto";

const TIMEOUT = 20_000;
const RATE_WAIT_MAX = 60_000;
const PASSWORD = "local-yurumeet-logout-outcome-fixture";

function need(ok, label) {
  if (!ok) throw new Error(`yurumeet-logout-outcome:${label}`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sessionKey(cookie, salt) {
  const bytes = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${cookie}`),
  );
  return `sha256:${Buffer.from(bytes).toString("hex")}`;
}

async function bounded(promise, label, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`yurumeet-logout-outcome:${label}-timeout`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function rateCapacity(page, origin) {
  const deadline = Date.now() + RATE_WAIT_MAX;
  let waited = false;
  let waitMs = 0;
  while (true) {
    const response = await page.request.get(`${origin}/api/auth/providers`, {
      timeout: TIMEOUT,
    });
    const remaining = Number(response.headers()["x-ratelimit-remaining"]);
    const reset = Number(response.headers()["x-ratelimit-reset"]);
    const limit = Number(response.headers()["x-ratelimit-limit"]);
    need(
      Number.isFinite(remaining) &&
        Number.isFinite(reset) &&
        limit === 20 &&
        remaining >= 0 &&
        remaining <= limit &&
        reset > 0,
      "public-auth-rate-limit-shape",
    );
    if (response.status() !== 429) {
      need(response.status() === 200, "readonly-auth-provider-capacity-read");
      // Start each independent browser lane with a fresh public auth window.
      // No KV reset or speculative login is used to obtain capacity.
      if (remaining >= 19) return { remaining, resetAt: reset, waitMs };
    }
    need(!waited, "single-readonly-provider-retry-confirms-fresh-window");
    const now = Date.now();
    const untilReset = Math.max(1, reset * 1000 - now);
    // Core rounds resetAt up to an integer second. A valid 60 s window can
    // therefore advertise a slightly later ceiling. Cap the wait at 60 s and
    // require the second read to prove fresh capacity; never reset KV or limits.
    need(
      untilReset <= RATE_WAIT_MAX + 1_000 && deadline > now,
      "public-reset-within-one-window-and-rounding-ceiling",
    );
    waitMs = Math.min(untilReset, deadline - now);
    need(
      waitMs > 0 && waitMs <= RATE_WAIT_MAX,
      "bounded-wait-for-auth-rate-window",
    );
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function completeSessionRows(db) {
  const result = await db
    .prepare(
      "SELECT id, member_id, access_token, refresh_token, expires_at, created_at, provider, provider_access_token, provider_refresh_token, provider_token_expires_at FROM sessions ORDER BY id",
    )
    .all();
  const rows = result.results ?? [];
  return { count: rows.length, sha256: sha(JSON.stringify(rows)), rows };
}

async function readAuth(page, origin) {
  const response = await page.request.get(`${origin}/api/auth/me`, {
    timeout: TIMEOUT,
  });
  let actorApId = null;
  if (response.status() === 200)
    actorApId = (await response.json()).actor?.ap_id ?? null;
  return { status: response.status(), actorApId };
}

function observe(page, origin) {
  const events = {
    logoutPosts: 0,
    oidcStarts: 0,
    callbacks: 0,
    pageErrors: 0,
    documents: [],
    expectedLogout503: 0,
    unexpectedFiveHundreds: [],
  };
  page.on("request", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (request.method() === "POST" && url.pathname === "/api/auth/logout")
      events.logoutPosts += 1;
    if (
      request.method() === "GET" &&
      /^\/api\/auth\/login(?:\/|$)/.test(url.pathname)
    )
      events.oidcStarts += 1;
    if (/^\/api\/auth\/callback(?:\/|$)/.test(url.pathname))
      events.callbacks += 1;
    if (request.isNavigationRequest() && request.resourceType() === "document")
      events.documents.push(url.pathname);
  });
  page.on("pageerror", () => {
    events.pageErrors += 1;
  });
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 500) {
        if (url.pathname === "/api/auth/logout" && response.status() === 503)
          events.expectedLogout503 += 1;
        else
          events.unexpectedFiveHundreds.push({
            path: url.pathname,
            status: response.status(),
          });
      }
    } catch {}
  });
  return events;
}

async function loginFreshOwner({
  browser,
  worker,
  db,
  origin,
  password,
  sessionSalt,
  caller,
}) {
  const context = await browser.newContext({
    locale: "ja-JP",
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  let blockedOutbound = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["data:", "blob:"].includes(url.protocol) || url.origin === origin)
      return route.continue();
    blockedOutbound += 1;
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  const events = observe(page, origin);
  const rateWindow = await rateCapacity(page, origin);
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: TIMEOUT });
  await passwordInput.fill(password);
  const loginResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === "/api/auth/login" &&
        response.request().method() === "POST"
      );
    },
    { timeout: TIMEOUT },
  );
  await passwordInput.press("Enter");
  const loginResponse = await loginResponsePromise;
  need(
    loginResponse.status() === 200,
    `${caller}-single-password-login-succeeded`,
  );
  await passwordInput.waitFor({ state: "hidden", timeout: TIMEOUT });
  await page.goto(`${origin}/settings`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  const me = await readAuth(page, origin);
  need(
    me.status === 200 && typeof me.actorApId === "string",
    `${caller}-authenticated-same-owner-read`,
  );
  const actorRow = await db
    .prepare("SELECT ap_id, role, deleted_at FROM actors WHERE ap_id = ?")
    .bind(me.actorApId)
    .first();
  need(
    actorRow?.ap_id === me.actorApId &&
      actorRow.role === "owner" &&
      actorRow.deleted_at == null,
    `${caller}-root-owner-row`,
  );
  const jar = await context.cookies(origin);
  const cookie = jar.find((item) => item.name === "session");
  need(Boolean(cookie?.value), `${caller}-session-cookie-issued`);
  const expectedId = await sessionKey(cookie.value, sessionSalt);
  const ownSession = await db
    .prepare(
      "SELECT id, member_id, access_token, refresh_token, expires_at, created_at, provider, provider_access_token, provider_refresh_token, provider_token_expires_at FROM sessions WHERE id = ? AND member_id = ?",
    )
    .bind(expectedId, me.actorApId)
    .first();
  need(ownSession?.id === expectedId, `${caller}-salted-cookie-row-match`);
  const rows = await completeSessionRows(db);
  need(rows.count >= 1, `${caller}-native-session-rows-present`);
  return {
    context,
    page,
    events,
    blockedOutbound: () => blockedOutbound,
    actorApId: me.actorApId,
    cookie: cookie.value,
    expectedId,
    ownSession,
    initialRows: rows,
    rateWindow,
  };
}

async function initiateSettingsLogout(
  fixture,
  interceptMode,
  { profileMenu = false } = {},
) {
  const { page, events } = fixture;
  let intercepted = 0;
  let routeRelease;
  let routeEnteredResolve;
  const routeEntered = new Promise((resolve) => {
    routeEnteredResolve = resolve;
  });
  const held = new Promise((resolve) => {
    routeRelease = resolve;
  });
  await page.route("**/api/auth/logout", async (route) => {
    const request = route.request();
    need(
      request.method() === "POST" &&
        new URL(request.url()).origin === new URL(page.url()).origin,
      "only-local-logout-post-intercepted",
    );
    intercepted += 1;
    if (interceptMode === "503" && intercepted === 1) {
      routeEnteredResolve();
      await held;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
      return;
    }
    if (interceptMode === "ack-loss") {
      const upstream = await fetch(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT),
      });
      const responseBytes = Buffer.from(await upstream.arrayBuffer());
      const after = await completeSessionRows(fixture.db);
      need(
        upstream.status === 200 && responseBytes.length > 0,
        "ack-loss-real-worker-200-consumed",
      );
      need(
        !after.rows.some((row) => row.id === fixture.expectedId),
        "ack-loss-session-row-revoked-before-browser-drop",
      );
      fixture.committed = {
        status: upstream.status,
        responseBodyBytes: responseBytes.length,
        responseBodySha256: sha(responseBytes),
        ownSessionAbsent: true,
      };
      routeEnteredResolve();
      return route.abort("failed");
    }
    return route.continue();
  });
  const responsePromise =
    interceptMode === "ack-loss"
      ? null
      : page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "POST" &&
              url.pathname === "/api/auth/logout"
            );
          },
          { timeout: TIMEOUT },
        );
  if (profileMenu) {
    const more = page.getByRole("button", { name: "その他" });
    await more.waitFor({ state: "visible", timeout: TIMEOUT });
    await more.click({ timeout: TIMEOUT });
    await page
      .getByRole("menuitem", { name: "ログアウト" })
      .click({ timeout: TIMEOUT });
  } else {
    const logout = page.getByRole("button", { name: "ログアウト" });
    await logout.waitFor({ state: "visible", timeout: TIMEOUT });
    await logout.click({ timeout: TIMEOUT });
  }
  const dialog = page.getByRole("alertdialog", { name: "ログアウト" });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  await dialog
    .getByRole("button", { name: "ログアウト" })
    .click({ timeout: TIMEOUT });
  return {
    responsePromise,
    intercepted: () => intercepted,
    routeEntered,
    release: routeRelease,
  };
}

async function runFailedThenRetry({
  fixture,
  db,
  origin,
  checks,
  caller,
  profileMenu = false,
}) {
  fixture.db = db;
  const initialDocuments = fixture.events.documents.length;
  const operation = await initiateSettingsLogout(fixture, "503", {
    profileMenu,
  });
  await bounded(operation.routeEntered, `${caller}-logout-busy-entered`);
  await fixture.page
    .getByText("ログアウトの結果を確認しています…", { exact: true })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  need(
    (await fixture.page
      .getByRole("alertdialog", { name: "ログアウト" })
      .count()) === 0,
    `${caller}-confirmation-settled-before-post`,
  );
  operation.release();
  need(
    (await operation.responsePromise).status() === 503,
    `${caller}-one-fixed-503`,
  );
  await fixture.page
    .getByRole("alert")
    .getByText(
      /ログアウトできませんでした。現在もログインしています。もう一度ログアウトしてください。/,
      { exact: true },
    )
    .waitFor({ state: "visible", timeout: TIMEOUT });
  const retry = fixture.page.getByRole("button", {
    name: "もう一度ログアウト",
    exact: true,
  });
  await retry.waitFor({ state: "visible", timeout: TIMEOUT });
  need(await retry.isEnabled(), `${caller}-global-retry-enabled`);
  need(
    fixture.events.logoutPosts === 1,
    `${caller}-single-post-during-failure`,
  );
  need(
    fixture.events.expectedLogout503 === 1,
    `${caller}-one-expected-503-response`,
  );
  need(
    fixture.events.documents.length === initialDocuments,
    `${caller}-no-document-reload-after-503`,
  );
  const auth = await readAuth(fixture.page, origin);
  const oldCookie = await fixture.page.request.get(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${fixture.cookie}` },
    timeout: TIMEOUT,
  });
  const afterFailure = await completeSessionRows(db);
  need(
    auth.status === 200 &&
      auth.actorApId === fixture.actorApId &&
      oldCookie.status() === 200,
    `${caller}-same-owner-and-old-cookie-remain-authorized`,
  );
  need(
    afterFailure.count === fixture.initialRows.count &&
      afterFailure.sha256 === fixture.initialRows.sha256,
    `${caller}-all-session-rows-unchanged-after-503`,
  );
  await fixture.page.waitForTimeout(200);
  need(fixture.events.logoutPosts === 1, `${caller}-no-automatic-retry-post`);

  const confirmPromise = fixture.page
    .getByRole("alertdialog", { name: "ログアウト" })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await retry.click({ timeout: TIMEOUT });
  await confirmPromise;
  const confirmDialog = fixture.page.getByRole("alertdialog", {
    name: "ログアウト",
  });
  const successPromise = fixture.page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === origin &&
        url.pathname === "/api/auth/logout"
      );
    },
    { timeout: TIMEOUT },
  );
  await confirmDialog
    .getByRole("button", { name: "ログアウト" })
    .click({ timeout: TIMEOUT });
  const ack = await successPromise;
  need(ack.status() === 200, `${caller}-explicit-retry-real-worker-ack`);
  // The product intentionally cancels the inconclusive ACK body. Chrome may
  // discard its CDP buffer; revocation is proved by UI, auth401 and native SQL.
  await fixture.page
    .getByRole("heading", { name: "サインイン" })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  const staleCookie = await fixture.page.request.get(`${origin}/api/auth/me`, {
    headers: { cookie: `session=${fixture.cookie}` },
    timeout: TIMEOUT,
  });
  const afterRetry = await completeSessionRows(db);
  need(
    staleCookie.status() === 401 &&
      !afterRetry.rows.some((row) => row.id === fixture.expectedId),
    `${caller}-retry-invalidates-original-cookie-session`,
  );
  need(
    afterRetry.count === fixture.initialRows.count - 1,
    `${caller}-retry-removes-exactly-current-session-row`,
  );
  need(
    sha(JSON.stringify(afterRetry.rows)) ===
      sha(
        JSON.stringify(
          fixture.initialRows.rows.filter(
            (row) => row.id !== fixture.expectedId,
          ),
        ),
      ),
    `${caller}-retry-preserves-every-unrelated-session-row`,
  );
  need(
    fixture.events.documents.length === initialDocuments,
    `${caller}-no-document-reload-after-explicit-retry`,
  );
  need(
    fixture.events.logoutPosts === 2 &&
      fixture.events.oidcStarts === 0 &&
      fixture.events.callbacks === 0,
    `${caller}-one-explicit-retry-no-oidc`,
  );
  need(
    fixture.events.pageErrors === 0 &&
      fixture.events.unexpectedFiveHundreds.length === 0 &&
      fixture.blockedOutbound() === 0,
    `${caller}-clean-browser-and-no-external-requests`,
  );
  checks.push(
    `yurumeet-logout-${caller}-503-inline-error-explicit-retry-revokes-session`,
  );
  return {
    rateWindow: fixture.rateWindow,
    posts: fixture.events.logoutPosts,
    afterFailure: {
      authStatus: auth.status,
      oldCookieStatus: oldCookie.status(),
      sessionRowsSha256: afterFailure.sha256,
    },
    retry: {
      status: ack.status(),
      oldCookieStatus: staleCookie.status(),
      sessionCount: afterRetry.count,
    },
    observations: fixture.events,
  };
}

async function runAckLoss({
  browser,
  worker,
  db,
  origin,
  checks,
  password,
  sessionSalt,
}) {
  const fixture = await loginFreshOwner({
    browser,
    worker,
    db,
    origin,
    password,
    sessionSalt,
    caller: "ack-loss",
  });
  fixture.db = db;
  try {
    const initialDocuments = fixture.events.documents.length;
    const operation = await initiateSettingsLogout(fixture, "ack-loss");
    await bounded(operation.routeEntered, "ack-loss-worker-commit");
    await fixture.page
      .getByRole("heading", { name: "サインイン" })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      fixture.committed?.status === 200 && fixture.committed.ownSessionAbsent,
      "real-logout-commit-before-browser-response-drop",
    );
    const current = await readAuth(fixture.page, origin);
    const oldCookie = await fixture.page.request.get(`${origin}/api/auth/me`, {
      headers: { cookie: `session=${fixture.cookie}` },
      timeout: TIMEOUT,
    });
    const sessions = await completeSessionRows(db);
    const cookieRetained = (await fixture.context.cookies(origin)).some(
      (item) => item.name === "session" && item.value === fixture.cookie,
    );
    need(cookieRetained, "ack-loss-browser-retains-exact-stale-cookie");
    need(
      current.status === 401 && oldCookie.status() === 401,
      "ack-loss-readonly-auth-confirms-anonymous",
    );
    need(
      !sessions.rows.some((row) => row.id === fixture.expectedId),
      "ack-loss-native-session-row-absent",
    );
    need(
      sha(JSON.stringify(sessions.rows)) ===
        sha(
          JSON.stringify(
            fixture.initialRows.rows.filter(
              (row) => row.id !== fixture.expectedId,
            ),
          ),
        ),
      "ack-loss-preserves-every-unrelated-session-row",
    );
    need(
      fixture.events.documents.length === initialDocuments,
      "ack-loss-no-document-reload",
    );
    need(
      fixture.events.logoutPosts === 1 &&
        fixture.events.oidcStarts === 0 &&
        fixture.events.callbacks === 0,
      "ack-loss-no-post-retry-or-oidc",
    );
    need(
      fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0 &&
        fixture.blockedOutbound() === 0,
      "ack-loss-no-errors-or-external-requests",
    );
    checks.push(
      "yurumeet-logout-ack-loss-real-commit-readonly-anonymous-reconciliation",
    );
    return {
      rateWindow: fixture.rateWindow,
      status: fixture.committed.status,
      responseBodyBytes: fixture.committed.responseBodyBytes,
      responseBodySha256: fixture.committed.responseBodySha256,
      oldCookieStatus: oldCookie.status(),
      browserRetainedStaleCookie: cookieRetained,
      nativeSessionCount: sessions.count,
      logoutPosts: fixture.events.logoutPosts,
      oidcStarts: fixture.events.oidcStarts,
    };
  } finally {
    await fixture.context.close();
  }
}

/** Candidate-only native-browser proof for the Meet logout recovery boundaries. */
export async function qualifyLogoutOutcome({
  browser,
  worker,
  db,
  origin,
  checks = [],
  password = PASSWORD,
  sessionSalt,
}) {
  need(
    browser && worker && db && typeof origin === "string",
    "browser-worker-db-origin-required",
  );
  need(
    typeof sessionSalt === "string" && sessionSalt.length > 0,
    "session-salt-required",
  );
  const baselineCounts = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
  need(
    Number(baselineCounts?.actors) >= 1,
    "caller-provided-runtime-has-authenticated-owner",
  );
  const rowsBefore = await completeSessionRows(db);
  const runCase = async (caller, path, menuProfile = false) => {
    const fixture = await loginFreshOwner({
      browser,
      worker,
      db,
      origin,
      password,
      sessionSalt,
      caller,
    });
    try {
      if (menuProfile) {
        await fixture.page.goto(`${origin}/profile`, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT,
        });
        await fixture.page
          .getByRole("button", { name: "その他" })
          .waitFor({ state: "visible", timeout: TIMEOUT });
      } else if (path !== "/settings") {
        await fixture.page.goto(`${origin}${path}`, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT,
        });
      }
      return await runFailedThenRetry({
        fixture,
        db,
        origin,
        checks,
        caller,
        profileMenu: menuProfile,
      });
    } finally {
      await fixture.context.close();
    }
  };

  const settings = await runCase("settings", "/settings");
  const profile = await runCase("profile-menu", "/profile", true);
  const ackLoss = await runAckLoss({
    browser,
    worker,
    db,
    origin,
    checks,
    password,
    sessionSalt,
  });
  const finalCounts = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
  const rowsAfter = await completeSessionRows(db);
  need(
    Number(finalCounts.actors) === Number(baselineCounts.actors) &&
      rowsAfter.count === rowsBefore.count,
    "candidate-lanes-preserve-existing-owner-and-session-counts",
  );
  need(
    rowsAfter.sha256 === rowsBefore.sha256,
    "candidate-lanes-preserve-every-prior-session-row",
  );
  checks.push("yurumeet-logout-outcome-settings-profile-retry-and-ack-loss");
  return {
    mode: "head",
    settings,
    profile,
    ackLoss,
    preservedPriorSessionRows: rowsAfter.sha256 === rowsBefore.sha256,
    finalCounts: {
      actors: Number(finalCounts.actors),
      sessions: rowsAfter.count,
    },
    issuer: "native password auth; no OIDC issuer enabled",
  };
}
