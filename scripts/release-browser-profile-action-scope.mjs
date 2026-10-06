// Disposable native Worker + Chrome qualification for asynchronous profile
// actions. Remote profiles are inserted into actor_cache; only local accounts
// are used for authorized DM contact. Worker responses are committed first,
// then held at the browser boundary while SPA navigation proceeds.

import { createHash } from "node:crypto";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const requireAction = (condition, message) => {
  if (!condition) throw new Error(`profile-action-scope ${message}`);
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
          () => reject(new Error(`profile-action-scope ${label} timed out`)),
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

async function rootSessionRows(db, actorApId) {
  return (
    (
      await db
        .prepare(
          "SELECT id, member_id, expires_at FROM sessions WHERE member_id = ? ORDER BY id",
        )
        .bind(actorApId)
        .all()
    ).results ?? []
  );
}

async function readAuthIdentity(response) {
  const status = response.status();
  let actor;
  try {
    const body = await response.json();
    actor = body?.actor?.ap_id;
  } catch {
    // Keep diagnostics to status and identity only; malformed bodies are not
    // included in fixture output.
  }
  return { status, actor };
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeInitialAuth({ page, db, origin, actorApId }) {
  const path = `${origin}/api/auth/me`;
  const sessionCookie = async () =>
    (await page.context().cookies(origin)).find(
      (cookie) => cookie.name === "session",
    );
  const cookieBefore = await sessionCookie();
  const sessionsBefore = await rootSessionRows(db, actorApId);
  requireAction(
    cookieBefore?.value && sessionsBefore.length > 0,
    "existing owner session is required before profile-action page load",
  );

  const firstResponsePromise = page.waitForResponse(
    (response) =>
      response.url() === path && response.request().method() === "GET",
    { timeout: 15_000 },
  );
  firstResponsePromise.catch(() => {});
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const firstResponse = await bounded(
    firstResponsePromise,
    "initial native auth observation",
  );
  const initialStatus = firstResponse.status();
  let retryAfterSeconds = null;
  let retryClicks = 0;
  let finalIdentity = await readAuthIdentity(firstResponse);

  if (initialStatus === 429) {
    const header = firstResponse.headers()["retry-after"];
    retryAfterSeconds = /^\d+$/.test(header ?? "") ? Number(header) : NaN;
    requireAction(
      Number.isInteger(retryAfterSeconds) &&
        retryAfterSeconds >= 1 &&
        retryAfterSeconds <= 120,
      `initial GET /api/auth/me returned 429 with invalid Retry-After=${String(header)}`,
    );
    await page
      .getByRole("alert")
      .filter({ hasText: "認証状態を確認できませんでした" })
      .waitFor({
        state: "visible",
        timeout: 10_000,
      });
    await wait(retryAfterSeconds * 1_000 + 150);
    const retryResponsePromise = page.waitForResponse(
      (response) =>
        response.url() === path && response.request().method() === "GET",
      { timeout: 15_000 },
    );
    retryResponsePromise.catch(() => {});
    await page.getByRole("button", { name: "再試行", exact: true }).click();
    retryClicks++;
    const retryResponse = await bounded(
      retryResponsePromise,
      "explicit native auth retry",
    );
    finalIdentity = await readAuthIdentity(retryResponse);
    requireAction(
      retryResponse.status() === 200,
      `explicit GET /api/auth/me retry returned HTTP ${retryResponse.status()}`,
    );
  } else {
    requireAction(
      initialStatus === 200,
      `initial GET /api/auth/me returned HTTP ${initialStatus}`,
    );
  }

  requireAction(
    finalIdentity.actor === actorApId,
    `native auth observation returned HTTP ${finalIdentity.status} for a different or missing owner`,
  );
  const cookieAfter = await sessionCookie();
  const sessionsAfter = await rootSessionRows(db, actorApId);
  requireAction(
    cookieAfter?.value === cookieBefore.value &&
      JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore),
    "profile-action auth recovery changed the owner session or native root session rows",
  );
  return {
    initialStatus,
    retryAfterSeconds,
    uiRetryClicks: retryClicks,
    finalStatus: finalIdentity.status,
    sameOwner: finalIdentity.actor === actorApId,
    sameSessionCookie: cookieAfter.value === cookieBefore.value,
    rootSessionCountBefore: sessionsBefore.length,
    rootSessionCountAfter: sessionsAfter.length,
  };
}

function profilePath(origin, apId) {
  return `${origin}/profile/${encodeURIComponent(apId)}`;
}

async function cachePersona(db, suffix) {
  const apId = `https://remote.example/ap/users/${suffix}`;
  const actor = {
    id: apId,
    type: "Person",
    preferredUsername: suffix,
    name: `Action ${suffix}`,
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

function safeErrorName(error) {
  const name = error?.name;
  return [
    "Error",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "RangeError",
    "TimeoutError",
    "AbortError",
    "NetworkError",
  ].includes(name)
    ? name
    : "OtherError";
}

function boundedRetryAfter(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  if (/^\d{1,3}$/.test(value)) {
    const seconds = Number(value);
    return seconds >= 0 && seconds <= 120 ? seconds : null;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  const seconds = Math.ceil((date - Date.now()) / 1_000);
  return seconds >= 0 && seconds <= 120 ? seconds : null;
}

function observeFirstProfileNavigation(page, origin, persona) {
  const actorPath = new URL(
    `${origin}/api/actors/${encodeURIComponent(persona.apId)}`,
  ).pathname;
  const paths = new Map([
    ["/api/auth/me", "auth"],
    [actorPath, "actor"],
    [`${actorPath}/posts`, "posts"],
  ]);
  const requests = Object.fromEntries(
    ["auth", "actor", "posts"].map((kind) => [
      kind,
      { started: 0, failed: 0, responses: [], omittedResponses: 0 },
    ]),
  );
  const startedAt = new WeakMap();
  const pageErrors = [];
  let omittedPageErrors = 0;
  const requestKind = (request) => {
    if (request.method() !== "GET") return null;
    try {
      const url = new URL(request.url());
      return url.origin === origin ? (paths.get(url.pathname) ?? null) : null;
    } catch {
      return null;
    }
  };
  const onRequest = (request) => {
    try {
      const kind = requestKind(request);
      if (!kind) return;
      requests[kind].started++;
      startedAt.set(request, performance.now());
    } catch {
      // A passive observer must not change the browser journey.
    }
  };
  const onResponse = (response) => {
    try {
      const request = response.request();
      const kind = requestKind(request);
      if (!kind) return;
      const observed = requests[kind];
      if (observed.responses.length >= 6) {
        observed.omittedResponses++;
        return;
      }
      const start = startedAt.get(request);
      const elapsedMs =
        start === undefined ? null : Math.round(performance.now() - start);
      const headers = response.headers();
      observed.responses.push({
        status: response.status(),
        elapsedMs:
          elapsedMs !== null && elapsedMs >= 0 && elapsedMs <= 120_000
            ? elapsedMs
            : null,
        retryAfterSeconds: boundedRetryAfter(headers["retry-after"]),
      });
    } catch {
      // A passive observer must not change the browser journey.
    }
  };
  const onRequestFailed = (request) => {
    try {
      const kind = requestKind(request);
      if (kind) requests[kind].failed++;
    } catch {
      // A passive observer must not change the browser journey.
    }
  };
  const onPageError = (error) => {
    try {
      if (pageErrors.length >= 4) {
        omittedPageErrors++;
        return;
      }
      pageErrors.push({
        name: safeErrorName(error),
        messageSha256: sha256(String(error?.message ?? error)),
      });
    } catch {
      // A passive observer must not change the browser journey.
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("pageerror", onPageError);
  return {
    snapshot: () => ({ requests, pageErrors, omittedPageErrors }),
    dispose: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("pageerror", onPageError);
    },
  };
}

async function optionalDiagnosticRead(read) {
  try {
    return await bounded(
      Promise.resolve().then(read),
      "diagnostic read",
      1_500,
    );
  } catch {
    return null;
  }
}

async function firstProfileNavigationDiagnostic({
  page,
  db,
  origin,
  actorApId,
  persona,
  sessionBefore,
  observer,
  phase,
  error,
}) {
  const expectedPath = new URL(profilePath(origin, persona.apId)).pathname;
  let currentPathHash = null;
  let routeKind = "unknown";
  try {
    const current = new URL(page.url());
    currentPathHash = sha256(current.pathname);
    routeKind =
      current.origin !== origin
        ? "other-origin"
        : current.pathname === expectedPath
          ? "expected-a-profile"
          : current.pathname.startsWith("/profile/")
            ? "other-profile"
            : current.pathname === "/"
              ? "root"
              : "other-path";
  } catch {
    // The browser may already have closed; omit its path.
  }
  const [ui, cache, sessionAfter] = await Promise.all([
    optionalDiagnosticRead(() =>
      page.evaluate((name) => {
        const visible = (element) =>
          Boolean(element && element.getClientRects().length > 0);
        const textVisible = (selector, text) =>
          Array.from(document.querySelectorAll(selector)).some(
            (element) =>
              visible(element) && element.textContent?.trim() === text,
          );
        return {
          targetNameVisible: Array.from(
            document.querySelectorAll(".p-profile-name"),
          ).some(
            (element) =>
              visible(element) && element.textContent?.includes(name),
          ),
          anotherProfileNameVisible: Array.from(
            document.querySelectorAll(".p-profile-name"),
          ).some(visible),
          profileLoadErrorVisible: textVisible(
            ".p-timeline-state p",
            "プロフィールを読み込めませんでした",
          ),
          connectionErrorVisible: textVisible(".p-connect h1", "接続エラー"),
          loginVisible: Array.from(
            document.querySelectorAll('input[type="password"]'),
          ).some(visible),
          bootVisible: Array.from(document.querySelectorAll(".yc-boot")).some(
            visible,
          ),
        };
      }, persona.name),
    ),
    optionalDiagnosticRead(async () => {
      const started = performance.now();
      const row = await first(
        db,
        "SELECT ap_id, name, preferred_username FROM actor_cache WHERE ap_id = ?",
        persona.apId,
      );
      return {
        exactRowCount: row ? 1 : 0,
        apIdMatches: row ? row.ap_id === persona.apId : null,
        nameMatches: row ? row.name === persona.name : null,
        preferredUsernameMatches: row
          ? row.preferred_username ===
            new URL(persona.apId).pathname.split("/").at(-1)
          : null,
        apIdSha256: row?.ap_id ? sha256(row.ap_id) : null,
        nameSha256: row?.name ? sha256(row.name) : null,
        readElapsedMs: Math.round(performance.now() - started),
      };
    }),
    optionalDiagnosticRead(async () => ({
      cookie: (await page.context().cookies(origin)).find(
        (candidate) => candidate.name === "session",
      )?.value,
      rows: await rootSessionRows(db, actorApId),
    })),
  ]);
  return {
    kind: "yurumeet.profile-action-first-a-navigation-diagnostic@v1",
    phase,
    failureName: safeErrorName(error),
    failureMessageSha256: sha256(String(error?.message ?? error)),
    targetApIdSha256: sha256(persona.apId),
    principalApIdSha256: sha256(actorApId),
    routeKind,
    currentPathSha256: currentPathHash,
    ui,
    cache,
    session: {
      beforeAvailable: sessionBefore !== null,
      afterAvailable: sessionAfter !== null,
      cookiePresentBefore: sessionBefore ? Boolean(sessionBefore.cookie) : null,
      cookiePresentAfter: sessionAfter ? Boolean(sessionAfter.cookie) : null,
      sameCookie:
        sessionBefore?.cookie && sessionAfter?.cookie
          ? sessionBefore.cookie === sessionAfter.cookie
          : null,
      sameRootSessionRows:
        sessionBefore && sessionAfter
          ? JSON.stringify(sessionBefore.rows) ===
            JSON.stringify(sessionAfter.rows)
          : null,
      rootSessionCountBefore: sessionBefore?.rows.length ?? null,
      rootSessionCountAfter: sessionAfter?.rows.length ?? null,
    },
    ...observer.snapshot(),
  };
}

async function spaNavigate(page, path) {
  const marker = crypto.randomUUID();
  await page.evaluate(
    ({ next, marker }) => {
      window.__profileActionDocumentMarker = marker;
      const link = document.createElement("a");
      link.href = next;
      link.dataset.profileActionFixture = "navigation";
      document.body.append(link);
      link.click();
      link.remove();
    },
    { next: path, marker },
  );
  await page.waitForURL(path, { timeout: 10_000 });
  requireAction(
    (await page.evaluate(() => window.__profileActionDocumentMarker)) ===
      marker,
    "profile navigation replaced the document",
  );
}

async function installProbe(page, method, path) {
  const init = function ({ method, path }) {
    const nativeFetch = window.fetch.bind(window);
    const key = `${method} ${path}`;
    const state = { key, initiated: 0, settled: [] };
    (window.__profileActionProbes ??= {})[key] = state;
    const consumed = new WeakMap();
    const nativeJson = Response.prototype.json;
    Response.prototype.json = async function (...args) {
      const observation = consumed.get(this);
      const value = await nativeJson.apply(this, args);
      observation?.mark("json", value);
      return value;
    };
    const mark = (
      ordinal,
      status,
      kind,
      targetApId,
      requestSha256,
      responseSha256,
      body,
    ) =>
      window.setTimeout(
        () =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              state.settled.push({
                ordinal,
                status,
                kind,
                targetApId,
                requestSha256,
                responseSha256,
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
      let bodyText = args[1]?.body;
      if (bodyText === undefined && input instanceof Request)
        bodyText = await input.clone().text();
      const requestSha256 = await crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(bodyText ?? ""))
        .then((digest) =>
          Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
      let targetApId;
      try {
        targetApId =
          JSON.parse(bodyText ?? "{}").ap_id ??
          JSON.parse(bodyText ?? "{}").target_actor_ap_id;
      } catch {
        targetApId = undefined;
      }
      try {
        const response = await nativeFetch(...args);
        const bytes = await response.clone().arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const responseSha256 = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        let responseBody = null;
        try {
          responseBody = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // Successful DELETE APIs can return an empty body.
        }
        const observation = {
          mark(kind, consumedBody = null) {
            mark(
              ordinal,
              response.status,
              kind,
              targetApId,
              requestSha256,
              responseSha256,
              consumedBody ?? responseBody,
            );
          },
        };
        consumed.set(response, observation);
        window.setTimeout(() => observation.mark("fetch", responseBody), 0);
        return response;
      } catch (error) {
        mark(ordinal, 0, "error", targetApId, requestSha256, null, null);
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
  targetApId,
  expected,
  ordinal = 1,
) {
  const key = `${method} ${path}`;
  await page.waitForFunction(
    ({ key, targetApId, expected, ordinal }) =>
      window.__profileActionProbes?.[key]?.settled.some(
        (item) =>
          item.ordinal === ordinal &&
          item.status === expected.status &&
          item.targetApId === targetApId,
      ),
    { key, targetApId, expected, ordinal },
    { timeout: 10_000 },
  );
  const state = await page.evaluate(
    (probeKey) => window.__profileActionProbes?.[probeKey],
    key,
  );
  const settled = state.settled.find(
    (item) =>
      item.ordinal === ordinal &&
      item.status === expected.status &&
      item.targetApId === targetApId,
  );
  requireAction(
    state.initiated >= ordinal &&
      settled?.requestSha256 === expected.requestSha256 &&
      settled?.responseSha256 === expected.responseSha256,
    `${key} browser request/response bytes differ from held native bytes for ${targetApId}`,
  );
  return { initiated: state.initiated, settled };
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
    const request = route.request();
    let actualTarget;
    try {
      actualTarget =
        request.postDataJSON()?.ap_id ??
        request.postDataJSON()?.target_actor_ap_id;
    } catch {
      actualTarget = undefined;
    }
    if (
      request.method() !== method ||
      request.url() !== path ||
      actualTarget !== targetApId
    ) {
      await route.fallback();
      return;
    }
    count++;
    if (count !== 1) {
      await route.fallback();
      return;
    }
    try {
      const requestBytes = Buffer.from(request.postData() ?? "");
      const response = await route.fetch();
      const body = await response.body();
      requireAction(
        response.status() === expectedStatus,
        `native ${method} returned ${response.status()} for ${targetApId}`,
      );
      captured = {
        status: response.status(),
        headers: response.headers(),
        body,
        targetApId,
        requestSha256: sha256(requestBytes),
        responseSha256: sha256(body),
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
        // Browser context may already be closing.
      }
    } finally {
      finished.resolve();
    }
  };
  await page.route(path, handler);
  return {
    entered: bounded(entered.promise, `${method} ${path} native commit`),
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

async function toastMessages(page) {
  return (await page.locator(".yc-toast").allTextContents()).map((text) =>
    text.trim(),
  );
}

async function openProfileMenu(page) {
  await page.getByRole("button", { name: "その他" }).click();
  await page.getByRole("menu").waitFor({ state: "visible", timeout: 5_000 });
}

async function laneMuteRouteSwitch({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode = "switch",
}) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `action_mute_a_${token}`);
  const b = await cachePersona(db, `action_mute_b_${token}`);
  const path = `${origin}/api/actors/me/muted`;
  await installProbe(page, "POST", path);
  if (mode === "switch") {
    const sessionBefore = await optionalDiagnosticRead(async () => ({
      cookie: (await page.context().cookies(origin)).find(
        (candidate) => candidate.name === "session",
      )?.value,
      rows: await rootSessionRows(db, actorApId),
    }));
    const observer = observeFirstProfileNavigation(page, origin, a);
    let phase = "goto";
    try {
      await page.goto(profilePath(origin, a.apId), {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      phase = "wait-profile";
      await waitProfile(page, a);
    } catch (error) {
      try {
        process.stderr.write(
          `${JSON.stringify(
            await firstProfileNavigationDiagnostic({
              page,
              db,
              origin,
              actorApId,
              persona: a,
              sessionBefore,
              observer,
              phase,
              error,
            }),
          )}\n`,
        );
      } catch {
        // Diagnostic failure must not replace the original browser failure.
      }
      throw error;
    } finally {
      try {
        observer.dispose();
      } catch {
        // Teardown of diagnostic listeners must not change the smoke verdict.
      }
    }
  } else {
    await page.goto(profilePath(origin, a.apId), {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await waitProfile(page, a);
  }
  const held = await holdCommittedResponse(page, "POST", path, a.apId, 200);
  let primary;
  try {
    await openProfileMenu(page);
    await page.getByRole("menuitem", { name: "ミュート", exact: true }).click();
    const committed = await held.entered;
    const row = await first(
      db,
      "SELECT muter_ap_id, muted_ap_id FROM mutes WHERE muter_ap_id = ? AND muted_ap_id = ?",
      actorApId,
      a.apId,
    );
    requireAction(
      row?.muter_ap_id === actorApId &&
        row?.muted_ap_id === a.apId &&
        held.count === 1,
      "A mute did not commit exactly once before its browser response was released",
    );
    await spaNavigate(page, profilePath(origin, b.apId));
    await waitProfile(page, b);
    if (mode === "aba") {
      await spaNavigate(page, profilePath(origin, a.apId));
      await waitProfile(page, a);
    } else if (mode === "unmount") {
      await spaNavigate(page, `${origin}/?tab=talk`);
      await page
        .getByRole("heading", { name: "トーク", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      requireAction(
        (await page.locator(".p-profile-name").count()) === 0 &&
          (await page.locator(".p-profile-more").count()) === 0,
        "Talk mounted without unmounting the profile before mute delivery",
      );
    }
    const before = await toastMessages(page);
    held.release();
    await held.finish();
    const probe = await waitProbe(page, "POST", path, a.apId, committed);
    const after = await toastMessages(page);
    if (mode === "unmount") {
      requireAction(
        JSON.stringify(after) === JSON.stringify(before),
        `unmounted A mute emitted a toast: before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`,
      );
      checks.push("browser-profile-action-mute-unmounted-route-retires-result");
    } else {
      const moreButton = page.getByRole("button", { name: "その他" });
      const expanded = await moreButton.getAttribute("aria-expanded");
      await openProfileMenu(page);
      const muteItem = await page
        .getByRole("menuitem", { name: /ミュート/ })
        .innerText();
      requireAction(
        expanded === "false" &&
          muteItem === "ミュート" &&
          JSON.stringify(after) === JSON.stringify(before),
        `stale A mute changed ${mode === "aba" ? "revisited A" : "B"} state/toasts: aria-expanded=${expanded}, menu=${muteItem}, before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`,
      );
      checks.push(
        mode === "aba"
          ? "browser-profile-action-mute-a-to-b-to-a-old-completion-is-retired"
          : "browser-profile-action-mute-a-to-b-stale-result-is-retired",
      );
    }
    return {
      a: a.apId,
      b: b.apId,
      native: {
        status: committed.status,
        requestSha256: committed.requestSha256,
        responseSha256: committed.responseSha256,
      },
      probe,
      committedMute: row,
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

async function laneBlockConfirmation({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `action_block_a_${token}`);
  const b = await cachePersona(db, `action_block_b_${token}`);
  const path = `${origin}/api/actors/me/blocked`;
  await installProbe(page, "POST", path);
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
  });
  await waitProfile(page, a);
  await openProfileMenu(page);
  await page.getByRole("menuitem", { name: "ブロック", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "ブロック" });
  await confirm.waitFor({ state: "visible", timeout: 5_000 });
  await spaNavigate(page, profilePath(origin, b.apId));
  await waitProfile(page, b);
  await confirm.waitFor({ state: "hidden", timeout: 5_000 });
  requireAction(
    (await first(
      db,
      "SELECT blocker_ap_id FROM blocks WHERE blocker_ap_id = ? AND blocked_ap_id = ?",
      actorApId,
      a.apId,
    )) === null,
    "obsolete A confirmation issued a native mutation after navigation",
  );
  checks.push(
    "browser-profile-action-obsolete-block-confirmation-closes-without-mutation",
  );

  await openProfileMenu(page);
  await page.getByRole("menuitem", { name: "ブロック", exact: true }).click();
  const replacementConfirm = page.getByRole("alertdialog", {
    name: "ブロック",
  });
  await replacementConfirm.waitFor({ state: "visible", timeout: 5_000 });
  await replacementConfirm
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await replacementConfirm.waitFor({ state: "hidden", timeout: 5_000 });
  requireAction(
    (await first(
      db,
      "SELECT blocker_ap_id FROM blocks WHERE blocker_ap_id = ? AND blocked_ap_id = ?",
      actorApId,
      b.apId,
    )) === null,
    "replacement B confirmation cancel issued a mutation",
  );
  checks.push("browser-profile-action-new-b-confirmation-remains-usable");

  await spaNavigate(page, profilePath(origin, a.apId));
  await waitProfile(page, a);
  await openProfileMenu(page);
  await page.getByRole("menuitem", { name: "ブロック", exact: true }).click();
  const currentConfirm = page.getByRole("alertdialog", { name: "ブロック" });
  await currentConfirm.waitFor({ state: "visible", timeout: 5_000 });
  const held = await holdCommittedResponse(page, "POST", path, a.apId, 200);
  let primary;
  try {
    await currentConfirm
      .getByRole("button", { name: "ブロック", exact: true })
      .click();
    const committed = await held.entered;
    const row = await first(
      db,
      "SELECT blocker_ap_id, blocked_ap_id FROM blocks WHERE blocker_ap_id = ? AND blocked_ap_id = ?",
      actorApId,
      a.apId,
    );
    requireAction(
      row?.blocker_ap_id === actorApId &&
        row?.blocked_ap_id === a.apId &&
        held.count === 1,
      "new A confirmation did not commit one local block before delivery",
    );
    await spaNavigate(page, profilePath(origin, b.apId));
    await waitProfile(page, b);
    held.release();
    await held.finish();
    const probe = await waitProbe(page, "POST", path, a.apId, committed);
    requireAction(
      !(await page.getByRole("alertdialog").count()) &&
        !(await toastMessages(page)).includes("ブロックしました"),
      "stale block completion changed the B route",
    );
    checks.push(
      "browser-profile-action-new-block-confirmation-commits-native-a-only",
    );
    return {
      a: a.apId,
      b: b.apId,
      native: {
        status: committed.status,
        requestSha256: committed.requestSha256,
        responseSha256: committed.responseSha256,
      },
      probe,
      committedBlock: row,
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

async function laneReportModalScope({
  page,
  db,
  origin,
  actorApId,
  checks,
  mode = "b",
}) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `action_report_a_${token}`);
  const b = await cachePersona(db, `action_report_b_${token}`);
  const path = `${origin}/api/moderation/reports/outbound`;
  await installProbe(page, "POST", path);
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
  });
  await waitProfile(page, a);
  await openProfileMenu(page);
  await page.getByRole("menuitem", { name: "報告", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "報告" });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  await dialog
    .getByRole("button", { name: "スパム・宣伝", exact: true })
    .click();
  const held = await holdCommittedResponse(page, "POST", path, a.apId, 200);
  let primary;
  try {
    await dialog.getByRole("button", { name: "報告", exact: true }).click();
    const committed = await held.entered;
    const report = await first(
      db,
      "SELECT actor_ap_id, object_ap_id, raw_json FROM activities WHERE type = 'Flag' AND direction = 'outbound' AND object_ap_id = ? ORDER BY created_at DESC LIMIT 1",
      a.apId,
    );
    requireAction(
      report?.object_ap_id === a.apId &&
        report?.raw_json?.includes("Flag") &&
        held.count === 1,
      "report A did not commit its native D1 record before browser delivery",
    );
    let currentPersona = b;
    if (mode === "b") {
      await spaNavigate(page, profilePath(origin, b.apId));
      await waitProfile(page, b);
    } else {
      await dialog.locator("form .p-composer-close").click();
      await dialog.waitFor({ state: "hidden", timeout: 5_000 });
      currentPersona = a;
    }
    const currentDialog = page.getByRole("dialog", { name: "報告" });
    if (mode === "b") {
      const bReportBeforeSubmit = await first(
        db,
        "SELECT ap_id FROM activities WHERE type = 'Flag' AND direction = 'outbound' AND object_ap_id = ? LIMIT 1",
        b.apId,
      );
      requireAction(
        !bReportBeforeSubmit,
        "A report unexpectedly created a B report record",
      );
    }
    await openProfileMenu(page);
    await page.getByRole("menuitem", { name: "報告", exact: true }).click();
    await currentDialog.waitFor({ state: "visible", timeout: 5_000 });
    await currentDialog
      .getByRole("button", {
        name: mode === "b" ? "スパム・宣伝" : "いやがらせ・攻撃的",
        exact: true,
      })
      .click();
    const toastsBefore = await toastMessages(page);
    const expectedReportTitle = `${currentPersona.name} を報告`;
    const delivery = page.waitForResponse(
      (response) =>
        response.url() === path && response.status() === committed.status,
      { timeout: 10_000 },
    );
    held.release();
    await held.finish();
    const delivered = await delivery;
    requireAction(
      sha256(await delivered.body()) === committed.responseSha256,
      "browser report bytes differ from committed native response",
    );
    const probe = await waitProbe(page, "POST", path, a.apId, committed);
    requireAction(
      (await currentDialog.isVisible()) &&
        (await currentDialog.locator("strong").innerText()) ===
          expectedReportTitle &&
        !(await page
          .getByRole("dialog")
          .getByRole("button", { name: "報告", exact: true })
          .isDisabled()) &&
        JSON.stringify(await toastMessages(page)) ===
          JSON.stringify(toastsBefore),
      `stale A report completion changed current ${mode === "b" ? "B" : "reopened A"} modal/toasts`,
    );
    checks.push(
      mode === "b"
        ? "browser-profile-action-report-a-settlement-preserves-b-modal"
        : "browser-profile-action-report-same-a-reopened-modal-survives-old-settlement",
    );
    await currentDialog.locator("form .p-composer-close").click();
    await currentDialog.waitFor({ state: "hidden", timeout: 5_000 });
    return {
      a: a.apId,
      b: mode === "b" ? b.apId : null,
      native: {
        status: committed.status,
        requestSha256: committed.requestSha256,
        responseSha256: committed.responseSha256,
      },
      probe,
      committedReport: report,
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

async function laneLocalMessageScope({ page, db, origin, actorApId, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const username = `action_dm_${token}`;
  const created = await page.evaluate(async (username) => {
    const response = await fetch("/api/auth/accounts", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, name: `Action DM ${username}` }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }, username);
  requireAction(
    [200, 201].includes(created.status) && created.body?.account?.ap_id,
    `local DM contact persona creation failed (${created.status})`,
  );
  const a = {
    apId: created.body.account.ap_id,
    name: created.body.account.name,
  };
  const owner = await first(
    db,
    "SELECT owner_actor_ap_id FROM actors WHERE ap_id = ?",
    a.apId,
  );
  requireAction(
    owner?.owner_actor_ap_id === actorApId,
    "DM persona is not owned locally",
  );
  const path = `${origin}/api/dm/contact/${encodeURIComponent(a.apId)}`;
  const entered = gate();
  const release = gate();
  let count = 0;
  const handler = async (route) => {
    if (route.request().method() !== "GET" || route.request().url() !== path) {
      await route.fallback();
      return;
    }
    count++;
    try {
      const response = await route.fetch();
      const body = await response.body();
      requireAction(
        response.status() === 200,
        `native DMContact returned ${response.status()}`,
      );
      entered.resolve({
        status: response.status(),
        headers: response.headers(),
        body,
        sha256: sha256(body),
      });
      await release.promise;
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body,
      });
    } catch (error) {
      entered.reject(error);
      try {
        await route.abort("failed");
      } catch {
        /* page closing */
      }
    }
  };
  await page.route(path, handler);
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
  });
  await waitProfile(page, a);
  const localB = actorApId;
  requireAction(
    localB !== a.apId,
    "owner actor must be a distinct local DM route target",
  );
  await installProbe(page, "GET", path);
  try {
    await page.getByRole("button", { name: "メッセージ", exact: true }).click();
    const native = await bounded(entered.promise, "DMContact native read");
    await spaNavigate(page, profilePath(origin, localB));
    await page.waitForFunction(
      (path) => location.pathname === new URL(path).pathname,
      profilePath(origin, localB),
      { timeout: 10_000 },
    );
    const delivery = page.waitForResponse(
      (response) =>
        response.url() === path && response.status() === native.status,
      { timeout: 10_000 },
    );
    release.resolve();
    const delivered = await bounded(delivery, "DMContact browser response");
    const browserSha256 = sha256(await delivered.body());
    requireAction(
      browserSha256 === native.sha256,
      "browser DMContact response bytes differ from held native response",
    );
    const probe = await waitProbe(page, "GET", path, undefined, {
      status: native.status,
      requestSha256: sha256(Buffer.alloc(0)),
      responseSha256: native.sha256,
    });
    await page.evaluate(async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const expectedPath = new URL(profilePath(origin, localB)).pathname;
    requireAction(
      count === 1 && new URL(page.url()).pathname === expectedPath,
      `stale A DM contact changed route after local B navigation: ${page.url()}`,
    );
    checks.push(
      "browser-profile-action-local-dm-a-success-cannot-steal-b-route",
    );
    return {
      a: a.apId,
      b: localB,
      native: {
        status: native.status,
        requestSha256: sha256(Buffer.alloc(0)),
        responseSha256: native.sha256,
      },
      browserSha256,
      probe,
      requestCount: count,
    };
  } finally {
    release.resolve();
    await page.unroute(path, handler);
  }
}

async function laneClipboardFailureLabel({ page, db, origin, checks }) {
  const token = crypto.randomUUID().slice(0, 8);
  const a = await cachePersona(db, `action_clipboard_${token}`);
  await page.goto(profilePath(origin, a.apId), {
    waitUntil: "domcontentloaded",
  });
  await waitProfile(page, a);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => window.__profileActionClipboardPromise },
    });
    window.__profileActionClipboardPromise = new Promise((_, reject) => {
      window.__profileActionClipboardReject = reject;
    });
  });
  await openProfileMenu(page);
  await page
    .getByRole("menuitem", { name: "リンクをコピー", exact: true })
    .click();
  await spaNavigate(page, `${origin}/?tab=talk`);
  await page.evaluate(() =>
    window.__profileActionClipboardReject(
      new Error("synthetic clipboard refusal"),
    ),
  );
  await page.evaluate(async () => {
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  requireAction(
    !(await toastMessages(page)).includes("コピーに失敗しました"),
    "synthetic stale clipboard failure emitted an obsolete-route toast",
  );
  checks.push(
    "browser-profile-action-clipboard-synthetic-failure-is-labeled-and-retired",
  );
  return {
    outcome: "synthetic clipboard rejection; not a Worker or D1 operation",
    route: `${origin}/?tab=talk`,
  };
}

export async function qualifyBrowserProfileActionScope({
  page,
  db,
  origin,
  actorApId,
  checks = [],
  scenario = process.env.PROFILE_ACTION_SCOPE_SCENARIO ?? "all",
}) {
  requireAction(
    page && db && Array.isArray(checks),
    "native page, D1 and checks are required",
  );
  requireAction(
    new URL(actorApId).origin === origin,
    "owner actor is not local to Worker",
  );
  const authRecovery = await observeInitialAuth({
    page,
    db,
    origin,
    actorApId,
  });
  const start = checks.length;
  const lanes = {};
  if (scenario === "all" || scenario === "mute")
    lanes.mute = await laneMuteRouteSwitch({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
  if (scenario === "all" || scenario === "mute-aba")
    lanes.muteAba = await laneMuteRouteSwitch({
      page,
      db,
      origin,
      actorApId,
      checks,
      mode: "aba",
    });
  if (scenario === "all" || scenario === "mute-unmount")
    lanes.muteUnmount = await laneMuteRouteSwitch({
      page,
      db,
      origin,
      actorApId,
      checks,
      mode: "unmount",
    });
  if (scenario === "all" || scenario === "block")
    lanes.block = await laneBlockConfirmation({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
  if (scenario === "all" || scenario === "report")
    lanes.report = await laneReportModalScope({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
  if (scenario === "all" || scenario === "report-same-a")
    lanes.reportSameA = await laneReportModalScope({
      page,
      db,
      origin,
      actorApId,
      checks,
      mode: "same-a",
    });
  if (scenario === "all" || scenario === "dm")
    lanes.dm = await laneLocalMessageScope({
      page,
      db,
      origin,
      actorApId,
      checks,
    });
  if (scenario === "all" || scenario === "clipboard")
    lanes.clipboard = await laneClipboardFailureLabel({
      page,
      db,
      origin,
      checks,
    });
  requireAction(
    scenario === "all" ||
      [
        "mute",
        "mute-aba",
        "mute-unmount",
        "block",
        "report",
        "report-same-a",
        "dm",
        "clipboard",
      ].includes(scenario),
    `unknown scenario ${scenario}`,
  );
  const expected = {
    all: 10,
    mute: 1,
    "mute-aba": 1,
    "mute-unmount": 1,
    block: 3,
    report: 1,
    "report-same-a": 1,
    dm: 1,
    clipboard: 1,
  }[scenario];
  requireAction(
    checks.length === start + expected,
    `fixture appended ${checks.length - start} checks; expected ${expected}`,
  );
  return {
    status: "PASSED",
    authRecovery,
    fixtureScope:
      "native disposable Worker and D1; cached remote moderation targets; local owned personas for DM; browser outbound requests are denied by caller",
    scenario,
    checks: checks.slice(start),
    lanes,
    observations: {
      syntheticClipboardFailure:
        scenario === "all" || scenario === "clipboard"
          ? "separately labeled; no native mutation"
          : "not run",
    },
  };
}
