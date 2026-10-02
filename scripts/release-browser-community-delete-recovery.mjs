// Disposable native-browser qualification for an optimistic community-message
// delete racing a newer persisted arrival. All messages and groups are created
// through the real local Worker. Synthetic failures are browser-boundary
// transport aborts before the Core DELETE; this is not a live/federation test.

function requireCommunityDeleteRecovery(condition, message) {
  if (!condition) {
    throw new Error(`community-delete-recovery ${message}`);
  }
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
      () => reject(new Error(`community-delete-recovery ${label} timed out`)),
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
  const name = `ga_delrec_${suffix}`;
  const displayName = `Delete recovery ${suffix}`;
  const result = await page.evaluate(
    async ({ name, displayName }) => {
      const response = await fetch("/api/communities", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          display_name: displayName,
          summary: "Disposable local browser recovery fixture",
        }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { name, displayName },
  );
  requireCommunityDeleteRecovery(
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

function messagePath(origin, communityApId) {
  return `${origin}/api/communities/${encodeURIComponent(communityApId)}/messages`;
}

function deletePath(origin, communityApId, messageId) {
  return `${messagePath(origin, communityApId)}/${encodeURIComponent(messageId)}`;
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

async function sendMessage(page, db, origin, community, actorApId, content) {
  const path = messagePath(origin, community.apId);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === new URL(path).pathname &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  responsePromise.catch(() => {});
  await page.locator('textarea[name="message"]').fill(content);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  requireCommunityDeleteRecovery(
    response.status() === 201 && typeof body?.message?.id === "string",
    `real Worker message send failed (${response.status()})`,
  );
  await page
    .locator("li.c-talk-chat")
    .filter({ hasText: content })
    .waitFor({ state: "visible", timeout: 10_000 });
  const native = await first(
    db,
    `SELECT o.ap_id, o.content, o.attributed_to,
            r.recipient_ap_id, r.type AS recipient_type
       FROM objects o
       JOIN object_recipients r ON r.object_ap_id = o.ap_id
      WHERE o.ap_id = ? AND r.recipient_ap_id = ? AND r.type = 'audience'`,
    body.message.id,
    community.apId,
  );
  requireCommunityDeleteRecovery(
    native?.ap_id === body.message.id &&
      native.content === content &&
      native.attributed_to === actorApId &&
      native.recipient_ap_id === community.apId &&
      native.recipient_type === "audience",
    "real POST did not persist its message in native D1",
  );
  return body.message;
}

async function createServerMessage(
  page,
  db,
  origin,
  community,
  actorApId,
  content,
) {
  const path = messagePath(origin, community.apId);
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
  requireCommunityDeleteRecovery(
    sent.status === 201 && sent.body?.message?.content === content,
    `real Worker M1 creation failed (${sent.status})`,
  );
  const native = await first(
    db,
    `SELECT o.ap_id, o.content, o.attributed_to,
            r.recipient_ap_id, r.type AS recipient_type
       FROM objects o
       JOIN object_recipients r ON r.object_ap_id = o.ap_id
      WHERE o.ap_id = ? AND r.recipient_ap_id = ? AND r.type = 'audience'`,
    sent.body.message.id,
    community.apId,
  );
  requireCommunityDeleteRecovery(
    native?.ap_id === sent.body.message.id &&
      native.content === content &&
      native.attributed_to === actorApId &&
      native.recipient_ap_id === community.apId &&
      native.recipient_type === "audience",
    "real Worker M1 was not persisted under the owner and community audience",
  );
  return { id: native.ap_id, content: native.content };
}

async function beginHeldDelete(page, origin, community, message) {
  const exactPath = deletePath(origin, community.apId, message.id);
  const entered = gate("delete request held before Core");
  const finish = gate("delete request release");
  const handled = gate("delete route handler finished");
  let intercepted = 0;
  const handler = async (route) => {
    if (
      route.request().method() !== "DELETE" ||
      new URL(route.request().url()).pathname !== new URL(exactPath).pathname
    ) {
      await route.continue();
      return;
    }
    intercepted += 1;
    entered.resolve(route);
    try {
      await finish.promise;
      // Deliberate synthetic transport failure. route.fetch() is never called,
      // so Core cannot delete this native object.
      await route.abort("failed");
    } catch (error) {
      entered.reject(error);
    } finally {
      handled.resolve();
    }
  };
  await page.route(exactPath, handler);
  const deleteLease = {
    exactPath,
    handler,
    intercepted: () => intercepted,
    release: () => finish.resolve(),
    handled: bounded(handled.promise, "delete route handler finished"),
    dispose: () => page.unroute(exactPath, handler),
  };
  try {
    const row = page
      .locator("li.c-talk-chat")
      .filter({ hasText: message.content });
    await row
      .getByRole("button", { name: "メッセージ操作", exact: true })
      .click();
    await row.getByRole("menuitem", { name: "削除", exact: true }).click();
    const dialog = page.getByRole("alertdialog", {
      name: "メッセージを削除",
    });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const failedRequest = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === new URL(exactPath).pathname,
      timeout: 15_000,
    });
    failedRequest.catch(() => {});
    await dialog.getByRole("button", { name: "削除", exact: true }).click();
    await bounded(entered.promise, "delete intercepted before Core");
    return { ...deleteLease, failedRequest };
  } catch (error) {
    finish.resolve();
    try {
      await bounded(handled.promise, "failed DELETE setup cleanup", 5_000);
    } catch {
      // Preserve the setup failure while making a best effort to release route.
    }
    await page.unroute(exactPath, handler);
    throw error;
  }
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

async function assertVisibleMessage(page, content, label) {
  const bubble = page.locator("li.c-talk-chat").filter({ hasText: content });
  await bubble.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    (text) => {
      const matches = Array.from(
        document.querySelectorAll("li.c-talk-chat"),
      ).filter((row) => row.textContent?.includes(text));
      return (
        matches.length === 1 &&
        !matches[0].classList.contains("is-pending") &&
        !matches[0].classList.contains("is-failed")
      );
    },
    content,
    { timeout: 10_000 },
  );
  return bubble;
}

async function runConcurrentArrivalCase({
  page,
  db,
  origin,
  actorApId,
  community,
  checks,
  mode,
}) {
  const m1Content = `M1 before delete ${crypto.randomUUID()}`;
  const m1 = await createServerMessage(
    page,
    db,
    origin,
    community,
    actorApId,
    m1Content,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator("li.c-talk-rooms").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await selectCommunity(page, community);
  await assertVisibleMessage(page, m1Content, "server-backed M1 before delete");
  const deletion = await beginHeldDelete(page, origin, community, m1);
  const m2Content = `M2 concurrent arrival ${crypto.randomUUID()}`;
  let primaryError;
  try {
    const m2 = await sendMessage(
      page,
      db,
      origin,
      community,
      actorApId,
      m2Content,
    );
    const nativeM2 = await nativeMessage(db, m2.id, community.apId);
    await assertVisibleMessage(page, m2Content, "M2 before DELETE failure");
    const m1BeforeFailure = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m1Content })
      .count();
    requireCommunityDeleteRecovery(
      nativeM2?.attributed_to === actorApId &&
        nativeM2.recipient_ap_id === community.apId &&
        nativeM2.recipient_type === "audience" &&
        nativeM2.content === m2Content,
      "M2 did not persist under the authenticated actor and fixture community",
    );
    requireCommunityDeleteRecovery(
      m1BeforeFailure === 0,
      "M1 was already visible before the concurrent DELETE failure",
    );

    const errorToast = page
      .getByRole("alert")
      .filter({ hasText: "削除に失敗しました" });
    deletion.release();
    await bounded(deletion.failedRequest, "synthetic DELETE transport failure");
    await bounded(deletion.handled, "synthetic DELETE handler completion");
    await errorToast.waitFor({ state: "visible", timeout: 10_000 });
    // Wait beyond the failed handler's response completion and UI settling; no
    // timed background poll or delayed continuation may hide the new message.
    await page.waitForTimeout(500);
    const retainedM1 = await nativeMessage(db, m1.id, community.apId);
    const retainedM2 = await nativeMessage(db, m2.id, community.apId);
    const visibleM2 = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m2Content })
      .isVisible()
      .catch(() => false);
    const visibleM1 = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m1Content })
      .isVisible()
      .catch(() => false);
    requireCommunityDeleteRecovery(
      deletion.intercepted() === 1 &&
        retainedM1?.ap_id === m1.id &&
        retainedM2?.ap_id === m2.id,
      "synthetic abort touched native state or repeated the DELETE",
    );
    await deletion.dispose();
    if (mode === "baseline-red") {
      requireCommunityDeleteRecovery(
        !visibleM2 && visibleM1,
        `#36 snapshot rollback regression was not reproduced: ${JSON.stringify({ visibleM1, visibleM2, nativeM1: retainedM1?.ap_id, nativeM2: retainedM2?.ap_id })}`,
      );
      checks.push(
        "browser-community-delete-recovery-baseline-red-loses-concurrent-m2",
      );
      return {
        result: "expected-red",
        syntheticFailure: "DELETE aborted before route.fetch/Core",
        messages: { m1: m1.id, m2: m2.id },
        native: { m1: retainedM1, m2: retainedM2 },
        visible: { m1: visibleM1, m2: visibleM2 },
      };
    }
    requireCommunityDeleteRecovery(
      visibleM1 && visibleM2,
      `failed delete did not restore M1 and retain concurrent M2: ${JSON.stringify({ visibleM1, visibleM2 })}`,
    );
    checks.push(
      "browser-community-delete-failure-retains-concurrent-native-m2",
    );
    return {
      result: "green",
      syntheticFailure: "DELETE aborted before route.fetch/Core",
      messages: { m1: m1.id, m2: m2.id },
      native: { m1: retainedM1, m2: retainedM2 },
      visible: { m1: visibleM1, m2: visibleM2 },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    deletion.release();
    try {
      await bounded(
        deletion.handled,
        "DELETE cleanup handler completion",
        5_000,
      );
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
    await deletion.dispose();
  }
}

