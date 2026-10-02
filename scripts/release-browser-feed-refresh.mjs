// Real Chrome/native-D1 regression for a stale paginated feed response racing
// a user-triggered refresh. Every response below comes from the local Worker.

function requireFeedRefresh(condition, message) {
  if (!condition) throw new Error(`browser-feed-refresh ${message}`);
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, label };
}

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`browser-feed-refresh ${label} timed out`)),
      timeout,
    );
  });
  deadline.catch(() => {});
  promise.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function requireResponse(
  page,
  pathname,
  method,
  label,
  { timeout = 15_000, query = {} } = {},
) {
  const origin = new URL(page.url()).origin;
  const pending = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        url.origin === origin &&
        url.pathname === pathname &&
        response.request().method() === method &&
        Object.entries(query).every(([key, expected]) =>
          expected === null
            ? !url.searchParams.has(key)
            : url.searchParams.get(key) === expected,
        )
      );
    },
    { timeout },
  );
  pending.catch(() => {});
  return pending.catch((error) => {
    throw new Error(
      `browser-feed-refresh ${label} response missing: ${String(error)}`,
    );
  });
}

async function countActorsAndSessions(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function readObject(db, apId) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at, published FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
}

async function nextPublishedSecond() {
  const second = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + 2_500;
  while (Math.floor(Date.now() / 1000) === second && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  requireFeedRefresh(
    Math.floor(Date.now() / 1000) > second,
    "could not cross the server publication timestamp boundary",
  );
}

async function createPublicPost(page, db, origin, actorApId, content) {
  const responsePromise = requireResponse(
    page,
    "/api/posts",
    "POST",
    "real composer post",
  );
  await page.getByRole("button", { name: "投稿を作成", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "投稿を作成" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("いまどうしてる?").fill(content);
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  const post = body?.post;
  requireFeedRefresh(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public",
    `real composer did not create the expected public Note (${response.status()})`,
  );
  const native = await readObject(db, post.ap_id);
  requireFeedRefresh(
    native?.ap_id === post.ap_id &&
      native.type === "Note" &&
      native.attributed_to === actorApId &&
      native.content === content &&
      native.visibility === "public" &&
      native.deleted_at === null,
    "real composer Note is absent or inconsistent in native D1",
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { apId: post.ap_id, content, native };
}

async function selectTimeline(page) {
  const tab = page.getByRole("link", { name: "タイムライン", exact: true });
  await tab.waitFor({ state: "visible", timeout: 10_000 });
  if (new URL(page.url()).searchParams.get("tab") !== "timeline") {
    await tab.click();
  }
  await page.waitForURL((url) => url.searchParams.get("tab") === "timeline", {
    timeout: 10_000,
  });
}

async function installTimelinePagerObserverControl(page) {
  await page.addInitScript(() => {
    const prototype = IntersectionObserver.prototype;
    const observe = prototype.observe;
    window.__feedRefreshIntersectionControl = {
      timelinePagerSuppressed: true,
      timelinePagerObserveCalls: 0,
      otherTargetsDelegated: 0,
    };
    prototype.observe = function (target) {
      if (target instanceof Element && target.matches(".p-timeline-more")) {
        window.__feedRefreshIntersectionControl.timelinePagerObserveCalls += 1;
        return;
      }
      window.__feedRefreshIntersectionControl.otherTargetsDelegated += 1;
      return observe.call(this, target);
    };
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await selectTimeline(page);
  await page.getByRole("button", { name: "最新に更新", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.waitForFunction(
    () =>
      !document.querySelector(".p-timeline-refresh")?.hasAttribute("disabled"),
    null,
    { timeout: 10_000 },
  );
}

async function waitRendered(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

function installRealResponseRouting(page, origin) {
  const ready = gate("real delayed older Worker response ready");
  const release = gate("delayed older response released");
  const delivered = gate("delayed older response delivered to browser");
  const finished = gate("delayed older route finished");
  const records = [];
  let error = null;
  let oldHeld = false;
  let active = 0;
  let firstOldFinished = false;

  const finish = (heldPage) => {
    active -= 1;
    if (heldPage) firstOldFinished = true;
    if (firstOldFinished && active === 0) finished.resolve();
  };

  const handler = async (route) => {
    const request = route.request();
    const sourceUrl = new URL(request.url());
    if (
      request.method() !== "GET" ||
      sourceUrl.origin !== origin ||
      sourceUrl.pathname !== "/api/timeline"
    ) {
      await route.fallback();
      return;
    }

    active += 1;
    const isOldPage = sourceUrl.searchParams.has("before");
    const holdThisRequest = isOldPage && !oldHeld;
    const workerUrl = new URL(sourceUrl);
    workerUrl.searchParams.set("limit", isOldPage ? "1" : "2");
    try {
      const response = await route.fetch({
        url: workerUrl.href,
        maxRedirects: 0,
        timeout: 15_000,
      });
      const rawBody = await response.body();
      const body = JSON.parse(rawBody.toString("utf8"));
      const record = {
        sourceUrl: sourceUrl.href,
        workerUrl: workerUrl.href,
        status: response.status(),
        body,
        held: holdThisRequest,
      };
      records.push(record);
      if (holdThisRequest) {
        oldHeld = true;
        ready.resolve(record);
        await bounded(release.promise, "held older response release", 60_000);
      }
      await route.fulfill({ response, body: rawBody });
      if (holdThisRequest) delivered.resolve(record);
    } catch (caught) {
      error = caught;
      if (holdThisRequest) {
        ready.reject(caught);
        delivered.reject(caught);
      }
      try {
        await route.abort("failed");
      } catch {
        // Preserve the Worker fetch or route fulfillment failure.
      }
    } finally {
      finish(holdThisRequest);
    }
  };
  return {
    handler,
    records,
    ready: bounded(ready.promise, "real older page snapshot", 20_000),
    get delivered() {
      return bounded(
        delivered.promise,
        "older response browser delivery",
        20_000,
      );
    },
    get finished() {
      return bounded(finished.promise, "older route cleanup", 20_000);
    },
    release() {
      release.resolve();
    },
    get oldHeld() {
      return oldHeld;
    },
    get error() {
      return error;
    },
  };
}

export async function qualifyBrowserFeedRefresh({
  page,
  db,
  origin,
  actorApId,
  checks,
  expectedBaseline,
}) {
  requireFeedRefresh(
    page &&
      db &&
      Array.isArray(checks) &&
      typeof expectedBaseline === "boolean",
    "page, native D1, checks, and boolean expectedBaseline are required",
  );
  const localOrigin = new URL(origin).origin;
  requireFeedRefresh(
    ["127.0.0.1", "localhost"].includes(new URL(localOrigin).hostname) &&
      new URL(actorApId).origin === localOrigin,
    "fixture is restricted to the authenticated loopback Worker owner",
  );
  const before = await countActorsAndSessions(db);
  const owner = await db
    .prepare("SELECT ap_id, role FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  const sessionBefore = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
  requireFeedRefresh(
    owner?.ap_id === actorApId &&
      owner.role === "owner" &&
      typeof sessionBefore?.value === "string",
    "existing authenticated root owner and session are required",
  );

  await selectTimeline(page);
  const suffix = crypto.randomUUID();
  const oldest = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Feed refresh oldest ${suffix}`,
  );
  await nextPublishedSecond();
  const older = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Feed refresh older ${suffix}`,
  );
  await nextPublishedSecond();
  const middle = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Feed refresh middle ${suffix}`,
  );
  await nextPublishedSecond();
  const recent = await createPublicPost(
    page,
    db,
    origin,
    actorApId,
    `Feed refresh recent ${suffix}`,
  );
  const afterSeed = await countActorsAndSessions(db);
  requireFeedRefresh(
    JSON.stringify(before) === JSON.stringify(afterSeed),
    "real post creation changed actor or session counts",
  );
  // A new document gives the fixture a single scoped observer override while
  // preserving the authenticated cookie and all real Worker/D1 data.
  await installTimelinePagerObserverControl(page);

  let route;
  let routeInstalled = false;
  let primaryError;
  const pageErrors = [];
  const serverErrors = [];
  const countRequest = (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.origin === localOrigin &&
      url.pathname === "/api/timeline"
    ) {
      requestLedger.requests.push({
        url: url.href,
        before: url.searchParams.get("before"),
      });
    }
  };
  const countResponse = (response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      url.origin === localOrigin &&
      url.pathname === "/api/timeline"
    ) {
      requestLedger.responses.push({
        url: url.href,
        status: response.status(),
        before: url.searchParams.get("before"),
      });
    } else if (url.origin === localOrigin && response.status() >= 500) {
      serverErrors.push({ status: response.status(), path: url.pathname });
    }
  };
  const requestLedger = { requests: [], responses: [] };
  page.on("request", countRequest);
  page.on("response", countResponse);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    route = installRealResponseRouting(page, localOrigin);
    await page.route("**/api/timeline?*", route.handler);
    routeInstalled = true;

    const initialResponsePromise = requireResponse(
      page,
      "/api/timeline",
      "GET",
      "initial two-row head",
      { query: { limit: "30", before: null } },
    );
    await page.getByRole("button", { name: "最新に更新", exact: true }).click();
    const initialResponse = await initialResponsePromise;
    const initialBody = await initialResponse.json().catch(() => null);
    const initialRecord = route.records.find(
      (entry) => !new URL(entry.sourceUrl).searchParams.has("before"),
    );
    requireFeedRefresh(
      initialResponse.status() === 200 &&
        initialRecord?.status === 200 &&
        new URL(initialRecord.sourceUrl).searchParams.get("limit") === "30" &&
        new URL(initialRecord.workerUrl).searchParams.get("limit") === "2" &&
        initialBody?.posts?.length === 2 &&
        initialBody.posts[0]?.ap_id === recent.apId &&
        initialBody.posts[1]?.ap_id === middle.apId &&
        initialBody.has_more === true &&
        typeof initialBody.next_cursor === "string" &&
        initialBody.next_cursor.length > 0,
      "initial real head was not ordered recent/middle with a usable cursor",
    );
    await page.getByText(recent.content, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.getByText(middle.content, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });

    const olderResponsePromise = requireResponse(
      page,
      "/api/timeline",
      "GET",
      "held older page response",
      {
        timeout: 20_000,
        query: { limit: "30", before: initialBody.next_cursor },
      },
    );
    await page.getByRole("button", { name: "もっと見る", exact: true }).click();
    const heldOlder = await route.ready;
    const heldSource = new URL(heldOlder.sourceUrl);
    const heldWorker = new URL(heldOlder.workerUrl);
    requireFeedRefresh(
      heldOlder.status === 200 &&
        heldSource.searchParams.get("limit") === "30" &&
        heldSource.searchParams.get("before") === initialBody.next_cursor &&
        heldWorker.searchParams.get("limit") === "1" &&
        heldWorker.searchParams.get("before") === initialBody.next_cursor &&
        heldOlder.body?.posts?.length === 1 &&
        heldOlder.body.posts[0]?.ap_id === older.apId &&
        heldOlder.body.has_more === true &&
        typeof heldOlder.body.next_cursor === "string" &&
        heldOlder.body.next_cursor.length > 0,
      "held older request did not fetch the real one-row older snapshot before browser delivery",
    );

    await nextPublishedSecond();
    const canary = await createPublicPost(
      page,
      db,
      origin,
      actorApId,
      `Feed refresh canary ${suffix}`,
    );
    const refreshResponsePromise = requireResponse(
      page,
      "/api/timeline",
      "GET",
      "latest-head refresh during held older response",
      { timeout: 20_000, query: { limit: "30", before: null } },
    );
    await page.getByRole("button", { name: "最新に更新", exact: true }).click();
    const refreshResponse = await refreshResponsePromise;
    const refreshedRecord = route.records.filter(
      (entry) => !new URL(entry.sourceUrl).searchParams.has("before"),
    )[1];
    const refreshedBody = await refreshResponse.json().catch(() => null);
    requireFeedRefresh(
      refreshResponse.status() === 200 &&
        refreshedRecord?.status === 200 &&
        refreshedBody?.posts?.length === 2 &&
        refreshedBody.posts[0]?.ap_id === canary.apId &&
        refreshedBody.posts[1]?.ap_id === recent.apId &&
        refreshedBody.has_more === true &&
        typeof refreshedBody.next_cursor === "string" &&
        refreshedBody.next_cursor.length > 0 &&
        refreshedBody.next_cursor !== initialBody.next_cursor,
      "real refresh did not replace the head and advance to its own cursor",
    );
    await page.getByText(canary.content, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await waitRendered(page);

    route.release();
    const delivered = await route.delivered;
    const olderResponse = await olderResponsePromise;
    await bounded(route.finished, "held older response handler completion");
    const olderResponseBody = await olderResponse.json().catch(() => null);
    requireFeedRefresh(
      delivered.status === 200 &&
        olderResponse.status() === 200 &&
        olderResponseBody?.posts?.length === 1 &&
        olderResponseBody.posts[0]?.ap_id === older.apId &&
        route.error === null &&
        delivered.body?.posts?.length === 1 &&
        delivered.body.posts[0]?.ap_id === older.apId,
      "the held real Worker response was not released intact after refresh",
    );
    await waitRendered(page);

    const olderVisibleAfterRelease = await page
      .getByText(older.content, { exact: true })
      .isVisible()
      .catch(() => false);
    const oldestVisibleAfterRelease = await page
      .getByText(oldest.content, { exact: true })
      .isVisible()
      .catch(() => false);
    const canaryVisibleAfterRelease = await page
      .getByText(canary.content, { exact: true })
      .isVisible()
      .catch(() => false);
    const refreshHeadStillSelected =
      (await page
        .getByRole("button", { name: "最新に更新", exact: true })
        .isEnabled()) &&
      (await page
        .getByText(recent.content, { exact: true })
        .isVisible()
        .catch(() => false));
    const prePage = {
      olderVisible: olderVisibleAfterRelease,
      oldestVisible: oldestVisibleAfterRelease,
      canaryVisible: canaryVisibleAfterRelease,
      recentVisible: refreshHeadStillSelected,
    };

    let manualPage = null;
    if (!expectedBaseline) {
      requireFeedRefresh(
        !olderVisibleAfterRelease &&
          !oldestVisibleAfterRelease &&
          canaryVisibleAfterRelease &&
          refreshHeadStillSelected,
        "candidate applied the stale older page over the refreshed head",
      );
      const nextResponsePromise = requireResponse(
        page,
        "/api/timeline",
        "GET",
        "post-refresh manual page",
        {
          timeout: 20_000,
          query: { limit: "30", before: refreshedBody.next_cursor },
        },
      );
      await page
        .getByRole("button", { name: "もっと見る", exact: true })
        .click();
      const nextResponse = await nextResponsePromise;
      const nextUrl = new URL(nextResponse.url());
      const nextBody = await nextResponse.json().catch(() => null);
      const nextRecord = route.records.at(-1);
      manualPage = {
        status: nextResponse.status(),
        browserLimit: nextUrl.searchParams.get("limit"),
        workerLimit: new URL(nextRecord.workerUrl).searchParams.get("limit"),
        posts: nextBody?.posts?.length ?? null,
        cursorMatchesRefresh:
          nextUrl.searchParams.get("before") === refreshedBody.next_cursor &&
          new URL(nextRecord.workerUrl).searchParams.get("before") ===
            refreshedBody.next_cursor,
        middlePresent: nextBody?.posts?.some(
          (post) => post.ap_id === middle.apId,
        ),
        olderAbsent:
          !nextBody?.posts?.some((post) => post.ap_id === older.apId) &&
          !nextBody?.posts?.some((post) => post.ap_id === oldest.apId),
      };
      requireFeedRefresh(
        nextResponse.status() === 200 &&
          nextUrl.searchParams.get("limit") === "30" &&
          nextUrl.searchParams.get("before") === refreshedBody.next_cursor &&
          new URL(nextRecord.workerUrl).searchParams.get("limit") === "1" &&
          manualPage.middlePresent &&
          manualPage.olderAbsent,
        "manual paging did not use the refreshed cursor to fetch the next live page",
      );
      await page.getByText(middle.content, { exact: true }).waitFor({
        state: "visible",
        timeout: 10_000,
      });
      requireFeedRefresh(
        !(await page
          .getByText(older.content, { exact: true })
          .isVisible()
          .catch(() => false)) &&
          !(await page
            .getByText(oldest.content, { exact: true })
            .isVisible()
            .catch(() => false)),
        "stale older row reappeared after following the refreshed cursor",
      );
    } else {
      requireFeedRefresh(
        olderVisibleAfterRelease &&
          !oldestVisibleAfterRelease &&
          canaryVisibleAfterRelease &&
          refreshHeadStillSelected,
        "baseline did not expose the stale older-page append regression",
      );
      const staleCursorResponsePromise = requireResponse(
        page,
        "/api/timeline",
        "GET",
        "baseline manual page after stale cursor overwrite",
        {
          timeout: 20_000,
          query: { limit: "30", before: heldOlder.body.next_cursor },
        },
      );
      await page
        .getByRole("button", { name: "もっと見る", exact: true })
        .click();
      const staleCursorResponse = await staleCursorResponsePromise;
      const staleCursorUrl = new URL(staleCursorResponse.url());
      const staleCursorBody = await staleCursorResponse
        .json()
        .catch(() => null);
      const staleCursorWorkerRecord = route.records.at(-1);
      requireFeedRefresh(
        staleCursorResponse.status() === 200 &&
          staleCursorUrl.searchParams.get("before") ===
            heldOlder.body.next_cursor &&
          new URL(staleCursorWorkerRecord.workerUrl).searchParams.get(
            "before",
          ) === heldOlder.body.next_cursor &&
          staleCursorBody?.posts?.length === 1 &&
          staleCursorBody.posts[0]?.ap_id === oldest.apId,
        "baseline did not overwrite the refreshed cursor with the delayed older cursor",
      );
      manualPage = {
        status: staleCursorResponse.status(),
        browserLimit: staleCursorUrl.searchParams.get("limit"),
        workerLimit: new URL(
          staleCursorWorkerRecord.workerUrl,
        ).searchParams.get("limit"),
        cursorMatchesHeldOlder:
          staleCursorUrl.searchParams.get("before") ===
          heldOlder.body.next_cursor,
        oldestPresent: true,
      };
    }

    const olderNative = await readObject(db, older.apId);
    const oldestNative = await readObject(db, oldest.apId);
    const middleNative = await readObject(db, middle.apId);
    const recentNative = await readObject(db, recent.apId);
    const canaryNative = await readObject(db, canary.apId);
    const after = await countActorsAndSessions(db);
    const sessionAfter = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    requireFeedRefresh(
      [
        olderNative,
        oldestNative,
        middleNative,
        recentNative,
        canaryNative,
      ].every((post) => post?.deleted_at === null) &&
        JSON.stringify(before) === JSON.stringify(after) &&
        sessionAfter?.value === sessionBefore.value,
      "native posts, actor/session counts, or authenticated session changed unexpectedly",
    );
    requireFeedRefresh(
      requestLedger.requests.length === 4 &&
        requestLedger.responses.length === 4 &&
        route.records.length === (expectedBaseline ? 4 : 4),
      `unexpected timeline request/response counts: ${JSON.stringify({ request: requestLedger.requests.length, response: requestLedger.responses.length, workerFetch: route.records.length })}`,
    );
    requireFeedRefresh(
      pageErrors.length === 0 && serverErrors.length === 0,
      "browser errors or Worker 5xx responses were observed",
    );
    const intersectionControl = await page.evaluate(
      () => window.__feedRefreshIntersectionControl,
    );
    requireFeedRefresh(
      intersectionControl?.timelinePagerSuppressed === true &&
        Number.isInteger(intersectionControl.timelinePagerObserveCalls) &&
        intersectionControl.timelinePagerObserveCalls >= 0 &&
        typeof intersectionControl.otherTargetsDelegated === "number",
      "controlled fixture did not suppress only the timeline pager observer",
    );

    const checksPassed = expectedBaseline
      ? [
          "browser-feed-refresh-baseline-red-old-page-appended-after-fresh-head",
          "browser-feed-refresh-baseline-red-old-cursor-overwrote-fresh-cursor",
          "browser-feed-refresh-real-worker-native-d1-snapshot-boundary",
        ]
      : [
          "browser-feed-refresh-stale-page-ignored-after-fresh-head",
          "browser-feed-refresh-manual-page-uses-refreshed-cursor",
          "browser-feed-refresh-real-worker-native-d1-snapshot-boundary",
        ];
    checks.push(...checksPassed);
    return {
      result: expectedBaseline ? "EXPECTED_BASELINE_RED" : "green",
      actorSessionCounts: { before, afterSeed, after },
      sameSession: sessionBefore.value === sessionAfter.value,
      posts: {
        older: olderNative
          ? { present: true, deletedAt: olderNative.deleted_at }
          : null,
        oldest: oldestNative
          ? { present: true, deletedAt: oldestNative.deleted_at }
          : null,
        middle: middleNative
          ? { present: true, deletedAt: middleNative.deleted_at }
          : null,
        recent: recentNative
          ? { present: true, deletedAt: recentNative.deleted_at }
          : null,
        canary: canaryNative
          ? { present: true, deletedAt: canaryNative.deleted_at }
          : null,
      },
      limits: {
        browserHead: 30,
        workerHead: 2,
        browserPage: 30,
        workerPage: 1,
        intersectionObserver:
          "timeline pager observe suppressed; other targets delegate to native observer",
        intersectionControl: intersectionControl,
      },
      initialHead: {
        status: initialResponse.status(),
        browserLimit: new URL(initialRecord.sourceUrl).searchParams.get(
          "limit",
        ),
        workerLimit: new URL(initialRecord.workerUrl).searchParams.get("limit"),
        postCount: initialBody.posts.length,
        hasMore: initialBody.has_more,
      },
      delayedOlderPage: {
        status: heldOlder.status,
        browserLimit: heldSource.searchParams.get("limit"),
        workerLimit: heldWorker.searchParams.get("limit"),
        sourceBeforeMatchesInitial:
          heldSource.searchParams.get("before") === initialBody.next_cursor,
        workerBeforeMatchesInitial:
          heldWorker.searchParams.get("before") === initialBody.next_cursor,
        postCount: heldOlder.body.posts.length,
        heldAfterRealWorkerFetch: true,
        releasedAfterRefresh: true,
      },
      refreshedHead: {
        status: refreshResponse.status(),
        browserLimit: new URL(refreshedRecord.sourceUrl).searchParams.get(
          "limit",
        ),
        workerLimit: new URL(refreshedRecord.workerUrl).searchParams.get(
          "limit",
        ),
        postCount: refreshedBody.posts.length,
        hasMore: refreshedBody.has_more,
        cursorAdvanced: refreshedBody.next_cursor !== initialBody.next_cursor,
      },
      afterOldDelivery: prePage,
      manualPage,
      requestCounts: {
        browserRequests: requestLedger.requests.length,
        browserResponses: requestLedger.responses.length,
        realWorkerFetches: route.records.length,
      },
      pageErrors,
      serverErrors,
      checks: checksPassed,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    page.off("request", countRequest);
    page.off("response", countResponse);
    if (route) {
      if (route.oldHeld) {
        route.release();
        try {
          await route.finished;
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
      if (routeInstalled)
        await page.unroute("**/api/timeline?*", route.handler);
    }
  }
}
