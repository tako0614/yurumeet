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
  const startedAt = Date.now();
  const authPath = (value) => {
    const url = new URL(value);
    return url.origin === origin &&
      [
        "/api/auth/me",
        "/api/auth/providers",
        "/api/auth/login",
        "/api/auth/logout",
      ].includes(url.pathname)
      ? url.pathname
      : null;
  };
  const events = {
    logoutPosts: 0,
    oidcStarts: 0,
    callbacks: 0,
    pageErrors: 0,
    documents: [],
    expectedLogout503: 0,
    expectedContact503: 0,
    allowContact503: false,
    unexpectedFiveHundreds: [],
    authRequests: [],
    authResponses: [],
    authFailures: [],
  };
  page.on("request", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    const path = authPath(request.url());
    if (path)
      events.authRequests.push({
        path,
        method: request.method(),
        elapsedMs: Date.now() - startedAt,
      });
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
  page.on("requestfailed", (request) => {
    const path = authPath(request.url());
    if (path)
      events.authFailures.push({
        path,
        method: request.method(),
        error: request.failure()?.errorText ?? null,
        elapsedMs: Date.now() - startedAt,
      });
  });
  page.on("pageerror", () => {
    events.pageErrors += 1;
  });
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      const path = authPath(response.url());
      if (path) {
        const headers = response.headers();
        events.authResponses.push({
          path,
          method: response.request().method(),
          status: response.status(),
          elapsedMs: Date.now() - startedAt,
          rate: {
            limit: headers["x-ratelimit-limit"] ?? null,
            remaining: headers["x-ratelimit-remaining"] ?? null,
            resetAt: headers["x-ratelimit-reset"] ?? null,
            retryAfter: headers["retry-after"] ?? null,
          },
        });
      }
      if (url.origin === origin && response.status() >= 500) {
        if (url.pathname === "/api/auth/logout" && response.status() === 503)
          events.expectedLogout503 += 1;
        else if (
          events.allowContact503 &&
          url.pathname === "/api/dm/contacts" &&
          response.request().method() === "GET" &&
          response.status() === 503
        )
          events.expectedContact503 += 1;
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

async function waitForSignedOut(fixture, caller) {
  try {
    await fixture.page
      .getByRole("heading", { name: "サインイン" })
      .waitFor({ state: "visible", timeout: TIMEOUT });
  } catch (error) {
    // Keep the original deadline and verdict. Diagnose only fixed UI flags and
    // auth path/status/rate metadata; never log cookies, headers or body text.
    let ui = null;
    try {
      ui = await bounded(
        fixture.page.evaluate(() => ({
          visibility: document.visibilityState,
          signedOut: [...document.querySelectorAll("h1")].some(
            (item) => item.textContent === "サインイン",
          ),
          appError: [...document.querySelectorAll("h1")].some(
            (item) => item.textContent === "問題が発生しました",
          ),
          boot: Boolean(document.querySelector(".yc-boot")),
          logoutBusy: Boolean(
            document.querySelector('.yc-logout-status[role="status"]'),
          ),
          connectionError:
            document.body.textContent.includes(
              "認証状態を確認できませんでした",
            ),
          retryError:
            document.body.textContent.includes(
              "ログアウトできませんでした。現在も",
            ),
        })),
        "failed-ui-diagnostic",
      );
    } catch {}
    process.stderr.write(
      `${JSON.stringify({ kind: "yurumeet.logout-ui-timeout@v1", caller, ui, observations: fixture.events })}\n`,
    );
    throw error;
  }
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
  const anonymousRateWindow = await rateCapacity(page, origin);
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
  const jar = await context.cookies(origin);
  const cookie = jar.find((item) => item.name === "session");
  need(Boolean(cookie?.value), `${caller}-session-cookie-issued`);
  const expectedId = await sessionKey(cookie.value, sessionSalt);
  const issuedSession = await db
    .prepare("SELECT member_id FROM sessions WHERE id = ?")
    .bind(expectedId)
    .first();
  need(
    typeof issuedSession?.member_id === "string",
    `${caller}-issued-cookie-native-principal`,
  );
  // Core keys authenticated auth requests by actor, not the anonymous IP.
  // Earlier full-smoke lanes share this owner bucket. Prove capacity using
  // the issued cookie before navigation/current-user reads can consume it.
  const authenticatedRateWindow = await rateCapacity(page, origin);
  await page.goto(`${origin}/settings`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  const me = await readAuth(page, origin);
  need(
    me.status === 200 && me.actorApId === issuedSession.member_id,
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
    rateWindow: {
      anonymous: anonymousRateWindow,
      authenticated: authenticatedRateWindow,
    },
  };
}

async function initiateSettingsLogout(
  fixture,
  interceptMode,
  { profileMenu = false, afterCommit } = {},
) {
  const { page, events } = fixture;
  let intercepted = 0;
  let afterCommitError = null;
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
      if (afterCommit) {
        try {
          await bounded(afterCommit(), "contact-401-after-commit", 10_000);
        } catch (error) {
          afterCommitError =
            error instanceof Error &&
            error.message.startsWith("yurumeet-logout-outcome:")
              ? error.message
              : "contact-401-after-commit-callback-failed";
        }
      }
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
    const more = page
      .locator(".p-profile-actions")
      .getByRole("button", { name: "メニュー", exact: true });
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
    afterCommitError: () => afterCommitError,
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
  await waitForSignedOut(fixture, caller);
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

/** Contact errors retain confirmed rows and expose explicit read-only recovery. */
async function qualifyContactRecovery(fixture, origin) {
  const { page } = fixture;
  const response = await page.request.get(`${origin}/api/dm/contacts`, {
    timeout: TIMEOUT,
  });
  need(response.status() === 200, "contact-recovery-real-contact-list");
  const body = await response.json();
  const peer = body.mutual_followers?.find((item) => item.name);
  need(
    typeof peer?.name === "string" && peer.name.length > 0,
    "contact-recovery-existing-named-dm",
  );
  let mode = "fail";
  const initialExpectedContact503 = fixture.events.expectedContact503;
  fixture.events.allowContact503 = true;
  let releaseRead;
  let enteredReadResolve;
  const armRead = () => {
    let resolve;
    const entered = new Promise((accept) => {
      enteredReadResolve = accept;
    });
    const gate = new Promise((accept) => {
      resolve = accept;
    });
    releaseRead = resolve;
    return { entered, gate };
  };
  let held = null;
  let refusedReads = 0;
  let forwardedReads = 0;
  await page.route("**/api/dm/contacts", async (route) => {
    need(route.request().method() === "GET", "contact-recovery-readonly-route");
    if (mode === "fail") {
      refusedReads += 1;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    }
    if (mode === "held") {
      enteredReadResolve();
      await held.gate;
    }
    forwardedReads += 1;
    return route.continue();
  });
  const notice = (view) =>
    page
      .locator(`${view} [role="alert"]`)
      .filter({ hasText: "読み込めませんでした" });
  const noFalseEmpty = async () => {
    need(
      (await page
        .getByRole("heading", { name: "問題が発生しました", exact: true })
        .count()) === 0,
      "contact-error-does-not-reach-root-boundary",
    );
    for (const text of [
      "まだ友だちはいません",
      "参加中のグループはありません",
      "まだトークはありません",
    ])
      need(
        (await page.getByText(text, { exact: false }).count()) === 0,
        "contact-error-is-not-confirmed-empty",
      );
  };
  const retry = async (view) => {
    mode = "held";
    held = armRead();
    await notice(view)
      .getByRole("button", { name: "再試行", exact: true })
      .click({ timeout: TIMEOUT });
    await bounded(held.entered, "manual-contact-retry-held");
    need(
      await notice(view)
        .getByRole("button", { name: "再読み込み中...", exact: true })
        .isDisabled(),
      "contact-retry-disabled-while-previous-error-present",
    );
    await noFalseEmpty();
    mode = "pass";
    releaseRead();
    await notice(view).waitFor({ state: "hidden", timeout: TIMEOUT });
    await page
      .locator(view)
      .getByText(peer.name, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
  };
  try {
    await page.goto(`${origin}/?tab=home`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    await notice(".p-home").waitFor({ state: "visible", timeout: TIMEOUT });
    await noFalseEmpty();
    const initialRefusedReads = refusedReads;
    need(initialRefusedReads > 0, "initial-contact-read-was-refused");
    await retry(".p-home");
    mode = "fail";
    await notice(".p-home").waitFor({ state: "visible", timeout: 25_000 });
    await page
      .locator(".p-home")
      .getByText(peer.name, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .locator('.l-header a[href="/?tab=talk"]')
      .click({ timeout: TIMEOUT });
    await notice(".p-talk-rooms-pane").waitFor({
      state: "visible",
      timeout: TIMEOUT,
    });
    await page
      .locator(".p-talk-rooms-pane")
      .getByText(peer.name, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await noFalseEmpty();
    await retry(".p-talk-rooms-pane");
    const current = await readAuth(page, origin);
    need(
      current.status === 200 && current.actorApId === fixture.actorApId,
      "contact503-does-not-certify-signout",
    );
    need(fixture.events.logoutPosts === 0, "contact-recovery-is-readonly");
    need(
      fixture.events.expectedContact503 - initialExpectedContact503 ===
        refusedReads,
      "contact-recovery-only-exact-injected503-accepted",
    );
    return {
      status: "PASSED",
      initialRefusedReads,
      refusedReads,
      forwardedReads,
      previousRowsRetained: true,
      retryWhilePriorError: true,
      unknownIsNotEmpty: true,
    };
  } finally {
    fixture.events.allowContact503 = false;
    releaseRead?.();
    await page.unroute("**/api/dm/contacts");
  }
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
  let releaseContacts;
  let contactRouteError = null;
  const contactResponses = [];
  let finishedContactResolve;
  const finishedContact = new Promise((resolve) => {
    finishedContactResolve = resolve;
  });
  try {
    const contactRecovery = await qualifyContactRecovery(fixture, origin);
    await fixture.page.goto(`${origin}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    // Earlier canonical draft lanes create real DM contacts. Require the wide
    // viewport's mounted conversation before racing its next background read
    // against real session revocation; settings still has the shared chat pane.
    await fixture.page
      .locator(".p-talk-chat-send__textarea")
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await fixture.page
      .locator(".c-talk-chat-box")
      .first()
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await fixture.page.evaluate(() => {
      const original = window.fetch;
      window.__logoutContact401Reads = 0;
      window.fetch = async function (...args) {
        const response = await original.apply(this, args);
        const request = args[0];
        const url = new URL(
          typeof request === "string"
            ? request
            : request instanceof URL
              ? request.href
              : request.url,
          window.location.href,
        );
        if (
          url.origin === window.location.origin &&
          url.pathname === "/api/dm/contacts" &&
          response.status === 401
        )
          window.__logoutContact401Reads += 1;
        return response;
      };
    });
    let enteredContactResolve;
    const enteredContact = new Promise((resolve) => {
      enteredContactResolve = resolve;
    });
    const contactGate = new Promise((resolve) => {
      releaseContacts = resolve;
    });
    await fixture.page.route("**/api/dm/contacts", async (route) => {
      enteredContactResolve();
      await contactGate;
      try {
        const request = route.request();
        const response = await fetch(request.url(), {
          method: "GET",
          headers: await request.allHeaders(),
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        });
        const body = Buffer.from(await response.arrayBuffer());
        need(
          response.status === 401 && body.length > 0,
          "contact-poll-real-worker-401-after-session-revocation",
        );
        contactResponses.push({
          status: response.status,
          bodyBytes: body.length,
        });
        await route.fulfill({
          status: response.status,
          contentType: "application/json",
          body,
        });
      } catch {
        contactRouteError = "contact-response-or-route-failed";
      } finally {
        finishedContactResolve();
      }
    });
    // The existing contact cadence is 20s. Hold its real next read, rather than
    // changing the cadence, credentials, KV or server response to force a race.
    await bounded(enteredContact, "next-contact-poll-held", 25_000);
    const initialDocuments = fixture.events.documents.length;
    const operation = await initiateSettingsLogout(fixture, "ack-loss", {
      afterCommit: async () => {
        releaseContacts();
        await bounded(finishedContact, "contact-401-fulfilled");
        need(contactRouteError === null, "contact-401-route-completed");
        await fixture.page.waitForFunction(
          () => window.__logoutContact401Reads > 0,
          null,
          { timeout: TIMEOUT },
        );
        // Let the SDK/resource rejection settle before delivering logout's
        // transport failure. This is an ordering fence, not an extended UI wait.
        await fixture.page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        );
        await fixture.page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        );
      },
    });
    await bounded(operation.routeEntered, "ack-loss-worker-commit");
    need(
      operation.afterCommitError() === null,
      operation.afterCommitError() ?? "contact-401-after-commit-completed",
    );
    await waitForSignedOut(fixture, "ack-loss");
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
      contact401Responses: contactResponses.length,
      contactRecovery,
      logoutPosts: fixture.events.logoutPosts,
      oidcStarts: fixture.events.oidcStarts,
    };
  } finally {
    releaseContacts?.();
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
          .getByRole("button", { name: "プロフィールを編集", exact: true })
          .waitFor({ state: "visible", timeout: TIMEOUT });
        await fixture.page
          .locator(".p-profile-actions")
          .getByRole("button", { name: "メニュー", exact: true })
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
