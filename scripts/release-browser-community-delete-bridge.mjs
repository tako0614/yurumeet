// Disposable local-native-browser fixture for the confirmed-send bridge that
// remains unobserved while an optimistic community delete races a newer send.
// History responses and DELETE delivery are synthetic scheduling controls;
// every POST and the successful DELETE still reach the real local Worker.

function requireDeleteBridge(condition, message) {
  if (!condition) throw new Error(`community-delete-bridge ${message}`);
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`community-delete-bridge ${label} timed out`)),
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

async function first(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .first();
}

async function createCommunity(page, suffix) {
  const name = `ga_delbridge_${suffix}`;
  const displayName = `Delete bridge ${suffix}`;
  const result = await page.evaluate(
    async ({ name, displayName }) => {
      const response = await fetch("/api/communities", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          display_name: displayName,
          summary: "Disposable local delete bridge fixture",
        }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { name, displayName },
  );
  requireDeleteBridge(
    result.status === 201 &&
      result.body?.community?.name === name &&
      typeof result.body.community.ap_id === "string",
    `real Worker community create failed (${result.status})`,
  );
  return {
    apId: result.body.community.ap_id,
    name,
    displayName,
  };
}

function messagesPath(origin, communityApId) {
  return `${origin}/api/communities/${encodeURIComponent(communityApId)}/messages`;
}

function deletePath(origin, communityApId, messageId) {
  return `${messagesPath(origin, communityApId)}/${encodeURIComponent(messageId)}`;
}

async function openTalk(page, origin, actorApId, expectedFailure = null) {
  const sessionCookie = () =>
    page
      .context()
      .cookies(origin)
      .then((cookies) => cookies.find((cookie) => cookie.name === "session"));
  const beforeCookie = await sessionCookie();
  requireDeleteBridge(
    beforeCookie?.value,
    "authenticated session cookie is required",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const observeAuth = () => {
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === "/api/auth/me" &&
        response.request().method() === "GET",
      { timeout: 15_000 },
    );
    response.catch(() => {});
    return response;
  };
  const initialAuth = observeAuth();
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  let auth = await initialAuth;
  const attempts = [{ status: auth.status(), explicitRetry: false }];
  if (expectedFailure !== null) {
    requireDeleteBridge(
      auth.status() === expectedFailure,
      `bootstrap refusal did not return ${expectedFailure}`,
    );
  }
  // The full suite can exhaust the native auth quota through real reloads.
  // Exercise the product's connection-error retry; do not bypass the quota or
  // lengthen the room-list deadline to hide a failed bootstrap.
  for (let retry = 0; auth.status() !== 200 && retry < 2; retry += 1) {
    const status = auth.status();
    requireDeleteBridge(
      status === 429 || (retry === 0 && status === expectedFailure),
      `unexpected bootstrap authentication response (${status})`,
    );
    await page
      .getByRole("heading", { name: "接続エラー", exact: true })
      .waitFor({
        state: "visible",
        timeout: 5_000,
      });
    requireDeleteBridge(
      !(await page
        .getByRole("heading", { name: "問題が発生しました", exact: true })
        .count()) && !(await page.locator('input[type="password"]').count()),
      "failed current-actor lookup reached the global error or sign-in screen",
    );
    let retryAfterSeconds = null;
    if (status === 429) {
      const retryAfter = auth.headers()["retry-after"];
      requireDeleteBridge(
        /^\d+$/.test(retryAfter ?? "") &&
          Number(retryAfter) >= 1 &&
          Number(retryAfter) <= 60,
        "native auth quota returned an invalid or excessive Retry-After",
      );
      retryAfterSeconds = Number(retryAfter);
      process.stderr.write(
        `community-delete-bridge auth HTTP 429; waiting ${retryAfterSeconds}s before one explicit UI retry\n`,
      );
      await page.waitForTimeout(retryAfterSeconds * 1000);
    }
    const retryResponse = observeAuth();
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    auth = await retryResponse;
    attempts.push({
      status: auth.status(),
      explicitRetry: true,
      retryAfterSeconds,
    });
    requireDeleteBridge(
      status !== 429 || auth.status() === 200,
      "one explicit retry after the declared quota wait did not recover",
    );
  }
  const body = await auth.json().catch(() => null);
  requireDeleteBridge(
    auth.status() === 200 && body?.actor?.ap_id === actorApId,
    "bootstrap recovery did not restore the same authenticated principal",
  );
  requireDeleteBridge(
    JSON.stringify(await sessionCookie()) === JSON.stringify(beforeCookie),
    "bootstrap recovery replaced or changed the session cookie",
  );
  await page.locator("li.c-talk-rooms").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  return {
    attempts,
    actorApId: body.actor.ap_id,
    sessionCookieUnchanged: true,
  };
}

export async function qualifyBrowserCurrentActorRecovery({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireDeleteBridge(
    ["127.0.0.1", "localhost"].includes(new URL(origin).hostname) &&
      new URL(actorApId).origin === origin,
    "current-actor recovery is limited to the authenticated local fixture",
  );
  const counts = () =>
    first(
      db,
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    );
  const before = await counts();
  const exactPath = `${origin}/api/auth/me`;
  let refused = 0;
  const refuseOnce = async (route) => {
    if (route.request().method() !== "GET" || refused > 0) {
      await route.fallback();
      return;
    }
    refused += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "local current-actor refusal fixture" }),
    });
  };
  await page.route(exactPath, refuseOnce);
  try {
    const authentication = await openTalk(page, origin, actorApId, 503);
    const after = await counts();
    requireDeleteBridge(
      refused === 1 &&
        authentication.attempts[0].status === 503 &&
        authentication.attempts[1]?.explicitRetry &&
        JSON.stringify(before) === JSON.stringify(after),
      "current-actor refusal changed sessions/actors or skipped explicit recovery",
    );
    checks.push("browser-current-actor-refusal-keeps-connection-error-retry");
    checks.push(
      "browser-current-actor-explicit-retry-keeps-principal-and-native-sessions",
    );
    return {
      syntheticControl: "one GET /api/auth/me returns 503 before Worker/Core",
      refused,
      authentication,
      nativeCounts: { before, after },
    };
  } finally {
    await page.unroute(exactPath, refuseOnce);
  }
}

