import { createHash, randomUUID, webcrypto } from "node:crypto";

const TIMEOUT = 20_000;
const RATE_WAIT_MAX = 60_000;
const PASSWORD = "local-yurumeet-bookmark-fixture";
const SESSION_SALT = "yurumeet-bookmarks-session-salt-fixture";
let stage = "entry";

function need(ok, label) {
  if (!ok) throw new Error(`yurumeet-bookmarks:${label}`);
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function orderedRow(row) {
  return Object.fromEntries(
    Object.entries(row).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

async function bounded(promise, label, timeout = TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`yurumeet-bookmarks:${label}-timeout`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilEnabled(locator, label) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`yurumeet-bookmarks:${label}-timeout`);
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
      "auth-rate-limit-public-header-shape",
    );
    if (response.status() !== 429) {
      need(response.status() === 200, "readonly-provider-capacity-response");
      if (remaining >= 19) return { remaining, resetAt: reset, waited };
    }
    need(!waited, "one-readonly-reset-wait-only");
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

async function jsonResponse(response, label, accepted = [200]) {
  need(
    accepted.includes(response.status()),
    `${label}-http-status-${response.status()}`,
  );
  const bytes = await bounded(response.body(), `${label}-body-read`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`yurumeet-bookmarks:${label}-json`);
  }
  return { value, bodyBytes: bytes.length };
}

async function readAuth(page, origin) {
  const response = await page.request.get(`${origin}/api/auth/me`, {
    timeout: TIMEOUT,
  });
  if (response.status() !== 200)
    return { status: response.status(), actorApId: null };
  const parsed = await jsonResponse(response, "authenticated-principal-read");
  return { status: 200, actorApId: parsed.value.actor?.ap_id ?? null };
}

async function saltedSessionId(cookie, salt) {
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${cookie}`),
  );
  return `sha256:${Buffer.from(digest).toString("hex")}`;
}

async function readBookmarks(page, origin) {
  const response = await page.request.get(`${origin}/api/bookmarks`, {
    timeout: TIMEOUT,
  });
  const { value } = await jsonResponse(response, "authoritative-bookmark-list");
  need(
    Array.isArray(value.posts) &&
      typeof value.has_more === "boolean" &&
      (value.next_cursor == null || typeof value.next_cursor === "string"),
    "bookmark-list-public-contract",
  );
  return value;
}

function observe(page, origin) {
  const events = {
    bookmarkPosts: 0,
    bookmarkDeletes: 0,
    expectedDelete503Path: null,
    expectedDelete503: 0,
    expectedGet503Path: null,
    expectedGet503: 0,
    pageErrors: 0,
    documents: [],
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
    if (/^\/api\/posts\/[^/]+\/bookmark$/.test(url.pathname)) {
      if (request.method() === "POST") events.bookmarkPosts += 1;
      if (request.method() === "DELETE") events.bookmarkDeletes += 1;
    }
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
        if (
          url.pathname === events.expectedDelete503Path &&
          response.request().method() === "DELETE" &&
          response.status() === 503
        )
          events.expectedDelete503 += 1;
        else if (
          url.pathname === events.expectedGet503Path &&
          response.request().method() === "GET" &&
          response.status() === 503
        )
          events.expectedGet503 += 1;
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

async function loginOwner({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  onSessionIssued,
}) {
  stage = "browser-authentication";
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
  const anonymousCapacity = await rateCapacity(page, origin);
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
  need(loginResponse.status() === 200, "single-native-password-login-ack");
  await passwordInput.waitFor({ state: "hidden", timeout: TIMEOUT });
  const authenticatedCapacity = await rateCapacity(page, origin);
  const auth = await readAuth(page, origin);
  need(
    auth.status === 200 && typeof auth.actorApId === "string",
    "local-owner-session-established",
  );
  const jar = await context.cookies(origin);
  const cookie = jar.find((item) => item.name === "session");
  need(
    typeof cookie?.value === "string" && cookie.value.length > 0,
    "browser-session-cookie-issued",
  );
  const sessionId = await saltedSessionId(cookie.value, sessionSalt);
  const session = await bounded(
    db.prepare("SELECT * FROM sessions WHERE id = ?").bind(sessionId).first(),
    "issued-session-row",
  );
  need(
    session?.id === sessionId && session.member_id === auth.actorApId,
    "salted-cookie-session-row-belongs-to-current-owner",
  );
  need(
    typeof onSessionIssued === "function",
    "native-session-inventory-callback-required",
  );
  onSessionIssued(orderedRow(session));
  const owner = await bounded(
    db
      .prepare("SELECT ap_id, role, deleted_at FROM actors WHERE ap_id = ?")
      .bind(auth.actorApId)
      .first(),
    "local-owner-row",
  );
  need(
    owner?.ap_id === auth.actorApId &&
      owner.role === "owner" &&
      owner.deleted_at == null,
    "same-local-root-owner",
  );
  let actorRowsAtCheckpoint = await actorRows(db);
  const sessionRowsAtLogin = await sessionRows(db);
  return {
    context,
    page,
    events,
    actorApId: auth.actorApId,
    blockedOutbound: () => blockedOutbound,
    rate: { anonymousCapacity, authenticatedCapacity },
    async checkpointActorSetup(createdPosts) {
      const observed = await actorRows(db);
      need(
        sha(JSON.stringify(observed)) ===
          sha(
            JSON.stringify(
              actorsAfterCreatedPosts(
                actorRowsAtCheckpoint,
                auth.actorApId,
                createdPosts,
                observed,
              ),
            ),
          ),
        "setup-changes-only-exact-post-count-and-author-timestamp",
      );
      actorRowsAtCheckpoint = observed;
    },
    async verifyIdentityRows() {
      need(
        sha(JSON.stringify(await actorRows(db))) ===
          sha(JSON.stringify(actorRowsAtCheckpoint)),
        "bookmark-action-preserves-complete-actor-checkpoint",
      );
      need(
        sha(JSON.stringify(await sessionRows(db))) ===
          sha(JSON.stringify(sessionRowsAtLogin)),
        "case-preserves-all-session-rows-after-issued-login",
      );
    },
  };
}

async function createPost(page, origin, content, label) {
  const response = await page.request.post(`${origin}/api/posts`, {
    data: { content, visibility: "public" },
    headers: { origin },
    timeout: TIMEOUT,
  });
  const { value } = await jsonResponse(
    response,
    `${label}-real-local-post-create`,
  );
  const apId = value.post?.ap_id;
  need(
    typeof apId === "string" && apId.startsWith(`${origin}/`),
    `${label}-local-http-post-id`,
  );
  const readback = await page.request.get(
    `${origin}/api/posts/${encodeURIComponent(apId)}`,
    { timeout: TIMEOUT },
  );
  const post = await jsonResponse(readback, `${label}-real-post-readback`);
  need(
    post.value.post?.ap_id === apId &&
      post.value.post.content.includes(content),
    `${label}-post-readback-matches`,
  );
  return apId;
}

async function addBookmark(page, origin, apId, label) {
  const response = await page.request.post(
    `${origin}/api/posts/${encodeURIComponent(apId)}/bookmark`,
    { headers: { origin }, timeout: TIMEOUT },
  );
  const { value } = await jsonResponse(
    response,
    `${label}-real-bookmark-create`,
  );
  need(
    value.success === true && value.bookmarked === true,
    `${label}-bookmark-200-truth`,
  );
}

async function nativeRows(db, actorApId) {
  const result = await bounded(
    db
      .prepare(
        "SELECT actor_ap_id, object_ap_id, created_at FROM bookmarks WHERE actor_ap_id = ? ORDER BY object_ap_id",
      )
      .bind(actorApId)
      .all(),
    "native-bookmark-read",
  );
  return (result.results ?? []).map(orderedRow);
}

function byObjectApId(a, b) {
  return a.object_ap_id < b.object_ap_id
    ? -1
    : a.object_ap_id > b.object_ap_id
      ? 1
      : 0;
}

async function actorRows(db) {
  const result = await bounded(
    db.prepare("SELECT * FROM actors ORDER BY ap_id").all(),
    "native-actor-read",
  );
  return result.results ?? [];
}

async function sessionRows(db) {
  const result = await bounded(
    db.prepare("SELECT * FROM sessions ORDER BY id").all(),
    "native-session-read",
  );
  return (result.results ?? [])
    .map(orderedRow)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Real public Note creation increments its author's post_count and Drizzle update timestamp in Core's
// atomic object batch. Account for fixture setup while preserving every other
// actor field and every unrelated actor; bookmark removal itself changes none.
function actorsAfterCreatedPosts(rows, actorApId, createdPosts, observedRows) {
  need(
    Number.isInteger(createdPosts) && createdPosts >= 0,
    "expected-created-post-count",
  );
  need(
    rows.some(
      (row) => row.ap_id === actorApId && Number.isInteger(row.post_count),
    ),
    "expected-fixture-author-row",
  );
  const before = rows.find((row) => row.ap_id === actorApId);
  const observed = observedRows.find((row) => row.ap_id === actorApId);
  need(
    observed &&
      Number.isFinite(Date.parse(observed.updated_at)) &&
      Date.parse(observed.updated_at) >= Date.parse(before.updated_at) &&
      Date.parse(observed.updated_at) <= Date.now() + 1000,
    "fixture-author-timestamp-bounded-and-nondecreasing",
  );
  return rows.map((row) =>
    row.ap_id === actorApId
      ? {
          ...row,
          post_count: row.post_count + createdPosts,
          updated_at: observed.updated_at,
        }
      : row,
  );
}

function recordIssuedSession(inventory, row) {
  need(inventory instanceof Map, "expected-session-inventory-active");
  need(!inventory.has(row.id), "issued-session-id-is-new-not-preexisting");
  inventory.set(row.id, orderedRow(row));
}

async function runMinimumBookmarkRemoval({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
  mode,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const runId = randomUUID();
  const targetText = `yurumeet-bookmark-target-${runId}`;
  const unrelatedText = `yurumeet-bookmark-unrelated-${runId}`;
  let primaryFailure = false;
  try {
    stage = "snapshot-existing-state";
    let actorsBefore = await actorRows(db);
    const sessionsBefore = await sessionRows(db);
    const originalRows = await nativeRows(db, fixture.actorApId);
    const originalHash = sha(JSON.stringify(originalRows));
    stage = "create-posts-and-bookmarks";
    const targetApId = await createPost(
      fixture.page,
      origin,
      targetText,
      "target",
    );
    const unrelatedApId = await createPost(
      fixture.page,
      origin,
      unrelatedText,
      "unrelated",
    );
    await addBookmark(fixture.page, origin, targetApId, "target");
    await addBookmark(fixture.page, origin, unrelatedApId, "unrelated");
    await fixture.checkpointActorSetup(2);
    actorsBefore = await actorRows(db);
    stage = "open-created-bookmarks-in-native-ui";
    await fixture.page.goto(`${origin}/bookmarks`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const beforeApi = await readBookmarks(fixture.page, origin);
    need(
      beforeApi.posts.some((post) => post.ap_id === targetApId) &&
        beforeApi.posts.some((post) => post.ap_id === unrelatedApId),
      "two-created-bookmarks-visible-by-api",
    );
    const initialRows = await nativeRows(db, fixture.actorApId);
    const expectedPreDeleteRows = [
      ...originalRows,
      ...initialRows.filter(
        (row) =>
          row.object_ap_id === targetApId || row.object_ap_id === unrelatedApId,
      ),
    ].sort(byObjectApId);
    need(
      sha(JSON.stringify(initialRows)) ===
        sha(JSON.stringify(expectedPreDeleteRows)),
      "native-bookmark-additions-are-only-fixture-posts",
    );
    need(
      initialRows.some((row) => row.object_ap_id === targetApId) &&
        initialRows.some((row) => row.object_ap_id === unrelatedApId),
      "two-native-bookmark-rows-present",
    );
    const posts = fixture.page.locator("article.c-timeline-post");
    const targetCard = posts.filter({ hasText: targetText });
    const unrelatedCard = posts.filter({ hasText: unrelatedText });
    await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
    await unrelatedCard.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await targetCard.count()) === 1 && (await unrelatedCard.count()) === 1,
      "two-distinct-bookmark-cards-rendered",
    );
    stage = "remove-bookmark-through-visible-card";
    const initialDocuments = fixture.events.documents.length;
    const originalTargetToggle = await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .elementHandle();
    need(
      Boolean(originalTargetToggle),
      "target-bookmark-control-present-before-removal",
    );
    const deleteResponsePromise = fixture.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          response.request().method() === "DELETE" &&
          url.pathname ===
            `/api/posts/${encodeURIComponent(targetApId)}/bookmark`
        );
      },
      { timeout: TIMEOUT },
    );
    await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    const deleteResponse = await deleteResponsePromise;
    const { value: deleteValue, bodyBytes: deleteBodyBytes } =
      await jsonResponse(deleteResponse, "visible-card-unbookmark");
    need(
      deleteValue.success === true && deleteValue.bookmarked === false,
      "unbookmark-actual-http-200-truth",
    );
    const afterApi = await readBookmarks(fixture.page, origin);
    const afterRows = await nativeRows(db, fixture.actorApId);
    const expectedAfterRows = expectedPreDeleteRows.filter(
      (row) => row.object_ap_id !== targetApId,
    );
    const targetPost = await db
      .prepare("SELECT ap_id, content, deleted_at FROM objects WHERE ap_id = ?")
      .bind(targetApId)
      .first();
    const unrelatedPost = await db
      .prepare("SELECT ap_id, content, deleted_at FROM objects WHERE ap_id = ?")
      .bind(unrelatedApId)
      .first();
    need(
      !afterApi.posts.some((post) => post.ap_id === targetApId) &&
        afterApi.posts.some((post) => post.ap_id === unrelatedApId),
      "readonly-api-removes-only-target-bookmark",
    );
    need(
      !afterRows.some((row) => row.object_ap_id === targetApId) &&
        afterRows.some((row) => row.object_ap_id === unrelatedApId),
      "native-delete-removes-only-target-bookmark",
    );
    need(
      sha(JSON.stringify(afterRows)) === sha(JSON.stringify(expectedAfterRows)),
      "native-bookmark-state-exactly-target-removed",
    );
    need(
      targetPost?.ap_id === targetApId &&
        targetPost.deleted_at == null &&
        unrelatedPost?.ap_id === unrelatedApId &&
        unrelatedPost.deleted_at == null,
      "posts-preserved-after-unbookmark",
    );
    if (mode === "candidate") {
      await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
      need(
        !(await originalTargetToggle.evaluate(
          (element) => element.isConnected,
        )),
        "confirmed-removal-detaches-original-card-control",
      );
    }
    const targetStillRendered = (await targetCard.count()) === 1;
    need(
      (await unrelatedCard.count()) === 1,
      "unrelated-bookmark-card-remains",
    );
    need(
      fixture.events.bookmarkDeletes === 1 &&
        fixture.events.bookmarkPosts === 0,
      "one-native-delete-no-bookmark-retry",
    );
    need(
      fixture.events.documents.length === initialDocuments,
      "no-document-navigation-on-unbookmark",
    );
    const restoredOriginalRows = await nativeRows(db, fixture.actorApId);
    const originalsPreserved = originalRows.every((row) =>
      restoredOriginalRows.some(
        (after) =>
          after.object_ap_id === row.object_ap_id &&
          after.actor_ap_id === row.actor_ap_id,
      ),
    );
    need(
      originalsPreserved && sha(JSON.stringify(originalRows)) === originalHash,
      "preexisting-bookmarks-preserved",
    );
    need(
      sha(JSON.stringify(await actorRows(db))) ===
        sha(JSON.stringify(actorsBefore)),
      "bookmark-action-preserves-complete-actor-checkpoint",
    );
    need(
      sha(JSON.stringify(await sessionRows(db))) ===
        sha(JSON.stringify(sessionsBefore)),
      "all-existing-session-rows-preserved",
    );
    need(
      fixture.blockedOutbound() === 0 &&
        fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0,
      "no-external-requests-page-errors-or-unexpected-5xx",
    );
    const rowExpectation =
      mode === "baseline" ? targetStillRendered : !targetStillRendered;
    need(
      rowExpectation,
      mode === "baseline"
        ? "baseline-retains-known-bookmark-row"
        : "candidate-removes-confirmed-bookmark-row",
    );
    const checksForLane = [
      "password-authenticated-existing-owner",
      "real-posts-and-two-bookmarks-created-through-local-http",
      "bookmark-removal-http-200-api-and-native-row-agree",
      mode === "baseline"
        ? "baseline-target-card-remains-after-confirmed-removal"
        : "candidate-target-card-disappears-after-confirmed-removal",
      "unrelated-bookmark-and-post-preserved",
    ];
    checks.push(
      ...checksForLane.map((check) => `yurumeet-bookmarks-${mode}-${check}`),
    );
    return {
      mode,
      status: mode === "baseline" ? "EXPECTED_BASELINE_RED" : "PASSED",
      expectationMet: true,
      targetApId,
      unrelatedApId,
      delete: {
        status: deleteResponse.status(),
        bodyBytes: deleteBodyBytes,
        targetStillRendered,
        deleteCount: fixture.events.bookmarkDeletes,
      },
      api: {
        targetPresent: afterApi.posts.some((post) => post.ap_id === targetApId),
        unrelatedPresent: afterApi.posts.some(
          (post) => post.ap_id === unrelatedApId,
        ),
      },
      native: {
        targetBookmarkPresent: afterRows.some(
          (row) => row.object_ap_id === targetApId,
        ),
        unrelatedBookmarkPresent: afterRows.some(
          (row) => row.object_ap_id === unrelatedApId,
        ),
        targetPostPresent: Boolean(targetPost),
        unrelatedPostPresent: Boolean(unrelatedPost),
      },
      rate: fixture.rate,
      observations: fixture.events,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(`yurumeet-bookmarks:minimum-failed-at:${stage}\n`);
    throw error;
  } finally {
    try {
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "browser-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:browser-context-close-failed");
      process.stderr.write(
        "yurumeet-bookmarks:secondary-context-cleanup-failed\n",
      );
    }
  }
}

async function runStaleSnapshotPendingRemoval({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
  ackFirst = false,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const runId = randomUUID();
  const targetText = `yurumeet-bookmark-stale-target-${runId}`;
  const unrelatedText = `yurumeet-bookmark-stale-unrelated-${runId}`;
  let releaseSnapshot;
  let releaseDeleteAck;
  const snapshotHold = new Promise((resolve) => {
    releaseSnapshot = resolve;
  });
  const deleteAckHold = new Promise((resolve) => {
    releaseDeleteAck = resolve;
  });
  let snapshotEnteredResolve;
  let deleteAckEnteredResolve;
  const snapshotEntered = new Promise((resolve) => {
    snapshotEnteredResolve = resolve;
  });
  const deleteAckEntered = new Promise((resolve) => {
    deleteAckEnteredResolve = resolve;
  });
  let primaryFailure = false;
  const routeState = {
    snapshot: null,
    delete: null,
    deletePosts: 0,
    heldGets: 0,
  };
  try {
    stage = "stale-snapshot-setup";
    const targetApId = await createPost(
      fixture.page,
      origin,
      targetText,
      "stale-target",
    );
    const unrelatedApId = await createPost(
      fixture.page,
      origin,
      unrelatedText,
      "stale-unrelated",
    );
    await addBookmark(fixture.page, origin, targetApId, "stale-target");
    await addBookmark(fixture.page, origin, unrelatedApId, "stale-unrelated");
    await fixture.checkpointActorSetup(2);
    const beforeSnapshotRows = await nativeRows(db, fixture.actorApId);
    await fixture.page.goto(`${origin}/bookmarks`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const targetCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetText });
    const unrelatedCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: unrelatedText });
    await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
    await unrelatedCard.waitFor({ state: "visible", timeout: TIMEOUT });
    const originalToggle = await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .elementHandle();
    need(Boolean(originalToggle), "pre-refresh-pending-control-handle-present");

    await fixture.page.route("**/api/bookmarks**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.origin !== origin)
        return route.continue();
      routeState.heldGets += 1;
      const response = await route.fetch({ timeout: TIMEOUT });
      const body = await bounded(
        response.body(),
        "stale-bookmark-snapshot-body",
      );
      need(response.status() === 200, "held-real-bookmark-snapshot-http-200");
      const parsed = JSON.parse(body.toString("utf8"));
      need(
        parsed.posts?.some((post) => post.ap_id === targetApId),
        "held-snapshot-contains-current-target",
      );
      routeState.snapshot = {
        status: response.status(),
        bodyBytes: body.length,
        hasTarget: true,
      };
      snapshotEnteredResolve();
      await snapshotHold;
      await route.fulfill({ response, body });
    });
    await fixture.page.route("**/api/posts/*/bookmark", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "DELETE" ||
        url.origin !== origin ||
        url.pathname !== `/api/posts/${encodeURIComponent(targetApId)}/bookmark`
      )
        return route.continue();
      routeState.deletePosts += 1;
      const response = await route.fetch({ timeout: TIMEOUT });
      const body = await bounded(
        response.body(),
        "held-real-bookmark-delete-body",
      );
      const parsed = JSON.parse(body.toString("utf8"));
      need(
        response.status() === 200 &&
          parsed.success === true &&
          parsed.bookmarked === false,
        "held-real-delete-ack-committed-and-consumed",
      );
      const committedRows = await nativeRows(db, fixture.actorApId);
      need(
        !committedRows.some((row) => row.object_ap_id === targetApId) &&
          committedRows.some((row) => row.object_ap_id === unrelatedApId),
        "native-delete-committed-before-held-browser-ack",
      );
      routeState.delete = {
        status: response.status(),
        bodyBytes: body.length,
        targetNativeAbsent: true,
      };
      deleteAckEnteredResolve();
      await deleteAckHold;
      await route.fulfill({ response, body });
    });

    stage = "hold-readonly-snapshot";
    await fixture.page
      .getByRole("button", { name: "最新に更新", exact: true })
      .click({ timeout: TIMEOUT });
    await bounded(snapshotEntered, "stale-snapshot-held");
    need(routeState.heldGets === 1, "one-real-readonly-snapshot-held");
    stage = "commit-delete-while-ack-held";
    await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    await bounded(deleteAckEntered, "real-delete-ack-held");
    need(routeState.deletePosts === 1, "single-real-delete-in-flight");
    if (ackFirst) {
      stage = "release-delete-ack-before-stale-snapshot";
      releaseDeleteAck();
      await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
      stage = "release-stale-snapshot-after-confirmed-removal";
      releaseSnapshot();
      await waitUntilEnabled(
        fixture.page.getByRole("button", { name: "最新に更新", exact: true }),
        "ack-first-refresh-finished",
      );
      await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
      need(
        !(await originalToggle.evaluate((element) => element.isConnected)),
        "confirmed-removal-target-stays-detached-after-stale-snapshot",
      );
    } else {
      stage = "release-stale-snapshot-while-delete-pending";
      releaseSnapshot();
      await waitUntilEnabled(
        fixture.page.getByRole("button", { name: "最新に更新", exact: true }),
        "pending-refresh-finished",
      );
      await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
      const remountedToggle = targetCard.getByRole("button", {
        name: "ブックマークを外す",
      });
      await remountedToggle.waitFor({ state: "visible", timeout: TIMEOUT });
      need(
        !(await originalToggle.evaluate((element) => element.isConnected)),
        "stale-refresh-replaces-original-target-card",
      );
      need(
        await remountedToggle.isDisabled(),
        "pending-bookmark-control-remains-disabled-after-stale-remount",
      );
      await remountedToggle.evaluate((element) =>
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        ),
      );
      await fixture.page.waitForTimeout(250);
      need(
        routeState.deletePosts === 1 && fixture.events.bookmarkDeletes === 1,
        "remounted-disabled-control-dispatch-does-not-send-second-delete",
      );
      stage = "release-delete-ack-and-apply-removal-fence";
      releaseDeleteAck();
      await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
    }
    need(
      (await unrelatedCard.count()) === 1,
      "stale-refresh-preserves-unrelated-card",
    );
    const finalApi = await readBookmarks(fixture.page, origin);
    const finalRows = await nativeRows(db, fixture.actorApId);
    const expectedRows = beforeSnapshotRows.filter(
      (row) => row.object_ap_id !== targetApId,
    );
    need(
      !finalApi.posts.some((post) => post.ap_id === targetApId) &&
        finalApi.posts.some((post) => post.ap_id === unrelatedApId),
      "stale-snapshot-cannot-override-api-authority",
    );
    need(
      sha(JSON.stringify(finalRows)) === sha(JSON.stringify(expectedRows)),
      "stale-snapshot-final-native-rows-exact",
    );
    need(
      routeState.heldGets === 1 &&
        routeState.deletePosts === 1 &&
        fixture.events.bookmarkDeletes === 1,
      "one-held-get-one-delete-no-automatic-retry",
    );
    need(
      fixture.blockedOutbound() === 0 &&
        fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0,
      "stale-case-no-external-requests-page-errors-or-unexpected-5xx",
    );
    checks.push(
      `yurumeet-bookmarks-candidate-${ackFirst ? "delete-ack-before-stale-get-release" : "stale-get-release-while-delete-pending"}-no-resurrection`,
    );
    if (!ackFirst)
      checks.push(
        "yurumeet-bookmarks-candidate-remounted-pending-control-stays-disabled-no-second-delete",
      );
    return {
      status: "PASSED",
      order: ackFirst
        ? "delete-ack-then-stale-get-release"
        : "stale-get-release-while-delete-ack-pending",
      staleSnapshot: routeState.snapshot,
      delete: routeState.delete,
      heldGets: routeState.heldGets,
      deletePosts: routeState.deletePosts,
      remountedControlStayedDisabled: !ackFirst,
      finalTargetPresentInApi: false,
      finalTargetPresentInNative: false,
      observations: fixture.events,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(
      `yurumeet-bookmarks:stale-snapshot-failed-at:${stage}\n`,
    );
    throw error;
  } finally {
    releaseSnapshot();
    releaseDeleteAck();
    try {
      await bounded(
        fixture.page.unroute("**/api/bookmarks**"),
        "stale-get-unroute",
      );
      await bounded(
        fixture.page.unroute("**/api/posts/*/bookmark"),
        "stale-delete-unroute",
      );
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "stale-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:stale-case-cleanup-failed");
      process.stderr.write(
        "yurumeet-bookmarks:secondary-stale-cleanup-failed\n",
      );
    }
  }
}

async function runNonforwarded503({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const runId = randomUUID();
  const targetText = `yurumeet-bookmark-503-target-${runId}`;
  const unrelatedText = `yurumeet-bookmark-503-unrelated-${runId}`;
  let release;
  let enteredResolve;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  let intercepted = 0;
  let primaryFailure = false;
  try {
    stage = "nonforwarded-503-setup";
    const targetApId = await createPost(
      fixture.page,
      origin,
      targetText,
      "503-target",
    );
    const unrelatedApId = await createPost(
      fixture.page,
      origin,
      unrelatedText,
      "503-unrelated",
    );
    await addBookmark(fixture.page, origin, targetApId, "503-target");
    await addBookmark(fixture.page, origin, unrelatedApId, "503-unrelated");
    await fixture.checkpointActorSetup(2);
    await fixture.page.goto(`${origin}/bookmarks`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const targetCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetText });
    const unrelatedCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: unrelatedText });
    await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
    await unrelatedCard.waitFor({ state: "visible", timeout: TIMEOUT });
    const beforeRows = await nativeRows(db, fixture.actorApId);
    const targetPath = `/api/posts/${encodeURIComponent(targetApId)}/bookmark`;
    fixture.events.expectedDelete503Path = targetPath;
    await fixture.page.route("**/api/posts/*/bookmark", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "DELETE" ||
        url.origin !== origin ||
        url.pathname !== targetPath ||
        ++intercepted > 1
      )
        return route.continue();
      enteredResolve();
      await held;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      });
    });
    const failureResponsePromise = fixture.page.waitForResponse(
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
    await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    await bounded(entered, "fixed-503-request-held");
    release();
    const failureResponse = await failureResponsePromise;
    await jsonResponse(failureResponse, "fixed-nonforwarded-delete-503", [503]);
    const errorNotice = fixture.page.getByText(
      "ブックマークの操作結果を確認できませんでした。一覧を再読み込みして確認してください",
      { exact: true },
    );
    await errorNotice.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await targetCard.count()) === 1 &&
        (await targetCard
          .getByRole("button", { name: "ブックマークを外す" })
          .getAttribute("aria-pressed")) === "true",
      "503-keeps-target-row-and-bookmark-flag",
    );
    const afterFailureApi = await readBookmarks(fixture.page, origin);
    const afterFailureRows = await nativeRows(db, fixture.actorApId);
    need(
      afterFailureApi.posts.some((post) => post.ap_id === targetApId) &&
        afterFailureApi.posts.some((post) => post.ap_id === unrelatedApId),
      "503-keeps-api-bookmarks",
    );
    need(
      sha(JSON.stringify(afterFailureRows)) === sha(JSON.stringify(beforeRows)),
      "503-preserves-exact-native-bookmark-rows",
    );
    await fixture.page.waitForTimeout(250);
    need(
      fixture.events.bookmarkDeletes === 1 &&
        fixture.events.expectedDelete503 === 1,
      "503-does-not-auto-retry",
    );
    const retryResponsePromise = fixture.page.waitForResponse(
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
    await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    const retry = await retryResponsePromise;
    const { value: retryBody } = await jsonResponse(
      retry,
      "explicit-delete-retry",
    );
    need(
      retry.status() === 200 &&
        retryBody.success === true &&
        retryBody.bookmarked === false,
      "explicit-retry-real-200",
    );
    await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
    const finalApi = await readBookmarks(fixture.page, origin);
    const finalRows = await nativeRows(db, fixture.actorApId);
    const expectedFinalRows = afterFailureRows.filter(
      (row) => row.object_ap_id !== targetApId,
    );
    need(
      !finalApi.posts.some((post) => post.ap_id === targetApId) &&
        finalApi.posts.some((post) => post.ap_id === unrelatedApId),
      "explicit-retry-removes-only-target-from-api",
    );
    need(
      !finalRows.some((row) => row.object_ap_id === targetApId) &&
        finalRows.some((row) => row.object_ap_id === unrelatedApId),
      "explicit-retry-removes-only-target-native-row",
    );
    need(
      sha(JSON.stringify(finalRows)) === sha(JSON.stringify(expectedFinalRows)),
      "explicit-retry-preserves-exact-unrelated-native-rows",
    );
    need(
      fixture.events.bookmarkDeletes === 2 &&
        fixture.events.expectedDelete503 === 1,
      "one-failed-delete-one-explicit-retry",
    );
    need(
      fixture.blockedOutbound() === 0 &&
        fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0,
      "503-case-no-external-requests-page-errors-or-unexpected-5xx",
    );
    checks.push(
      "yurumeet-bookmarks-candidate-nonforwarded-503-preserves-row-state-and-requires-explicit-retry",
    );
    return {
      status: "PASSED",
      failureStatus: 503,
      retryStatus: retry.status(),
      deletePosts: fixture.events.bookmarkDeletes,
      expected503: fixture.events.expectedDelete503,
      targetStillRenderedAfterFailure: true,
      observations: fixture.events,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(
      `yurumeet-bookmarks:nonforwarded-503-failed-at:${stage}\n`,
    );
    throw error;
  } finally {
    release();
    try {
      await bounded(
        fixture.page.unroute("**/api/posts/*/bookmark"),
        "503-route-unroute",
      );
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "503-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:503-case-cleanup-failed");
      process.stderr.write("yurumeet-bookmarks:secondary-503-cleanup-failed\n");
    }
  }
}

async function runGeneralTimelineRemoval({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const text = `yurumeet-bookmark-timeline-${randomUUID()}`;
  let primaryFailure = false;
  try {
    stage = "general-timeline-setup";
    const targetApId = await createPost(fixture.page, origin, text, "timeline");
    await addBookmark(fixture.page, origin, targetApId, "timeline");
    await fixture.checkpointActorSetup(1);
    const beforeRows = await nativeRows(db, fixture.actorApId);
    const path = `/api/posts/${encodeURIComponent(targetApId)}/bookmark`;
    await fixture.page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const timelineTab = fixture.page.getByRole("link", {
      name: "タイムライン",
      exact: true,
    });
    await timelineTab.waitFor({ state: "visible", timeout: TIMEOUT });
    if (new URL(fixture.page.url()).searchParams.get("tab") !== "timeline")
      await timelineTab.click({ timeout: TIMEOUT });
    await fixture.page.waitForURL(
      (url) => url.searchParams.get("tab") === "timeline",
      { timeout: TIMEOUT },
    );
    const card = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: text });
    await card.waitFor({ state: "visible", timeout: TIMEOUT });
    const responsePromise = fixture.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          response.request().method() === "DELETE" &&
          url.pathname === path
        );
      },
      { timeout: TIMEOUT },
    );
    stage = "general-timeline-unbookmark";
    await card
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    const response = await responsePromise;
    const { value } = await jsonResponse(response, "timeline-unbookmark");
    need(
      response.status() === 200 &&
        value.success === true &&
        value.bookmarked === false,
      "timeline-unbookmark-real-200",
    );
    await card.waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await card
        .getByRole("button", { name: "ブックマーク" })
        .getAttribute("aria-pressed")) === "false",
      "timeline-card-remains-unbookmarked",
    );
    const api = await readBookmarks(fixture.page, origin);
    const rows = await nativeRows(db, fixture.actorApId);
    const expectedRows = beforeRows.filter(
      (row) => row.object_ap_id !== targetApId,
    );
    const post = await bounded(
      db
        .prepare("SELECT ap_id, deleted_at FROM objects WHERE ap_id = ?")
        .bind(targetApId)
        .first(),
      "timeline-post-row",
    );
    need(
      !api.posts.some((item) => item.ap_id === targetApId) &&
        !rows.some((row) => row.object_ap_id === targetApId),
      "timeline-unbookmark-removes-only-bookmark-edge",
    );
    need(
      sha(JSON.stringify(rows)) === sha(JSON.stringify(expectedRows)),
      "timeline-unbookmark-preserves-exact-unrelated-native-rows",
    );
    need(
      post?.ap_id === targetApId && post.deleted_at == null,
      "timeline-unbookmark-preserves-post",
    );
    need(
      fixture.events.bookmarkDeletes === 1 &&
        fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0 &&
        fixture.blockedOutbound() === 0,
      "timeline-case-clean-native-observation",
    );
    checks.push(
      "yurumeet-bookmarks-candidate-general-timeline-unbookmark-retains-post-card",
    );
    return {
      status: "PASSED",
      deleteStatus: response.status(),
      cardRetained: true,
      targetPresentInBookmarks: false,
      postPreserved: true,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(`yurumeet-bookmarks:timeline-failed-at:${stage}\n`);
    throw error;
  } finally {
    try {
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "timeline-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:timeline-cleanup-failed");
      process.stderr.write(
        "yurumeet-bookmarks:secondary-timeline-cleanup-failed\n",
      );
    }
  }
}

async function runAckLoss({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const runId = randomUUID();
  const targetText = `yurumeet-bookmark-ack-loss-target-${runId}`;
  const unrelatedText = `yurumeet-bookmark-ack-loss-unrelated-${runId}`;
  let primaryFailure = false;
  let committed = null;
  try {
    stage = "ack-loss-setup";
    const targetApId = await createPost(
      fixture.page,
      origin,
      targetText,
      "ack-target",
    );
    const unrelatedApId = await createPost(
      fixture.page,
      origin,
      unrelatedText,
      "ack-unrelated",
    );
    await addBookmark(fixture.page, origin, targetApId, "ack-target");
    await addBookmark(fixture.page, origin, unrelatedApId, "ack-unrelated");
    await fixture.checkpointActorSetup(2);
    const beforeAckRows = await nativeRows(db, fixture.actorApId);
    await fixture.page.goto(`${origin}/bookmarks`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const targetCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetText });
    const unrelatedCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: unrelatedText });
    await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
    await unrelatedCard.waitFor({ state: "visible", timeout: TIMEOUT });
    const targetPath = `/api/posts/${encodeURIComponent(targetApId)}/bookmark`;
    let forwarded = 0;
    await fixture.page.route("**/api/posts/*/bookmark", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() !== "DELETE" ||
        url.origin !== origin ||
        url.pathname !== targetPath ||
        forwarded > 0
      )
        return route.continue();
      forwarded += 1;
      const response = await route.fetch({ timeout: TIMEOUT });
      const body = await bounded(response.body(), "ack-loss-real-delete-body");
      const parsed = JSON.parse(body.toString("utf8"));
      need(
        response.status() === 200 &&
          parsed.success === true &&
          parsed.bookmarked === false,
        "ack-loss-real-delete-200-consumed",
      );
      const rows = await nativeRows(db, fixture.actorApId);
      need(
        !rows.some((row) => row.object_ap_id === targetApId) &&
          rows.some((row) => row.object_ap_id === unrelatedApId),
        "ack-loss-target-native-row-absent-before-browser-drop",
      );
      committed = {
        status: response.status(),
        bodyBytes: body.length,
        bodySha256: sha(body),
        targetNativeAbsent: true,
      };
      await route.abort("failed");
    });
    stage = "ack-loss-browser-request";
    await targetCard
      .getByRole("button", { name: "ブックマークを外す" })
      .click({ timeout: TIMEOUT });
    await fixture.page
      .getByText(
        "ブックマークの操作結果を確認できませんでした。一覧を再読み込みして確認してください",
        { exact: true },
      )
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      committed?.status === 200 && committed.targetNativeAbsent,
      "ack-loss-real-commit-before-ui-unknown-guidance",
    );
    need(
      (await targetCard.count()) === 1 &&
        (await targetCard
          .getByRole("button", { name: "ブックマークを外す" })
          .getAttribute("aria-pressed")) === "true",
      "ack-loss-keeps-card-and-unknown-bookmark-flag",
    );
    await fixture.page.waitForTimeout(250);
    need(
      fixture.events.bookmarkDeletes === 1 && forwarded === 1,
      "ack-loss-no-automatic-delete-retry",
    );
    const nativeRowsAfterCommit = await nativeRows(db, fixture.actorApId);
    const expectedAfterCommitRows = beforeAckRows.filter(
      (row) => row.object_ap_id !== targetApId,
    );
    const beforeManualApi = nativeRowsAfterCommit.some(
      (row) => row.object_ap_id === targetApId,
    );
    need(
      !beforeManualApi,
      "ack-loss-native-row-still-absent-before-manual-reload",
    );
    need(
      sha(JSON.stringify(nativeRowsAfterCommit)) ===
        sha(JSON.stringify(expectedAfterCommitRows)),
      "ack-loss-real-commit-preserves-exact-unrelated-native-rows",
    );
    stage = "manual-readonly-reconciliation";
    await fixture.page
      .getByRole("button", { name: "最新に更新", exact: true })
      .click({ timeout: TIMEOUT });
    await targetCard.waitFor({ state: "detached", timeout: TIMEOUT });
    const api = await readBookmarks(fixture.page, origin);
    const rows = await nativeRows(db, fixture.actorApId);
    need(
      !api.posts.some((post) => post.ap_id === targetApId) &&
        api.posts.some((post) => post.ap_id === unrelatedApId),
      "manual-readonly-refresh-matches-bookmark-api",
    );
    need(
      !rows.some((row) => row.object_ap_id === targetApId) &&
        rows.some((row) => row.object_ap_id === unrelatedApId),
      "manual-readonly-refresh-matches-native-state",
    );
    need(
      sha(JSON.stringify(rows)) ===
        sha(JSON.stringify(expectedAfterCommitRows)),
      "ack-loss-manual-refresh-preserves-exact-native-rows",
    );
    need(
      fixture.events.bookmarkDeletes === 1 &&
        fixture.events.bookmarkPosts === 0,
      "manual-readonly-refresh-does-not-retry-mutation",
    );
    need(
      (await unrelatedCard.count()) === 1 &&
        fixture.blockedOutbound() === 0 &&
        fixture.events.pageErrors === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0,
      "ack-loss-unrelated-state-and-browser-clean",
    );
    checks.push(
      "yurumeet-bookmarks-candidate-ack-loss-commit-retained-unknown-until-readonly-reload",
    );
    return {
      status: "PASSED",
      commit: committed,
      browserDeletePosts: fixture.events.bookmarkDeletes,
      targetPresentBeforeManualReload: true,
      targetPresentAfterManualReload: false,
      finalUnrelatedPresent: true,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(`yurumeet-bookmarks:ack-loss-failed-at:${stage}\n`);
    throw error;
  } finally {
    try {
      await bounded(
        fixture.page.unroute("**/api/posts/*/bookmark"),
        "ack-loss-route-unroute",
      );
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "ack-loss-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:ack-loss-cleanup-failed");
      process.stderr.write(
        "yurumeet-bookmarks:secondary-ack-loss-cleanup-failed\n",
      );
    }
  }
}

async function runRefreshFailurePreservesRows({
  browser,
  db,
  origin,
  password,
  sessionSalt,
  sessionInventory,
  checks,
}) {
  const fixture = await loginOwner({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    onSessionIssued: (row) => recordIssuedSession(sessionInventory, row),
  });
  const runId = randomUUID();
  const targetText = `yurumeet-bookmark-refresh-error-target-${runId}`;
  const unrelatedText = `yurumeet-bookmark-refresh-error-unrelated-${runId}`;
  let attempts = 0;
  let primaryFailure = false;
  try {
    stage = "refresh-failure-setup";
    const targetApId = await createPost(
      fixture.page,
      origin,
      targetText,
      "refresh-error-target",
    );
    const unrelatedApId = await createPost(
      fixture.page,
      origin,
      unrelatedText,
      "refresh-error-unrelated",
    );
    await addBookmark(fixture.page, origin, targetApId, "refresh-error-target");
    await addBookmark(
      fixture.page,
      origin,
      unrelatedApId,
      "refresh-error-unrelated",
    );
    await fixture.checkpointActorSetup(2);
    await fixture.page.goto(`${origin}/bookmarks`, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });
    const targetCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: targetText });
    const unrelatedCard = fixture.page
      .locator("article.c-timeline-post")
      .filter({ hasText: unrelatedText });
    await targetCard.waitFor({ state: "visible", timeout: TIMEOUT });
    await unrelatedCard.waitFor({ state: "visible", timeout: TIMEOUT });
    const beforeRows = await nativeRows(db, fixture.actorApId);
    fixture.events.expectedGet503Path = "/api/bookmarks";
    await fixture.page.route("**/api/bookmarks**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.origin !== origin)
        return route.continue();
      attempts += 1;
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporarily unavailable" }),
        });
      return route.continue();
    });
    stage = "refresh-readonly-503";
    const failedRead = fixture.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          response.request().method() === "GET" &&
          url.pathname === "/api/bookmarks"
        );
      },
      { timeout: TIMEOUT },
    );
    await fixture.page
      .getByRole("button", { name: "最新に更新", exact: true })
      .click({ timeout: TIMEOUT });
    need(
      (await failedRead).status() === 503,
      "manual-refresh-one-fixed-readonly-503",
    );
    await fixture.page
      .getByRole("status")
      .getByText(
        "ブックマークを確認できませんでした。表示中の一覧は更新されていません",
        { exact: true },
      )
      .waitFor({ state: "visible", timeout: TIMEOUT });
    need(
      (await targetCard.count()) === 1 && (await unrelatedCard.count()) === 1,
      "refresh-failure-retains-both-rendered-bookmark-rows",
    );
    const apiAfterFailure = await readBookmarks(fixture.page, origin);
    const rowsAfterFailure = await nativeRows(db, fixture.actorApId);
    need(
      apiAfterFailure.posts.some((post) => post.ap_id === targetApId) &&
        apiAfterFailure.posts.some((post) => post.ap_id === unrelatedApId),
      "readonly-refresh-failure-leaves-server-bookmarks",
    );
    need(
      sha(JSON.stringify(rowsAfterFailure)) === sha(JSON.stringify(beforeRows)),
      "readonly-refresh-failure-preserves-exact-native-rows",
    );
    need(
      fixture.events.expectedGet503 === 1 &&
        fixture.events.bookmarkDeletes === 0 &&
        fixture.events.bookmarkPosts === 0,
      "refresh-failure-is-one-read-only-request-no-mutation",
    );
    stage = "manual-refresh-retry";
    const retryRead = fixture.page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          url.origin === origin &&
          response.request().method() === "GET" &&
          url.pathname === "/api/bookmarks"
        );
      },
      { timeout: TIMEOUT },
    );
    await fixture.page
      .getByRole("status")
      .getByRole("button", { name: "再読み込み" })
      .click({ timeout: TIMEOUT });
    const success = await retryRead;
    need(
      success.status() === 200 && attempts === 2,
      "explicit-refresh-retry-real-200-only",
    );
    await fixture.page
      .getByRole("status")
      .waitFor({ state: "hidden", timeout: TIMEOUT });
    need(
      (await targetCard.count()) === 1 && (await unrelatedCard.count()) === 1,
      "successful-read-retry-retains-actual-bookmarks",
    );
    const finalApi = await readBookmarks(fixture.page, origin);
    const finalRows = await nativeRows(db, fixture.actorApId);
    need(
      finalApi.posts.some((post) => post.ap_id === targetApId) &&
        finalApi.posts.some((post) => post.ap_id === unrelatedApId),
      "successful-read-retry-matches-bookmark-api",
    );
    need(
      sha(JSON.stringify(finalRows)) === sha(JSON.stringify(beforeRows)),
      "successful-read-retry-preserves-exact-native-rows",
    );
    need(
      fixture.events.bookmarkDeletes === 0 &&
        fixture.events.bookmarkPosts === 0 &&
        fixture.events.unexpectedFiveHundreds.length === 0,
      "refresh-retry-does-not-mutate-bookmarks",
    );
    need(
      fixture.blockedOutbound() === 0 && fixture.events.pageErrors === 0,
      "refresh-failure-case-no-external-or-page-errors",
    );
    checks.push(
      "yurumeet-bookmarks-candidate-readonly-refresh-503-preserves-visible-bookmarks-and-retry-is-read-only",
    );
    return {
      status: "PASSED",
      failedReadStatus: 503,
      retryStatus: success.status(),
      attempts,
      retainedCards: 2,
      bookmarkMutations: 0,
    };
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(
      `yurumeet-bookmarks:refresh-failure-failed-at:${stage}\n`,
    );
    throw error;
  } finally {
    try {
      await bounded(
        fixture.page.unroute("**/api/bookmarks**"),
        "refresh-failure-route-unroute",
      );
      await fixture.verifyIdentityRows();
      await bounded(fixture.context.close(), "refresh-failure-context-close");
    } catch {
      if (!primaryFailure)
        throw new Error("yurumeet-bookmarks:refresh-failure-cleanup-failed");
      process.stderr.write(
        "yurumeet-bookmarks:secondary-refresh-failure-cleanup-failed\n",
      );
    }
  }
}

/** Candidate-only native-browser proof for the confirmed bookmark removal boundary. */
export async function qualifyBookmarks({
  browser,
  worker,
  db,
  origin,
  checks = [],
  password = PASSWORD,
  sessionSalt = SESSION_SALT,
  mode,
}) {
  need(
    browser && worker && db && typeof origin === "string",
    "browser-worker-db-origin-required",
  );
  need(
    mode === "baseline" || mode === "candidate",
    "baseline-or-candidate-mode-required",
  );
  const checkStart = checks.length;
  const beforeActors = await bounded(
    db.prepare("SELECT COUNT(*) AS count FROM actors").first(),
    "actor-count-before",
  );
  need(
    Number(beforeActors?.count) >= 1,
    "existing-runtime-local-owner-required",
  );
  const actorsBefore = await actorRows(db);
  const sessionsBefore = await sessionRows(db);
  const expectedSessionRows = new Map(
    sessionsBefore.map((row) => [row.id, row]),
  );
  const baselineSessionCount = sessionsBefore.length;
  const expectedLogins = mode === "baseline" ? 1 : 7;
  need(
    typeof sessionSalt === "string" && sessionSalt.length > 0,
    "session-salt-required",
  );
  const minimum = await runMinimumBookmarkRemoval({
    browser,
    db,
    origin,
    password,
    sessionSalt,
    sessionInventory: expectedSessionRows,
    checks,
    mode,
  });
  const staleSnapshot =
    mode === "candidate"
      ? await runStaleSnapshotPendingRemoval({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
        })
      : null;
  const staleSnapshotAfterAck =
    mode === "candidate"
      ? await runStaleSnapshotPendingRemoval({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
          ackFirst: true,
        })
      : null;
  const nonforwarded503 =
    mode === "candidate"
      ? await runNonforwarded503({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
        })
      : null;
  const timeline =
    mode === "candidate"
      ? await runGeneralTimelineRemoval({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
        })
      : null;
  const ackLoss =
    mode === "candidate"
      ? await runAckLoss({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
        })
      : null;
  const refreshFailure =
    mode === "candidate"
      ? await runRefreshFailurePreservesRows({
          browser,
          db,
          origin,
          password,
          sessionSalt,
          sessionInventory: expectedSessionRows,
          checks,
        })
      : null;
  const afterActors = await bounded(
    db.prepare("SELECT COUNT(*) AS count FROM actors").first(),
    "actor-count-after",
  );
  need(
    Number(afterActors?.count) === Number(beforeActors.count),
    "bookmark-fixture-does-not-create-actors",
  );
  const issuedRows = Array.from(expectedSessionRows.values()).filter(
    (row) => !sessionsBefore.some((prior) => prior.id === row.id),
  );
  const fixtureAuthors = new Set(issuedRows.map((row) => row.member_id));
  need(
    fixtureAuthors.size === 1,
    "independent-password-lanes-use-same-fixture-author",
  );
  const fixtureAuthor = issuedRows[0]?.member_id;
  const expectedCreatedPosts = mode === "baseline" ? 2 : 13;
  const actualActorRows = await actorRows(db);
  need(
    sha(JSON.stringify(actualActorRows)) ===
      sha(
        JSON.stringify(
          actorsAfterCreatedPosts(
            actorsBefore,
            fixtureAuthor,
            expectedCreatedPosts,
            actualActorRows,
          ),
        ),
      ),
    "all-native-actor-fields-preserved-except-exact-fixture-post-count-and-setup-timestamp",
  );
  const expectedSessionRowsSorted = Array.from(
    expectedSessionRows.values(),
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const actualSessionRows = await sessionRows(db);
  need(
    expectedSessionRows.size === baselineSessionCount + expectedLogins,
    "expected-independent-password-login-count",
  );
  need(
    actualSessionRows.length === baselineSessionCount + expectedLogins,
    "exact-native-session-count-after-fixture",
  );
  need(
    sha(JSON.stringify(actualSessionRows.map(orderedRow))) ===
      sha(JSON.stringify(expectedSessionRowsSorted.map(orderedRow))),
    "all-native-session-rows-match-prior-and-issued-cookie-inventory",
  );
  return {
    mode,
    status: minimum.status,
    minimum,
    staleSnapshot,
    staleSnapshotAfterAck,
    nonforwarded503,
    timeline,
    ackLoss,
    refreshFailure,
    checks: checks.slice(checkStart),
    actorCount: Number(afterActors.count),
    createdPublicNotes: expectedCreatedPosts,
    sessions: {
      baselineCount: baselineSessionCount,
      issuedCount: expectedLogins,
      finalCount: actualSessionRows.length,
      exactInventorySha256: sha(JSON.stringify(actualSessionRows)),
    },
  };
}
