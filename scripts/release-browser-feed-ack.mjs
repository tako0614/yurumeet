// Real Chrome/native-D1 acceptance for creation ACKs racing full timeline heads.

function requireFeedAck(condition, message) {
  if (!condition) throw new Error(`browser-feed-ack ${message}`);
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
      () => reject(new Error(`browser-feed-ack ${label} timed out`)),
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

function waitForResponse(
  page,
  { pathname, method, label, content, fullHead = false, timeout = 15_000 },
) {
  const origin = new URL(page.url()).origin;
  const pending = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      const request = response.request();
      if (
        url.origin !== origin ||
        url.pathname !== pathname ||
        request.method() !== method
      ) {
        return false;
      }
      if (
        fullHead &&
        (url.searchParams.get("limit") !== "30" ||
          url.searchParams.has("before"))
      ) {
        return false;
      }
      if (content === undefined) return true;
      return request.postDataJSON()?.content === content;
    },
    { timeout },
  );
  pending.catch(() => {});
  return pending.catch((error) => {
    throw new Error(
      `browser-feed-ack ${label} response missing: ${String(error)}`,
    );
  });
}

async function countActorsSessions(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function object(db, apId) {
  return db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, visibility, deleted_at FROM objects WHERE ap_id = ?",
    )
    .bind(apId)
    .first();
}