async function selectCommunity(page, community) {
  const row = page
    .locator("li.c-talk-rooms")
    .filter({ hasText: community.displayName });
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const button = row.locator("button").first();
  const selected = await button.getAttribute("aria-pressed");
  const active = await row.getAttribute("class");
  if (selected !== "true" && !active?.split(/\s+/).includes("is-active")) {
    await button.click();
  }
  await page
    .locator(".p-talk-chat .p-talk-chat-title")
    .filter({ hasText: community.displayName })
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('textarea[name="message"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });
}

function responseSnapshot(response, body) {
  return {
    status: response.status(),
    headers: response.headers(),
    body,
  };
}

async function fulfillSnapshot(route, snapshot) {
  await route.fulfill({
    status: snapshot.status,
    headers: snapshot.headers,
    body: snapshot.body,
  });
}

function holdHistoryAfterInitialGet(page, origin, community) {
  const exactPath = new URL(messagesPath(origin, community.apId)).pathname;
  const initial = gate("initial community history GET allowed");
  const initialDelivered = gate("initial community history GET delivered");
  const captured = [];
  const waiters = [];
  let requestCount = 0;
  let autoRelease = false;
  let routeError = null;

  const notifyCaptured = () => {
    while (waiters.length && captured.length >= waiters[0].count) {
      waiters.shift().resolve(captured.length);
    }
  };
  const waitForCaptured = (count) => {
    if (captured.length >= count) return Promise.resolve(captured.length);
    const waiter = gate(`history GET ${count} captured`);
    waiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  };

  const handler = async (route) => {
    const request = route.request();
    if (
      request.method() !== "GET" ||
      new URL(request.url()).origin !== origin ||
      new URL(request.url()).pathname !== exactPath
    ) {
      await route.fallback();
      return;
    }
    const ordinal = ++requestCount;
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const body = await response.body();
      const snapshot = responseSnapshot(response, body);
      if (ordinal === 1) {
        requireDeleteBridge(
          snapshot.status === 200,
          `initial community history GET failed (${snapshot.status})`,
        );
        await fulfillSnapshot(route, snapshot);
        initial.resolve(snapshot);
        initialDelivered.resolve();
        return;
      }
      const record = {
        snapshot,
        released: gate("held history GET release"),
        delivered: gate("held history GET delivered to browser"),
      };
      captured.push(record);
      notifyCaptured();
      if (autoRelease) record.released.resolve();
      try {
        await record.released.promise;
        await fulfillSnapshot(route, snapshot);
      } finally {
        record.delivered.resolve();
      }
    } catch (error) {
      routeError = error;
      if (ordinal === 1) {
        initial.reject(error);
        initialDelivered.reject(error);
      } else throw error;
    }
  };

  return {
    exactPath,
    handler,
    initial: bounded(initial.promise, "initial history GET"),
    initialDelivered: bounded(
      initialDelivered.promise,
      "initial history response delivery",
    ),
    waitForCaptured,
    captured,
    requestCount: () => requestCount,
    routeError: () => routeError,
    deliverCaptured: async () => {
      // Leave interception installed: any later poll must remain held until
      // the canary proves that this exact captured response was consumed.
      const selected = [...captured];
      for (const record of selected) record.released.resolve();
      await bounded(
        Promise.all(selected.map((record) => record.delivered.promise)),
        "selected held history response delivery",
      );
    },
    releaseAll: async () => {
      autoRelease = true;
      for (const record of captured) record.released.resolve();
      await page.unroute("**/api/communities/**/messages**", handler);
      await bounded(
        Promise.all(captured.map((record) => record.delivered.promise)),
        "held history response delivery",
      );
    },
  };
}

