// Disposable Chrome + native Worker qualification for conversation history
// reads racing the four-second poll. Only the initial 503 is synthetic: every
// successful GET and every message mutation goes through the local Worker.
import { createHash } from "node:crypto";

const sha256 = (body) => createHash("sha256").update(body).digest("hex");

const fail = (message) => new Error(`history-read-order ${message}`);
const requireHistory = (condition, message) => {
  if (!condition) throw fail(message);
};

function signal() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label, timeout = 14_000) {
  let timer;
  promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail(`${label} timed out`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function first(db, sql, ...args) {
  return db
    .prepare(sql)
    .bind(...args)
    .first();
}

async function rows(db, sql, ...args) {
  const result = await db
    .prepare(sql)
    .bind(...args)
    .all();
  return result.results ?? [];
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        credentials: "include",
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { method, path, body },
  );
}

function messagesPath(origin, communityApId) {
  return `${origin}/api/communities/${encodeURIComponent(communityApId)}/messages`;
}

async function createCommunity(page, suffix) {
  const name = `ga_read_order_${suffix}`;
  const displayName = `Read order ${suffix}`;
  const result = await api(page, "POST", "/api/communities", {
    name,
    display_name: displayName,
    summary: "Disposable local history read ordering fixture",
  });
  requireHistory(
    result.status === 201 &&
      result.body?.community?.name === name &&
      typeof result.body.community.ap_id === "string",
    `native community create failed (${result.status})`,
  );
  return { apId: result.body.community.ap_id, name, displayName };
}

async function createMessage(page, db, origin, community, actorApId, content) {
  const result = await api(page, "POST", messagesPath(origin, community.apId), {
    content,
  });
  requireHistory(
    result.status === 201 &&
      result.body?.message?.content === content &&
      typeof result.body.message.id === "string",
    `native message POST failed (${result.status})`,
  );
  const row = await first(
    db,
    `SELECT o.ap_id, o.content, o.attributed_to, r.recipient_ap_id,
            r.type AS recipient_type FROM objects o JOIN object_recipients r
       ON r.object_ap_id = o.ap_id WHERE o.ap_id = ? AND r.recipient_ap_id = ?`,
    result.body.message.id,
    community.apId,
  );
  requireHistory(
    row?.ap_id === result.body.message.id &&
      row.content === content &&
      row.attributed_to === actorApId &&
      row.recipient_ap_id === community.apId &&
      row.recipient_type === "audience",
    "native message owner/audience persistence differs from POST response",
  );
  return result.body.message.id;
}

async function editMessage(page, db, origin, community, messageId, content) {
  const result = await api(
    page,
    "PATCH",
    `${messagesPath(origin, community.apId)}/${encodeURIComponent(messageId)}`,
    { content },
  );
  const row = await first(
    db,
    "SELECT content FROM objects WHERE ap_id = ?",
    messageId,
  );
  requireHistory(
    result.status === 200 &&
      result.body?.success === true &&
      row?.content === content,
    `native message PATCH failed or was not persisted (${result.status})`,
  );
}

async function openTalk(page, origin) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.locator("li.c-talk-rooms").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

async function selectCommunity(page, community) {
  const row = page.locator("li.c-talk-rooms").filter({
    hasText: community.displayName,
  });
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const button = row.locator("button").first();
  const selected = await button.getAttribute("aria-pressed");
  const active = await row.getAttribute("class");
  if (selected !== "true" && !active?.split(/\s+/).includes("is-active")) {
    await button.click();
  }
  await page
    .locator(".p-talk-chat .p-talk-chat-title")
    .filter({
      hasText: community.displayName,
    })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function rendered(page, content) {
  return page.locator("li.c-talk-chat").filter({ hasText: content }).count();
}

async function waitRendered(page, content) {
  await page.locator("li.c-talk-chat").filter({ hasText: content }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  requireHistory(
    (await rendered(page, content)) === 1,
    "message is not unique",
  );
}

async function waitAbsent(page, content) {
  await page.locator("li.c-talk-chat").filter({ hasText: content }).waitFor({
    state: "hidden",
    timeout: 10_000,
  });
}

function historyErrorRow(page) {
  return page.locator("li.p-talk-chat-empty-row").filter({
    hasText: "メッセージを読み込めませんでした",
  });
}

async function assertFixtureRows(db, actorApId, community, messageIds) {
  const members = await rows(
    db,
    "SELECT actor_ap_id, role FROM community_members WHERE community_ap_id = ?",
    community.apId,
  );
  const messages = await rows(
    db,
    `SELECT o.ap_id, o.attributed_to, r.recipient_ap_id, r.type
       FROM objects o JOIN object_recipients r ON r.object_ap_id = o.ap_id
      WHERE r.recipient_ap_id = ? AND r.type = 'audience' ORDER BY o.ap_id`,
    community.apId,
  );
  const reads = await rows(
    db,
    "SELECT actor_ap_id, community_ap_id, last_read_at FROM dm_community_read_status WHERE community_ap_id = ?",
    community.apId,
  );
  requireHistory(
    members.length === 1 &&
      members[0].actor_ap_id === actorApId &&
      messages.length === messageIds.length &&
      messages.every(
        (row) =>
          messageIds.includes(row.ap_id) &&
          row.attributed_to === actorApId &&
          row.recipient_ap_id === community.apId &&
          row.type === "audience",
      ) &&
      reads.every(
        (row) =>
          row.actor_ap_id === actorApId &&
          row.community_ap_id === community.apId &&
          typeof row.last_read_at === "string",
      ),
    "fixture membership, message rows, or intentional read state escaped owner scope",
  );
  return {
    memberCount: members.length,
    messageCount: messages.length,
    readCount: reads.length,
  };
}

// One exact GET path is intercepted per lane. The first successful response is
// captured from native workerd before holding it at the browser transport.
// Subsequent requests continue through workerd, preserving the real poll timer.
async function holdFirstRead(page, exactPath, { synthetic503 = false } = {}) {
  const entered = signal();
  const release = signal();
  const finished = signal();
  let count = 0;
  let captured = null;
  let handlerError = null;
  const handler = async (route) => {
    const request = route.request();
    if (request.method() !== "GET" || request.url() !== exactPath) {
      await route.fallback();
      return;
    }
    count += 1;
    if (count !== 1) {
      await route.fallback();
      return;
    }
    try {
      if (synthetic503) {
        captured = {
          status: 503,
          body: '{"error":"fixture initial read unavailable"}',
        };
      } else {
        const response = await route.fetch();
        const body = await response.body();
        const json = JSON.parse(body.toString());
        requireHistory(
          response.status() === 200 && Array.isArray(json.messages),
          `held native GET returned ${response.status()} or invalid history`,
        );
        captured = {
          status: response.status(),
          headers: response.headers(),
          body,
          json,
          sha256: sha256(body),
        };
      }
      entered.resolve(captured);
      await release.promise;
      await route.fulfill({
        status: captured.status,
        headers: captured.headers ?? { "content-type": "application/json" },
        body: captured.body,
      });
    } catch (error) {
      handlerError = error;
      entered.reject(error);
      try {
        await route.abort("failed");
      } catch {
        /* page may already close */
      }
    } finally {
      finished.resolve();
    }
  };
  await page.route(exactPath, handler);
  return {
    entered: bounded(entered.promise, "held initial GET"),
    get count() {
      return count;
    },
    get captured() {
      return captured;
    },
    release: () => release.resolve(),
    finish: () => bounded(finished.promise, "held GET completion", 5_000),
    dispose: async () => {
      release.resolve();
      await page.unroute(exactPath, handler);
      if (handlerError) throw handlerError;
    },
  };
}

function observeReads(page, exactPath) {
  const responses = [];
  const failures = [];
  const onResponse = async (response) => {
    if (response.request().method() !== "GET" || response.url() !== exactPath)
      return;
    try {
      const bytes = await response.body();
      const body = JSON.parse(bytes.toString());
      responses.push({
        status: response.status(),
        messages: body.messages ?? null,
        sha256: sha256(bytes),
      });
    } catch (error) {
      responses.push({
        status: response.status(),
        messages: null,
        sha256: null,
      });
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  const onFailure = (request) => {
    if (request.method() === "GET" && request.url() === exactPath) {
      failures.push(request.failure()?.errorText ?? "unknown GET failure");
    }
  };
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  return {
    responses,
    failures,
    dispose: () => {
      page.off("response", onResponse);
      page.off("requestfailed", onFailure);
    },
  };
}

async function waitResponse(observed, predicate, label, diagnose) {
  const deadline = Date.now() + 14_000;
  while (Date.now() < deadline) {
    const match = observed.responses.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const details = diagnose ? await diagnose() : {};
  throw fail(
    `${label} did not arrive from native Worker: ${JSON.stringify({
      responses: observed.responses.map((response) => ({
        status: response.status,
        ids: response.messages?.map((message) => message.id) ?? null,
        sha256: response.sha256,
      })),
      failures: observed.failures,
      ...details,
    })}`,
  );
}

function monitorLaneRequests(page, exactPath) {
  const counts = {
    messagePosts: 0,
    messagePatches: 0,
    messageGets: 0,
    readMarks: 0,
  };
  const readPath = exactPath
    .replace("/api/communities/", "/api/dm/community/")
    .replace(/\/messages$/, "/read");
  const onRequest = (request) => {
    if (request.url() === exactPath) {
      if (request.method() === "GET") counts.messageGets++;
      if (request.method() === "POST") counts.messagePosts++;
    } else if (
      request.url().startsWith(`${exactPath}/`) &&
      request.method() === "PATCH"
    ) {
      counts.messagePatches++;
    } else if (request.url() === readPath && request.method() === "POST") {
      counts.readMarks++;
    }
  };
  page.on("request", onRequest);
  return { counts, dispose: () => page.off("request", onRequest) };
}

async function responseSeenAfter(observed, previousLength, predicate, label) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const response = observed.responses.slice(previousLength).find(predicate);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw fail(`${label} body was not consumed in browser`);
}

async function installReadProbe(page, exactPath) {
  // This runs before the navigation which can auto-select the contact and
  // start its first GET. The original Response is returned unchanged; only
  // its json() method records when the app has consumed that exact response.
  await page.addInitScript((path) => {
    const nativeFetch = window.fetch.bind(window);
    const state = { path, initiated: 0, settled: [] };
    (window.__historyReadProbes ??= {})[path] = state;
    const checkpoint = (ordinal, status, consumedJson) => {
      window.setTimeout(() => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.settled.push({ ordinal, status, consumedJson });
          }),
        );
      }, 0);
    };
    window.fetch = async (...args) => {
      const input = args[0];
      const method = (
        args[1]?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (method !== "GET" || url.href !== path) return nativeFetch(...args);
      const ordinal = ++state.initiated;
      const response = await nativeFetch(...args);
      if (response.status === 503) {
        // apiFetch rejects at assertOk before Response.json() is called.
        checkpoint(ordinal, response.status, false);
      } else {
        const nativeJson = response.json.bind(response);
        response.json = async (...jsonArgs) => {
          const result = await nativeJson(...jsonArgs);
          checkpoint(ordinal, response.status, true);
          return result;
        };
      }
      return response;
    };
  }, exactPath);
}

async function waitReadProbe(
  page,
  exactPath,
  ordinal,
  status,
  consumedJson,
  expectedCount = ordinal,
) {
  await page.waitForFunction(
    ({ path, ordinal, status, consumedJson }) => {
      const probe = window.__historyReadProbes?.[path];
      return (
        probe?.path === path &&
        probe.settled.some(
          (entry) =>
            entry.ordinal === ordinal &&
            entry.status === status &&
            entry.consumedJson === consumedJson,
        )
      );
    },
    { path: exactPath, ordinal, status, consumedJson },
    { timeout: 10_000 },
  );
  const probe = await page.evaluate(
    (path) => window.__historyReadProbes?.[path],
    exactPath,
  );
  requireHistory(
    probe.initiated === expectedCount,
    `GET ordinal ${ordinal} reached an unexpected request count before the app consumption checkpoint`,
  );
  return probe;
}

async function lanePendingFull({
  page,
  db,
  origin,
  actorApId,
  mode,
  checks,
  synthetic503,
}) {
  const kind = synthetic503 ? "failure" : "success";
  const community = await createCommunity(
    page,
    `${kind}_${crypto.randomUUID().slice(0, 8)}`,
  );
  const path = messagesPath(origin, community.apId);
  await installReadProbe(page, path);
  const observed = observeReads(page, path);
  const monitored = monitorLaneRequests(page, path);
  const held = await holdFirstRead(page, path, { synthetic503 });
  let primaryError;
  try {
    await openTalk(page, origin);
    await selectCommunity(page, community);
    const captured = await held.entered;
    requireHistory(
      captured?.status === (synthetic503 ? 503 : 200),
      "initial GET capture failed",
    );
    requireHistory(
      synthetic503 || captured.json.messages.length === 0,
      "initial GET was not the empty native snapshot",
    );
    const content = `Read order ${kind} ${crypto.randomUUID()}`;
    const messageId = await createMessage(
      page,
      db,
      origin,
      community,
      actorApId,
      content,
    );
    const ownerAfterSetup = await first(
      db,
      "SELECT * FROM actors WHERE ap_id = ?",
      actorApId,
    );
    const poll = await waitResponse(
      observed,
      (response) =>
        response.status === 200 &&
        response.messages?.some((message) => message.id === messageId),
      "real four-second poll with new message",
      async () => ({
        requestCounts: { ...monitored.counts },
        interceptedGets: held.count,
        heldInitialStatus: captured.status,
        heldInitialIds:
          captured.json?.messages.map((message) => message.id) ?? null,
        expectedMessageId: messageId,
        page: await page.evaluate(() => ({
          url: location.href,
          visibility: document.visibilityState,
          title: document.querySelector(".p-talk-chat-title")?.textContent,
          loading: document.body.textContent?.includes("読み込み中..."),
        })),
      }),
    );
    await waitReadProbe(page, path, 2, 200, true);
    requireHistory(
      poll.messages.filter((message) => message.id === messageId).length ===
        1 && held.count === 2,
      "poll did not fetch the persisted message exactly once",
    );
    // Candidate can settle and show this message before the old full GET is
    // released. On baseline the pending full load keeps the spinner visible.
    if (mode === "candidate") await waitRendered(page, content);
    const responseBeforeRelease = observed.responses.length;
    held.release();
    await held.finish();
    const oldFull = await responseSeenAfter(
      observed,
      responseBeforeRelease,
      (response) =>
        response.status === captured.status &&
        (synthetic503 || response.sha256 === captured.sha256),
      "held initial GET",
    );
    const probeAfterOldFull = await waitReadProbe(
      page,
      path,
      1,
      captured.status,
      !synthetic503,
      2,
    );
    if (mode === "candidate") {
      await waitRendered(page, content);
      await page
        .getByText("読み込み中...", { exact: true })
        .waitFor({ state: "hidden", timeout: 10_000 });
      await historyErrorRow(page).waitFor({ state: "hidden", timeout: 3_000 });
    } else if (synthetic503) {
      await historyErrorRow(page).waitFor({ state: "visible", timeout: 3_000 });
      requireHistory(
        (await rendered(page, content)) === 0,
        "baseline failure unexpectedly preserved polled message",
      );
    } else {
      await page
        .getByText("まだメッセージがありません。あいさつを送ってみましょう。", {
          exact: true,
        })
        .waitFor({ state: "visible", timeout: 3_000 });
      await waitAbsent(page, content);
      requireHistory(
        (await rendered(page, content)) === 0,
        "baseline stale full unexpectedly preserved polled message",
      );
    }
    const rows = await assertFixtureRows(db, actorApId, community, [messageId]);
    requireHistory(
      JSON.stringify(ownerAfterSetup) ===
        JSON.stringify(
          await first(db, "SELECT * FROM actors WHERE ap_id = ?", actorApId),
        ),
      "full/poll outcome changed owner actor after native message setup",
    );
    requireHistory(
      monitored.counts.messageGets === 2 &&
        monitored.counts.messagePosts === 1 &&
        monitored.counts.messagePatches === 0 &&
        monitored.counts.readMarks <= 2,
      "unexpected GET, message mutation, or mark-read count in full/poll lane",
    );
    checks.push(`browser-history-read-order-${kind}-${mode}`);
    return {
      kind,
      communityApId: community.apId,
      initialStatus: captured.status,
      pollStatus: poll.status,
      pollMessageId: messageId,
      oldFullSha256: oldFull.sha256,
      pollSha256: poll.sha256,
      appReadProbe: probeAfterOldFull,
      interceptedGets: held.count,
      requests: { ...monitored.counts },
      nativeRows: rows,
      symptom:
        mode === "baseline-red"
          ? synthetic503
            ? "stale-error-hid-polled-message"
            : "stale-full-hid-polled-message"
          : "polled-message-visible",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    held.release();
    try {
      await held.finish();
    } catch (error) {
      if (!primaryError) throw error;
    }
    try {
      await held.dispose();
    } catch (error) {
      if (!primaryError) throw error;
    }
    observed.dispose();
    monitored.dispose();
  }
}

async function laneOldPollAfterRetry({
  page,
  db,
  origin,
  actorApId,
  mode,
  checks,
}) {
  const community = await createCommunity(
    page,
    `retry_${crypto.randomUUID().slice(0, 8)}`,
  );
  const path = messagesPath(origin, community.apId);
  await installReadProbe(page, path);
  const observed = observeReads(page, path);
  const monitored = monitorLaneRequests(page, path);
  let firstGet = true;
  const pollEntered = signal();
  const releasePoll = signal();
  const pollFinished = signal();
  let pollSnapshot;
  let pollError;
  let pollCount = 0;
  const handler = async (route) => {
    if (route.request().method() !== "GET" || route.request().url() !== path) {
      await route.fallback();
      return;
    }
    if (firstGet) {
      firstGet = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"fixture initial read unavailable"}',
      });
      return;
    }
    if (pollCount++ !== 0) {
      await route.fallback();
      return;
    }
    try {
      const response = await route.fetch();
      const body = await response.body();
      const json = JSON.parse(body.toString());
      requireHistory(
        response.status() === 200 && Array.isArray(json.messages),
        "old poll did not capture native GET200",
      );
      pollSnapshot = {
        status: response.status(),
        headers: response.headers(),
        body,
        json,
        sha256: sha256(body),
      };
      pollEntered.resolve(pollSnapshot);
      await releasePoll.promise;
      await route.fulfill({
        status: pollSnapshot.status,
        headers: pollSnapshot.headers,
        body: pollSnapshot.body,
      });
    } catch (error) {
      pollError = error;
      pollEntered.reject(error);
      try {
        await route.abort("failed");
      } catch {
        /* page may already close */
      }
    } finally {
      pollFinished.resolve();
    }
  };
  await page.route(path, handler);
  let primaryError;
  try {
    await openTalk(page, origin);
    await selectCommunity(page, community);
    await historyErrorRow(page).waitFor({ state: "visible", timeout: 10_000 });
    await waitReadProbe(page, path, 1, 503, false);
    const oldContent = `Read order before edit ${crypto.randomUUID()}`;
    const editedContent = `Read order after edit ${crypto.randomUUID()}`;
    const messageId = await createMessage(
      page,
      db,
      origin,
      community,
      actorApId,
      oldContent,
    );
    const oldPoll = await bounded(
      pollEntered.promise,
      "real four-second old poll",
    );
    requireHistory(
      oldPoll?.json.messages.length === 1 &&
        oldPoll.json.messages[0].id === messageId &&
        oldPoll.json.messages[0].content === oldContent,
      "held poll did not carry the native pre-edit message bytes",
    );
    await editMessage(page, db, origin, community, messageId, editedContent);
    const ownerAfterSetup = await first(
      db,
      "SELECT * FROM actors WHERE ap_id = ?",
      actorApId,
    );
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    const retry = await waitResponse(
      observed,
      (response) =>
        response.status === 200 &&
        response.messages?.some(
          (message) =>
            message.id === messageId && message.content === editedContent,
        ),
      "retry full GET with edited message",
    );
    await waitReadProbe(page, path, 3, 200, true);
    requireHistory(
      pollCount === 2,
      "retry did not issue exactly one full GET after the held poll",
    );
    await waitRendered(page, editedContent);
    const responseBeforeRelease = observed.responses.length;
    releasePoll.resolve();
    await bounded(pollFinished.promise, "old poll delivery");
    const deliveredOldPoll = await responseSeenAfter(
      observed,
      responseBeforeRelease,
      (response) =>
        response.status === 200 &&
        response.sha256 === oldPoll.sha256 &&
        response.messages?.some(
          (message) =>
            message.id === messageId && message.content === oldContent,
        ),
      "held old poll browser response",
    );
    // Let the app's own response parser and Solid update pass the captured
    // browser response before checking the absence of the stale value.
    const probeAfterOldPoll = await waitReadProbe(page, path, 2, 200, true, 3);
    if (mode === "candidate") {
      await waitRendered(page, editedContent);
      requireHistory(
        (await rendered(page, oldContent)) === 0,
        "old poll reverted the edited message",
      );
    } else {
      await waitRendered(page, oldContent);
      requireHistory(
        (await rendered(page, editedContent)) === 0,
        "baseline old poll did not revert edited message",
      );
    }
    const persisted = await first(
      db,
      "SELECT content FROM objects WHERE ap_id = ?",
      messageId,
    );
    requireHistory(
      persisted?.content === editedContent && retry.status === 200,
      "retry message was not persisted",
    );
    const fixtureRows = await assertFixtureRows(db, actorApId, community, [
      messageId,
    ]);
    requireHistory(
      JSON.stringify(ownerAfterSetup) ===
        JSON.stringify(
          await first(db, "SELECT * FROM actors WHERE ap_id = ?", actorApId),
        ),
      "retry outcome changed owner actor after native message setup",
    );
    requireHistory(
      monitored.counts.messageGets === 3 &&
        monitored.counts.messagePosts === 1 &&
        monitored.counts.messagePatches === 1 &&
        monitored.counts.readMarks <= 2,
      "unexpected GET, message mutation, or mark-read count in retry lane",
    );
    checks.push(`browser-history-read-order-retry-${mode}`);
    return {
      kind: "retry",
      communityApId: community.apId,
      initialStatus: 503,
      oldPollStatus: oldPoll.status,
      retryStatus: retry.status,
      pollMessageId: messageId,
      oldPollSha256: deliveredOldPoll.sha256,
      retrySha256: retry.sha256,
      appReadProbe: probeAfterOldPoll,
      interceptedGets: 1 + pollCount,
      requests: { ...monitored.counts },
      nativeRows: fixtureRows,
      symptom:
        mode === "baseline-red"
          ? "old-poll-reverted-server-edit"
          : "retry-edit-preserved",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    releasePoll.resolve();
    if (pollCount > 0) {
      try {
        await bounded(pollFinished.promise, "old poll cleanup", 5_000);
      } catch (error) {
        if (!primaryError) throw error;
      }
    }
    await page.unroute(path, handler);
    observed.dispose();
    monitored.dispose();
    if (pollError && !primaryError) throw pollError;
  }
}

export async function qualifyBrowserHistoryReadOrder({
  page,
  db,
  origin,
  actorApId,
  checks = [],
  mode = "candidate",
}) {
  requireHistory(
    page && db && Array.isArray(checks),
    "native page, D1, and checks are required",
  );
  requireHistory(
    mode === "candidate" || mode === "baseline-red",
    "invalid qualification mode",
  );
  requireHistory(
    new URL(actorApId).origin === origin,
    "actor is outside local Worker origin",
  );
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const identity = await api(page, "GET", "/api/auth/me");
  requireHistory(
    identity.status === 200 && identity.body?.actor?.ap_id === actorApId,
    "browser page lacks authenticated owner session",
  );
  const sessionsBefore = await rows(db, "SELECT * FROM sessions ORDER BY id");
  const otherActorsBefore = await rows(
    db,
    "SELECT * FROM actors WHERE ap_id != ? ORDER BY ap_id",
    actorApId,
  );
  const priorActorIds = new Set(otherActorsBefore.map((actor) => actor.ap_id));
  const start = checks.length;
  const success = await lanePendingFull({
    page,
    db,
    origin,
    actorApId,
    mode,
    checks,
    synthetic503: false,
  });
  const failure = await lanePendingFull({
    page,
    db,
    origin,
    actorApId,
    mode,
    checks,
    synthetic503: true,
  });
  const retry = await laneOldPollAfterRetry({
    page,
    db,
    origin,
    actorApId,
    mode,
    checks,
  });
  const sessionsAfter = await rows(db, "SELECT * FROM sessions ORDER BY id");
  const otherActorsAfter = await rows(
    db,
    "SELECT * FROM actors WHERE ap_id != ? ORDER BY ap_id",
    actorApId,
  );
  const preservedPriorActors = otherActorsAfter.filter((actor) =>
    priorActorIds.has(actor.ap_id),
  );
  const allowedNewActorIds = new Set([
    success.communityApId,
    failure.communityApId,
    retry.communityApId,
  ]);
  requireHistory(
    JSON.stringify(sessionsBefore) === JSON.stringify(sessionsAfter) &&
      JSON.stringify(otherActorsBefore) ===
        JSON.stringify(preservedPriorActors) &&
      otherActorsAfter.every(
        (actor) =>
          priorActorIds.has(actor.ap_id) || allowedNewActorIds.has(actor.ap_id),
      ),
    "history qualification changed a session or unrelated actor",
  );
  requireHistory(
    checks.length === start + 3,
    "history qualification did not append exactly three checks",
  );
  return {
    status: mode === "candidate" ? "PASSED" : "EXPECTED_BASELINE_RED",
    fixtureScope:
      "local disposable native Worker communities/messages; initial 503 is browser transport only",
    checks: checks.slice(start),
    lanes: { success, failure, retry },
    sessionCount: sessionsAfter.length,
    preexistingOtherActorCount: otherActorsBefore.length,
  };
}
