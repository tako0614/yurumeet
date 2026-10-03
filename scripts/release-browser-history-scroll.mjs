// Local Chrome + native Worker/D1 proof for an older-page response that lands
// after the reader has switched communities. All successful responses are real.
const fail = (message) => new Error(`history-scroll ${message}`);
const expect = (value, message) => {
  if (!value) throw fail(message);
};

async function rows(db, sql, ...args) {
  return (
    (
      await db
        .prepare(sql)
        .bind(...args)
        .all()
    ).results ?? []
  );
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

async function settledFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function bounded(promise, label, timeout = 5_000) {
  let timer;
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

async function createCommunity(page, origin, token, role) {
  const name = `ga_scroll_${token}_${role}`;
  const displayName = `GA scroll ${token} ${role}`;
  const created = await api(page, "POST", "/api/communities", {
    name,
    display_name: displayName,
    summary: "Disposable local scroll qualification",
  });
  expect(
    created.status === 201 &&
      typeof created.body?.community?.ap_id === "string",
    `${role} native community create failed (${created.status})`,
  );
  const apId = created.body.community.ap_id;
  return {
    role,
    name: displayName,
    apId,
    path: `${origin}/api/communities/${encodeURIComponent(apId)}/messages`,
  };
}

async function seedCommunity(
  page,
  db,
  origin,
  actorApId,
  token,
  room,
  count,
  tall,
) {
  const marker = `GA scroll ${token} ${room.role}`;
  const messages = [];
  // A community chat object is addressed to its audience, not stored as a feed
  // post. These rows exist only in the disposable native D1 backing this smoke.
  for (let index = 0; index < count - 1; index++) {
    const id = `${origin}/ap/objects/ga-scroll-${token}-${room.role}-${String(index).padStart(3, "0")}`;
    const activityId = `${origin}/ap/activities/ga-scroll-${token}-${room.role}-${String(index).padStart(3, "0")}`;
    const published = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
    const content =
      `${marker} ${String(index).padStart(3, "0")}${tall ? ` ${"Tall destination content ".repeat(22)}` : ""}`.trimEnd();
    const note = {
      id,
      type: "Note",
      attributedTo: actorApId,
      content,
      published,
      audience: [room.apId],
    };
    const activity = {
      id: activityId,
      type: "Create",
      actor: actorApId,
      object: note,
      published,
    };
    await db.batch([
      db
        .prepare(
          `INSERT INTO objects
        (ap_id, type, attributed_to, content, attachments_json, conversation,
         visibility, to_json, cc_json, audience_json, published, is_local, raw_json)
        VALUES (?, 'Note', ?, ?, '[]', NULL, 'public', '[]', '[]', ?, ?, 1, ?)`,
        )
        .bind(
          id,
          actorApId,
          content,
          JSON.stringify([room.apId]),
          published,
          JSON.stringify(note),
        ),
      db
        .prepare(
          `INSERT INTO object_recipients
        (object_ap_id, recipient_ap_id, type) VALUES (?, ?, 'audience')`,
        )
        .bind(id, room.apId),
      db
        .prepare(
          `INSERT INTO activities
        (ap_id, type, actor_ap_id, object_ap_id, object_json, raw_json, direction, processed)
        VALUES (?, 'Create', ?, ?, ?, ?, 'outbound', 1)`,
        )
        .bind(
          activityId,
          actorApId,
          id,
          JSON.stringify(note),
          JSON.stringify(activity),
        ),
    ]);
    messages.push({ id, content, published });
  }
  const openerContent =
    `${marker} ${String(count - 1).padStart(3, "0")}${tall ? ` ${"Tall destination content ".repeat(22)}` : ""}`.trimEnd();
  const opener = await api(page, "POST", room.path, { content: openerContent });
  expect(
    opener.status === 201 && typeof opener.body?.message?.id === "string",
    `${room.role} native opener failed (${opener.status})`,
  );
  const openerRows = await rows(
    db,
    "SELECT ap_id AS id, content, published FROM objects WHERE ap_id = ?",
    opener.body.message.id,
  );
  expect(
    openerRows.length === 1 &&
      opener.body.message.content === openerContent &&
      openerRows[0].content === openerContent,
    `${room.role} native opener missing from D1`,
  );
  messages.push(openerRows[0]);
  return { ...room, messages, marker };
}

async function snapshot(db) {
  const tables = [
    ["actors", "ap_id"],
    ["sessions", "id"],
    ["objects", "ap_id"],
    ["object_recipients", "object_ap_id, recipient_ap_id"],
    ["activities", "ap_id"],
    ["communities", "ap_id"],
    ["community_members", "community_ap_id, actor_ap_id"],
  ];
  const result = {};
  for (const [table, order] of tables)
    result[table] = await rows(db, `SELECT * FROM ${table} ORDER BY ${order}`);
  // Opening a room intentionally advances dm_community_read_status.
  return result;
}

async function waitRoom(page, room) {
  const row = page.locator("li.c-talk-rooms").filter({ hasText: room.name });
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const button = row.locator("button").first();
  const active = await row.getAttribute("class");
  if (
    (await button.getAttribute("aria-pressed")) !== "true" &&
    !active?.split(/\s+/).includes("is-active")
  )
    await button.click();
  await page
    .locator(".p-talk-chat .p-talk-chat-title")
    .filter({ hasText: room.name })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function waitBubbles(page, room, count) {
  await page.waitForFunction(
    ({ marker, count }) => {
      const bubbles = [
        ...document.querySelectorAll(".p-talk-chat-main li.c-talk-chat"),
      ];
      return (
        bubbles.length === count &&
        bubbles.every((node) => node.textContent?.includes(marker))
      );
    },
    { marker: room.marker, count },
    { timeout: 12_000 },
  );
}

async function view(page, room, setTop = false) {
  return page.evaluate(
    ({ marker, setTop }) => {
      const host = document.querySelector(".p-talk-chat-main");
      if (!host) return null;
      if (setTop)
        host.scrollTop = Math.min(
          430,
          host.scrollHeight - host.clientHeight - 20,
        );
      const hostBox = host.getBoundingClientRect();
      const bubbles = [...host.querySelectorAll("li.c-talk-chat")];
      const anchor = bubbles.find((node) => {
        const box = node.getBoundingClientRect();
        return (
          node.textContent?.includes(marker) &&
          box.top >= hostBox.top &&
          box.bottom <= hostBox.bottom
        );
      });
      return {
        top: host.scrollTop,
        height: host.scrollHeight,
        count: bubbles.length,
        contents: bubbles.map((node) => node.textContent),
        anchorText: anchor?.textContent ?? null,
        anchorTop: anchor?.getBoundingClientRect().top ?? null,
      };
    },
    { marker: room.marker, setTop },
  );
}

async function holdNativeOlder(page, path) {
  let enterResolve;
  let releaseResolve;
  let finishResolve;
  const entered = new Promise((resolve) => {
    enterResolve = resolve;
  });
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  const finished = new Promise((resolve) => {
    finishResolve = resolve;
  });
  let captured;
  let error;
  let timer;
  let activeRoute;
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || !url.searchParams.has("before")) {
      await route.fallback();
      return;
    }
    activeRoute = route;
    try {
      const response = await route.fetch();
      const bytes = await response.body();
      const json = JSON.parse(bytes.toString());
      expect(
        response.status() === 200 && Array.isArray(json.messages),
        `native held older GET failed (${response.status()})`,
      );
      captured = {
        url,
        status: response.status(),
        headers: response.headers(),
        bytes,
        json,
      };
      enterResolve(captured);
      await release;
      await route.fulfill({
        status: captured.status,
        headers: captured.headers,
        body: bytes,
      });
    } catch (cause) {
      error = cause;
      enterResolve(null);
      await route.abort("failed").catch(() => {});
    } finally {
      finishResolve();
    }
  };
  await page.route(`${path}*`, handler);
  return {
    entered: Promise.race([
      entered,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(fail("held older GET timed out")),
          12_000,
        );
      }),
    ]).finally(() => clearTimeout(timer)),
    release: () => releaseResolve(),
    finish: () => bounded(finished, "held older GET completion"),
    dispose: async () => {
      releaseResolve();
      let finishError;
      if (activeRoute) {
        try {
          await bounded(finished, "held older GET cleanup");
        } catch (cause) {
          finishError = cause;
          await activeRoute.abort("failed").catch(() => {});
        }
      }
      await page.unroute(`${path}*`, handler);
      if (error) throw error;
      if (finishError) throw finishError;
    },
  };
}