async function nativeMessage(db, messageId, communityApId) {
  return first(
    db,
    `SELECT o.ap_id, o.content, o.attributed_to,
            r.recipient_ap_id, r.type AS recipient_type
       FROM objects o
       JOIN object_recipients r ON r.object_ap_id = o.ap_id
      WHERE o.ap_id = ? AND r.recipient_ap_id = ? AND r.type = 'audience'`,
    messageId,
    communityApId,
  );
}

async function nativeObject(db, messageId) {
  return first(
    db,
    "SELECT ap_id, type, content, attributed_to FROM objects WHERE ap_id = ?",
    messageId,
  );
}

async function assertVisible(page, content) {
  const row = page.locator("li.c-talk-chat").filter({ hasText: content });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    (text) => {
      const matches = Array.from(
        document.querySelectorAll("li.c-talk-chat"),
      ).filter((item) => item.textContent?.includes(text));
      return (
        matches.length === 1 &&
        !matches[0].classList.contains("is-pending") &&
        !matches[0].classList.contains("is-failed")
      );
    },
    content,
    { timeout: 10_000 },
  );
}

async function isVisible(page, content) {
  return page
    .locator("li.c-talk-chat")
    .filter({ hasText: content })
    .isVisible()
    .catch(() => false);
}

async function sendFromUi(page, db, origin, community, actorApId, content) {
  const exactPath = new URL(messagesPath(origin, community.apId)).pathname;
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === exactPath &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  responsePromise.catch(() => {});
  await page.locator('textarea[name="message"]').fill(content);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  requireDeleteBridge(
    response.status() === 201 && body?.message?.content === content,
    `real Worker message POST failed (${response.status()})`,
  );
  await assertVisible(page, content);
  const native = await nativeMessage(db, body.message.id, community.apId);
  requireDeleteBridge(
    native?.ap_id === body.message.id &&
      native.content === content &&
      native.attributed_to === actorApId &&
      native.recipient_ap_id === community.apId &&
      native.recipient_type === "audience",
    "real UI POST did not persist under the owner and community audience",
  );
  return body.message;
}

