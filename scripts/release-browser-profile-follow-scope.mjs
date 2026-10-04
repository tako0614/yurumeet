// Disposable native Worker + Chrome qualification for profile follow races.
// Remote follow targets live only in actor_cache; the accepted-follow lane
// creates a disposable local persona through the native account API. Target
// requests commit through workerd before their exact browser bytes are held.

import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requireFollow = (condition, message) => {
  if (!condition) throw new Error(`profile-follow-scope ${message}`);
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
          () => reject(new Error(`profile-follow-scope ${label} timed out`)),
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

function profilePath(origin, apId) {
  return `${origin}/profile/${encodeURIComponent(apId)}`;
}

function followPath(origin) {
  return `${origin}/api/follow`;
}

async function cachePersona(db, suffix) {
  const apId = `https://remote.example/ap/users/${suffix}`;
  const actor = {
    id: apId,
    type: "Person",
    preferredUsername: suffix,
    name: `Follow ${suffix}`,
    inbox: `${apId}/inbox`,
  };
  await db
    .prepare(
      `INSERT INTO actor_cache (ap_id, type, preferred_username, name, inbox, raw_json)
       VALUES (?, 'Person', ?, ?, ?, ?)`,
    )
    .bind(apId, suffix, actor.name, actor.inbox, JSON.stringify(actor))
    .run();
  return { apId, name: actor.name };
}

async function waitProfile(page, persona) {
  await page
    .locator(".p-profile-name")
    .filter({ hasText: persona.name })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function visibleFollowerCount(page) {
  return Number(
    await page
      .locator(".p-profile-stats button")
      .filter({ hasText: "フォロワー" })
      .locator("strong")
      .innerText(),
  );
}

async function spaNavigate(page, path) {
  const marker = crypto.randomUUID();
  await page.evaluate(
    ({ next, marker }) => {
      window.__profileFollowDocumentMarker = marker;
      const link = document.createElement("a");
      link.href = next;
      link.dataset.profileFollowFixture = "navigation";
      document.body.append(link);
      link.click();
      link.remove();
    },
    { next: path, marker },
  );
  await page.waitForURL(path, { timeout: 10_000 });
  requireFollow(
    (await page.evaluate(() => window.__profileFollowDocumentMarker)) ===
      marker,
    "profile navigation replaced the document",
  );
}

async function installProbe(page, method, path) {
  const init = function ({ method, path }) {
    const nativeFetch = window.fetch.bind(window);
    const key = `${method} ${path}`;
    const state = { key, initiated: 0, settled: [] };
    (window.__profileFollowProbes ??= {})[key] = state;
    const consumed = new WeakMap();
    const nativeJson = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const observation = consumed.get(this);
      const value = await nativeJson.apply(this, args);
      observation?.mark("json", value);
      return value;
    };
    const mark = (ordinal, status, kind, targetApId, bodySha256, body) =>
      window.setTimeout(
        () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              state.settled.push({
                ordinal,
                status,
                kind,
                targetApId,
                bodySha256,
                body,
              }),
            ),
          ),
        0,
      );
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
      let targetApId;
      try {
        targetApId = JSON.parse(args[1]?.body ?? "{}").target_ap_id;
      } catch {
        targetApId = undefined;
      }
      try {
        const response = await nativeFetch(...args);
        const bodyBytes = await response.clone().arrayBuffer();
        const bodyText = new TextDecoder().decode(bodyBytes);
        const bodyHash = await crypto.subtle.digest("SHA-256", bodyBytes);
        const bodySha256 = Array.from(new Uint8Array(bodyHash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          /* Bodyless successful DELETE remains observable by fetch status. */
        }
        const observation = {
          mark(kind, consumedBody = null) {
            mark(
              ordinal,
              response.status,
              kind,
              targetApId,
              bodySha256,
              consumedBody ?? parsedBody,
            );
          },
        };
        consumed.set(response, observation);
        window.setTimeout(() => {
          observation.mark("fetch", parsedBody);
        }, 0);
        return response;
      } catch (error) {
        mark(ordinal, 0, "error", targetApId, null, null);
        throw error;
      }
    };
  };
  await page.addInitScript(init, { method, path });
  await page.evaluate(init, { method, path });
}

