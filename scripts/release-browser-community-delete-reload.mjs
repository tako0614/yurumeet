// Disposable local-native-browser reload qualification for a confirmed
// community send whose storage removal fails during a successful DELETE.
// The injected failure affects one exact journal entry; Worker writes, reads,
// and DELETE remain real local requests.

function requireDeleteReload(condition, message) {
  if (!condition) throw new Error(`community-delete-reload ${message}`);
}

function gate(label) {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  promise.catch(() => {});
  return { label, promise, resolve, reject };
}

async function bounded(promise, label, timeout = 15_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`community-delete-reload ${label} timed out`)),
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

async function counts(db) {
  return first(
    db,
    `SELECT (SELECT COUNT(*) FROM actors) AS actors,
            (SELECT COUNT(*) FROM sessions) AS sessions`,
  );
}

async function sessionCookie(page, origin) {
  return (await page.context().cookies(origin)).find(
    (cookie) => cookie.name === "session",
  );
}

async function createCommunity(page, suffix) {
  const name = `ga_delreload_${suffix}`;
  const displayName = `Delete reload ${suffix}`;
  const result = await page.evaluate(
    async ({ name, displayName }) => {
      const response = await fetch("/api/communities", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          display_name: displayName,
          summary: "Disposable local delete-reload fixture",
        }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { name, displayName },
  );
  requireDeleteReload(
    result.status === 201 &&
      result.body?.community?.name === name &&
      typeof result.body.community.ap_id === "string",
    `real local Worker community create failed (${result.status})`,
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

function holdHistoryUntilReload(page, origin, community) {
  const exactPath = new URL(messagesPath(origin, community.apId)).pathname;
  const initialDone = gate("initial history GET delivered");
  const held = [];
  const pending = [];
  const released = new Set();
  let abortPromise;
  let requests = 0;
  let allowReloadHistory = false;
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
    requests += 1;
    if (requests === 1 || allowReloadHistory) {
      try {
        if (requests === 1) {
          const response = await route.fetch({ maxRedirects: 0 });
          const body = await response.body();
          requireDeleteReload(
            response.status() === 200,
            `initial community history GET failed (${response.status()})`,
          );
          await route.fulfill({
            status: response.status(),
            headers: response.headers(),
            body,
          });
          initialDone.resolve();
        } else {
          await route.continue();
        }
      } catch (error) {
        if (requests === 1) initialDone.reject(error);
        else throw error;
      }
      return;
    }
    const entered = gate("post-ACK history held before browser observation");
    const released = gate("held history request aborted for reload");
    const completion = gate("held history request cleanup complete");
    const entry = { route, entered, released, completed: completion };
    pending.push(entry);
    entered.resolve();
    try {
      await entry.released.promise;
      try {
        await route.abort("aborted");
      } catch (error) {
        entry.completed.reject(error);
        throw error;
      }
      entry.completed.resolve();
    } finally {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      held.push(entry);
    }
  };
  return {
    handler,
    initial: bounded(initialDone.promise, "initial history response"),
    held,
    pending,
    waitForHeld: async () => {
      const deadline = Date.now() + 15_000;
      while (held.length + pending.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      requireDeleteReload(
        held.length + pending.length > 0,
        "post-ACK history hold timed out",
      );
    },
    allowReloadHistory: () => {
      allowReloadHistory = true;
    },
    abortHeld: async () => {
      if (!abortPromise) {
        abortPromise = (async () => {
          const entries = [...pending, ...held];
          for (const entry of entries) {
            entry.released.resolve();
          }
          await bounded(
            Promise.all(entries.map((entry) => entry.completed.promise)),
            "held history request cleanup",
          );
          for (const entry of entries) released.add(entry);
          await page.unroute("**/api/communities/**/messages**", handler);
        })();
      }
      await abortPromise;
    },
    requestCount: () => requests,
    heldCount: () => held.length + pending.length,
    releasedCount: () => released.size,
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

async function sendUiMessage(
  page,
  db,
  origin,
  community,
  actorApId,
  content,
  expectStoredAck = false,
) {
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
  requireDeleteReload(
    response.status() === 201 && body?.message?.content === content,
    `real UI message POST failed (${response.status()})`,
  );
  const row = page.locator("li.c-talk-chat").filter({ hasText: content });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const native = await nativeMessage(db, body.message.id, community.apId);
  requireDeleteReload(
    native?.ap_id === body.message.id &&
      native.content === content &&
      native.attributed_to === actorApId &&
      native.recipient_ap_id === community.apId &&
      native.recipient_type === "audience",
    "real UI POST did not persist with the owner and audience in native D1",
  );
  if (expectStoredAck) {
    await waitForStoredEntry(
      page,
      `yurume:outgoing:v1:${encodeURIComponent(origin)}:${encodeURIComponent(actorApId)}:community:${encodeURIComponent(community.apId)}:`,
      body.message.id,
      { version: 1, state: "confirmed" },
      "confirmed UI ACK journal persistence",
    );
  }
  return body.message;
}

function installRemoveFailure(
  page,
  { origin, actorApId, communityApId, content },
) {
  const prefix = `yurume:outgoing:v1:${encodeURIComponent(origin)}:${encodeURIComponent(actorApId)}:community:${encodeURIComponent(communityApId)}:`;
  return page.addInitScript(
    ({ prefix, content }) => {
      const activationKey = "__community_delete_reload_arm_once";
      if (sessionStorage.getItem(activationKey) !== "1") return;
      sessionStorage.removeItem(activationKey);
      const installed = Storage.prototype.removeItem;
      const original = installed.__communityDeleteReloadOriginal ?? installed;
      const state = { denied: 0, keys: [], original };
      Object.defineProperty(window, "__communityDeleteReloadStorageFault", {
        configurable: true,
        value: state,
      });
      const guardedRemove = function (key) {
        if (key.startsWith(prefix)) {
          try {
            const saved = JSON.parse(this.getItem(key) ?? "null");
            if (saved?.record?.content === content) {
              state.denied += 1;
              state.keys.push(key);
              throw new DOMException(
                "Synthetic sessionStorage removeItem refusal for exact fixture intent",
                "QuotaExceededError",
              );
            }
          } catch (error) {
            if (error?.name === "QuotaExceededError") throw error;
          }
        }
        return state.original.call(this, key);
      };
      Object.defineProperty(guardedRemove, "__communityDeleteReloadOriginal", {
        value: original,
      });
      Storage.prototype.removeItem = guardedRemove;
    },
    { prefix, content },
  );
}

async function storedEntry(page, prefix, serverId) {
  return page.evaluate(
    ({ prefix, serverId }) => {
      const found = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        let envelope;
        try {
          envelope = JSON.parse(sessionStorage.getItem(key));
        } catch {
          continue;
        }
        if (envelope?.record?.serverId === serverId) {
          found.push({ key, envelope, raw: sessionStorage.getItem(key) });
        }
      }
      return found;
    },
    { prefix, serverId },
  );
}

async function waitForStoredEntry(page, prefix, serverId, expected, label) {
  await page
    .waitForFunction(
      ({ prefix, serverId, expected }) => {
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const key = sessionStorage.key(i);
          if (!key?.startsWith(prefix)) continue;
          let envelope;
          try {
            envelope = JSON.parse(sessionStorage.getItem(key));
          } catch {
            continue;
          }
          if (
            envelope?.record?.serverId === serverId &&
            envelope.record.version === expected.version &&
            envelope.record.state === expected.state &&
            (expected.recordId === undefined ||
              envelope.record.id === expected.recordId)
          ) {
            return true;
          }
        }
        return false;
      },
      { prefix, serverId, expected },
      { timeout: 10_000, polling: 50 },
    )
    .catch((error) => {
      throw new Error(
        `community-delete-reload ${label} timed out: ${error.message}`,
      );
    });
}

async function isVisible(page, text) {
  return page
    .locator("li.c-talk-chat")
    .filter({ hasText: text })
    .isVisible()
    .catch(() => false);
}

async function waitForReloadAuth(page, origin, actorApId) {
  const observe = () => {
    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).origin === origin &&
        new URL(candidate.url()).pathname === "/api/auth/me" &&
        candidate.request().method() === "GET",
      { timeout: 20_000 },
    );
    response.catch(() => {});
    return response;
  };
  let responsePromise = observe();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  let response = await responsePromise;
  const attempts = [response.status()];
  if (response.status() === 429) {
    const retryAfter = response.headers()["retry-after"];
    requireDeleteReload(
      /^\d+$/.test(retryAfter ?? "") &&
        Number(retryAfter) >= 1 &&
        Number(retryAfter) <= 60,
      "reload auth quota returned an invalid Retry-After",
    );
    await page.waitForTimeout(Number(retryAfter) * 1000);
    responsePromise = observe();
    await page
      .getByRole("heading", { name: "接続エラー", exact: true })
      .waitFor({
        state: "visible",
        timeout: 5_000,
      });
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    response = await responsePromise;
    attempts.push(response.status());
  }
  const body = await response.json().catch(() => null);
  requireDeleteReload(
    response.status() === 200 && body?.actor?.ap_id === actorApId,
    `reload did not keep the same authenticated principal (${response.status()})`,
  );
  await page.locator("li.c-talk-rooms").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  return attempts;
}

export async function qualifyBrowserCommunityDeleteReload({
  page,
  origin,
  db,
  actorApId,
  mode = "green",
}) {
  requireDeleteReload(
    ["127.0.0.1", "localhost"].includes(new URL(origin).hostname) &&
      new URL(actorApId).origin === new URL(origin).origin,
    "fixture is limited to one authenticated disposable local Worker principal",
  );
  requireDeleteReload(
    mode === "green" || mode === "baseline-red",
    "mode must be green or baseline-red",
  );
  const before = await counts(db);
  const pageErrors = [];
  const serverErrors = [];
  const capturePageError = (error) => pageErrors.push(error.message);
  const captureResponse = (response) => {
    if (response.status() >= 500) {
      serverErrors.push({ status: response.status(), url: response.url() });
    }
  };
  page.on("pageerror", capturePageError);
  page.on("response", captureResponse);
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const community = await createCommunity(page, suffix);
  const afterCommunity = await counts(db);
  requireDeleteReload(
    before.actors === afterCommunity.actors &&
      before.sessions === afterCommunity.sessions,
    "fixture community creation changed actor/session counts",
  );
  const m1Content = `M1 confirmed then deleted ${crypto.randomUUID()}`;
  const m2Content = `M2 remains after reload ${crypto.randomUUID()}`;
  await page.evaluate(() =>
    sessionStorage.setItem("__community_delete_reload_arm_once", "1"),
  );
  await installRemoveFailure(page, {
    origin,
    actorApId,
    communityApId: community.apId,
    content: m1Content,
  });
  const history = holdHistoryUntilReload(page, origin, community);
  await page.route("**/api/communities/**/messages**", history.handler);
  let primaryError;
  try {
    await openTalk(page, origin);
    await selectCommunity(page, community);
    await history.initial;
    const m1 = await sendUiMessage(
      page,
      db,
      origin,
      community,
      actorApId,
      m1Content,
      true,
    );
    const prefix = `yurume:outgoing:v1:${encodeURIComponent(origin)}:${encodeURIComponent(actorApId)}:community:${encodeURIComponent(community.apId)}:`;
    const keyBeforeDelete = await storedEntry(page, prefix, m1.id);
    requireDeleteReload(
      keyBeforeDelete.length === 1 &&
        keyBeforeDelete[0].key ===
          `${prefix}${keyBeforeDelete[0].envelope.record.id}` &&
        keyBeforeDelete[0].envelope.scope.serverOrigin === origin &&
        keyBeforeDelete[0].envelope.scope.principalApId === actorApId &&
        keyBeforeDelete[0].envelope.record.target.type === "community" &&
        keyBeforeDelete[0].envelope.record.target.ap_id === community.apId &&
        keyBeforeDelete[0].envelope.record.version === 1 &&
        keyBeforeDelete[0].envelope.record.state === "confirmed" &&
        keyBeforeDelete[0].envelope.record.id.startsWith("temp-") &&
        keyBeforeDelete[0].envelope.record.serverId === m1.id,
      "UI M1 ACK was not persisted as the exact confirmed v1 journal entry",
    );
    requireDeleteReload(
      keyBeforeDelete[0].raw === JSON.stringify(keyBeforeDelete[0].envelope),
      "confirmed M1 sessionStorage bytes do not match their verified envelope",
    );
    const storageFault = await page.evaluate(
      () => window.__communityDeleteReloadStorageFault,
    );
    requireDeleteReload(
      storageFault?.denied >= 1 &&
        storageFault.keys.length === storageFault.denied &&
        storageFault.keys.every((key) => key === keyBeforeDelete[0].key),
      "synthetic removeItem refusal did not target only M1's exact journal key",
    );
    await page
      .getByRole("alert")
      .filter({ hasText: "送信済みですが復旧履歴を更新できません" })
      .waitFor({ state: "visible", timeout: 5_000 });
    const acknowledgementDeniedCount = storageFault.denied;

    const m2 = await sendUiMessage(
      page,
      db,
      origin,
      community,
      actorApId,
      m2Content,
    );
    await history.waitForHeld();
    const heldCountBeforeDelete = history.heldCount();
    requireDeleteReload(
      heldCountBeforeDelete >= 1 && (await isVisible(page, m1Content)),
      "post-ACK history GET was not held or the confirmed M1 disappeared before delete",
    );

    const row = page.locator("li.c-talk-chat").filter({ hasText: m1Content });
    await row
      .getByRole("button", { name: "メッセージ操作", exact: true })
      .click();
    await row.getByRole("menuitem", { name: "削除", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: "メッセージを削除" });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const deletionPath = new URL(deletePath(origin, community.apId, m1.id))
      .pathname;
    const deleteResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).origin === origin &&
        new URL(response.url()).pathname === deletionPath &&
        response.request().method() === "DELETE",
      { timeout: 15_000 },
    );
    deleteResponse.catch(() => {});
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    const response = await deleteResponse;
    const deleteBody = await response.json().catch(() => null);
    requireDeleteReload(
      response.status() === 200 && deleteBody?.success === true,
      `real local Worker DELETE failed (${response.status()})`,
    );
    await row.waitFor({ state: "hidden", timeout: 10_000 });
    if (mode === "green") {
      await waitForStoredEntry(
        page,
        prefix,
        m1.id,
        {
          version: 2,
          state: "deleted",
          recordId: keyBeforeDelete[0].envelope.record.id,
        },
        "minimal deleted marker persistence after DELETE",
      );
    } else {
      await page
        .getByRole("alert")
        .filter({ hasText: "削除済みですが復旧履歴を更新できません" })
        .waitFor({ state: "visible", timeout: 5_000 });
    }
    const deletedObject = await first(
      db,
      "SELECT ap_id, type FROM objects WHERE ap_id = ?",
      m1.id,
    );
    const retainedM2 = await nativeMessage(db, m2.id, community.apId);
    requireDeleteReload(
      deletedObject === null && retainedM2?.ap_id === m2.id,
      "native DELETE result was not absence of M1 with M2 retained",
    );
    const visibleAfterDelete = {
      m1: await isVisible(page, m1Content),
      m2: await isVisible(page, m2Content),
    };
    requireDeleteReload(
      !visibleAfterDelete.m1 && visibleAfterDelete.m2,
      `successful DELETE UI state is unexpected: ${JSON.stringify(visibleAfterDelete)}`,
    );
    const keyAfterDelete = await storedEntry(page, prefix, m1.id);
    const deniedAfterDelete = await page.evaluate(
      () => window.__communityDeleteReloadStorageFault,
    );
    if (mode === "green") {
      requireDeleteReload(
        keyAfterDelete.length === 1 &&
          keyAfterDelete[0].key === keyBeforeDelete[0].key &&
          keyAfterDelete[0].envelope.record.version === 2 &&
          keyAfterDelete[0].envelope.record.state === "deleted" &&
          Object.keys(keyAfterDelete[0].envelope.record).sort().join(",") ===
            "id,serverId,state,target,version" &&
          keyAfterDelete[0].envelope.record.id ===
            keyBeforeDelete[0].envelope.record.id &&
          keyAfterDelete[0].envelope.record.serverId === m1.id &&
          deniedAfterDelete?.denied > acknowledgementDeniedCount &&
          deniedAfterDelete.keys
            .slice(acknowledgementDeniedCount)
            .every((key) => key === keyBeforeDelete[0].key),
        "successful delete did not leave one verified minimal v2 deleted marker",
      );
    } else {
      requireDeleteReload(
        deniedAfterDelete?.denied > acknowledgementDeniedCount &&
          deniedAfterDelete.keys
            .slice(acknowledgementDeniedCount)
            .every((key) => key === keyBeforeDelete[0].key) &&
          keyAfterDelete.length === 1 &&
          keyAfterDelete[0].key === keyBeforeDelete[0].key &&
          keyAfterDelete[0].envelope.record.version === 1 &&
          keyAfterDelete[0].envelope.record.state === "confirmed" &&
          keyAfterDelete[0].envelope.record.serverId === m1.id,
        "baseline did not preserve the exact confirmed M1 entry after denied removal",
      );
      const cleanupWarning = page
        .getByRole("alert")
        .filter({ hasText: "削除済みですが復旧履歴を更新できません" });
      await cleanupWarning.waitFor({ state: "visible", timeout: 5_000 });
    }
    if (mode === "green") {
      const expectedMarker = {
        version: 2,
        id: keyBeforeDelete[0].envelope.record.id,
        target: { type: "community", ap_id: community.apId },
        state: "deleted",
        serverId: m1.id,
      };
      requireDeleteReload(
        keyAfterDelete[0].raw ===
          JSON.stringify({
            scope: keyBeforeDelete[0].envelope.scope,
            record: expectedMarker,
          }),
        "minimal deletion marker readback bytes differ from the exact expected envelope",
      );
    } else {
      requireDeleteReload(
        keyAfterDelete[0].raw === keyBeforeDelete[0].raw,
        "baseline confirmed v1 bytes changed after failed marker cleanup",
      );
    }
    const beforeReloadVisible = {
      m1: await isVisible(page, m1Content),
      m2: await isVisible(page, m2Content),
    };
    requireDeleteReload(
      !beforeReloadVisible.m1 && beforeReloadVisible.m2,
      `UI state before reload is unexpected: ${JSON.stringify(beforeReloadVisible)}`,
    );

    await history.abortHeld();
    requireDeleteReload(
      history.releasedCount() >= 1,
      "post-ACK history response was not explicitly aborted before reload",
    );
    history.allowReloadHistory();
    const cookieBeforeReload = await sessionCookie(page, origin);
    requireDeleteReload(
      cookieBeforeReload?.value,
      "session cookie is missing before reload",
    );
    const authAttempts = await waitForReloadAuth(page, origin, actorApId);
    const cookieAfterReload = await sessionCookie(page, origin);
    const sameSession =
      cookieAfterReload?.value === cookieBeforeReload.value &&
      cookieAfterReload?.path === cookieBeforeReload.path;
    requireDeleteReload(
      sameSession,
      "reload replaced the authenticated session cookie",
    );
    await selectCommunity(page, community);
    await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m2Content })
      .waitFor({ state: "visible", timeout: 15_000 });
    const afterReload = {
      m1: await isVisible(page, m1Content),
      m2: await isVisible(page, m2Content),
    };
    const after = await counts(db);
    requireDeleteReload(
      JSON.stringify(afterCommunity) === JSON.stringify(after),
      "reload fixture changed actor/session counts",
    );
    if (mode === "baseline-red") {
      requireDeleteReload(
        afterReload.m1 && afterReload.m2,
        `immutable #38 did not reproduce the deleted confirmed M1 resurrection: ${JSON.stringify(afterReload)}`,
      );
      requireDeleteReload(
        pageErrors.length === 0 && serverErrors.length === 0,
        `baseline reload raised browser/runtime errors: ${JSON.stringify({ pageErrors, serverErrors })}`,
      );
      return {
        result: "EXPECTED_BASELINE_RED",
        failure:
          "confirmed M1 bridge reappeared after successful native DELETE and reload",
        actorApId,
        actorSessionCounts: { before, afterCommunity, after },
        authAttempts,
        community: community.apId,
        messages: { m1: m1.id, m2: m2.id },
        native: { m1: deletedObject, m2: retainedM2 },
        storage: {
          beforeDelete: keyBeforeDelete,
          afterDelete: keyAfterDelete,
          deniedRemove: deniedAfterDelete,
        },
        visibleBeforeReload: beforeReloadVisible,
        visibleAfterDelete,
        visibleAfterReload: afterReload,
        heldHistoryGets: heldCountBeforeDelete,
        pageErrors,
        serverErrors,
        sameSession,
        checks: [],
      };
    }
    requireDeleteReload(
      !afterReload.m1 && afterReload.m2,
      `deleted M1 reappeared or retained M2 was lost after reload: ${JSON.stringify(afterReload)}`,
    );
    requireDeleteReload(
      pageErrors.length === 0 && serverErrors.length === 0,
      `reload raised browser/runtime errors: ${JSON.stringify({ pageErrors, serverErrors })}`,
    );
    const finalEntry = await storedEntry(page, prefix, m1.id);
    requireDeleteReload(
      finalEntry.length === 1 &&
        finalEntry[0].key === keyBeforeDelete[0].key &&
        finalEntry[0].raw === keyAfterDelete[0].raw &&
        finalEntry[0].envelope.scope.serverOrigin === origin &&
        finalEntry[0].envelope.scope.principalApId === actorApId &&
        finalEntry[0].envelope.record.target.type === "community" &&
        finalEntry[0].envelope.record.target.ap_id === community.apId &&
        finalEntry[0].envelope.record.version === 2 &&
        finalEntry[0].envelope.record.state === "deleted" &&
        finalEntry[0].envelope.record.serverId === m1.id,
      "reload changed or retried the minimal deleted marker",
    );
    return {
      result: "green",
      checks: [
        "browser-community-delete-reload-confirmed-m1-ack-stored",
        "browser-community-delete-reload-denied-cleanup-writes-minimal-marker",
        "browser-community-delete-reload-native-delete-removes-m1-and-keeps-m2",
        "browser-community-delete-reload-marker-prevents-m1-resurrection",
        "browser-community-delete-reload-preserves-owner-session",
      ],
      fixtureScope:
        "disposable local Worker/D1 only; no federation or live data",
      actorApId,
      actorSessionCounts: { before, afterCommunity, after },
      authAttempts,
      community: community.apId,
      messages: { m1: m1.id, m2: m2.id },
      native: { m1: deletedObject, m2: retainedM2 },
      storage: {
        beforeDelete: keyBeforeDelete,
        afterDelete: keyAfterDelete,
        afterReload: finalEntry,
        deniedRemove: deniedAfterDelete,
      },
      visibleBeforeReload: beforeReloadVisible,
      visibleAfterDelete,
      visibleAfterReload: afterReload,
      heldHistoryGets: heldCountBeforeDelete,
      pageErrors,
      serverErrors,
      sameSession,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    page.off("pageerror", capturePageError);
    page.off("response", captureResponse);
    try {
      await page.evaluate(() => {
        const state = window.__communityDeleteReloadStorageFault;
        if (!state) return;
        state.active = false;
        Storage.prototype.removeItem = state.original;
        delete window.__communityDeleteReloadStorageFault;
      });
    } catch {
      // The page may already have closed after a fixture failure.
    }
    try {
      await history.abortHeld();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}