async function createNativeOnlyMessage(
  page,
  db,
  origin,
  community,
  actorApId,
  content,
) {
  const path = new URL(messagesPath(origin, community.apId)).pathname;
  const sent = await page.evaluate(
    async ({ path, content }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { path, content },
  );
  requireDeleteBridge(
    sent.status === 201 &&
      sent.body?.message?.content === content &&
      typeof sent.body.message.id === "string",
    `real Worker native-only M3 POST failed (${sent.status})`,
  );
  const native = await nativeMessage(db, sent.body.message.id, community.apId);
  requireDeleteBridge(
    native?.ap_id === sent.body.message.id &&
      native.content === content &&
      native.attributed_to === actorApId &&
      native.recipient_ap_id === community.apId &&
      native.recipient_type === "audience",
    "real Worker native-only M3 did not persist under the owner and audience",
  );
  return { id: native.ap_id, content: native.content, native };
}

async function beginHeldDelete(page, origin, community, message, delivery) {
  const exactPath = deletePath(origin, community.apId, message.id);
  const entered = gate("DELETE held before local Worker/Core");
  const finish = gate("DELETE delivery release");
  const handled = gate("DELETE route handler finished");
  let intercepted = 0;
  let outcome = null;
  const handler = async (route) => {
    if (
      route.request().method() !== "DELETE" ||
      new URL(route.request().url()).pathname !== new URL(exactPath).pathname
    ) {
      await route.fallback();
      return;
    }
    intercepted += 1;
    entered.resolve();
    try {
      await finish.promise;
      if (delivery === "abort-before-core") {
        // Explicit synthetic boundary fault: route.fetch is skipped, so Core
        // cannot mutate native state in the failure qualification.
        await route.abort("failed");
        outcome = { kind: "synthetic-abort-before-Core" };
      } else {
        const response = await route.fetch({ maxRedirects: 0 });
        const body = await response.body();
        outcome = {
          kind: "real-Worker-DELETE",
          status: response.status(),
          headers: response.headers(),
          body,
        };
        await fulfillSnapshot(route, outcome);
      }
    } finally {
      handled.resolve();
    }
  };
  await page.route(exactPath, handler);
  const dispose = async () => page.unroute(exactPath, handler);
  try {
    const row = page
      .locator("li.c-talk-chat")
      .filter({ hasText: message.content });
    await row
      .getByRole("button", { name: "メッセージ操作", exact: true })
      .click();
    await row.getByRole("menuitem", { name: "削除", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "メッセージを削除" });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const requestFailed =
      delivery === "abort-before-core"
        ? page.waitForEvent("requestfailed", {
            predicate: (request) =>
              request.method() === "DELETE" &&
              new URL(request.url()).pathname === new URL(exactPath).pathname,
            timeout: 15_000,
          })
        : null;
    requestFailed?.catch(() => {});
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    await bounded(entered.promise, "DELETE interception before Core");
    return {
      release: () => finish.resolve(),
      entered,
      handled: bounded(handled.promise, "DELETE handler completion"),
      requestFailed,
      intercepted: () => intercepted,
      outcome: () => outcome,
      dispose,
    };
  } catch (error) {
    finish.resolve();
    try {
      await bounded(handled.promise, "DELETE setup cleanup", 5_000);
    } catch {
      // Keep the primary setup failure while attempting route cleanup.
    }
    await dispose();
    throw error;
  }
}

async function prepareUnobservedBridge({
  page,
  db,
  origin,
  actorApId,
  community,
  switchTo,
}) {
  const history = holdHistoryAfterInitialGet(page, origin, community);
  await page.route("**/api/communities/**/messages**", history.handler);
  await selectCommunity(page, community);
  await history.initial;
  await history.initialDelivered;

  const m1Content = `M1 confirmed but unobserved ${crypto.randomUUID()}`;
  const m1 = await sendFromUi(
    page,
    db,
    origin,
    community,
    actorApId,
    m1Content,
  );
  const m3Content = `M3 native-only stale GET canary ${crypto.randomUUID()}`;
  const m3 = await createNativeOnlyMessage(
    page,
    db,
    origin,
    community,
    actorApId,
    m3Content,
  );
  requireDeleteBridge(
    !(await isVisible(page, m3Content)),
    "native-only M3 appeared before its held history response was delivered",
  );
  const capturedBeforeNavigation = history.captured.length;
  // Trigger a real poll without replacing the current view with a loading
  // state. Hold its native response so history cannot retire the ACK bridge.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await bounded(
    history.waitForCaptured(capturedBeforeNavigation + 1),
    "post-M1 history response capture",
  );
  const stale = history.captured.at(-1)?.snapshot;
  const staleBody = JSON.parse(stale?.body?.toString("utf8") ?? "null");
  requireDeleteBridge(
    Array.isArray(staleBody?.messages) &&
      staleBody.messages.some((message) => message.id === m1.id) &&
      staleBody.messages.some((message) => message.id === m3.id),
    "post-M1 controlled history response did not contain M1 and native-only M3",
  );
  requireDeleteBridge(
    history.captured.length === 1,
    `expected one controlled stale history response, captured ${history.captured.length}`,
  );
  await assertVisible(page, m1Content);
  requireDeleteBridge(
    !(await isVisible(page, m3Content)),
    "native-only M3 became visible before the held GET was delivered",
  );
  return { m1, m1Content, m3, m3Content, history };
}

