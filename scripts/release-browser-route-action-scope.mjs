// Disposable native Worker + Chrome qualification for async route actions.
// The target operation commits through workerd before only its browser
// response is held. Navigation remains inside the SPA during every race.

import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requireScope = (condition, message) => {
  if (!condition) throw new Error(`route-action-scope ${message}`);
};

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label, ms = 15_000) {
  let timer;
  promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`route-action-scope ${label} timed out`)),
          ms,
        );
      }),
    ]);
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

function communityPath(origin, apId) {
  return `${origin}/communities/${encodeURIComponent(apId)}`;
}

function profilePath(origin, apId) {
  return `${origin}/profile/${encodeURIComponent(apId)}`;
}

async function createCommunity(page, suffix, displayName) {
  const name = `ga_scope_${suffix}`;
  const result = await api(page, "POST", "/api/communities", {
    name,
    display_name: displayName,
    summary: "Disposable local route-action fixture",
  });
  requireScope(
    result.status === 201 && result.body?.community?.ap_id,
    `native community create failed (${result.status})`,
  );
  return { apId: result.body.community.ap_id, name, displayName };
}

async function waitCommunity(page, community) {
  await page
    .locator(".p-community-name")
    .filter({ hasText: community.displayName })
    .waitFor({
      state: "visible",
      timeout: 10_000,
    });
}

async function spaNavigate(page, path) {
  const documentMarker = crypto.randomUUID();
  await page.evaluate(
    ({ next, marker }) => {
      window.__routeActionDocumentMarker = marker;
      const link = document.createElement("a");
      link.href = next;
      link.dataset.routeActionFixture = "navigation";
      document.body.append(link);
      link.click();
      link.remove();
    },
    { next: path, marker: documentMarker },
  );
  await page.waitForURL(path, { timeout: 10_000 });
  requireScope(
    (await page.evaluate(() => window.__routeActionDocumentMarker)) ===
      documentMarker,
    "route navigation replaced the document instead of using the SPA",
  );
}

async function installActionProbe(page, method, path) {
  // The probe changes no status or bytes. It observes only the app's exact
  // target request and waits one task plus two frames after app consumption.
  const actionProbeInit = function ({ method, path }) {
    const nativeFetch = window.fetch.bind(window);
    const key = `${method} ${path}`;
    const state = { key, initiated: 0, settled: [] };
    (window.__routeActionProbes ??= {})[key] = state;
    const settled = (ordinal, status, kind) =>
      window.setTimeout(() => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            state.settled.push({ ordinal, status, kind });
          }),
        );
      }, 0);
    window.fetch = async (...args) => {
      const input = args[0];
      const actualMethod = (
        args[1]?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const actualUrl = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (actualMethod !== method || actualUrl.href !== path)
        return nativeFetch(...args);
      const ordinal = ++state.initiated;
      const response = await nativeFetch(...args);
      const json = response.json.bind(response);
      response.json = async (...jsonArgs) => {
        const value = await json(...jsonArgs);
        settled(ordinal, response.status, "json");
        return value;
      };
      // assertOk may finish without json() for PATCH/PUT. Record that path
      // only after fetch resolves, allowing SDK and UI continuations to drain.
      settled(ordinal, response.status, "fetch");
      return response;
    };
  };
  await page.addInitScript(actionProbeInit, { method, path });
  await page.evaluate(actionProbeInit, { method, path });
}

async function waitProbe(page, method, path, expectedStatus) {
  const key = `${method} ${path}`;
  await page.waitForFunction(
    ({ key, status }) => {
      const state = window.__routeActionProbes?.[key];
      return state?.settled.some(
        (item) =>
          item.ordinal === 1 && item.status === status && item.kind === "fetch",
      );
    },
    { key, status: expectedStatus },
    { timeout: 10_000 },
  );
  const state = await page.evaluate(
    (probeKey) => window.__routeActionProbes?.[probeKey],
    key,
  );
  requireScope(
    state.initiated === 1,
    `action probe saw ${state.initiated} target requests`,
  );
  return state;
}