async function installConsumptionProbe(page, path) {
  await page.addInitScript((exactPath) => {
    const nativeFetch = window.fetch.bind(window);
    window.__gaScrollOlderConsumed = false;
    window.fetch = async (...args) => {
      const input = args[0];
      const method = (
        args[1]?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      const response = await nativeFetch(...args);
      if (
        method === "GET" &&
        url.pathname === new URL(exactPath).pathname &&
        url.searchParams.has("before")
      ) {
        const nativeJson = response.json.bind(response);
        response.json = async (...jsonArgs) => {
          const value = await nativeJson(...jsonArgs);
          setTimeout(
            () =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  window.__gaScrollOlderConsumed = true;
                }),
              ),
            0,
          );
          return value;
        };
      }
      return response;
    };
  }, path);
}

export async function qualifyBrowserHistoryScroll({
  page,
  db,
  origin,
  actorApId,
  checks = [],
}) {
  expect(
    page && db && Array.isArray(checks),
    "native page, D1, and checks are required",
  );
  expect(
    new URL(actorApId).origin === origin,
    "owner actor must be local to Worker",
  );
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const blocked = [];
  const mutations = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    )
      mutations.push({ method: request.method(), path: url.pathname });
  };
  page.on("request", onRequest);
  const blockOutbound = async (route) => {
    const url = new URL(route.request().url());
    if (
      url.origin === origin ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    )
      return route.continue();
    blocked.push({ method: route.request().method(), url: url.href });
    return route.abort("blockedbyclient");
  };
  await page.route("**/*", blockOutbound);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${origin}/?tab=talk`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const me = await api(page, "GET", "/api/auth/me");
    expect(
      me.status === 200 && me.body?.actor?.ap_id === actorApId,
      "browser page lacks authenticated owner session",
    );
    const source = await seedCommunity(
      page,
      db,
      origin,
      actorApId,
      token,
      await createCommunity(page, origin, token, "source"),
      51,
      false,
    );
    const dest = await seedCommunity(
      page,
      db,
      origin,
      actorApId,
      token,
      await createCommunity(page, origin, token, "dest"),
      50,
      true,
    );
    const before = await snapshot(db);
    const setupMutationCount = mutations.length;
    await installConsumptionProbe(page, source.path);
    await page.goto(`${origin}/?tab=talk`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await waitRoom(page, source);
    await waitBubbles(page, source, 50);
    await settledFrame(page);
    const sourceView = await view(page, source);
    expect(
      sourceView && sourceView.count === 50 && sourceView.height > 900,
      "source initial thread lacks 50 rendered rows and overflow",
    );
    checks.push("browser-history-scroll-native-source-first-page");

    const held = await holdNativeOlder(page, source.path);
    let older;
    let destBefore;
    let destAfter;
    try {
      const button = page
        .locator(".p-talk-chat-older button")
        .filter({ hasText: "以前のメッセージ" });
      await button.waitFor({ state: "attached", timeout: 5_000 });
      await button.evaluate((node) => node.click());
      older = await held.entered;
      expect(
        older &&
          older.json.has_more === false &&
          older.json.messages.length === 1 &&
          older.json.messages[0].id === source.messages[0].id,
        "held older response was not the native single oldest row",
      );
      checks.push("browser-history-scroll-held-native-older-page");
      await waitRoom(page, dest);
      await waitBubbles(page, dest, 50);
      await settledFrame(page);
      destBefore = await view(page, dest, true);
      expect(
        destBefore?.count === 50 &&
          destBefore.height > sourceView.height + 500 &&
          destBefore.top > 300 &&
          destBefore.anchorText?.includes(dest.marker) &&
          destBefore.anchorTop !== null,
        "destination did not establish a taller stable viewport anchor",
      );
      held.release();
      await held.finish();
      await page.waitForFunction(
        () => window.__gaScrollOlderConsumed === true,
        null,
        { timeout: 8_000 },
      );
      destAfter = await view(page, dest);
      expect(
        destAfter?.count === 50 &&
          destAfter.contents.every((content) =>
            content?.includes(dest.marker),
          ) &&
          Math.abs(destAfter.top - destBefore.top) <= 3 &&
          destAfter.anchorText === destBefore.anchorText &&
          Math.abs(destAfter.anchorTop - destBefore.anchorTop) <= 3,
        `stale older completion moved destination viewport: ${JSON.stringify({
          sourceHeight: sourceView.height,
          before: { top: destBefore.top, anchorTop: destBefore.anchorTop },
          after: { top: destAfter?.top, anchorTop: destAfter?.anchorTop },
        })}`,
      );
      checks.push(
        "browser-history-scroll-stale-response-keeps-destination-anchor",
      );
    } finally {
      await held.dispose();
    }
    const afterMe = await api(page, "GET", "/api/auth/me");
    expect(
      afterMe.status === 200 && afterMe.body?.actor?.ap_id === actorApId,
      "scroll journey lost owner session",
    );
    expect(
      JSON.stringify(await snapshot(db)) === JSON.stringify(before),
      "history reads or scope switch changed immutable D1 rows",
    );
    const readPaths = new Set(
      [source, dest].map(
        (room) => `/api/dm/community/${encodeURIComponent(room.apId)}/read`,
      ),
    );
    expect(
      mutations
        .slice(setupMutationCount)
        .every(
          (mutation) =>
            mutation.method === "POST" && readPaths.has(mutation.path),
        ),
      `history journey sent unexpected mutation: ${JSON.stringify(mutations.slice(setupMutationCount))}`,
    );
    expect(
      blocked.length === 0,
      `history journey requested external URL: ${JSON.stringify(blocked)}`,
    );
    checks.push("browser-history-scroll-read-only-owner-scope");
    return {
      status: "PASSED",
      fixtureScope: "disposable local native D1 and Worker",
      checks: checks.slice(-4),
      sourceCount: 51,
      destinationCount: 50,
      sourceHeight: sourceView.height,
      destinationHeight: destBefore.height,
      destinationScrollTopBefore: destBefore.top,
      destinationScrollTopAfter: destAfter.top,
      anchorTopBefore: destBefore.anchorTop,
      anchorTopAfter: destAfter.anchorTop,
    };
  } finally {
    page.off("request", onRequest);
    await page.unroute("**/*", blockOutbound);
  }
}