async function runABADeleteFailureCase({
  page,
  db,
  origin,
  actorApId,
  communityA,
  communityB,
  checks,
  mode,
}) {
  const m1Content = `M1 A before route change ${crypto.randomUUID()}`;
  const m1 = await createServerMessage(
    page,
    db,
    origin,
    communityA,
    actorApId,
    m1Content,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator("li.c-talk-rooms").first().waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await selectCommunity(page, communityA);
  await assertVisibleMessage(page, m1Content, "server-backed M1 in A");
  const deletion = await beginHeldDelete(page, origin, communityA, m1);
  let primaryError;
  try {
    const m2Content = `M2 A after route change ${crypto.randomUUID()}`;
    const m2 = await sendMessage(
      page,
      db,
      origin,
      communityA,
      actorApId,
      m2Content,
    );
    const nativeM2 = await nativeMessage(db, m2.id, communityA.apId);
    requireCommunityDeleteRecovery(
      nativeM2?.ap_id === m2.id &&
        nativeM2.attributed_to === actorApId &&
        nativeM2.recipient_ap_id === communityA.apId &&
        nativeM2.recipient_type === "audience" &&
        nativeM2.content === m2Content,
      "route-change M2 was not persisted in native D1",
    );

    await selectCommunity(page, communityB);
    await selectCommunity(page, communityA);
    await assertVisibleMessage(page, m2Content, "M2 after returning A");
    const oldM1 = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m1Content })
      .count();
    requireCommunityDeleteRecovery(
      oldM1 === 1,
      "A re-entry did not reload the original M1 while DELETE remained pending",
    );
    const errorToast = page
      .getByRole("alert")
      .filter({ hasText: "削除に失敗しました" });
    const errorToastBefore = await errorToast.count();

    deletion.release();
    await bounded(deletion.failedRequest, "late synthetic DELETE failure");
    await bounded(deletion.handled, "late DELETE handler completion");
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await page.waitForTimeout(350);

    const nativeM1 = await nativeMessage(db, m1.id, communityA.apId);
    const nativeAfterM2 = await nativeMessage(db, m2.id, communityA.apId);
    const visibleM1 = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m1Content })
      .isVisible()
      .catch(() => false);
    const visibleM2 = await page
      .locator("li.c-talk-chat")
      .filter({ hasText: m2Content })
      .isVisible()
      .catch(() => false);
    const staleErrorVisible = (await errorToast.count()) > errorToastBefore;
    if (mode === "navigation-red") {
      requireCommunityDeleteRecovery(
        deletion.intercepted() === 1 &&
          nativeM1?.ap_id === m1.id &&
          nativeAfterM2?.ap_id === m2.id &&
          visibleM1 &&
          !visibleM2 &&
          staleErrorVisible,
        `#36 ABA late-failure regression was not reproduced: ${JSON.stringify({ visibleM1, visibleM2, staleErrorVisible, nativeM1: nativeM1?.ap_id, nativeM2: nativeAfterM2?.ap_id })}`,
      );
      checks.push(
        "browser-community-delete-navigation-baseline-red-stale-snapshot-and-error-toast",
      );
      return {
        result: "expected-red",
        syntheticFailure:
          "DELETE aborted before route.fetch/Core after A-to-B-to-A selection",
        messages: { m1: m1.id, m2: m2.id },
        native: { m1: nativeM1, m2: nativeAfterM2 },
        visible: { m1: visibleM1, m2: visibleM2 },
        staleErrorVisible,
      };
    }
    requireCommunityDeleteRecovery(
      deletion.intercepted() === 1 &&
        nativeM1?.ap_id === m1.id &&
        nativeAfterM2?.ap_id === m2.id &&
        visibleM1 &&
        visibleM2 &&
        !staleErrorVisible,
      `late A failure changed the reloaded A state or showed an obsolete error: ${JSON.stringify({ visibleM1, visibleM2, staleErrorVisible, nativeM1: nativeM1?.ap_id, nativeM2: nativeAfterM2?.ap_id })}`,
    );
    checks.push(
      "browser-community-delete-late-failure-does-not-restore-stale-a-snapshot-after-aba",
    );
    return {
      result: "green",
      syntheticFailure:
        "DELETE aborted before route.fetch/Core after A-to-B-to-A selection",
      messages: { m1: m1.id, m2: m2.id },
      native: { m1: nativeM1, m2: nativeAfterM2 },
      visible: { m1: visibleM1, m2: visibleM2 },
      staleErrorVisible,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    deletion.release();
    try {
      await bounded(
        deletion.handled,
        "ABA DELETE cleanup handler completion",
        5_000,
      );
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
    await deletion.dispose();
  }
}