async function waitProbe(
  page,
  method,
  path,
  expectedStatus,
  ordinal = 1,
  targetApId,
  expectedSha256,
) {
  const key = `${method} ${path}`;
  await page.waitForFunction(
    ({ key, status, ordinal, targetApId, method }) =>
      window.__profileFollowProbes?.[key]?.settled.some(
        (item) =>
          item.ordinal === ordinal &&
          item.status === status &&
          item.kind === (method === "POST" ? "json" : "fetch") &&
          item.targetApId === targetApId,
      ),
    { key, status: expectedStatus, ordinal, targetApId, method },
    { timeout: 10_000 },
  );
  const state = await page.evaluate(
    (probeKey) => window.__profileFollowProbes?.[probeKey],
    key,
  );
  requireFollow(
    state.initiated >= ordinal,
    `${key} reached only ${state.initiated} requests`,
  );
  const settled = state.settled.find(
    (item) =>
      item.ordinal === ordinal &&
      item.targetApId === targetApId &&
      item.status === expectedStatus,
  );
  requireFollow(
    settled?.bodySha256 === expectedSha256,
    `${key} response body digest differs from native bytes for ${targetApId}`,
  );
  return state;
}

async function holdCommittedResponse(
  page,
  method,
  path,
  targetApId,
  expectedStatus,
) {
  const entered = gate();
  const release = gate();
  const finished = gate();
  let count = 0;
  let captured;
  let error;
  const handler = async (route) => {
    if (
      route.request().method() !== method ||
      route.request().url() !== path ||
      route.request().postDataJSON()?.target_ap_id !== targetApId
    ) {
      await route.fallback();
      return;
    }
    count++;
    if (count !== 1) return route.fallback();
    try {
      const response = await route.fetch();
      const body = await response.body();
      requireFollow(
        expectedStatus
          ? response.status() === expectedStatus
          : response.status() >= 200 && response.status() < 300,
        `native ${method} returned ${response.status()} for ${targetApId}`,
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
        /* page already closed */
      }
    } finally {
      finished.resolve();
    }
  };
  await page.route(path, handler);
  return {
    entered: bounded(entered.promise, `${method} native action`),
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

function expectNativeResponse(page, method, path, targetApId, expected) {
  const pending = page.waitForResponse(
    (response) =>
      response.request().method() === method &&
      response.url() === path &&
      response.request().postDataJSON()?.target_ap_id === targetApId,
    { timeout: 10_000 },
  );
  pending.catch(() => {});
  return pending.then(async (response) => {
    const body = await response.body();
    requireFollow(
      response.status() === expected.status && sha256(body) === expected.sha256,
      `${method} browser delivery differs from native response bytes`,
    );
    return response.status();
  });
}

async function toastMessages(page) {
  return (await page.locator(".yc-toast").allTextContents()).map((text) =>
    text.trim(),
  );
}

async function followEdge(db, follower, target) {
  return first(
    db,
    "SELECT status, accepted_at FROM follows WHERE follower_ap_id = ? AND following_ap_id = ?",
    follower,
    target,
  );
}

async function lanePendingRouteSwitch({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `scope_a_${token}`);
  const b = await cachePersona(db, `scope_b_${token}`);
  const pathA = followPath(origin);
  const pathB = pathA;
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitProfile(page, a);
  const heldA = await holdCommittedResponse(page, "POST", pathA, a.apId);
  let heldB;
  let primary;
  try {
    const button = page.locator(".p-profile-follow");
    await button.click();
    const responseA = await heldA.entered;
    const edgeA = await followEdge(db, actorApId, a.apId);
    requireFollow(
      edgeA?.status === "pending" && heldA.count === 1,
      "native A follow did not commit exactly one pending edge before response delivery",
    );

    await spaNavigate(page, profilePath(origin, b.apId));
    await waitProfile(page, b);
    requireFollow(
      !(await page.locator(".p-profile-follow").isDisabled()),
      "new route B button remained busy after native A committed",
    );
    heldB = await holdCommittedResponse(page, "POST", pathB, b.apId);
    await page.locator(".p-profile-follow").click();
    const responseB = await heldB.entered;
    requireFollow(
      (await followEdge(db, actorApId, b.apId))?.status === "pending" &&
        heldB.count === 1,
      "native B follow did not commit while its response was held",
    );

    const nativeA = expectNativeResponse(
      page,
      "POST",
      pathA,
      a.apId,
      responseA,
    );
    const toastsBeforeA = await toastMessages(page);
    heldA.release();
    await heldA.finish();
    requireFollow(
      (await nativeA) === responseA.status,
      "A response status changed",
    );
    const probeA = await waitProbe(
      page,
      "POST",
      pathA,
      responseA.status,
      1,
      a.apId,
      responseA.sha256,
    );
    const bButton = page.locator(".p-profile-follow");
    requireFollow(
      (await bButton.isDisabled()) &&
        (await bButton.innerText()) === "フォロー" &&
        JSON.stringify(await toastMessages(page)) ===
          JSON.stringify(toastsBeforeA),
      "stale A completion cleared B's independently pending busy state",
    );
    checks.push("browser-profile-follow-a-to-b-old-finally-preserves-b-busy");

    const nativeB = expectNativeResponse(
      page,
      "POST",
      pathB,
      b.apId,
      responseB,
    );
    heldB.release();
    await heldB.finish();
    requireFollow(
      (await nativeB) === responseB.status,
      "B response status changed",
    );
    const probeB = await waitProbe(
      page,
      "POST",
      pathB,
      responseB.status,
      2,
      b.apId,
      responseB.sha256,
    );
    requireFollow(
      !(await bButton.isDisabled()) &&
        (await bButton.innerText()) === "リクエスト済み",
      "B's own pending result did not apply after its response",
    );
    checks.push(
      "browser-profile-follow-b-pending-result-applies-to-current-target",
    );
    return {
      a: { apId: a.apId, edge: edgeA },
      b: { apId: b.apId, edge: await followEdge(db, actorApId, b.apId) },
      responses: {
        a: { status: responseA.status, sha256: responseA.sha256 },
        b: { status: responseB.status, sha256: responseB.sha256 },
      },
      probes: { a: probeA, b: probeB },
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

async function laneAbaAndAcceptedUnfollow({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `scope_aba_${token}`);
  const accountName = `follow_peer_${token}`;
  const accountCreated = await page.evaluate(async (username) => {
    const response = await fetch("/api/auth/accounts", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, name: `Follow peer ${username}` }),
    });
    const body = await response.json().catch(() => null);
    const accountsResponse = await fetch("/api/auth/accounts", {
      credentials: "include",
    });
    return {
      status: response.status,
      body,
      accounts: await accountsResponse.json().catch(() => null),
    };
  }, accountName);
  requireFollow(
    [200, 201].includes(accountCreated.status) &&
      accountCreated.body?.account?.ap_id &&
      accountCreated.accounts?.current_ap_id === actorApId &&
      accountCreated.accounts.accounts?.some(
        (account) => account.ap_id === accountCreated.body.account.ap_id,
      ),
    `native local follow persona creation failed (${accountCreated.status})`,
  );
  const accepted = {
    apId: accountCreated.body.account.ap_id,
    name: accountCreated.body.account.name,
    preferredUsername: accountCreated.body.account.preferred_username,
  };
  const createdAccountOwner = await first(
    db,
    "SELECT owner_actor_ap_id FROM actors WHERE ap_id = ?",
    accepted.apId,
  );
  requireFollow(
    createdAccountOwner?.owner_actor_ap_id === actorApId,
    "native account API did not link persona to the current owner",
  );
  const pathA = followPath(origin);
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitProfile(page, a);
  const heldA = await holdCommittedResponse(page, "POST", pathA, a.apId);
  let primary;
  try {
    await page.locator(".p-profile-follow").click();
    const native = await heldA.entered;
    requireFollow(
      (await followEdge(db, actorApId, a.apId))?.status === "pending",
      "A follow did not commit pending state before the response was held",
    );
    await spaNavigate(page, profilePath(origin, accepted.apId));
    await waitProfile(page, accepted);
    await spaNavigate(page, profilePath(origin, a.apId));
    await waitProfile(page, a);
    const currentButton = page.locator(".p-profile-follow");
    requireFollow(
      (await currentButton.innerText()) === "フォロー" &&
        !(await currentButton.isDisabled()),
      "A→B→A did not reload the current actor state while retaining pending edge",
    );
    const nativeDelivery = expectNativeResponse(
      page,
      "POST",
      pathA,
      a.apId,
      native,
    );
    const toastsBefore = await toastMessages(page);
    heldA.release();
    await heldA.finish();
    await nativeDelivery;
    const probe = await waitProbe(
      page,
      "POST",
      pathA,
      native.status,
      1,
      a.apId,
      native.sha256,
    );
    requireFollow(
      (await currentButton.innerText()) === "フォロー" &&
        !(await currentButton.isDisabled()) &&
        JSON.stringify(await toastMessages(page)) ===
          JSON.stringify(toastsBefore),
      "stale A completion affected a later A visit or emitted its toast",
    );
    checks.push("browser-profile-follow-a-to-b-to-a-old-completion-is-retired");
    const aba = {
      target: a.apId,
      edge: await followEdge(db, actorApId, a.apId),
      response: { status: native.status, sha256: native.sha256 },
      probe,
      requestCount: heldA.count,
    };

    const acceptedPath = followPath(origin);
    await page.goto(profilePath(origin, accepted.apId), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await waitProfile(page, accepted);
    const initialEdge = await followEdge(db, actorApId, accepted.apId);
    requireFollow(
      initialEdge === null,
      "new local persona already had a follow edge",
    );
    const followCountsBefore = await first(
      db,
      "SELECT following_count FROM actors WHERE ap_id = ?",
      actorApId,
    );
    const heldAccepted = await holdCommittedResponse(
      page,
      "POST",
      acceptedPath,
      accepted.apId,
    );
    let acceptedFollowError;
    let acceptedResponse;
    let acceptedProbe;
    try {
      const button = page.locator(".p-profile-follow");
      requireFollow(
        (await button.innerText()) === "フォロー",
        "new local persona was already followed",
      );
      await button.click();
      acceptedResponse = await heldAccepted.entered;
      const acceptedEdge = await followEdge(db, actorApId, accepted.apId);
      const countAfterCommit = await first(
        db,
        "SELECT following_count FROM actors WHERE ap_id = ?",
        actorApId,
      );
      requireFollow(
        acceptedEdge?.status === "accepted" &&
          countAfterCommit?.following_count ===
            followCountsBefore.following_count + 1 &&
          heldAccepted.count === 1,
        "native local follow did not commit accepted edge and increment before delivery",
      );
      requireFollow(
        (
          await first(
            db,
            "SELECT follower_count FROM actors WHERE ap_id = ?",
            accepted.apId,
          )
        )?.follower_count === 1 && (await visibleFollowerCount(page)) === 0,
        "accepted follow target count must commit before its held UI result",
      );
      const nativeFollow = expectNativeResponse(
        page,
        "POST",
        acceptedPath,
        accepted.apId,
        acceptedResponse,
      );
      heldAccepted.release();
      await heldAccepted.finish();
      await nativeFollow;
      acceptedProbe = await waitProbe(
        page,
        "POST",
        acceptedPath,
        acceptedResponse.status,
        1,
        accepted.apId,
        acceptedResponse.sha256,
      );
      requireFollow(
        acceptedProbe.settled.find((item) => item.targetApId === accepted.apId)
          ?.body?.status === "accepted" &&
          (await button.innerText()) === "フォロー中" &&
          !(await button.isDisabled()),
        "accepted follow body or current profile state was not consumed",
      );
      requireFollow(
        (await visibleFollowerCount(page)) === 1,
        "current accepted follow must increment the rendered target count once",
      );
    } catch (error) {
      acceptedFollowError = error;
      throw error;
    } finally {
      heldAccepted.release();
      try {
        await heldAccepted.finish();
      } catch (error) {
        if (!acceptedFollowError) throw error;
      }
      try {
        await heldAccepted.dispose();
      } catch (error) {
        if (!acceptedFollowError) throw error;
      }
    }
    const countBeforeUnfollow = await first(
      db,
      "SELECT following_count FROM actors WHERE ap_id = ?",
      actorApId,
    );
    requireFollow(
      (await followEdge(db, actorApId, accepted.apId))?.status === "accepted" &&
        countBeforeUnfollow?.following_count ===
          followCountsBefore.following_count + 1,
      "native accepted edge or owner count drifted before unfollow",
    );
    const acceptedEdgeBeforeUnfollow = await followEdge(
      db,
      actorApId,
      accepted.apId,
    );
    const heldUnfollow = await holdCommittedResponse(
      page,
      "DELETE",
      acceptedPath,
      accepted.apId,
    );
    let unfollowError;
    try {
      const button = page.locator(".p-profile-follow");
      requireFollow(
        (await button.innerText()) === "フォロー中",
        "accepted edge was not displayed",
      );
      await button.click();
      const response = await heldUnfollow.entered;
      requireFollow(
        (await followEdge(db, actorApId, accepted.apId)) === null &&
          heldUnfollow.count === 1,
        "native accepted unfollow did not delete only its committed edge",
      );
      requireFollow(
        (
          await first(
            db,
            "SELECT follower_count FROM actors WHERE ap_id = ?",
            accepted.apId,
          )
        )?.follower_count === 0 && (await visibleFollowerCount(page)) === 1,
        "unfollow target count must commit before its held UI result",
      );
      const browserResponse = expectNativeResponse(
        page,
        "DELETE",
        acceptedPath,
        accepted.apId,
        response,
      );
      heldUnfollow.release();
      await heldUnfollow.finish();
      await browserResponse;
      const unfollowProbe = await waitProbe(
        page,
        "DELETE",
        acceptedPath,
        response.status,
        1,
        accepted.apId,
        response.sha256,
      );
      requireFollow(
        (await button.innerText()) === "フォロー" &&
          !(await button.isDisabled()),
        "accepted unfollow result was not reflected on its profile",
      );
      requireFollow(
        (await visibleFollowerCount(page)) === 0,
        "current unfollow must decrement the rendered target count once",
      );
      const ownerCountsAfterUnfollow = await first(
        db,
        "SELECT following_count FROM actors WHERE ap_id = ?",
        actorApId,
      );
      requireFollow(
        (await followEdge(db, actorApId, accepted.apId)) === null &&
          ownerCountsAfterUnfollow?.following_count ===
            followCountsBefore.following_count,
        "accepted unfollow did not delete the edge and restore the native owner count",
      );
      checks.push(
        "browser-profile-follow-accepted-unfollow-native-commit-and-delivery",
      );
      return {
        aba,
        acceptedUnfollow: {
          target: accepted.apId,
          personaOrigin:
            "created through native POST /api/auth/accounts in existing owner session",
          accountCreateStatus: accountCreated.status,
          acceptedFollowStatus: acceptedResponse.status,
          acceptedOutcome: acceptedProbe.settled.find(
            (item) => item.targetApId === accepted.apId,
          )?.body?.status,
          before: acceptedEdgeBeforeUnfollow,
          after: await followEdge(db, actorApId, accepted.apId),
          ownerFollowingCount: {
            before: followCountsBefore.following_count,
            after: ownerCountsAfterUnfollow.following_count,
          },
          response: { status: response.status, sha256: response.sha256 },
          probe: unfollowProbe,
          requestCount: heldUnfollow.count,
        },
      };
    } catch (error) {
      unfollowError = error;
      throw error;
    } finally {
      heldUnfollow.release();
      try {
        await heldUnfollow.finish();
      } catch (error) {
        if (!unfollowError) throw error;
      }
      try {
        await heldUnfollow.dispose();
      } catch (error) {
        if (!unfollowError) throw error;
      }
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    heldA.release();
    try {
      await heldA.finish();
    } catch (error) {
      if (!primary) throw error;
    }
    try {
      await heldA.dispose();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}

async function lanePendingCancellation({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const token = crypto.randomUUID().slice(0, 8);
  const target = await cachePersona(db, `scope_cancel_${token}`);
  const postPath = followPath(origin);
  const deletePath = postPath;
  await page.goto(profilePath(origin, target.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitProfile(page, target);
  const heldPost = await holdCommittedResponse(
    page,
    "POST",
    postPath,
    target.apId,
  );
  let primary;
  try {
    await page.locator(".p-profile-follow").click();
    const created = await heldPost.entered;
    requireFollow(
      (await followEdge(db, actorApId, target.apId))?.status === "pending",
      "pending cancellation fixture did not create a pending edge",
    );
    const postDelivery = expectNativeResponse(
      page,
      "POST",
      postPath,
      target.apId,
      created,
    );
    heldPost.release();
    await heldPost.finish();
    await postDelivery;
    await waitProbe(
      page,
      "POST",
      postPath,
      created.status,
      1,
      target.apId,
      created.sha256,
    );
    const heldDelete = await holdCommittedResponse(
      page,
      "DELETE",
      deletePath,
      target.apId,
    );
    await page
      .getByRole("button", { name: "フォローリクエストを取り消す" })
      .click();
    let deleteError;
    try {
      const removed = await heldDelete.entered;
      requireFollow(
        (await followEdge(db, actorApId, target.apId)) === null &&
          heldDelete.count === 1,
        "pending cancellation did not delete its edge before response delivery",
      );
      const deleteDelivery = expectNativeResponse(
        page,
        "DELETE",
        deletePath,
        target.apId,
        removed,
      );
      heldDelete.release();
      await heldDelete.finish();
      await deleteDelivery;
      const probe = await waitProbe(
        page,
        "DELETE",
        deletePath,
        removed.status,
        1,
        target.apId,
        removed.sha256,
      );
      const button = page.locator(".p-profile-follow");
      requireFollow(
        (await button.innerText()) === "フォロー" &&
          !(await button.isDisabled()),
        "pending cancellation response did not reset the profile control",
      );
      checks.push(
        "browser-profile-follow-pending-request-cancellation-native-commit",
      );
      return {
        target: target.apId,
        created: { status: created.status, sha256: created.sha256 },
        removed: { status: removed.status, sha256: removed.sha256 },
        finalEdge: await followEdge(db, actorApId, target.apId),
        probe,
        requestCounts: { post: heldPost.count, delete: heldDelete.count },
      };
    } catch (error) {
      deleteError = error;
      throw error;
    } finally {
      heldDelete.release();
      try {
        await heldDelete.finish();
      } catch (error) {
        if (!deleteError) throw error;
      }
      try {
        await heldDelete.dispose();
      } catch (error) {
        if (!deleteError) throw error;
      }
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    heldPost.release();
    try {
      await heldPost.finish();
    } catch (error) {
      if (!primary) throw error;
    }
    try {
      await heldPost.dispose();
    } catch (error) {
      if (!primary) throw error;
    }
  }
}

async function laneStaleNativeRefusal({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const refused = await cachePersona(db, `scope_refused_${token}`);
  const next = await cachePersona(db, `scope_after_refusal_${token}`);
  const path = followPath(origin);
  await page.goto(profilePath(origin, refused.apId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await waitProfile(page, refused);
  await db
    .prepare(
      `INSERT INTO follows (follower_ap_id, following_ap_id, status)
       VALUES (?, ?, 'pending')`,
    )
    .bind(actorApId, refused.apId)
    .run();
  const held = await holdCommittedResponse(
    page,
    "POST",
    path,
    refused.apId,
    400,
  );
  let primary;
  try {
    await page.locator(".p-profile-follow").click();
    const response = await held.entered;
    requireFollow(
      (await followEdge(db, actorApId, refused.apId))?.status === "pending" &&
        held.count === 1,
      "native duplicate refusal changed the existing pending edge",
    );
    await spaNavigate(page, profilePath(origin, next.apId));
    await waitProfile(page, next);
    const toastsBefore = await toastMessages(page);
    const nativeDelivery = expectNativeResponse(
      page,
      "POST",
      path,
      refused.apId,
      response,
    );
    held.release();
    await held.finish();
    await nativeDelivery;
    const probe = await waitProbe(
      page,
      "POST",
      path,
      400,
      1,
      refused.apId,
      response.sha256,
    );
    requireFollow(
      held.count === 1 &&
        (await followEdge(db, actorApId, refused.apId))?.status === "pending" &&
        JSON.stringify(await toastMessages(page)) ===
          JSON.stringify(toastsBefore),
      "stale native refusal changed follow data or toasted on another profile",
    );
    checks.push("browser-profile-follow-stale-native-refusal-is-retired");
    return {
      refused: refused.apId,
      current: next.apId,
      outcome: "native duplicate pending edge refused by workerd with HTTP 400",
      response: { status: response.status, sha256: response.sha256 },
      probe,
      deliveryCount: held.count,
      refusedEdge: await followEdge(db, actorApId, refused.apId),
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

export async function qualifyBrowserProfileFollowScope({
  page,
  db,
  origin,
  actorApId,
  checks = [],
}) {
  requireFollow(
    page && db && Array.isArray(checks),
    "native page, D1 and checks are required",
  );
  requireFollow(
    new URL(actorApId).origin === origin,
    "owner actor is not local to Worker",
  );
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/me", { credentials: "include" });
    const body = await response.json();
    return { status: response.status, actor: body.actor?.ap_id };
  });
  requireFollow(
    identity.status === 200 && identity.actor === actorApId,
    "page lacks owner session",
  );
  await installProbe(page, "POST", followPath(origin));
  await installProbe(page, "DELETE", followPath(origin));
  const start = checks.length;
  const pending = await lanePendingRouteSwitch({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const abaAndUnfollow = await laneAbaAndAcceptedUnfollow({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const pendingCancellation = await lanePendingCancellation({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  const refusal = await laneStaleNativeRefusal({
    page,
    db,
    origin,
    actorApId,
    checks,
  });
  requireFollow(
    checks.length === start + 6,
    "fixture did not append its six ordered checks",
  );
  return {
    status: "PASSED",
    fixtureScope:
      "local disposable native Worker and existing owner session; remote targets cached in actor_cache and accepted local target created through native account API",
    checks: checks.slice(start),
    lanes: { pending, abaAndUnfollow, pendingCancellation, refusal },
  };
}