async function holdCommittedResponse(page, method, path, expectedStatus = 200) {
  const entered = gate();
  const release = gate();
  const finished = gate();
  let count = 0;
  let captured;
  let error;
  const handler = async (route) => {
    if (route.request().method() !== method || route.request().url() !== path) {
      await route.fallback();
      return;
    }
    count++;
    if (count !== 1) {
      await route.fallback();
      return;
    }
    try {
      const response = await route.fetch();
      const body = await response.body();
      requireScope(
        response.status() === expectedStatus,
        `native ${method} returned ${response.status()} instead of ${expectedStatus}`,
      );
      captured = {
        status: response.status(),
        headers: response.headers(),
        body,
        sha256: sha256(body),
      };
      entered.resolve(captured);
      await release.promise;
      await route.fulfill({
        status: captured.status,
        headers: captured.headers,
        body: captured.body,
      });
    } catch (caught) {
      error = caught;
      entered.reject(caught);
      try {
        await route.abort("failed");
      } catch {
        /* closed page */
      }
    } finally {
      finished.resolve();
    }
  };
  await page.route(path, handler);
  return {
    entered: bounded(entered.promise, `${method} native operation`),
    get count() {
      return count;
    },
    release: () => release.resolve(),
    finish: () =>
      bounded(finished.promise, `${method} browser delivery`, 5_000),
    dispose: async () => {
      release.resolve();
      await page.unroute(path, handler);
      if (error) throw error;
    },
  };
}

function expectNativeResponse(page, method, path, sha) {
  const pending = page.waitForResponse(
    (item) => item.request().method() === method && item.url() === path,
    { timeout: 10_000 },
  );
  pending.catch(() => {});
  return pending.then(async (response) => {
    const bytes = await response.body();
    requireScope(
      sha256(bytes) === sha,
      `${method} browser bytes differ from committed workerd response`,
    );
    return response.status();
  });
}

async function ownerSessionSnapshot(db, actorApId) {
  return {
    actor: await first(db, "SELECT * FROM actors WHERE ap_id = ?", actorApId),
    sessions:
      (await db.prepare("SELECT * FROM sessions ORDER BY id").all()).results ??
      [],
  };
}

async function assertOwnerSessions(db, actorApId, before, allowOwnerChange) {
  const after = await ownerSessionSnapshot(db, actorApId);
  requireScope(
    JSON.stringify(before.sessions) === JSON.stringify(after.sessions),
    "fixture mutated authenticated sessions",
  );
  if (!allowOwnerChange)
    requireScope(
      JSON.stringify(before.actor) === JSON.stringify(after.actor),
      "fixture mutated owner actor outside profile save",
    );
  return after;
}