export async function qualifyBrowserCommunityDeleteRecovery({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode,
}) {
  requireCommunityDeleteRecovery(
    page && db,
    "native browser page and D1 are required",
  );
  requireCommunityDeleteRecovery(
    typeof origin === "string" && typeof actorApId === "string",
    "origin and authenticated actor AP ID are required",
  );
  requireCommunityDeleteRecovery(
    Array.isArray(checks),
    "checks array is required",
  );
  requireCommunityDeleteRecovery(
    new URL(actorApId).origin === new URL(origin).origin,
    "actor AP ID must belong to the local Worker origin",
  );
  requireCommunityDeleteRecovery(
    mode === undefined || mode === "baseline-red" || mode === "navigation-red",
    "mode must be omitted, baseline-red, or navigation-red",
  );
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const communityA = await createCommunity(page, `a_${suffix}`);
  const communityB = await createCommunity(page, `b_${suffix}`);
  await openTalk(page, origin);
  if (mode === "navigation-red") {
    const navigation = await runABADeleteFailureCase({
      page,
      db,
      origin,
      actorApId,
      communityA,
      communityB,
      checks,
      mode,
    });
    return {
      result: "expected-red",
      fixtureScope:
        "disposable native Worker community/messages; no federation or live-state proof",
      navigation,
    };
  }
  const concurrent = await runConcurrentArrivalCase({
    page,
    db,
    origin,
    actorApId,
    community: communityA,
    checks,
    mode,
  });
  if (mode === "baseline-red") {
    return {
      result: "expected-red",
      fixtureScope:
        "disposable native Worker community/messages; no federation or live-state proof",
      concurrent,
    };
  }
  await page
    .getByRole("alert")
    .filter({ hasText: "削除に失敗しました" })
    .waitFor({ state: "hidden", timeout: 10_000 });
  const aba = await runABADeleteFailureCase({
    page,
    db,
    origin,
    actorApId,
    communityA,
    communityB,
    checks,
    mode,
  });
  return {
    result: "green",
    fixtureScope:
      "disposable native Worker community/messages; no federation or live-state proof",
    communities: [communityA.apId, communityB.apId],
    concurrent,
    aba,
  };
}