async function runAbortCase({
  page,
  db,
  origin,
  actorApId,
  community,
  switchTo,
  baselineRed,
  checks,
}) {
  const prepared = await prepareUnobservedBridge({
    page,
    db,
    origin,
    actorApId,
    community,
    switchTo,
  });
  const deletion = await beginHeldDelete(
    page,
    origin,
    community,
    prepared.m1,
    "abort-before-core",
  );
  let primaryError;
  try {
    const m2Content = `M2 real POST during held DELETE ${crypto.randomUUID()}`;
    const m2 = await sendFromUi(
      page,
      db,
      origin,
      community,
      actorApId,
      m2Content,
    );
    const beforeRelease = {
      m1: await isVisible(page, prepared.m1Content),
      m2: await isVisible(page, m2Content),
      m3: await isVisible(page, prepared.m3Content),
    };
    requireDeleteBridge(
      beforeRelease.m1 === baselineRed && beforeRelease.m2 && !beforeRelease.m3,
      `optimistic UI before DELETE release was unexpected: ${JSON.stringify(beforeRelease)}`,
    );
    if (!baselineRed)
      checks.push(
        "browser-delete-bridge-hides-m1-and-keeps-m2-before-delete-release",
      );

    const errorToast = page
      .getByRole("alert")
      .filter({ hasText: "削除に失敗しました" });
    deletion.release();
    await bounded(deletion.requestFailed, "synthetic DELETE request failure");
    await deletion.handled;
    await errorToast.waitFor({ state: "visible", timeout: 10_000 });
    const retainedM1 = await nativeMessage(db, prepared.m1.id, community.apId);
    const retainedM2 = await nativeMessage(db, m2.id, community.apId);
    requireDeleteBridge(
      deletion.intercepted() === 1 &&
        deletion.outcome()?.kind === "synthetic-abort-before-Core" &&
        retainedM1?.ap_id === prepared.m1.id &&
        retainedM2?.ap_id === m2.id,
      "synthetic abort touched native state or failed to persist M2",
    );
    requireDeleteBridge(
      prepared.history.captured.length === 1,
      "expected one held history response before abort completion",
    );
    await prepared.history.deliverCaptured();
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await assertVisible(page, prepared.m3Content);
    const visible = {
      m1: await isVisible(page, prepared.m1Content),
      m2: await isVisible(page, m2Content),
      m3: await isVisible(page, prepared.m3Content),
    };
    if (baselineRed) {
      requireDeleteBridge(
        beforeRelease.m1 && beforeRelease.m2 && visible.m1 && visible.m2,
        `immutable #37 baseline did not reproduce M1 reappearing: ${JSON.stringify(visible)}`,
      );
      checks.push(
        "browser-delete-bridge-immutable-37-baseline-red-m1-reappears",
      );
      return {
        result: "expected-red",
        syntheticControl: "DELETE aborted before route.fetch/Core",
        messages: { m1: prepared.m1.id, m2: m2.id },
        nativeOnlyCanary: {
          m3: prepared.m3.id,
          content: prepared.m3Content,
          native: prepared.m3.native,
        },
        native: { m1: retainedM1, m2: retainedM2 },
        visibleBeforeRelease: beforeRelease,
        visibleAfterAbortAndStaleGet: visible,
        heldHistoryGets: prepared.history.captured.length,
      };
    }
    requireDeleteBridge(
      visible.m1 && visible.m2 && visible.m3,
      `failed DELETE did not retain both messages after the controlled stale GET: ${JSON.stringify(visible)}`,
    );
    checks.push("browser-delete-bridge-failed-delete-retains-m1-and-m2");
    return {
      result: "green",
      syntheticControl: "DELETE aborted before route.fetch/Core",
      messages: { m1: prepared.m1.id, m2: m2.id },
      nativeOnlyCanary: {
        m3: prepared.m3.id,
        content: prepared.m3Content,
        native: prepared.m3.native,
      },
      native: { m1: retainedM1, m2: retainedM2 },
      visibleBeforeRelease: beforeRelease,
      visibleAfterAbortAndStaleGet: visible,
      heldHistoryGets: prepared.history.captured.length,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    deletion.release();
    try {
      await bounded(deletion.handled, "abort-case DELETE cleanup", 5_000);
    } catch (error) {
      if (!primaryError) throw error;
    }
    await deletion.dispose();
    await prepared.history.releaseAll();
  }
}

async function runSuccessCase({
  page,
  db,
  origin,
  actorApId,
  community,
  switchTo,
  checks,
}) {
  const prepared = await prepareUnobservedBridge({
    page,
    db,
    origin,
    actorApId,
    community,
    switchTo,
  });
  const deletion = await beginHeldDelete(
    page,
    origin,
    community,
    prepared.m1,
    "real-worker-delete",
  );
  let primaryError;
  try {
    const m2Content = `M2 persisted before real DELETE ${crypto.randomUUID()}`;
    const m2 = await sendFromUi(
      page,
      db,
      origin,
      community,
      actorApId,
      m2Content,
    );
    const visibleBeforeRelease = {
      m1: await isVisible(page, prepared.m1Content),
      m2: await isVisible(page, m2Content),
      m3: await isVisible(page, prepared.m3Content),
    };
    requireDeleteBridge(
      !visibleBeforeRelease.m1 &&
        visibleBeforeRelease.m2 &&
        !visibleBeforeRelease.m3,
      `optimistic UI before real DELETE was unexpected: ${JSON.stringify(visibleBeforeRelease)}`,
    );
    checks.push(
      "browser-delete-bridge-real-delete-hides-m1-and-keeps-m2-before-release",
    );

    deletion.release();
    await deletion.handled;
    const result = deletion.outcome();
    requireDeleteBridge(
      deletion.intercepted() === 1 &&
        result?.kind === "real-Worker-DELETE" &&
        result.status >= 200 &&
        result.status < 300,
      `real Worker DELETE failed (${result?.status ?? "no response"})`,
    );
    const deletedM1 = await nativeObject(db, prepared.m1.id);
    const retainedM2 = await nativeMessage(db, m2.id, community.apId);
    const retainedM3 = await nativeMessage(db, prepared.m3.id, community.apId);
    requireDeleteBridge(
      (!deletedM1 || deletedM1.type === "Tombstone") &&
        retainedM2?.ap_id === m2.id &&
        retainedM3?.ap_id === prepared.m3.id,
      "real DELETE did not remove M1 while retaining native M2",
    );
    const visibleAfterDelete = {
      m1: await isVisible(page, prepared.m1Content),
      m2: await isVisible(page, m2Content),
      m3: await isVisible(page, prepared.m3Content),
    };
    requireDeleteBridge(
      !visibleAfterDelete.m1 && visibleAfterDelete.m2 && !visibleAfterDelete.m3,
      `real DELETE UI result was unexpected: ${JSON.stringify(visibleAfterDelete)}`,
    );
    checks.push(
      "browser-delete-bridge-real-delete-removes-native-m1-and-keeps-m2",
    );

    // Deliver a history response fetched before the DELETE, then verify that
    // neither the stale payload nor its still-unobserved outgoing bridge can
    // resurrect M1 after the authoritative local mutation.
    const staleRows = JSON.parse(
      prepared.history.captured.at(-1).snapshot.body.toString("utf8"),
    );
    requireDeleteBridge(
      Array.isArray(staleRows?.messages) &&
        staleRows.messages.some((message) => message.id === prepared.m1.id) &&
        staleRows.messages.some((message) => message.id === prepared.m3.id),
      "controlled stale GET did not contain pre-delete M1 and native-only M3 evidence",
    );
    requireDeleteBridge(
      prepared.history.captured.length === 1,
      `expected exactly one controlled stale GET at DELETE release, captured ${prepared.history.captured.length}`,
    );
    await prepared.history.deliverCaptured();
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await assertVisible(page, prepared.m3Content);
    const visibleAfterStaleGet = {
      m1: await isVisible(page, prepared.m1Content),
      m2: await isVisible(page, m2Content),
      m3: await isVisible(page, prepared.m3Content),
    };
    requireDeleteBridge(
      !visibleAfterStaleGet.m1 &&
        visibleAfterStaleGet.m2 &&
        visibleAfterStaleGet.m3,
      `stale controlled GET did not preserve deleted M1 while showing M2 and canary M3: ${JSON.stringify(visibleAfterStaleGet)}`,
    );
    checks.push(
      "browser-delete-bridge-stale-history-get-does-not-resurrect-m1",
    );
    return {
      result: "green",
      deleteTransport:
        "route.fetch forwarded the real DELETE to the local Worker/Core",
      deleteStatus: result.status,
      staleGetControl:
        "pre-delete real Worker response held, then delivered after DELETE",
      messages: { m1: prepared.m1.id, m2: m2.id },
      nativeOnlyCanary: {
        m3: prepared.m3.id,
        content: prepared.m3Content,
        native: prepared.m3.native,
      },
      native: { m1: deletedM1, m2: retainedM2, m3: retainedM3 },
      visibleBeforeRelease,
      visibleAfterDelete,
      visibleAfterStaleGet,
      heldHistoryGets: prepared.history.captured.length,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    deletion.release();
    try {
      await bounded(deletion.handled, "success-case DELETE cleanup", 5_000);
    } catch (error) {
      if (!primaryError) throw error;
    }
    await deletion.dispose();
    await prepared.history.releaseAll();
  }
}

export async function qualifyBrowserCommunityDeleteBridge({
  page,
  db,
  origin,
  actorApId,
  checks = [],
  baselineRed = false,
}) {
  requireDeleteBridge(page && db, "native browser page and D1 are required");
  requireDeleteBridge(
    typeof origin === "string" && typeof actorApId === "string",
    "origin and authenticated actor AP ID are required",
  );
  requireDeleteBridge(
    new URL(origin).hostname === "127.0.0.1" ||
      new URL(origin).hostname === "localhost",
    "fixture evidence is limited to the disposable local Worker",
  );
  requireDeleteBridge(
    new URL(actorApId).origin === new URL(origin).origin,
    "actor AP ID must belong to the local Worker origin",
  );
  requireDeleteBridge(Array.isArray(checks), "checks array is required");
  requireDeleteBridge(
    typeof baselineRed === "boolean",
    "baselineRed must be boolean",
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const firstCommunity = await createCommunity(page, `a_${suffix}`);
  const secondCommunity = await createCommunity(page, `b_${suffix}`);
  const authentication = await openTalk(page, origin, actorApId);
  const failure = await runAbortCase({
    page,
    db,
    origin,
    actorApId,
    community: firstCommunity,
    switchTo: secondCommunity,
    baselineRed,
    checks,
  });
  if (baselineRed) {
    return {
      result: "expected-red",
      fixtureScope:
        "disposable local native Worker only; no live data, federation, or external URLs",
      syntheticControls:
        "history response scheduling and DELETE abort before route.fetch/Core",
      authentication,
      failure,
    };
  }
  const success = await runSuccessCase({
    page,
    db,
    origin,
    actorApId,
    community: secondCommunity,
    switchTo: firstCommunity,
    checks,
  });
  return {
    result: "green",
    fixtureScope:
      "disposable local native Worker only; no live data, federation, or external URLs",
    syntheticControls:
      "history response scheduling; success DELETE forwarded through route.fetch",
    communities: [firstCommunity.apId, secondCommunity.apId],
    authentication,
    failure,
    success,
  };
}