async function laneCommunitySettings({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await createCommunity(page, `a_${token}`, `Scope A ${token}`);
  const b = await createCommunity(page, `b_${token}`, `Scope B ${token}`);
  const initialB = await first(
    db,
    "SELECT name, summary, join_policy FROM communities WHERE ap_id = ?",
    b.apId,
  );
  const identity = await ownerSessionSnapshot(db, actorApId);
  await page.goto(communityPath(origin, a.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitCommunity(page, a);

  // An unsent A draft must close on B and must never submit to B.
  await page.getByRole("button", { name: "設定", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "グループ設定" });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  await dialog.getByLabel("表示名").fill(`Unsent A draft ${token}`);
  await spaNavigate(page, communityPath(origin, b.apId));
  await waitCommunity(page, b);
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  requireScope(
    (await first(db, "SELECT name FROM communities WHERE ap_id = ?", b.apId))
      .name === initialB.name,
    "A draft touched B during route change",
  );
  checks.push(
    "browser-route-action-settings-draft-closes-before-target-switch",
  );

  await spaNavigate(page, communityPath(origin, a.apId));
  await waitCommunity(page, a);
  const path = `${origin}/api/communities/${encodeURIComponent(a.apId)}/settings`;
  await installActionProbe(page, "PATCH", path);
  const held = await holdCommittedResponse(page, "PATCH", path);
  let primary;
  try {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const savedName = `Committed A ${token}`;
    await dialog.getByLabel("表示名").fill(savedName);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    const captured = await held.entered;
    const nativeA = await first(
      db,
      "SELECT name, summary, join_policy FROM communities WHERE ap_id = ?",
      a.apId,
    );
    requireScope(
      nativeA.name === savedName && held.count === 1,
      "A settings PATCH did not commit exactly once through native Worker",
    );
    await spaNavigate(page, communityPath(origin, b.apId));
    await waitCommunity(page, b);
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    const responsePromise = expectNativeResponse(
      page,
      "PATCH",
      path,
      captured.sha256,
    );
    held.release();
    await held.finish();
    requireScope(
      (await responsePromise) === 200,
      "held PATCH delivery was not HTTP 200",
    );
    const probe = await waitProbe(page, "PATCH", path, 200);
    requireScope(
      (await page.locator(".p-community-name").innerText()) === b.displayName,
      "A settings callback replaced B title",
    );
    requireScope(
      (await dialog.count()) === 0 &&
        (await page
          .locator(".yc-toast")
          .filter({ hasText: "グループ設定を更新しました" })
          .count()) === 0,
      "stale A settings callback opened editor or emitted success toast on B",
    );
    const afterB = await first(
      db,
      "SELECT name, summary, join_policy FROM communities WHERE ap_id = ?",
      b.apId,
    );
    requireScope(
      JSON.stringify(initialB) === JSON.stringify(afterB),
      "A settings PATCH mutated B",
    );
    await assertOwnerSessions(db, actorApId, identity, false);
    checks.push(
      "browser-route-action-settings-native-commit-stale-response-does-not-mutate-b",
    );
    return {
      a: a.apId,
      b: b.apId,
      operationSha256: captured.sha256,
      probe,
      nativeA,
      nativeB: afterB,
      requestCount: held.count,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    held.release();
    try {
      await held.finish();
    } catch (error) {
      if (!primary) throw error;
    }
    try {
      await held.dispose();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}

async function laneProfileSave({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const remoteApId = `https://remote.example/ap/users/ga_scope_${token}`;
  const remoteName = `Remote scope ${token}`;
  const remoteActor = {
    id: remoteApId,
    type: "Person",
    preferredUsername: `ga_scope_${token}`,
    name: remoteName,
    inbox: `${remoteApId}/inbox`,
  };
  await db
    .prepare(
      `INSERT INTO actor_cache (ap_id, type, preferred_username, name, inbox, raw_json)
     VALUES (?, 'Person', ?, ?, ?, ?)`,
    )
    .bind(
      remoteApId,
      remoteActor.preferredUsername,
      remoteName,
      remoteActor.inbox,
      JSON.stringify(remoteActor),
    )
    .run();
  const initialRemote = await first(
    db,
    "SELECT * FROM actor_cache WHERE ap_id = ?",
    remoteApId,
  );
  const identity = await ownerSessionSnapshot(db, actorApId);
  await page.goto(profilePath(origin, actorApId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page
    .getByRole("button", { name: "プロフィールを編集", exact: true })
    .waitFor({
      state: "visible",
      timeout: 15_000,
    });
  const path = `${origin}/api/actors/me`;
  await installActionProbe(page, "PUT", path);
  const held = await holdCommittedResponse(page, "PUT", path);
  let primary;
  try {
    await page
      .getByRole("button", { name: "プロフィールを編集", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "プロフィールを編集" });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });
    const savedName = `Saved owner ${token}`;
    await dialog.getByLabel("表示名").fill(savedName);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    const captured = await held.entered;
    const ownerAfterCommit = await first(
      db,
      "SELECT name FROM actors WHERE ap_id = ?",
      actorApId,
    );
    requireScope(
      ownerAfterCommit?.name === savedName && held.count === 1,
      "owner profile PUT did not commit exactly once through native Worker",
    );
    await spaNavigate(page, profilePath(origin, remoteApId));
    await page
      .locator(".p-profile-name")
      .filter({ hasText: remoteName })
      .waitFor({
        state: "visible",
        timeout: 15_000,
      });
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    const responsePromise = expectNativeResponse(
      page,
      "PUT",
      path,
      captured.sha256,
    );
    held.release();
    await held.finish();
    requireScope(
      (await responsePromise) === 200,
      "held profile PUT delivery was not HTTP 200",
    );
    const probe = await waitProbe(page, "PUT", path, 200);
    // The confirmed save must refresh root actor state without navigating or
    // issuing a fixture read that could repair a missing application refresh.
    await page
      .getByRole("link", { name: `${savedName} のプロフィール`, exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    requireScope(
      (await page.locator(".p-profile-name").innerText()).includes(
        remoteName,
      ) &&
        !(await page.locator(".p-profile-name").innerText()).includes(
          savedName,
        ),
      "stale owner save replaced remote profile",
    );
    requireScope(
      (await page
        .locator(".yc-toast")
        .filter({ hasText: "プロフィールを更新しました" })
        .count()) === 0,
      "stale owner save emitted success toast on remote profile",
    );
    const afterRemote = await first(
      db,
      "SELECT * FROM actor_cache WHERE ap_id = ?",
      remoteApId,
    );
    requireScope(
      JSON.stringify(initialRemote) === JSON.stringify(afterRemote),
      "owner save mutated cached remote profile",
    );
    await assertOwnerSessions(db, actorApId, identity, true);
    checks.push(
      "browser-route-action-profile-native-commit-stale-response-does-not-replace-other-actor",
    );
    return {
      owner: actorApId,
      other: remoteApId,
      nativeOwnerName: savedName,
      operationSha256: captured.sha256,
      probe,
      requestCount: held.count,
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    held.release();
    try {
      await held.finish();
    } catch (error) {
      if (!primary) throw error;
    }
    try {
      await held.dispose();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}

async function kickRemoteMember(page, remoteName) {
  const row = page
    .locator(".p-community-member")
    .filter({ hasText: remoteName });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.locator(".p-community-member-menu-btn").click();
  await page.getByRole("menuitem", { name: "グループから削除" }).click();
  const confirm = page.getByRole("alertdialog", { name: "メンバーを削除" });
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  await confirm.getByRole("button", { name: "削除", exact: true }).click();
  return row;
}

async function laneRemoteKickBusy({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await createCommunity(page, `kick_a_${token}`, `Kick A ${token}`);
  const b = await createCommunity(page, `kick_b_${token}`, `Kick B ${token}`);
  const remoteApId = `https://remote.example/ap/users/ga_kick_${token}`;
  const remoteName = `Kick peer ${token}`;
  const raw = {
    id: remoteApId,
    type: "Person",
    preferredUsername: `ga_kick_${token}`,
    name: remoteName,
    inbox: `${remoteApId}/inbox`,
  };
  await db
    .prepare(
      `INSERT INTO actor_cache (ap_id, type, preferred_username, name, inbox, raw_json)
     VALUES (?, 'Person', ?, ?, ?, ?)`,
    )
    .bind(
      remoteApId,
      raw.preferredUsername,
      remoteName,
      raw.inbox,
      JSON.stringify(raw),
    )
    .run();
  for (const community of [a, b]) {
    await db
      .prepare(
        `INSERT INTO follows (follower_ap_id, following_ap_id, status, activity_ap_id, accepted_at)
       VALUES (?, ?, 'accepted', NULL, datetime('now'))`,
      )
      .bind(remoteApId, community.apId)
      .run();
  }
  const identity = await ownerSessionSnapshot(db, actorApId);
  const pathA = `${origin}/api/communities/${encodeURIComponent(a.apId)}/members/${encodeURIComponent(remoteApId)}`;
  const pathB = `${origin}/api/communities/${encodeURIComponent(b.apId)}/members/${encodeURIComponent(remoteApId)}`;
  await installActionProbe(page, "DELETE", pathA);
  await installActionProbe(page, "DELETE", pathB);
  await page.goto(communityPath(origin, a.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitCommunity(page, a);
  const heldA = await holdCommittedResponse(page, "DELETE", pathA);
  let heldB;
  let primary;
  try {
    await kickRemoteMember(page, remoteName);
    const capturedA = await heldA.entered;
    const afterA = await first(
      db,
      "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
      remoteApId,
      a.apId,
    );
    const beforeB = await first(
      db,
      "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
      remoteApId,
      b.apId,
    );
    requireScope(
      afterA === null && beforeB?.status === "accepted" && heldA.count === 1,
      "native A kick did not remove only A accepted edge once",
    );

    await spaNavigate(page, communityPath(origin, b.apId));
    await waitCommunity(page, b);
    const bRow = page
      .locator(".p-community-member")
      .filter({ hasText: remoteName });
    await bRow.waitFor({ state: "visible", timeout: 10_000 });
    heldB = await holdCommittedResponse(page, "DELETE", pathB);
    await kickRemoteMember(page, remoteName);
    const capturedB = await heldB.entered;
    requireScope(
      heldB.count === 1 &&
        (await first(
          db,
          "SELECT status FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
          remoteApId,
          b.apId,
        )) === null,
      "native B kick did not commit exactly once while its response is pending",
    );

    const responseA = expectNativeResponse(
      page,
      "DELETE",
      pathA,
      capturedA.sha256,
    );
    heldA.release();
    await heldA.finish();
    requireScope(
      (await responseA) === 200,
      "held A DELETE delivery was not HTTP 200",
    );
    const probeA = await waitProbe(page, "DELETE", pathA, 200);
    requireScope(
      (await bRow.count()) === 1 &&
        (await bRow.locator(".p-community-member-menu-btn").isDisabled()),
      "stale A kick removed B member or cleared B pending action busy state",
    );
    requireScope(
      (await page
        .locator(".yc-toast")
        .filter({ hasText: "メンバーを削除しました" })
        .count()) === 0,
      "stale A kick emitted success toast on B",
    );
    checks.push(
      "browser-route-action-kick-old-finally-preserves-b-busy-and-member",
    );

    const responseB = expectNativeResponse(
      page,
      "DELETE",
      pathB,
      capturedB.sha256,
    );
    heldB.release();
    await heldB.finish();
    requireScope(
      (await responseB) === 200,
      "held B DELETE delivery was not HTTP 200",
    );
    const probeB = await waitProbe(page, "DELETE", pathB, 200);
    await bRow.waitFor({ state: "hidden", timeout: 5_000 });
    requireScope(
      heldA.count === 1 && heldB.count === 1,
      "kick request was retried",
    );
    await assertOwnerSessions(db, actorApId, identity, false);
    checks.push(
      "browser-route-action-kick-b-own-result-applies-after-a-stale-response",
    );
    return {
      a: a.apId,
      b: b.apId,
      remote: remoteApId,
      nativeAStatus: afterA,
      nativeBStatus: beforeB.status,
      aResponseSha256: capturedA.sha256,
      bResponseSha256: capturedB.sha256,
      probeA,
      probeB,
      requestCounts: { a: heldA.count, b: heldB.count },
    };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    for (const lease of [heldA, heldB].filter(Boolean)) {
      lease.release();
      try {
        await lease.finish();
      } catch (error) {
        if (!primary) throw error;
      }
      try {
        await lease.dispose();
      } catch (error) {
        if (!primary) throw error;
      }
    }
  }
}

export async function qualifyBrowserRouteActionScope({
  page,
  db,
  origin,
  actorApId,
  checks = [],
}) {
  requireScope(
    page && db && Array.isArray(checks),
    "native page, D1 and checks are required",
  );
  requireScope(
    new URL(actorApId).origin === origin,
    "actor is outside local Worker origin",
  );
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const identity = await api(page, "GET", "/api/auth/me");
  requireScope(
    identity.status === 200 && identity.body?.actor?.ap_id === actorApId,
    "browser page lacks owner session",
  );
  const start = checks.length;
  const settings = await laneCommunitySettings({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const profile = await laneProfileSave({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const kick = await laneRemoteKickBusy({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  requireScope(
    checks.length === start + 5,
    "qualification did not append exactly five checks",
  );
  return {
    status: "PASSED",
    fixtureScope: "local disposable native Worker, same owner session",
    checks: checks.slice(start),
    lanes: { settings, profile, kick },
  };
}
