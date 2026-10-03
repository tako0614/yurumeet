// Disposable local Worker + native D1 qualification of three-page chat history.
// The only intercepted responses are bytes fetched from the real Worker.
const fail = (message) => new Error(`history-pagination ${message}`);
const expect = (condition, message) => {
  if (!condition) throw fail(message);
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

const marker = (token, kind, index) =>
  `GA pagination ${token} ${kind} ${String(index).padStart(3, "0")}`;
const publishedAt = (index) =>
  index < 11
    ? "2025-01-01T00:00:00.000Z"
    : index < 61
      ? "2025-01-01T00:00:01.000Z"
      : "2025-01-01T00:00:02.000Z";

// Uppercase, lowercase, dash and underscore IDs deliberately expose any
// client localeCompare ordering that differs from SQLite BINARY ordering.
// The first character varies within each timestamp tie. Locale collation and
// SQLite BINARY therefore choose different oldest IDs at a page boundary.
const slug = (index) =>
  `${["_a", "-Z", "_B", "-z"][index % 4]}${String(index).padStart(3, "0")}`;

async function insertMessages(
  db,
  { origin, actorApId, recipientApId, conversationId, kind, token, count },
) {
  const expected = [];
  for (let index = 0; index < count; index++) {
    const id = `${origin}/ap/objects/ga-page-${token}-${kind}-${slug(index)}`;
    const activityId = `${origin}/ap/activities/ga-page-${token}-${kind}-${slug(index)}`;
    const published = publishedAt(index);
    const content = marker(token, kind, index);
    const to = kind === "dm" ? [recipientApId] : [];
    const audience = kind === "community" ? [recipientApId] : [];
    const note = {
      id,
      type: "Note",
      attributedTo: actorApId,
      content,
      published,
      to,
      audience,
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
        VALUES (?, 'Note', ?, ?, '[]', ?, ?, ?, '[]', ?, ?, 1, ?)`,
        )
        .bind(
          id,
          actorApId,
          content,
          conversationId ?? null,
          kind === "dm" ? "direct" : "public",
          JSON.stringify(to),
          JSON.stringify(audience),
          published,
          JSON.stringify(note),
        ),
      db
        .prepare(
          `INSERT INTO object_recipients
        (object_ap_id, recipient_ap_id, type) VALUES (?, ?, ?)`,
        )
        .bind(id, recipientApId, kind === "dm" ? "to" : "audience"),
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
    expected.push({ id, content, published });
  }
  return expected;
}

async function makeDm(page, db, origin, actorApId, token) {
  const peerApId = `${origin}/ap/users/ga-page-${token}`;
  const peerName = `GA page peer ${token}`;
  await db
    .prepare(
      `INSERT INTO actors
    (ap_id, type, preferred_username, name, inbox, outbox, followers_url,
     following_url, public_key_pem, private_key_pem, role)
    VALUES (?, 'Person', ?, ?, ?, ?, ?, ?, 'fixture-public', 'fixture-private', 'member')`,
    )
    .bind(
      peerApId,
      `ga-page-${token}`,
      peerName,
      `${peerApId}/inbox`,
      `${peerApId}/outbox`,
      `${peerApId}/followers`,
      `${peerApId}/following`,
    )
    .run();
  const opener = await api(
    page,
    "POST",
    `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
    { content: marker(token, "dm", 104) },
  );
  expect(
    opener.status === 201 &&
      typeof opener.body?.message?.id === "string" &&
      typeof opener.body?.conversation_id === "string",
    `native DM opener failed (${opener.status})`,
  );
  const messages = await insertMessages(db, {
    origin,
    actorApId,
    recipientApId: peerApId,
    conversationId: opener.body.conversation_id,
    kind: "dm",
    token,
    count: 104,
  });
  const openerRow = await rows(
    db,
    "SELECT ap_id, published, content FROM objects WHERE ap_id = ?",
    opener.body.message.id,
  );
  expect(openerRow.length === 1, "native DM opener is absent from D1");
  messages.push({
    id: openerRow[0].ap_id,
    published: openerRow[0].published,
    content: openerRow[0].content,
  });
  return {
    kind: "dm",
    name: peerName,
    apId: peerApId,
    path: `${origin}/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
    messages,
  };
}

async function makeCommunity(page, db, origin, actorApId, token) {
  const name = `ga_page_${token}`;
  const displayName = `GA page community ${token}`;
  const created = await api(page, "POST", "/api/communities", {
    name,
    display_name: displayName,
    summary: "Disposable local pagination fixture",
  });
  expect(
    created.status === 201 &&
      typeof created.body?.community?.ap_id === "string",
    `native community create failed (${created.status})`,
  );
  const apId = created.body.community.ap_id;
  const path = `${origin}/api/communities/${encodeURIComponent(apId)}/messages`;
  const opener = await api(page, "POST", path, {
    content: marker(token, "community", 104),
  });
  expect(
    opener.status === 201 && typeof opener.body?.message?.id === "string",
    `native community opener failed (${opener.status})`,
  );
  const messages = await insertMessages(db, {
    origin,
    actorApId,
    recipientApId: apId,
    kind: "community",
    token,
    count: 104,
  });
  const openerRow = await rows(
    db,
    "SELECT ap_id, published, content FROM objects WHERE ap_id = ?",
    opener.body.message.id,
  );
  expect(
    openerRow.length === 1 &&
      openerRow[0].content === marker(token, "community", 104),
    "native community opener is absent from D1 or has wrong content",
  );
  messages.push({
    id: openerRow[0].ap_id,
    published: openerRow[0].published,
    content: openerRow[0].content,
  });
  return {
    kind: "community",
    name: displayName,
    apId,
    path,
    messages,
  };
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
  for (const [table, order] of tables) {
    result[table] = await rows(db, `SELECT * FROM ${table} ORDER BY ${order}`);
  }
  // Read receipts and inbox read flags are intentionally outside this immutable
  // snapshot: opening a thread may advance them through native read-mark POSTs.
  return result;
}

async function expectedPages(db, messages) {
  const prefix = messages[0].content.slice(0, -3);
  const ordered = await rows(
    db,
    `SELECT ap_id AS id, content, published FROM objects
      WHERE instr(content, ?) = 1 ORDER BY published ASC, ap_id ASC`,
    prefix,
  );
  const seededIds = new Set(messages.map((message) => message.id));
  expect(
    ordered.length === messages.length &&
      ordered.every((message) => seededIds.has(message.id)),
    "D1 ordering oracle lost or mixed a seed row",
  );
  return {
    ordered,
    pages: [
      ordered.slice(-50),
      ordered.slice(-100, -50),
      ordered.slice(0, -100),
    ],
  };
}

function idsEqual(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((id, i) => id === expected[i].id)
  );
}

async function domState(page, token, kind) {
  return page.evaluate(
    ({ token, kind }) => {
      const prefix = `GA pagination ${token} ${kind} `;
      const bubbles = [
        ...document.querySelectorAll(".p-talk-chat-main li.c-talk-chat"),
      ];
      return bubbles.map((bubble) => {
        const match = bubble.textContent?.match(
          new RegExp(`${prefix}(\\d{3})`),
        );
        return match ? Number(match[1]) : null;
      });
    },
    { token, kind },
  );
}

async function waitDom(page, token, kind, expectedCount) {
  await page.waitForFunction(
    ({ token, kind, expectedCount }) => {
      const prefix = `GA pagination ${token} ${kind} `;
      const bubbles = [
        ...document.querySelectorAll(".p-talk-chat-main li.c-talk-chat"),
      ];
      return (
        bubbles.length === expectedCount &&
        bubbles.every((bubble) => bubble.textContent?.includes(prefix))
      );
    },
    { token, kind, expectedCount },
    { timeout: 12_000 },
  );
}

async function anchor(page, content) {
  return page.evaluate((text) => {
    const bubble = [
      ...document.querySelectorAll(".p-talk-chat-main li.c-talk-chat"),
    ].find((node) => node.textContent?.includes(text));
    return bubble?.getBoundingClientRect().top ?? null;
  }, content);
}

async function settledFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
}

async function holdNextOlder(page, path) {
  let enteredResolve;
  let releaseResolve;
  let finishedResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  const finished = new Promise((resolve) => {
    finishedResolve = resolve;
  });
  let captured;
  let error;
  let timer;
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || !url.searchParams.has("before")) {
      await route.fallback();
      return;
    }
    try {
      const response = await route.fetch();
      const bytes = await response.body();
      const json = JSON.parse(bytes.toString());
      expect(
        response.status() === 200 && Array.isArray(json.messages),
        `held native older GET returned ${response.status()}`,
      );
      captured = {
        url: url.href,
        json,
        bytes,
        status: response.status(),
        headers: response.headers(),
      };
      enteredResolve(captured);
      await release;
      await route.fulfill({
        status: captured.status,
        headers: captured.headers,
        body: bytes,
      });
    } catch (cause) {
      error = cause;
      enteredResolve(null);
      await route.abort("failed").catch(() => {});
    } finally {
      finishedResolve();
    }
  };
  await page.route(`${path}*`, handler);
  return {
    entered: Promise.race([
      entered,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail("older GET timed out")), 12_000);
      }),
    ]).finally(() => clearTimeout(timer)),
    release: () => releaseResolve(),
    dispose: async () => {
      releaseResolve();
      if (captured || error) await finished;
      await page.unroute(`${path}*`, handler);
      if (error) throw error;
    },
  };
}

async function lane({ page, db, origin, actorApId, token, fixture, checks }) {
  const { ordered, pages } = await expectedPages(db, fixture.messages);
  expect(
    ordered.length === 105 &&
      pages.map((part) => part.length).join(",") === "50,50,5",
    "fixture must cross two 50-row boundaries",
  );
  expect(
    pages[0][0].published === pages[1].at(-1).published &&
      pages[1][0].published === pages[2].at(-1).published,
    "same-millisecond rows must cross both page boundaries",
  );
  const snapshotBefore = await snapshot(db);
  const requests = [];
  const mutations = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === new URL(fixture.path).pathname
    ) {
      requests.push(url);
    }
    if (
      url.origin === origin &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    ) {
      mutations.push({ method: request.method(), path: url.pathname });
    }
  };
  page.on("request", onRequest);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Desktop Talk may auto-select this room during navigation, so arm the
    // native GET waiter before navigation rather than after the room appears.
    const firstResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url() === fixture.path,
      { timeout: 15_000 },
    );
    firstResponse.catch(() => {});
    await page.goto(`${origin}/?tab=talk`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const room = page
      .locator("li.c-talk-rooms")
      .filter({ hasText: fixture.name });
    await room.waitFor({ state: "visible", timeout: 15_000 });
    const button = room.locator("button").first();
    const active = await room.getAttribute("class");
    if (
      (await button.getAttribute("aria-pressed")) !== "true" &&
      !active?.split(/\s+/).includes("is-active")
    )
      await button.click();
    const initial = await firstResponse;
    const firstJson = await initial.json();
    expect(
      initial.status() === 200 &&
        firstJson.has_more === true &&
        idsEqual(
          firstJson.messages.map((message) => message.id),
          pages[0],
        ),
      `${fixture.kind} native first page has wrong IDs/order/has_more`,
    );
    await waitDom(page, token, fixture.kind, 50);
    const firstDom = await domState(page, token, fixture.kind);
    expect(
      firstDom.every(
        (index, position) =>
          index === Number(pages[0][position].content.slice(-3)),
      ),
      `${fixture.kind} first page DOM differs from native D1 order`,
    );
    await settledFrame(page);
    checks.push(`browser-history-pagination-${fixture.kind}-native-first-page`);

    const older = page
      .locator(".p-talk-chat-older button")
      .filter({ hasText: "以前のメッセージ" });
    await older.waitFor({ state: "attached", timeout: 5_000 });
    // DOM click avoids Playwright's automatic scroll-to-button, so the anchor
    // comparison measures the application's prepend compensation itself.
    const firstHold = await holdNextOlder(page, fixture.path);
    let firstCaptured;
    try {
      await older.evaluate((button) => button.click());
      firstCaptured = await firstHold.entered;
      expect(firstCaptured, `${fixture.kind} first older GET failed`);
      const anchorContent = pages[0][8].content;
      const before = await anchor(page, anchorContent);
      expect(before !== null, `${fixture.kind} button anchor disappeared`);
      firstHold.release();
      await waitDom(page, token, fixture.kind, 100);
      await settledFrame(page);
      const after = await anchor(page, anchorContent);
      expect(
        after !== null && Math.abs(after - before) <= 3,
        `${fixture.kind} button prepend moved the existing bubble by ${after - before}px`,
      );
    } finally {
      await firstHold.dispose();
    }
    expect(
      firstCaptured.json.has_more === true &&
        idsEqual(
          firstCaptured.json.messages.map((message) => message.id),
          pages[1],
        ) &&
        new URL(firstCaptured.url).searchParams.get("before") ===
          `${pages[0][0].published} ${pages[0][0].id}`,
      `${fixture.kind} first older cursor/IDs/has_more differ from D1 order`,
    );
    checks.push(
      `browser-history-pagination-${fixture.kind}-button-cursor-anchor`,
    );

    const secondHold = await holdNextOlder(page, fixture.path);
    let secondCaptured;
    try {
      const anchorContent = pages[1][8].content;
      // Setting scrollTop near zero invokes the real onScroll path. Read the
      // bubble position while the native response is held at browser transport.
      const before = await page.evaluate((text) => {
        const host = document.querySelector(".p-talk-chat-main");
        host.scrollTop = 1;
        const bubble = [...host.querySelectorAll("li.c-talk-chat")].find(
          (node) => node.textContent?.includes(text),
        );
        return bubble?.getBoundingClientRect().top ?? null;
      }, anchorContent);
      expect(before !== null, `${fixture.kind} scroll anchor disappeared`);
      secondCaptured = await secondHold.entered;
      expect(
        secondCaptured,
        `${fixture.kind} scroll-triggered older GET failed`,
      );
      secondHold.release();
      await waitDom(page, token, fixture.kind, 105);
      await settledFrame(page);
      const after = await anchor(page, anchorContent);
      expect(
        after !== null && Math.abs(after - before) <= 3,
        `${fixture.kind} near-top prepend moved the existing bubble by ${after - before}px`,
      );
    } finally {
      await secondHold.dispose();
    }
    expect(
      secondCaptured.json.has_more === false &&
        idsEqual(
          secondCaptured.json.messages.map((message) => message.id),
          pages[2],
        ) &&
        new URL(secondCaptured.url).searchParams.get("before") ===
          `${pages[1][0].published} ${pages[1][0].id}`,
      `${fixture.kind} terminal cursor/IDs/has_more differ from D1 order`,
    );
    await older.waitFor({ state: "detached", timeout: 5_000 });
    const beforeTerminal = requests.filter((url) =>
      url.searchParams.has("before"),
    ).length;
    await page.locator(".p-talk-chat-main").evaluate((host) => {
      host.scrollTop = 90;
      host.scrollTop = 0;
      host.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await settledFrame(page);
    expect(
      requests.filter((url) => url.searchParams.has("before")).length ===
        beforeTerminal && beforeTerminal === 2,
      `${fixture.kind} requested older history after has_more=false`,
    );
    const dom = await domState(page, token, fixture.kind);
    const expectedIndices = ordered.map((message) =>
      Number(message.content.slice(-3)),
    );
    expect(
      dom.length === 105 &&
        new Set(dom).size === 105 &&
        dom.every((index, position) => index === expectedIndices[position]),
      `${fixture.kind} DOM skipped, duplicated, or reordered a message`,
    );
    checks.push(
      `browser-history-pagination-${fixture.kind}-scroll-terminal-dom`,
    );
    const allowedRead =
      fixture.kind === "dm"
        ? `/api/dm/user/${encodeURIComponent(fixture.apId)}/read`
        : `/api/dm/community/${encodeURIComponent(fixture.apId)}/read`;
    expect(
      mutations.every(
        (mutation) =>
          mutation.method === "POST" && mutation.path === allowedRead,
      ),
      `${fixture.kind} paging sent a mutation other than its intentional read receipt: ${JSON.stringify(mutations)}`,
    );
    const me = await api(page, "GET", "/api/auth/me");
    expect(
      me.status === 200 && me.body?.actor?.ap_id === actorApId,
      `${fixture.kind} paging lost the owner session`,
    );
    expect(
      JSON.stringify(await snapshot(db)) === JSON.stringify(snapshotBefore),
      `${fixture.kind} read-only paging changed actors/sessions/messages/recipients/activities/members`,
    );
    checks.push(
      `browser-history-pagination-${fixture.kind}-read-only-persistence`,
    );
    return {
      kind: fixture.kind,
      messageCount: dom.length,
      pageSizes: [50, 50, 5],
      olderGetCount: beforeTerminal,
      sameMillisecondBoundaries: 2,
    };
  } finally {
    page.off("request", onRequest);
  }
}

export async function qualifyBrowserHistoryPagination({
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
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const me = await api(page, "GET", "/api/auth/me");
  expect(
    me.status === 200 && me.body?.actor?.ap_id === actorApId,
    "browser page lacks authenticated owner session",
  );
  const dm = await makeDm(page, db, origin, actorApId, token);
  const dmResult = await lane({
    page,
    db,
    origin,
    actorApId,
    token,
    fixture: dm,
    checks,
  });
  const community = await makeCommunity(page, db, origin, actorApId, token);
  const communityResult = await lane({
    page,
    db,
    origin,
    actorApId,
    token,
    fixture: community,
    checks,
  });
  return {
    status: "PASSED",
    fixtureScope: "disposable local native D1 and Worker",
    checks: checks.slice(-8),
    lanes: { dm: dmResult, community: communityResult },
  };
}