async function createThroughComposer(page, db, actorApId, content) {
  const responsePromise = waitForResponse(page, {
    pathname: "/api/posts",
    method: "POST",
    label: "canonical composer create",
    content,
  });
  await page.getByRole("button", { name: "投稿を作成", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "投稿を作成" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByPlaceholder("いまどうしてる?").fill(content);
  await dialog.getByRole("button", { name: "投稿", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  const post = body?.post;
  requireFeedAck(
    response.status() === 200 &&
      typeof post?.ap_id === "string" &&
      post.type === "Note" &&
      post.author?.ap_id === actorApId &&
      post.content === content &&
      post.visibility === "public",
    `real composer did not acknowledge the expected own public Note (${response.status()})`,
  );
  const native = await object(db, post.ap_id);
  requireFeedAck(
    native?.ap_id === post.ap_id &&
      native.type === "Note" &&
      native.attributed_to === actorApId &&
      native.content === content &&
      native.visibility === "public" &&
      native.deleted_at === null,
    "acknowledged real Note is missing or inconsistent in native D1",
  );
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return { apId: post.ap_id, content, native };
}

async function visibleCount(page, content) {
  const cards = page.locator(".c-timeline-post").filter({ hasText: content });
  return cards.count();
}

function installHolds(page, origin) {
  const oldHeadReady = gate("old full head fetched from Worker");
  const oldHeadRelease = gate("old full head released");
  const oldHeadDelivered = gate("old full head delivered");
  const ackReady = gate("POST committed Worker response fetched");
  const ackRelease = gate("POST ACK released");
  const ackDelivered = gate("POST ACK delivered to composer");
  const ackHeadRequested = gate(
    "second full-head request reached Worker route",
  );
  const ackHeadFetchRelease = gate("second full-head Worker fetch released");
  const ackHeadDelivered = gate("second full-head response delivered");
  const routesFinished = gate("all held routes finished");
  let idleWaiters = [];
  const records = [];
  let heldHead = false;
  let ackHeadDeliveredFlag = false;
  let heldAck = false;
  let headCount = 0;
  let active = 0;
  let error = null;

  const finish = () => {
    active -= 1;
    if (heldHead && heldAck && active === 0) routesFinished.resolve();
    if (active === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  };

  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      await route.fallback();
      return;
    }
    const isHead =
      request.method() === "GET" && url.pathname === "/api/timeline";
    const isCreate =
      request.method() === "POST" && url.pathname === "/api/posts";
    if (!isHead && !isCreate) {
      await route.fallback();
      return;
    }
    active += 1;
    if (isHead) headCount += 1;
    const holdHead = isHead && !heldHead;
    const delayAckHeadFetch = isHead && headCount === 2;
    const requestContent = isCreate
      ? request.postDataJSON()?.content
      : undefined;
    const holdAck = isCreate && requestContent === ackReady.content && !heldAck;
    try {
      if (delayAckHeadFetch) {
        ackHeadRequested.resolve({ sourceUrl: url.href });
        await bounded(
          ackHeadFetchRelease.promise,
          "post-commit refresh fetch release",
          60_000,
        );
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      const rawBody = await response.body();
      const body = JSON.parse(rawBody.toString("utf8"));
      const record = {
        method: request.method(),
        sourceUrl: url.href,
        requestContent,
        status: response.status(),
        body,
        heldHead: holdHead,
        ackOrderHead: delayAckHeadFetch,
        heldAck: holdAck,
      };
      records.push(record);
      if (holdHead) {
        heldHead = true;
        oldHeadReady.resolve(record);
        await bounded(oldHeadRelease.promise, "head delivery release", 60_000);
      }
      if (holdAck) {
        heldAck = true;
        ackReady.resolve(record);
        await bounded(ackRelease.promise, "creation ACK release", 60_000);
      }
      await route.fulfill({ response, body: rawBody });
      if (holdHead) oldHeadDelivered.resolve(record);
      if (holdAck) ackDelivered.resolve(record);
      if (delayAckHeadFetch) {
        ackHeadDeliveredFlag = true;
        ackHeadDelivered.resolve(record);
      }
    } catch (caught) {
      error = caught;
      if (holdHead) {
        oldHeadReady.reject(caught);
        oldHeadDelivered.reject(caught);
      }
      if (holdAck) {
        ackReady.reject(caught);
        ackDelivered.reject(caught);
      }
      if (delayAckHeadFetch) {
        ackHeadRequested.reject(caught);
        ackHeadDelivered.reject(caught);
      }
      try {
        await route.abort("failed");
      } catch {
        // Preserve the original fetch/fulfill failure.
      }
    } finally {
      finish();
    }
  };

  return {
    handler,
    records,
    get oldHeadReady() {
      return bounded(oldHeadReady.promise, "old head Worker snapshot", 20_000);
    },
    get oldHeadDelivered() {
      return bounded(
        oldHeadDelivered.promise,
        "old head browser delivery",
        20_000,
      );
    },
    get ackReady() {
      return bounded(ackReady.promise, "committed POST response", 20_000);
    },
    get ackDelivered() {
      return bounded(
        ackDelivered.promise,
        "composer POST ACK delivery",
        20_000,
      );
    },
    get ackHeadRequested() {
      return bounded(
        ackHeadRequested.promise,
        "refresh request before committed POST",
        20_000,
      );
    },
    get ackHeadDelivered() {
      return bounded(
        ackHeadDelivered.promise,
        "refresh response after committed POST",
        20_000,
      );
    },
    get routesFinished() {
      return bounded(routesFinished.promise, "held route completion", 20_000);
    },
    async waitForStartedRoutes() {
      if (active > 0) {
        await bounded(
          new Promise((resolve) => idleWaiters.push(resolve)),
          "started route completion",
          20_000,
        );
      }
    },
    releaseHead() {
      oldHeadRelease.resolve();
    },
    releaseAck() {
      ackRelease.resolve();
    },
    releaseAckHeadFetch() {
      ackHeadFetchRelease.resolve();
    },
    get ackHeadDeliveredFlag() {
      return ackHeadDeliveredFlag;
    },
    set ackContent(value) {
      ackReady.content = value;
    },
    get heldHead() {
      return heldHead;
    },
    get heldAck() {
      return heldAck;
    },
    get error() {
      return error;
    },
  };
}

export async function qualifyBrowserFeedAck({
  page,
  db,
  origin,
  actorApId,
  checks,
  expectedBaseline = false,
}) {
  requireFeedAck(
    page &&
      db &&
      Array.isArray(checks) &&
      typeof expectedBaseline === "boolean",
    "page, native D1, checks, and expectedBaseline are required",
  );
  const localOrigin = new URL(origin).origin;
  requireFeedAck(
    ["127.0.0.1", "localhost"].includes(new URL(localOrigin).hostname) &&
      new URL(actorApId).origin === localOrigin,
    "fixture requires the authenticated loopback Worker owner",
  );
  const before = await countActorsSessions(db);
  const owner = await db
    .prepare("SELECT ap_id, role FROM actors WHERE ap_id = ?")
    .bind(actorApId)
    .first();
  const sessionBefore = (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
  requireFeedAck(
    owner?.ap_id === actorApId &&
      owner.role === "owner" &&
      typeof sessionBefore?.value === "string",
    "existing authenticated owner session is required",
  );

  const suffix = crypto.randomUUID();
  const seed = await createThroughComposer(
    page,
    db,
    actorApId,
    `Feed ACK seed ${suffix}`,
  );
  await page
    .getByText(seed.content, { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  const afterSeed = await countActorsSessions(db);
  requireFeedAck(
    JSON.stringify(before) === JSON.stringify(afterSeed),
    "creating the real seed changed actor/session counts",
  );

  let routes;
  let routeInstalled = false;
  let primaryError;
  const requestLog = [];
  const responseLog = [];
  const pageErrors = [];
  const serverErrors = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (
      url.origin === localOrigin &&
      ["GET", "POST"].includes(request.method())
    ) {
      if (["/api/timeline", "/api/posts"].includes(url.pathname)) {
        requestLog.push({
          method: request.method(),
          pathname: url.pathname,
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
          content:
            request.method() === "POST"
              ? request.postDataJSON()?.content
              : null,
        });
      }
    }
  };
  const onResponse = (response) => {
    const url = new URL(response.url());
    if (url.origin !== localOrigin) return;
    if (response.status() >= 500) {
      serverErrors.push({ status: response.status(), pathname: url.pathname });
    }
    if (["/api/timeline", "/api/posts"].includes(url.pathname)) {
      responseLog.push({
        method: response.request().method(),
        pathname: url.pathname,
        limit: url.searchParams.get("limit"),
        before: url.searchParams.get("before"),
        status: response.status(),
      });
    }
  };
  const onPageError = (error) => pageErrors.push(error.message);
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("pageerror", onPageError);
  try {
    routes = installHolds(page, localOrigin);
    await page.route("**/api/timeline**", routes.handler);
    await page.route("**/api/posts", routes.handler);
    routeInstalled = true;

    const firstRefreshPromise = waitForResponse(page, {
      pathname: "/api/timeline",
      method: "GET",
      label: "head started before canonical creation",
      fullHead: true,
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "最新に更新", exact: true }).click();
    const oldHead = await routes.oldHeadReady;
    const oldHeadPostIds = oldHead.body?.posts?.map((post) => post.ap_id) ?? [];
    requireFeedAck(
      oldHead.status === 200 &&
        new URL(oldHead.sourceUrl).searchParams.get("limit") === "30" &&
        !new URL(oldHead.sourceUrl).searchParams.has("before") &&
        oldHeadPostIds.includes(seed.apId),
      "pre-create full head was not a real limit=30 snapshot containing the seed",
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".p-timeline-refresh")?.hasAttribute("disabled"),
      null,
      { timeout: 10_000 },
    );

    const beforeHeadCreate = `Feed ACK after head ${suffix}`;
    const headCreatePromise = createThroughComposer(
      page,
      db,
      actorApId,
      beforeHeadCreate,
    );
    const headCreated = await headCreatePromise;
    requireFeedAck(
      !oldHeadPostIds.includes(headCreated.apId) &&
        (await visibleCount(page, headCreated.content)) === 1,
      "canonical creation ACK was not visible exactly once before the old head arrived",
    );
    routes.releaseHead();
    const oldHeadDelivered = await routes.oldHeadDelivered;
    const firstRefresh = await firstRefreshPromise;
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".p-timeline-refresh")
          ?.hasAttribute("disabled"),
      null,
      { timeout: 10_000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const afterOldHeadCount = await visibleCount(page, headCreated.content);
    requireFeedAck(
      oldHeadDelivered.status === 200 &&
        (expectedBaseline ? afterOldHeadCount === 0 : afterOldHeadCount === 1),
      expectedBaseline
        ? "baseline did not expose loss of a canonical creation during pending head refresh"
        : "candidate lost the acknowledged post when the older head completed",
    );

    const ackContent = `Feed ACK after commit ${suffix}`;
    routes.ackContent = ackContent;
    const ackHeadRequest = waitForResponse(page, {
      pathname: "/api/timeline",
      method: "GET",
      label: "refresh request queued before POST commit",
      fullHead: true,
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "最新に更新", exact: true }).click();
    const queuedHead = await routes.ackHeadRequested;
    requireFeedAck(
      new URL(queuedHead.sourceUrl).searchParams.get("limit") === "30" &&
        !new URL(queuedHead.sourceUrl).searchParams.has("before"),
      "real full refresh GET was not queued before the second create",
    );

    const postAckPromise = waitForResponse(page, {
      pathname: "/api/posts",
      method: "POST",
      label: "held successful create ACK",
      content: ackContent,
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "投稿を作成", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "投稿を作成" });
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByPlaceholder("いまどうしてる?").fill(ackContent);
    await dialog.getByRole("button", { name: "投稿", exact: true }).click();
    const committedAck = await routes.ackReady;
    const committedPost = committedAck.body?.post;
    const committedNative = await object(db, committedPost?.ap_id);
    requireFeedAck(
      committedAck.status === 200 &&
        committedAck.method === "POST" &&
        committedAck.requestContent === ackContent &&
        committedPost?.type === "Note" &&
        committedPost.author?.ap_id === actorApId &&
        committedPost.content === ackContent &&
        committedPost.visibility === "public" &&
        committedNative?.ap_id === committedPost.ap_id &&
        committedNative.attributed_to === actorApId &&
        committedNative.content === ackContent &&
        committedNative.visibility === "public" &&
        committedNative.deleted_at === null,
      "held POST was not a successful committed public Note in native D1",
    );
    requireFeedAck(
      await dialog
        .getByRole("button", { name: "送信中", exact: true })
        .isVisible(),
      "composer did not remain pending while the real committed POST ACK was held",
    );
    routes.releaseAckHeadFetch();
    const ackOrderHead = await routes.ackHeadDelivered;
    const ackOrderRefresh = await ackHeadRequest;
    const ackOrderBody = ackOrderHead.body;
    requireFeedAck(
      ackOrderHead.status === 200 &&
        ackOrderRefresh.status() === 200 &&
        ackOrderBody?.posts?.filter(
          (post) => post.ap_id === committedPost.ap_id,
        ).length === 1,
      "real full refresh after native commit did not contain the held-ACK post",
    );
    await page
      .getByRole("button", { name: "最新に更新", exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () =>
        !document
          .querySelector(".p-timeline-refresh")
          ?.hasAttribute("disabled"),
      undefined,
      { timeout: 10_000 },
    );
    await page
      .getByText(ackContent, { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const refreshContainsOne = await visibleCount(page, ackContent);
    requireFeedAck(
      refreshContainsOne === 1,
      `server refresh must render the committed AP ID once before POST ACK (got ${refreshContainsOne})`,
    );

    routes.releaseAck();
    const postAckResponse = await postAckPromise;
    const ackDelivered = await routes.ackDelivered;
    await bounded(routes.routesFinished, "both held route cleanup");
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const afterAckCount = await visibleCount(page, ackContent);
    requireFeedAck(
      postAckResponse.status() === 200 &&
        ackDelivered.status === 200 &&
        (expectedBaseline ? afterAckCount === 2 : afterAckCount === 1),
      expectedBaseline
        ? `baseline did not expose duplicate AP ID after late create ACK (got ${afterAckCount})`
        : `candidate rendered the acknowledged AP ID more than once (got ${afterAckCount})`,
    );

    const headCreatedNative = await object(db, headCreated.apId);
    const ackNativeAfter = await object(db, committedPost.ap_id);
    const after = await countActorsSessions(db);
    const sessionAfter = (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
    requireFeedAck(
      headCreatedNative?.deleted_at === null &&
        ackNativeAfter?.deleted_at === null &&
        JSON.stringify(before) === JSON.stringify(after) &&
        sessionAfter?.value === sessionBefore.value,
      "native posts, actor/session counts, or owner session changed unexpectedly",
    );
    requireFeedAck(
      routes.records.filter(
        (record) =>
          record.method === "POST" && record.requestContent === ackContent,
      ).length === 1 &&
        requestLog.filter(
          (request) =>
            request.method === "POST" && request.content === ackContent,
        ).length === 1 &&
        responseLog.filter(
          (response) =>
            response.method === "POST" && response.pathname === "/api/posts",
        ).length === 2 &&
        requestLog.filter(
          (request) =>
            request.method === "GET" && request.pathname === "/api/timeline",
        ).length === 2 &&
        requestLog
          .filter(
            (request) =>
              request.method === "GET" && request.pathname === "/api/timeline",
          )
          .every(
            (request) => request.limit === "30" && request.before === null,
          ) &&
        responseLog.filter(
          (response) =>
            response.method === "GET" && response.pathname === "/api/timeline",
        ).length === 2 &&
        responseLog
          .filter(
            (response) =>
              response.method === "GET" &&
              response.pathname === "/api/timeline",
          )
          .every(
            (response) => response.limit === "30" && response.before === null,
          ),
      "real timeline/create request counts did not match the controlled sequence",
    );
    requireFeedAck(
      pageErrors.length === 0 &&
        serverErrors.length === 0 &&
        routes.error === null,
      "browser errors, Worker 5xx, or route errors were observed",
    );

    const checksPassed = expectedBaseline
      ? [
          "browser-feed-ack-baseline-red-head-refresh-loses-visible-create",
          "browser-feed-ack-baseline-red-late-post-ack-duplicates-refreshed-id",
          "browser-feed-ack-real-post-and-refresh-native-d1",
        ]
      : [
          "browser-feed-ack-head-refresh-retains-visible-create-once",
          "browser-feed-ack-late-post-ack-deduplicates-refreshed-id",
          "browser-feed-ack-real-post-and-refresh-native-d1",
        ];
    checks.push(...checksPassed);
    return {
      result: expectedBaseline ? "EXPECTED_BASELINE_RED" : "green",
      actorSessionCounts: { before, afterSeed, after },
      sameSession: sessionBefore.value === sessionAfter.value,
      seed: { present: true, apId: seed.apId },
      headRace: {
        createdApId: headCreated.apId,
        preCreateHeadStatus: firstRefresh.status(),
        preCreateHeadLimit: new URL(oldHead.sourceUrl).searchParams.get(
          "limit",
        ),
        oldHeadContainedCreatedId: oldHeadPostIds.includes(headCreated.apId),
        visibleBeforeOldHeadDelivery: 1,
        visibleAfterOldHeadDelivery: afterOldHeadCount,
        workerResponseHeldAfterFetch: true,
      },
      ackRace: {
        apId: committedPost.ap_id,
        postStatus: committedAck.status,
        postMethod: committedAck.method,
        nativeCommittedBeforeAckDelivery: true,
        refreshStatus: ackOrderRefresh.status(),
        refreshSawCommittedId: true,
        visibleBeforeAckDelivery: refreshContainsOne,
        visibleAfterAckDelivery: afterAckCount,
        refreshGETRequestedBeforePostAck: true,
        workerHeadFetchReleasedAfterPostCommit: routes.ackHeadDeliveredFlag,
        workerPostResponseHeldAfterFetch: true,
      },
      transport: {
        timelineRequests: requestLog.filter(
          (request) => request.pathname === "/api/timeline",
        ).length,
        timelineResponses: responseLog.filter(
          (response) => response.pathname === "/api/timeline",
        ).length,
        createRequestsForAck: requestLog.filter(
          (request) =>
            request.method === "POST" && request.content === ackContent,
        ).length,
        workerCreateFetchesForAck: routes.records.filter(
          (record) =>
            record.method === "POST" && record.requestContent === ackContent,
        ).length,
      },
      pageErrors,
      serverErrors,
      checks: checksPassed,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("pageerror", onPageError);
    if (routes) {
      if (routes.heldHead) routes.releaseHead();
      if (routes.heldAck) routes.releaseAck();
      routes.releaseAckHeadFetch();
      if (routeInstalled) {
        await page.unroute("**/api/timeline**", routes.handler);
        await page.unroute("**/api/posts", routes.handler);
      }
      if (routeInstalled) {
        try {
          await routes.waitForStartedRoutes();
        } catch (cleanupError) {
          if (!primaryError) throw cleanupError;
        }
      }
    }
  }
}
