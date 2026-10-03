import { createHash, randomUUID, webcrypto } from "node:crypto";

const TIMEOUT = 20_000;
const RATE_WAIT_MAX = 60_000;
const PASSWORD = "local-yurumeet-bookmark-fixture";

function need(ok, label) {
  if (!ok) throw new Error(`yurumeet-bookmark-auth-loss:${label}`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function orderedRow(row) {
  return Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function sortByJson(rows, field) {
  return rows
    .map(orderedRow)
    .sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
}

async function bounded(promise, label, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`yurumeet-bookmark-auth-loss:${label}-timeout`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sessionId(cookie, salt) {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${cookie}`),
  );
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

async function rateCapacity(page, origin) {
  const deadline = Date.now() + RATE_WAIT_MAX;
  let waited = false;
  while (true) {
    const response = await page.request.get(`${origin}/api/auth/providers`, {
      timeout: TIMEOUT,
    });
    const headers = response.headers();
    const limit = Number(headers["x-ratelimit-limit"]);
    const remaining = Number(headers["x-ratelimit-remaining"]);
    const reset = Number(headers["x-ratelimit-reset"]);
    need(
      limit === 20 &&
        Number.isFinite(remaining) &&
        remaining >= 0 &&
        remaining <= limit &&
        Number.isFinite(reset) &&
        reset > 0,
      "public-auth-rate-limit-shape",
    );
    if (response.status() !== 429) {
      need(response.status() === 200, "readonly-provider-capacity-response");
      if (remaining >= 19) return { remaining, resetAt: reset, waited };
    }
    need(!waited, "one-readonly-auth-window-wait");
    const waitMs = Math.min(
      Math.max(1, reset * 1000 - Date.now() + 150),
      deadline - Date.now(),
    );
    need(
      waitMs > 0 && waitMs <= RATE_WAIT_MAX && Date.now() + waitMs <= deadline,
      "public-reset-within-60-second-bound",
    );
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function readAuth(page, origin) {
  const response = await page.request.get(`${origin}/api/auth/me`, {
    timeout: TIMEOUT,
  });
  let actorApId = null;
  if (response.status() === 200) {
    const body = await bounded(response.body(), "auth-me-body");
    try {
      actorApId = JSON.parse(body.toString("utf8")).actor?.ap_id ?? null;
    } catch {
      throw new Error("yurumeet-bookmark-auth-loss:auth-me-json");
    }
  }
  return { status: response.status(), actorApId };
}

async function responseJson(response, label, expectedStatus = 200) {
  need(
    response.status() === expectedStatus,
    `${label}-http-${response.status()}`,
  );
  const body = await bounded(response.body(), `${label}-body`);
  try {
    return { value: JSON.parse(body.toString("utf8")), bodyBytes: body.length };
  } catch {
    throw new Error(`yurumeet-bookmark-auth-loss:${label}-json`);
  }
}

async function actors(db) {
  const result = await bounded(
    db.prepare("SELECT * FROM actors ORDER BY ap_id").all(),
    "actor-snapshot",
  );
  return sortByJson(result.results ?? [], "ap_id");
}

async function sessions(db) {
  const result = await bounded(
    db.prepare("SELECT * FROM sessions ORDER BY id").all(),
    "session-snapshot",
  );
  return sortByJson(result.results ?? [], "id");
}

async function bookmarks(db) {
  const result = await bounded(
    db
      .prepare("SELECT * FROM bookmarks ORDER BY actor_ap_id, object_ap_id")
      .all(),
    "bookmark-snapshot",
  );
  return (result.results ?? [])
    .map(orderedRow)
    .sort((a, b) =>
      a.actor_ap_id < b.actor_ap_id
        ? -1
        : a.actor_ap_id > b.actor_ap_id
          ? 1
          : a.object_ap_id < b.object_ap_id
            ? -1
            : a.object_ap_id > b.object_ap_id
              ? 1
              : 0,
    );
}

function sortBookmarks(rows) {
  return rows
    .map(orderedRow)
    .sort((a, b) =>
      a.actor_ap_id < b.actor_ap_id
        ? -1
        : a.actor_ap_id > b.actor_ap_id
          ? 1
          : a.object_ap_id < b.object_ap_id
            ? -1
            : a.object_ap_id > b.object_ap_id
              ? 1
              : 0,
    );
}

async function objects(db) {
  const result = await bounded(
    db.prepare("SELECT * FROM objects ORDER BY ap_id").all(),
    "object-snapshot",
  );
  return sortByJson(result.results ?? [], "ap_id");
}

function observe(page, origin) {
  const events = {
    bookmarkDeletes: 0,
    logoutPosts: 0,
    documents: [],
    pageErrors: 0,
    unhandledRejections: 0,
    expectedDelete503: 0,
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
    if (
      request.method() === "DELETE" &&
      /^\/api\/posts\/[^/]+\/bookmark$/.test(url.pathname)
    )
      events.bookmarkDeletes += 1;
    if (request.method() === "POST" && url.pathname === "/api/auth/logout")
      events.logoutPosts += 1;
    if (request.isNavigationRequest() && request.resourceType() === "document")
      events.documents.push(url.pathname);
  });
  page.on("pageerror", () => {
    events.pageErrors += 1;
  });
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== origin || response.status() < 500) return;
      if (
        url.pathname === events.expectedBookmarkPath &&
        response.request().method() === "DELETE" &&
        response.status() === 503
      )
        events.expectedDelete503 += 1;
      else
        events.unexpectedFiveHundreds.push({
          path: url.pathname,
          status: response.status(),
        });
    } catch {}
  });
  return events;
}

async function loginOwner({ browser, db, origin, password, sessionSalt }) {
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
  const observations = observe(page, origin);
  await page.addInitScript(() => {
    window.__bookmarkAuthLossUnhandledRejections = 0;
    window.addEventListener("unhandledrejection", () => {
      window.__bookmarkAuthLossUnhandledRejections += 1;
    });
  });
  const anonymousRate = await rateCapacity(page, origin);
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
  need(loginResponse.status() === 200, "single-real-password-login-200");
  await passwordInput.waitFor({ state: "hidden", timeout: TIMEOUT });
  const jar = await context.cookies(origin);
  const cookie = jar.find((item) => item.name === "session");
  need(
    typeof cookie?.value === "string" && cookie.value.length > 0,
    "browser-session-cookie-issued",
  );
  const expectedId = await sessionId(cookie.value, sessionSalt);
  const issuedRow = await bounded(
    db.prepare("SELECT * FROM sessions WHERE id = ?").bind(expectedId).first(),
    "issued-full-session-row",
  );
  need(
    issuedRow?.id === expectedId && typeof issuedRow.member_id === "string",
    "salted-cookie-session-row-exists",
  );
  const authenticatedRate = await rateCapacity(page, origin);
  const me = await readAuth(page, origin);
  need(
    me.status === 200 && me.actorApId === issuedRow.member_id,
    "current-owner-auth-api-read",
  );
  const owner = await bounded(
    db
      .prepare("SELECT * FROM actors WHERE ap_id = ?")
      .bind(me.actorApId)
      .first(),
    "owner-row",
  );
  need(
    owner?.ap_id === me.actorApId &&
      owner.role === "owner" &&
      owner.deleted_at == null,
    "same-local-root-owner",
  );
  await page.goto(`${origin}/bookmarks`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  return {
    context,
    page,
    observations,
    actorApId: me.actorApId,
    cookie: cookie.value,
    expectedSessionId: expectedId,
    issuedRow: orderedRow(issuedRow),
    blockedOutbound: () => blockedOutbound,
    rate: { anonymous: anonymousRate, authenticated: authenticatedRate },
  };
}

async function createAndBookmark(fixture, db, origin) {
  const runId = randomUUID();
  const text = `yurumeet-bookmark-auth-loss-${runId}`;
  const create = await fixture.page.request.post(`${origin}/api/posts`, {
    data: { content: text, visibility: "public" },
    headers: { origin },
    timeout: TIMEOUT,
  });
  const postResult = await responseJson(create, "fixture-note-create");
  const apId = postResult.value.post?.ap_id;
  need(
    typeof apId === "string" && apId.startsWith(`${origin}/`),
    "new-local-note-id",
  );
  const postRead = await fixture.page.request.get(
    `${origin}/api/posts/${encodeURIComponent(apId)}`,
    { timeout: TIMEOUT },
  );
  const post = await responseJson(postRead, "fixture-note-readback");
  need(
    post.value.post?.ap_id === apId && post.value.post.content.includes(text),
    "created-note-real-api-readback",
  );
  const add = await fixture.page.request.post(
    `${origin}/api/posts/${encodeURIComponent(apId)}/bookmark`,
    { headers: { origin }, timeout: TIMEOUT },
  );
  const bookmark = await responseJson(add, "fixture-bookmark-create");
  need(
    bookmark.value.success === true && bookmark.value.bookmarked === true,
    "fixture-bookmark-real-200",
  );
  const native = await bounded(
    db
      .prepare(
        "SELECT actor_ap_id, object_ap_id, created_at FROM bookmarks WHERE actor_ap_id = ? AND object_ap_id = ?",
      )
      .bind(fixture.actorApId, apId)
      .first(),
    "fixture-bookmark-native-row",
  );
  need(
    native?.actor_ap_id === fixture.actorApId && native.object_ap_id === apId,
    "fixture-bookmark-native-row-exists",
  );
  return { apId, text };
}

async function waitLogoutConfirmation(page) {
  const more = page
    .locator(".p-profile-actions")
    .getByRole("button", { name: "メニュー", exact: true });
  await more.waitFor({ state: "visible", timeout: TIMEOUT });
  await more.click({ timeout: TIMEOUT });
  const signout = page.getByRole("menuitem", {
    name: "ログアウト",
    exact: true,
  });
  await signout.waitFor({ state: "visible", timeout: TIMEOUT });
  const dialogPromise = page
    .getByRole("alertdialog", { name: "ログアウト" })
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await signout.click({ timeout: TIMEOUT });
  await dialogPromise;
  const logoutResponsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(page.url()).origin &&
        url.pathname === "/api/auth/logout" &&
        response.request().method() === "POST"
      );
    },
    { timeout: TIMEOUT },
  );
  await page
    .getByRole("alertdialog", { name: "ログアウト" })
    .getByRole("button", { name: "ログアウト", exact: true })
    .click({ timeout: TIMEOUT });
  return logoutResponsePromise;
}

/** Race a real pending Bookmark deletion against a completed real logout. */
export async function qualifyBookmarkAuthLoss({
  browser,
  worker,
  db,
  origin,
  password = PASSWORD,
  sessionSalt,
  checks = [],
}) {
  need(
    browser && worker && db && typeof origin === "string",
    "browser-worker-db-origin-required",
  );
  need(
    typeof sessionSalt === "string" && sessionSalt.length > 0,
    "session-salt-required",
  );
  const checksStart = checks.length;
  const actorsBefore = await actors(db);
  const sessionsBefore = await sessions(db);
  const bookmarksBefore = await bookmarks(db);
  const objectsBefore = await objects(db);
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
  });
  let primaryFailure = false;
  let releaseDelete;
  let routeEnteredResolve;
  let routeFinishedResolve;
  const deleteHold = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const routeEntered = new Promise((resolve) => {
    routeEnteredResolve = resolve;
  });
  const routeFinished = new Promise((resolve) => {
    routeFinishedResolve = resolve;
  });
  const routeState = { count: 0, errorKind: null, status: null, bodyBytes: 0 };
  let targetPost = null;
  try {
    targetPost = await createAndBookmark(fixture, db, origin);
    await fixture.page.reload({
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const card = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetPost.text });
    await card.waitFor({ state: "visible", timeout: TIMEOUT });
    const bookmarkButton = card.getByRole("button", {
      name: "ブックマークを外す",
      exact: true,
    });
    await bookmarkButton.waitFor({ state: "visible", timeout: TIMEOUT });
    const targetPath = `/api/posts/${encodeURIComponent(targetPost.apId)}/bookmark`;
    fixture.observations.expectedBookmarkPath = targetPath;
    const documentsBefore = fixture.observations.documents.length;
    const sessionRowsAfterLogin = await sessions(db);
    const issued = sessionRowsAfterLogin.find(
      (row) => row.id === fixture.expectedSessionId,
    );
    need(
      issued &&
        sha(JSON.stringify(issued)) === sha(JSON.stringify(fixture.issuedRow)),
      "issued-cookie-full-session-row-readback",
    );
    const actorAfterCreate = await actors(db);
    const actorRowBeforeLogout = actorAfterCreate.find(
      (row) => row.ap_id === fixture.actorApId,
    );
    const actorPrior = actorsBefore.find(
      (row) => row.ap_id === fixture.actorApId,
    );
    const actorUpdatedAt = Date.parse(actorRowBeforeLogout?.updated_at);
    const actorPriorUpdatedAt = Date.parse(actorPrior?.updated_at);
    need(
      actorRowBeforeLogout &&
        actorPrior &&
        Number(actorRowBeforeLogout.post_count) ===
          Number(actorPrior.post_count) + 1,
      "fixture-note-increments-only-expected-owner-post-count",
    );
    need(
      Number.isFinite(actorUpdatedAt) &&
        Number.isFinite(actorPriorUpdatedAt) &&
        actorUpdatedAt >= actorPriorUpdatedAt &&
        actorUpdatedAt <= Date.now() + 1000,
      "fixture-note-owner-updated-at-is-bounded-and-nondecreasing",
    );
    const expectedActorsAfterCreate = actorsBefore.map((row) =>
      row.ap_id === fixture.actorApId
        ? {
            ...row,
            post_count: row.post_count + 1,
            updated_at: actorRowBeforeLogout.updated_at,
          }
        : row,
    );
    need(
      sha(JSON.stringify(actorAfterCreate)) ===
        sha(JSON.stringify(expectedActorsAfterCreate)),
      "setup-changes-only-exact-author-post-count-and-timestamp",
    );
    need(
      !sessionsBefore.some((row) => row.id === fixture.expectedSessionId),
      "new-session-id-not-prior",
    );
    const expectedSessionsAfterLogin = sortByJson(
      [...sessionsBefore, fixture.issuedRow],
      "id",
    );
    need(
      sha(JSON.stringify(sessionRowsAfterLogin)) ===
        sha(JSON.stringify(expectedSessionsAfterLogin)),
      "login-adds-only-exact-issued-row-preserves-all-prior-fields",
    );
    const bookmarkRowsAfterCreate = await bookmarks(db);
    const objectRowsAfterCreate = await objects(db);
    const expectedBookmarksAfterCreate = sortBookmarks([
      ...bookmarksBefore,
      ...bookmarkRowsAfterCreate.filter(
        (row) =>
          row.object_ap_id === targetPost.apId &&
          row.actor_ap_id === fixture.actorApId,
      ),
    ]);
    need(
      sha(JSON.stringify(bookmarkRowsAfterCreate)) ===
        sha(JSON.stringify(expectedBookmarksAfterCreate)),
      "fixture-adds-exactly-one-bookmark-row",
    );
    need(
      bookmarkRowsAfterCreate.length === bookmarksBefore.length + 1,
      "exact-new-bookmark-row-count",
    );
    need(
      objectRowsAfterCreate.length === objectsBefore.length + 1,
      "exact-new-object-row-count",
    );
    const expectedObjectsAfterCreate = sortByJson(
      [
        ...objectsBefore,
        ...objectRowsAfterCreate.filter((row) => row.ap_id === targetPost.apId),
      ],
      "ap_id",
    );
    need(
      sha(JSON.stringify(objectRowsAfterCreate)) ===
        sha(JSON.stringify(expectedObjectsAfterCreate)),
      "fixture-adds-exactly-one-note-object",
    );
    await fixture.page.route("**/api/posts/*/bookmark", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "DELETE" ||
        url.origin !== origin ||
        url.pathname !== targetPath
      )
        return route.continue();
      routeState.count += 1;
      routeEnteredResolve();
      await deleteHold;
      try {
        routeState.status = 503;
        const mockBody = JSON.stringify({ error: "temporarily unavailable" });
        routeState.bodyBytes = Buffer.byteLength(mockBody);
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: mockBody,
        });
      } catch (error) {
        routeState.errorKind =
          error instanceof TypeError ? "TypeError" : "route-fulfill-error";
      } finally {
        routeFinishedResolve();
      }
    });
    const deleteResponsePromise = fixture.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          response.request().method() === "DELETE" &&
          url.pathname === targetPath
        );
      },
      { timeout: TIMEOUT },
    );
    await bookmarkButton.click({ timeout: TIMEOUT });
    await bounded(routeEntered, "bookmark-delete-pending");
    need(routeState.count === 1, "one-real-mounted-card-delete-started");
    await fixture.page
      .locator('.l-header-logo a[href="/profile"]')
      .click({ timeout: TIMEOUT });
    await fixture.page.waitForURL((url) => url.pathname === "/profile", {
      timeout: TIMEOUT,
    });
    const logoutResponsePromise = await waitLogoutConfirmation(fixture.page);
    const logoutResponse = await logoutResponsePromise;
    need(logoutResponse.status() === 200, "real-logout-http-200");
    // Auth may cancel the ACK body after its strict read-only observation.
    // Prove logout through UI, old-cookie refusal and full native row readback.
    await fixture.page
      .getByRole("heading", { name: "サインイン" })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    const anonymous = await readAuth(fixture.page, origin);
    need(
      anonymous.status === 401 && anonymous.actorApId === null,
      "real-logout-anonymous-before-delete-503-release",
    );
    const issuedCookieStatus = await fixture.page.request.get(
      `${origin}/api/auth/me`,
      { headers: { cookie: `session=${fixture.cookie}` }, timeout: TIMEOUT },
    );
    need(
      issuedCookieStatus.status() === 401,
      "issued-cookie-revoked-after-real-logout",
    );
    const sessionsAfterLogout = await sessions(db);
    const expectedSessionsAfterLogout = sessionsBefore;
    need(
      sha(JSON.stringify(sessionsAfterLogout)) ===
        sha(JSON.stringify(expectedSessionsAfterLogout)),
      "logout-deletes-only-issued-session-preserves-prior-session-rows",
    );
    const releaseBookmarksBefore = await bookmarks(db);
    const releaseObjectsBefore = await objects(db);
    need(
      sha(JSON.stringify(releaseBookmarksBefore)) ===
        sha(JSON.stringify(expectedBookmarksAfterCreate)),
      "bookmark-row-still-exists-before-503-release",
    );
    need(
      sha(JSON.stringify(releaseObjectsBefore)) ===
        sha(JSON.stringify(expectedObjectsAfterCreate)),
      "note-object-still-exists-before-503-release",
    );
    const actorsAfterLogout = await actors(db);
    need(
      sha(JSON.stringify(actorsAfterLogout)) ===
        sha(JSON.stringify(actorAfterCreate)),
      "actor-rows-unchanged-through-real-logout",
    );
    releaseDelete();
    await bounded(routeFinished, "fixed-503-route-finished");
    need(
      routeState.errorKind === null,
      "delete-route-callback-had-no-exception",
    );
    const deleteResponse = await bounded(
      deleteResponsePromise,
      "browser-delete-503-response",
    );
    await responseJson(deleteResponse, "fixed-nonforwarded-bookmark-503", 503);
    await fixture.page.waitForTimeout(200);
    await bounded(
      fixture.page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      ),
      "first-rejection-task",
    );
    await bounded(
      fixture.page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      ),
      "second-rejection-task",
    );
    const unhandled = await fixture.page.evaluate(
      () => window.__bookmarkAuthLossUnhandledRejections ?? 0,
    );
    fixture.observations.unhandledRejections = unhandled;
    const targetStillPresent = await fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetPost.text })
      .count();
    const bookmarksAfter = await bookmarks(db);
    const objectsAfter = await objects(db);
    const actorsAfter = await actors(db);
    const sessionsAfter = await sessions(db);
    need(
      sha(JSON.stringify(actorsAfter)) ===
        sha(JSON.stringify(actorsAfterLogout)),
      "actor-rows-unchanged-after-503",
    );
    need(
      sha(JSON.stringify(sessionsAfter)) ===
        sha(JSON.stringify(sessionsBefore)),
      "only-preexisting-sessions-remain-after-logout",
    );
    need(
      sha(JSON.stringify(bookmarksAfter)) ===
        sha(JSON.stringify(expectedBookmarksAfterCreate)),
      "503-keeps-exact-bookmark-rows",
    );
    need(
      sha(JSON.stringify(objectsAfter)) ===
        sha(JSON.stringify(expectedObjectsAfterCreate)),
      "503-keeps-exact-note-and-object-rows",
    );
    need(
      fixture.observations.bookmarkDeletes === 1 &&
        fixture.observations.logoutPosts === 1 &&
        fixture.observations.expectedDelete503 === 1,
      "one-delete-one-logout-one-fixed-503",
    );
    need(
      fixture.observations.pageErrors === 0 && unhandled === 0,
      "no-pageerror-or-unhandled-rejection-after-auth-loss",
    );
    need(
      routeState.status === 503 && routeState.count === 1,
      "fixed-nonforwarded-503-only",
    );
    need(
      fixture.observations.documents.length === documentsBefore &&
        fixture.blockedOutbound() === 0 &&
        fixture.observations.unexpectedFiveHundreds.length === 0,
      "no-document-reload-external-request-or-unexpected-5xx",
    );
    need(targetStillPresent === 0, "signed-out-spa-has-no-stale-bookmark-card");
    checks.push(
      "yurumeet-bookmark-auth-loss-real-logout-before-fixed-unbookmark-503-no-runtime-exception",
    );
    return {
      status: "PASSED",
      checks: checks.slice(checksStart),
      observations: {
        deleteCount: fixture.observations.bookmarkDeletes,
        logoutCount: fixture.observations.logoutPosts,
        delete503Count: fixture.observations.expectedDelete503,
        pageErrors: fixture.observations.pageErrors,
        unhandledRejections: unhandled,
        documents: fixture.observations.documents.length,
      },
      native: {
        actors: actorsAfter.length,
        sessions: sessionsAfter.length,
        bookmarks: bookmarksAfter.length,
        objects: objectsAfter.length,
        actorsSha256: sha(JSON.stringify(actorsAfter)),
        sessionsSha256: sha(JSON.stringify(sessionsAfter)),
        bookmarksSha256: sha(JSON.stringify(bookmarksAfter)),
        objectsSha256: sha(JSON.stringify(objectsAfter)),
      },
      targetCardAfterLogout: targetStillPresent,
      routeErrorKind: routeState.errorKind,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(
      `${JSON.stringify({ kind: "yurumeet.bookmark-auth-loss-failed@v1", stage: routeState.count > 0 ? "logout-race" : "setup", pageErrors: fixture.observations.pageErrors, unhandledRejections: fixture.observations.unhandledRejections, deleteCount: fixture.observations.bookmarkDeletes, logoutCount: fixture.observations.logoutPosts, routeErrorKind: routeState.errorKind })}\n`,
    );
    throw error;
  } finally {
    releaseDelete?.();
    try {
      await bounded(
        fixture.page.unroute("**/api/posts/*/bookmark"),
        "bookmark-route-unroute",
      );
      await bounded(fixture.context.close(), "browser-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmark-auth-loss:cleanup-failed");
      process.stderr.write(
        "yurumeet-bookmark-auth-loss:secondary-cleanup-failed\n",
      );
    }
  }
}
