const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==";
const WEBM_BASE64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHoEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHS7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WItu5OCw2M4pucgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBElTDZ0B/c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNz2mPAi2PFiLbuTgsNjOKbZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAB9DtnWl54EAo6CBAACAgkmDQgAA8AD2ADgkHBhKAAAwYAAAEL///UiMABxTu2uRu4+zgQC3iveBAfGCAajwgQM=";

function requireTalk(condition, message) {
  if (!condition) throw new Error(`release-browser talk ${message}`);
}

async function first(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .first();
}

async function all(db, sql, ...values) {
  const result = await db
    .prepare(sql)
    .bind(...values)
    .all();
  return result.results ?? [];
}

async function waitForRow(db, sql, values, predicate, message) {
  const deadline = Date.now() + 10_000;
  let row;
  while (Date.now() < deadline) {
    row = await first(db, sql, ...values);
    if (predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`release-browser talk ${message}`);
}

function equalBytes(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function jsonResponse(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`release-browser talk ${label} returned invalid JSON`);
  }
}

function dmPost(response, origin, peerApId, content) {
  if (response.request().method() !== "POST") return false;
  const url = new URL(response.url());
  return (
    url.origin === origin &&
    url.pathname === `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
    response.request().postDataJSON()?.content === content
  );
}

function waitForDmPost(page, origin, peerApId, content) {
  const pending = page.waitForResponse(
    (response) => dmPost(response, origin, peerApId, content),
    { timeout: 15_000 },
  );
  // A preceding UI action can fail before the caller awaits this waiter.
  // Observe that rejection immediately without changing the returned promise.
  pending.catch(() => {});
  return pending;
}

async function postFromPage(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}

async function sendMediaFile(page, file) {
  const uploadWait = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  const chooserWait = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("button", { name: "画像・動画を添付" }).click();
  const chooser = await chooserWait;
  await chooser.setFiles(file);
  const response = await uploadWait;
  requireTalk(response.status() === 200, `${file.name} upload was refused`);
  return jsonResponse(response, `${file.name} upload`);
}

async function persistedMessage(db, apId) {
  return first(
    db,
    `SELECT ap_id, type, attributed_to, content, attachments_json,
            visibility, to_json, conversation
       FROM objects WHERE ap_id = ?`,
    apId,
  );
}

async function settledBubble(page, content) {
  await page.waitForFunction(
    (text) => {
      const matches = Array.from(
        document.querySelectorAll("li.c-talk-chat"),
      ).filter((node) => node.textContent?.includes(text));
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

async function assertDmPersistence(db, { apId, actorApId, peerApId, content }) {
  const object = await persistedMessage(db, apId);
  requireTalk(
    object?.type === "Note" &&
      object.attributed_to === actorApId &&
      object.content === content &&
      object.visibility === "direct" &&
      JSON.stringify(JSON.parse(object.to_json)) === JSON.stringify([peerApId]),
    "D1 Note did not preserve its direct sender, recipient, and content",
  );
  const recipient = await first(
    db,
    "SELECT type FROM object_recipients WHERE object_ap_id = ? AND recipient_ap_id = ?",
    apId,
    peerApId,
  );
  const activity = await first(
    db,
    "SELECT ap_id, type, actor_ap_id, object_ap_id FROM activities WHERE object_ap_id = ? AND type = 'Create'",
    apId,
  );
  const inbox = activity
    ? await first(
        db,
        "SELECT actor_ap_id, activity_ap_id FROM inbox WHERE actor_ap_id = ? AND activity_ap_id = ?",
        peerApId,
        activity.ap_id,
      )
    : null;
  requireTalk(
    recipient?.type === "to" &&
      activity?.actor_ap_id === actorApId &&
      activity.object_ap_id === apId &&
      inbox?.actor_ap_id === peerApId,
    "D1 DM recipient, Create activity, or peer inbox row is missing",
  );
  return object;
}

async function dmSideEffectCounts(db, { actorApId, peerApId, content }) {
  return {
    notes: await first(
      db,
      "SELECT COUNT(*) AS count FROM objects WHERE attributed_to = ? AND content = ? AND type = 'Note' AND visibility = 'direct'",
      actorApId,
      content,
    ),
    creates: await first(
      db,
      `SELECT COUNT(*) AS count FROM activities a
        JOIN objects o ON o.ap_id = a.object_ap_id
       WHERE o.attributed_to = ? AND o.content = ? AND a.type = 'Create'`,
      actorApId,
      content,
    ),
    recipients: await first(
      db,
      `SELECT COUNT(*) AS count FROM object_recipients r
        JOIN objects o ON o.ap_id = r.object_ap_id
       WHERE o.attributed_to = ? AND o.content = ?
         AND r.recipient_ap_id = ? AND r.type = 'to'`,
      actorApId,
      content,
      peerApId,
    ),
    peerInbox: await first(
      db,
      `SELECT COUNT(*) AS count FROM inbox i
        JOIN activities a ON a.ap_id = i.activity_ap_id
        JOIN objects o ON o.ap_id = a.object_ap_id
       WHERE o.attributed_to = ? AND o.content = ?
         AND i.actor_ap_id = ? AND a.type = 'Create'`,
      actorApId,
      content,
      peerApId,
    ),
  };
}

function hasSideEffectCounts(counts, expected) {
  return (
    counts.notes?.count === expected &&
    counts.creates?.count === expected &&
    counts.recipients?.count === expected &&
    counts.peerInbox?.count === expected
  );
}

async function expectUnknownDelivery(page, content) {
  // Polling may already render the committed server message with the same text.
  // Only the local failed placeholder owns the unconfirmed outcome controls.
  const row = page
    .locator("li.c-talk-chat.is-failed")
    .filter({ hasText: content });
  await row.waitFor({ state: "visible", timeout: 10_000 });
  requireTalk(
    (await row.count()) === 1,
    "unconfirmed placeholder is not unique",
  );
  await row
    .getByText("送信結果を確認できません", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await row
    .getByText("再送すると重複する可能性があります。履歴を確認してください。", {
      exact: true,
    })
    .waitFor({ state: "visible", timeout: 10_000 });
  await row.getByRole("button", { name: "再送" }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await row.getByRole("button", { name: "表示を消す" }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  return row;
}

async function addLocalMemberPeer(
  db,
  peerApId,
  preferredUsername = "ga-talk-peer",
  peerName = "GA talk peer",
) {
  await db
    .prepare(
      `INSERT INTO actors (
         ap_id, type, preferred_username, name, inbox, outbox, followers_url,
         following_url, public_key_pem, private_key_pem, role
       ) VALUES (?, 'Person', ?, ?, ?, ?, ?, ?, 'browser-fixture-public-key',
                 'browser-fixture-private-key', 'member')`,
    )
    .bind(
      peerApId,
      preferredUsername,
      peerName,
      `${peerApId}/inbox`,
      `${peerApId}/outbox`,
      `${peerApId}/followers`,
      `${peerApId}/following`,
    )
    .run();
  const peer = await first(
    db,
    "SELECT ap_id, role, owner_actor_ap_id FROM actors WHERE ap_id = ?",
    peerApId,
  );
  const owners = await first(
    db,
    "SELECT COUNT(*) AS count FROM actors WHERE role = 'owner' AND deleted_at IS NULL",
  );
  requireTalk(
    peer?.role === "member" &&
      peer.owner_actor_ap_id === null &&
      owners?.count === 1,
    "contact fixture added an owner or lost its member boundary",
  );
}

async function seedUnreadIncomingDm(
  db,
  { actorApId, peerApId, conversationId, content, readAfter },
) {
  const published = new Date(
    Math.max(Date.now(), Date.parse(readAfter ?? "1970-01-01T00:00:00Z") + 1),
  ).toISOString();
  const objectApId = `${peerApId}/ap/objects/${crypto.randomUUID()}`;
  const activityApId = `${peerApId}/ap/activities/${crypto.randomUUID()}`;
  const note = {
    id: objectApId,
    type: "Note",
    attributedTo: peerApId,
    content,
    published,
    to: [actorApId],
  };
  const activity = {
    id: activityApId,
    type: "Create",
    actor: peerApId,
    object: note,
    published,
  };
  await db
    .prepare(
      `INSERT INTO objects (
         ap_id, type, attributed_to, content, attachments_json, conversation,
         visibility, to_json, cc_json, audience_json, published, is_local,
         raw_json
       ) VALUES (?, 'Note', ?, ?, '[]', ?, 'direct', ?, '[]', '[]', ?, 0, ?)`,
    )
    .bind(
      objectApId,
      peerApId,
      content,
      conversationId,
      JSON.stringify([actorApId]),
      published,
      JSON.stringify(note),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO object_recipients (object_ap_id, recipient_ap_id, type) VALUES (?, ?, 'to')",
    )
    .bind(objectApId, actorApId)
    .run();
  await db
    .prepare(
      `INSERT INTO activities (
         ap_id, type, actor_ap_id, object_ap_id, object_json, raw_json,
         direction, processed
       ) VALUES (?, 'Create', ?, ?, ?, ?, 'inbound', 1)`,
    )
    .bind(
      activityApId,
      peerApId,
      objectApId,
      JSON.stringify(note),
      JSON.stringify(activity),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO inbox (actor_ap_id, activity_ap_id, read) VALUES (?, ?, 0)",
    )
    .bind(actorApId, activityApId)
    .run();
  return { objectApId, activityApId, published };
}

async function archiveUnreadDiagnostics({
  page,
  db,
  origin,
  actorApId,
  peerApId,
  conversationId,
  objectApId,
}) {
  const api = await page.evaluate(
    async ({ peerApId }) => {
      async function read(path, project) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        try {
          const response = await fetch(path, {
            credentials: "include",
            signal: controller.signal,
          });
          let body;
          try {
            body = await response.json();
          } catch {
            return { status: response.status, json: false };
          }
          return { status: response.status, json: true, ...project(body) };
        } catch (error) {
          return {
            status: null,
            json: false,
            error: error instanceof Error ? error.name : "fetch-error",
          };
        } finally {
          clearTimeout(timeout);
        }
      }

      const [unread, contacts] = await Promise.all([
        read("/api/dm/unread/count", (body) => ({
          total: body?.total,
          dm: body?.dm,
          community: body?.community,
        })),
        read("/api/dm/contacts", (body) => {
          const contact = Array.isArray(body?.mutual_followers)
            ? body.mutual_followers.find((row) => row?.ap_id === peerApId)
            : undefined;
          return {
            contact: contact
              ? {
                  conversation_id: contact.conversation_id,
                  unread_count: contact.unread_count,
                }
              : null,
          };
        }),
      ]);
      const header = document.querySelector(".l-header");
      const links = Array.from(document.querySelectorAll(".l-header a")).map(
        (link) => {
          const badge = link.querySelector(".l-header__badge");
          return {
            ariaLabel: link.getAttribute("aria-label"),
            text: (link.textContent ?? "").trim().slice(0, 80),
            badgeText: badge?.textContent?.trim() ?? null,
            href: link.getAttribute("href"),
            visible: link.getClientRects().length > 0,
          };
        },
      );
      const contactButtons = Array.from(
        document.querySelectorAll("li.c-talk-rooms > button"),
      ).map((button) => ({
        ariaLabel: button.getAttribute("aria-label"),
        visible: button.getClientRects().length > 0,
      }));
      return {
        unread,
        contacts,
        page: {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          header: header
            ? {
                className: header.className,
                visible: header.getClientRects().length > 0,
              }
            : null,
          navLinks: links,
          contactButtons,
          selectedThread: Boolean(
            document.querySelector(".p-talk-chat .p-talk-chat-title"),
          ),
          emptyThreadPrompt: Boolean(
            document.querySelector(".p-talk-chat-empty"),
          ),
        },
      };
    },
    { peerApId },
  );

  const [readStatus, object, recipient, archive] = await Promise.all([
    first(
      db,
      "SELECT last_read_at FROM dm_read_status WHERE actor_ap_id = ? AND conversation_id = ?",
      actorApId,
      conversationId,
    ),
    first(
      db,
      "SELECT ap_id, attributed_to, conversation, visibility, published FROM objects WHERE ap_id = ?",
      objectApId,
    ),
    first(
      db,
      "SELECT type FROM object_recipients WHERE object_ap_id = ? AND recipient_ap_id = ?",
      objectApId,
      actorApId,
    ),
    first(
      db,
      "SELECT COUNT(*) AS count FROM dm_archived_conversations WHERE actor_ap_id = ? AND conversation_id = ?",
      actorApId,
      conversationId,
    ),
  ]);

  return {
    api,
    d1: {
      readStatus: readStatus ? { last_read_at: readStatus.last_read_at } : null,
      object: object
        ? {
            ap_id: object.ap_id,
            attributed_to: object.attributed_to,
            conversation: object.conversation,
            visibility: object.visibility,
            published: object.published,
          }
        : null,
      recipient: recipient ? { type: recipient.type } : null,
      archiveRows: archive?.count ?? null,
      archived: (archive?.count ?? 0) > 0,
    },
    page: api.page,
  };
}

export async function qualifyBrowserTalk({
  page,
  worker,
  db,
  origin,
  actorApId,
  checks,
}) {
  const sessionIdentity = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/auth/me`, {
      credentials: "include",
    });
    const body = await response.json();
    return { status: response.status, apId: body.actor?.ap_id };
  }, origin);
  requireTalk(
    sessionIdentity.status === 200 && sessionIdentity.apId === actorApId,
    "browser talk journey is not using the authenticated root session",
  );

  const peerApId = `${origin}/ap/users/ga-talk-peer`;
  const peerName = "GA talk peer";
  await addLocalMemberPeer(db, peerApId);
  const openerText = `browser opener ${crypto.randomUUID()}`;
  const opener = await postFromPage(
    page,
    `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
    { content: openerText },
  );
  requireTalk(
    opener.status === 201 &&
      typeof opener.body.message?.id === "string" &&
      typeof opener.body.conversation_id === "string",
    "real Core API did not create the fixture conversation opener",
  );
  const openerRow = await assertDmPersistence(db, {
    apId: opener.body.message.id,
    actorApId,
    peerApId,
    content: openerText,
  });
  requireTalk(
    openerRow.conversation === opener.body.conversation_id,
    "opener response and D1 conversation identity differ",
  );
  checks.push(
    "browser-talk-local-member-contact-created-through-native-dm-api",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  const contactButton = page
    .locator("li.c-talk-rooms > button")
    .filter({ hasText: peerName });
  await contactButton.waitFor({ state: "visible", timeout: 15_000 });
  await contactButton.click({ timeout: 10_000 });
  const threadText = page.getByText(openerText, { exact: true });
  await threadText.waitFor({ state: "visible", timeout: 15_000 });
  const conversationId = opener.body.conversation_id;
  await waitForRow(
    db,
    "SELECT last_read_at FROM dm_read_status WHERE actor_ap_id = ? AND conversation_id = ?",
    [actorApId, conversationId],
    (row) => Boolean(row?.last_read_at),
    "opening the selected DM did not persist read status",
  );
  const archived = await first(
    db,
    "SELECT conversation_id FROM dm_archived_conversations WHERE actor_ap_id = ? AND conversation_id = ?",
    actorApId,
    conversationId,
  );
  requireTalk(!archived, "opening the contact unexpectedly archived the DM");
  checks.push("browser-talk-contact-opened-and-read-state-persisted");

  const unreadPeerApId = `${origin}/ap/users/ga-unread-peer`;
  const unreadPeerName = "GA unread peer";
  await addLocalMemberPeer(
    db,
    unreadPeerApId,
    "ga-unread-peer",
    unreadPeerName,
  );
  const unreadOpenerText = `unread thread opener ${crypto.randomUUID()}`;
  const unreadOpener = await postFromPage(
    page,
    `/api/dm/user/${encodeURIComponent(unreadPeerApId)}/messages`,
    { content: unreadOpenerText },
  );
  requireTalk(
    unreadOpener.status === 201 &&
      typeof unreadOpener.body.conversation_id === "string" &&
      typeof unreadOpener.body.message?.id === "string",
    "native API did not create the unread-restore contact conversation",
  );
  const unreadOpenerRow = await assertDmPersistence(db, {
    apId: unreadOpener.body.message.id,
    actorApId,
    peerApId: unreadPeerApId,
    content: unreadOpenerText,
  });
  requireTalk(
    unreadOpenerRow.conversation === unreadOpener.body.conversation_id,
    "unread-restore opener response and D1 conversation identity differ",
  );
  checks.push("browser-talk-unread-restore-thread-opened-by-native-api");

  // Navigate through the actual talk route. At desktop width the chat context
  // may auto-select the most recent contact and advance its read position.
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const badgePath = "/api/dm/unread/count";
  const badgeRequests = [];
  const onBadgeRequest = (request) => {
    if (new URL(request.url()).pathname === badgePath) {
      badgeRequests.push(Date.now());
    }
  };
  page.on("request", onBadgeRequest);
  try {
    const badgeJourneyStartedAt = Date.now();
    const initialBadgeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === badgePath &&
        response.request().method() === "GET",
      { timeout: 10_000 },
    );
    initialBadgeResponse.catch(() => {});
    // Restart before archiving and arm the waiter first: domcontentloaded can
    // precede AppRoot's asynchronous actor load and initial badge request.
    await page.goto(`${origin}/?tab=talk`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const initialBadge = await initialBadgeResponse;
    const initialBadgeBody = await jsonResponse(
      initialBadge,
      "initial unread badge refresh",
    );
    requireTalk(
      initialBadge.status() === 200 &&
        initialBadgeBody.total === 0 &&
        initialBadgeBody.dm === 0 &&
        badgeRequests.length > 0 &&
        Date.now() - badgeJourneyStartedAt < 10_000,
      `talk route initial badge response was not a timely native zero: status=${initialBadge.status()}, body=${JSON.stringify(initialBadgeBody)}, elapsedMs=${Date.now() - badgeJourneyStartedAt}`,
    );
    const unreadContactRow = page
      .locator("li.c-talk-rooms")
      .filter({ hasText: unreadPeerName });
    await unreadContactRow.waitFor({ state: "visible", timeout: 10_000 });
    await waitForRow(
      db,
      "SELECT last_read_at FROM dm_read_status WHERE actor_ap_id = ? AND conversation_id = ?",
      [actorApId, unreadOpener.body.conversation_id],
      (row) => Boolean(row?.last_read_at),
      "opening the unread-restore contact did not persist its initial read state",
    );
    const archiveBadgeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === badgePath &&
        response.request().method() === "GET",
      { timeout: 5_000 },
    );
    archiveBadgeResponse.catch(() => {});
    await unreadContactRow
      .getByRole("button", { name: "アーカイブ", exact: true })
      .click();
    const archivedBadge = await archiveBadgeResponse;
    const archivedBadgeBody = await jsonResponse(
      archivedBadge,
      "archive unread badge refresh",
    );
    requireTalk(
      archivedBadgeBody.total === 0,
      "archiving unread DM did not clear the native unread count",
    );
    const archivedRow = await first(
      db,
      "SELECT conversation_id FROM dm_archived_conversations WHERE actor_ap_id = ? AND conversation_id = ?",
      actorApId,
      unreadOpener.body.conversation_id,
    );
    requireTalk(
      !!archivedRow,
      "archive click did not persist the conversation",
    );
    await page
      .getByRole("link", { name: "トーク", exact: true })
      .waitFor({ state: "visible", timeout: 5_000 });
    await unreadContactRow.waitFor({ state: "detached", timeout: 5_000 });
    requireTalk(
      Date.now() - badgeJourneyStartedAt < 10_000,
      "archive/restore fixture no longer excludes the 20-second badge poll",
    );

    await page
      .locator(".p-talk-chips")
      .getByRole("button", { name: "アーカイブ", exact: true })
      .click();
    const archivedContactRow = page
      .locator("li.c-talk-rooms")
      .filter({ hasText: unreadPeerName });
    await archivedContactRow.waitFor({ state: "visible", timeout: 5_000 });
    const restoreButton = archivedContactRow.getByRole("button", {
      name: "アーカイブから戻す",
      exact: true,
    });
    await restoreButton.waitFor({ state: "visible", timeout: 5_000 });

    // Create the unread Note only after the conversation is durably archived.
    // Desktop auto-selection may mark a recently opened conversation read, so
    // this incoming activity must arrive after the read position is established
    // and while the archived thread cannot be auto-selected from the inbox.
    const readStateBeforeIncoming = await first(
      db,
      "SELECT last_read_at FROM dm_read_status WHERE actor_ap_id = ? AND conversation_id = ?",
      actorApId,
      unreadOpener.body.conversation_id,
    );
    requireTalk(
      !!readStateBeforeIncoming?.last_read_at,
      "archive fixture has no persisted read baseline",
    );
    const unreadText = `archived unread ${crypto.randomUUID()}`;
    const unreadMessage = await seedUnreadIncomingDm(db, {
      actorApId,
      peerApId: unreadPeerApId,
      conversationId: unreadOpener.body.conversation_id,
      content: unreadText,
      readAfter: readStateBeforeIncoming.last_read_at,
    });
    const archivedUnreadDiagnostics = await archiveUnreadDiagnostics({
      page,
      db,
      origin,
      actorApId,
      peerApId: unreadPeerApId,
      conversationId: unreadOpener.body.conversation_id,
      objectApId: unreadMessage.objectApId,
    });
    requireTalk(
      archivedUnreadDiagnostics.api.unread.status === 200 &&
        archivedUnreadDiagnostics.api.unread.total === 0 &&
        archivedUnreadDiagnostics.api.unread.dm === 0 &&
        archivedUnreadDiagnostics.api.contacts.contact === null &&
        archivedUnreadDiagnostics.d1.archiveRows === 1 &&
        archivedUnreadDiagnostics.d1.object?.attributed_to === unreadPeerApId &&
        archivedUnreadDiagnostics.d1.object?.conversation ===
          unreadOpener.body.conversation_id &&
        archivedUnreadDiagnostics.d1.object?.visibility === "direct" &&
        archivedUnreadDiagnostics.d1.recipient?.type === "to" &&
        archivedUnreadDiagnostics.d1.object.published >
          archivedUnreadDiagnostics.d1.readStatus?.last_read_at,
      `incoming archived Note is not durably unread while archived: ${JSON.stringify(archivedUnreadDiagnostics)}`,
    );

    const restoreBadgeResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === badgePath &&
        response.request().method() === "GET",
      { timeout: 3_000 },
    );
    restoreBadgeResponse.catch(() => {});
    requireTalk(
      Date.now() - badgeJourneyStartedAt < 17_000,
      "unread restore is too close to the 20-second badge poll window",
    );
    await restoreButton.click();
    let restoredBadge;
    try {
      restoredBadge = await restoreBadgeResponse;
    } catch {
      const postClickDiagnostics = await archiveUnreadDiagnostics({
        page,
        db,
        origin,
        actorApId,
        peerApId: unreadPeerApId,
        conversationId: unreadOpener.body.conversation_id,
        objectApId: unreadMessage.objectApId,
      });
      const talkNav = postClickDiagnostics.page.navLinks.find(
        (link) => link.href === "/?tab=talk" || link.href === "?tab=talk",
      );
      const contactButton = postClickDiagnostics.page.contactButtons.find(
        (contact) =>
          contact.ariaLabel?.startsWith(`${unreadPeerName}、未読 1件`),
      );
      const elapsedMs = Date.now() - badgeJourneyStartedAt;
      throw new Error(
        `unarchive badge refresh was absent after click; elapsedMs=${elapsedMs}; postClickState=${JSON.stringify(
          {
            ...postClickDiagnostics,
            assertions: {
              nativeUnreadTotalIsOne:
                postClickDiagnostics.api.unread.total === 1 &&
                postClickDiagnostics.api.unread.dm === 1,
              archiveRowsAreZero: postClickDiagnostics.d1.archiveRows === 0,
              contactRestoredInApi:
                postClickDiagnostics.api.contacts.contact?.conversation_id ===
                  unreadOpener.body.conversation_id &&
                postClickDiagnostics.api.contacts.contact?.unread_count === 1,
              contactRestoredInDom: Boolean(contactButton),
              navLabel: talkNav?.ariaLabel ?? null,
              navBadgeText: talkNav?.badgeText ?? null,
              navBadgeValue: Number(talkNav?.badgeText ?? 0),
              completedWithin20Seconds: elapsedMs < 20_000,
            },
          },
        )}`,
      );
    }
    const restoredBadgeBody = await jsonResponse(
      restoredBadge,
      "unarchive unread badge refresh",
    );
    requireTalk(
      restoredBadgeBody.total === 1,
      "unarchive badge request did not return the restored unread DM",
    );
    const removedArchive = await first(
      db,
      "SELECT COUNT(*) AS count FROM dm_archived_conversations WHERE actor_ap_id = ? AND conversation_id = ?",
      actorApId,
      unreadOpener.body.conversation_id,
    );
    requireTalk(
      removedArchive?.count === 0,
      "unarchive did not delete durable archive state",
    );
    await archivedContactRow.waitFor({ state: "detached", timeout: 5_000 });
    await page
      .getByRole("link", { name: "トーク、未読 1件", exact: true })
      .waitFor({ state: "visible", timeout: 3_000 });

    await page.getByRole("button", { name: "アーカイブ済み" }).click();
    await unreadContactRow.waitFor({ state: "visible", timeout: 5_000 });
    await page
      .getByRole("button", {
        name: `${unreadPeerName}、未読 1件`,
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 5_000 });
    requireTalk(
      (await first(
        db,
        "SELECT ap_id FROM objects WHERE ap_id = ? AND attributed_to = ? AND content = ? AND published = ?",
        unreadMessage.objectApId,
        unreadPeerApId,
        unreadText,
        unreadMessage.published,
      )) !== null,
      "restore journey lost the native inbound unread Note",
    );
    checks.push(
      "browser-talk-unarchive-restores-native-contact-and-unread-badge-before-poll",
    );

    await page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: peerName })
      .click();
    await page.getByText(openerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } finally {
    page.off("request", onBadgeRequest);
  }

  const textarea = page.locator('textarea[name="message"]');
  const sendButton = page.getByRole("button", { name: "送信" });
  const text = `browser unicode İstanbul 😀İx😀 ${crypto.randomUUID()}`;
  await textarea.fill(text);
  const textResponseWait = waitForDmPost(page, origin, peerApId, text);
  await sendButton.click();
  const textResponse = await textResponseWait;
  requireTalk(
    textResponse.status() === 201,
    "UI text DM did not return HTTP 201",
  );
  const textBody = await jsonResponse(textResponse, "UI text DM");
  const textRow = await assertDmPersistence(db, {
    apId: textBody.message?.id,
    actorApId,
    peerApId,
    content: text,
  });
  requireTalk(
    textRow.conversation === conversationId &&
      JSON.parse(textRow.attachments_json).length === 0,
    "text send split the thread or stored unexpected attachments",
  );
  await page.getByText(text, { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => document.querySelector('textarea[name="message"]')?.value === "",
    undefined,
    { timeout: 10_000 },
  );
  const sentTextRow = page.locator("li.c-talk-chat").filter({ hasText: text });
  await settledBubble(page, text);
  requireTalk(
    !(await sentTextRow.evaluate(
      (element) =>
        element.classList.contains("is-pending") ||
        element.classList.contains("is-failed"),
    )),
    "successful text send left an optimistic pending/failed row",
  );
  checks.push("browser-talk-text-send-clears-composer-and-persists-activity");

  await page.getByRole("button", { name: "トーク内を検索" }).click();
  const searchInput = page.getByRole("textbox", {
    name: "トーク内のメッセージを検索",
  });
  for (const [query, expectedMark] of [
    ["stan", "stan"],
    ["i̇", "İ"],
    ["x😀", "x😀"],
  ]) {
    await searchInput.fill(query);
    await page.waitForFunction(
      ({ content, expected }) => {
        const row = Array.from(
          document.querySelectorAll("li.c-talk-chat"),
        ).find((node) => node.textContent?.includes(content));
        const marks = Array.from(
          row?.querySelectorAll("mark.c-search-hit") ?? [],
        ).map((node) => node.textContent);
        return (
          row?.classList.contains("is-search-hit") &&
          row.classList.contains("is-search-current") &&
          document.querySelector(".p-talk-chat-search__count")?.textContent ===
            "1/1" &&
          marks.length === (expected === "İ" ? 2 : 1) &&
          marks.every((mark) => mark === expected)
        );
      },
      { content: text, expected: expectedMark },
      { timeout: 10_000 },
    );
  }
  await page.getByRole("button", { name: "検索を閉じる" }).click();
  requireTalk(
    (await sentTextRow.locator("mark.c-search-hit").count()) === 0 &&
      (await sentTextRow.textContent()).includes(text),
    "closing Unicode search did not restore the complete original message text",
  );
  checks.push(
    "browser-talk-unicode-search-marks-original-text-without-offset-drift",
  );

  const pngBytes = Buffer.from(PNG_BASE64, "base64");
  const webmBytes = Buffer.from(WEBM_BASE64, "base64");
  const mediaFiles = [
    { name: "ascii.png", mimeType: "image/png", buffer: pngBytes },
    { name: "旅行.png", mimeType: "image/png", buffer: pngBytes },
    { name: "旅行.webm", mimeType: "video/webm", buffer: webmBytes },
  ];
  const uploads = [];
  for (const file of mediaFiles) {
    const uploaded = await sendMediaFile(page, file);
    requireTalk(
      typeof uploaded.url === "string" &&
        typeof uploaded.r2_key === "string" &&
        uploaded.content_type === file.mimeType,
      `${file.name} upload response lost storage identity`,
    );
    uploads.push({ ...uploaded, name: file.name, bytes: file.buffer });
  }
  const stagedImages = page.locator(".p-talk-chat-attach-strip img");
  const stagedVideo = page.locator(".p-talk-chat-attach-strip video");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".p-talk-chat-attach-strip img"))
        .length === 2 &&
      Array.from(document.querySelectorAll(".p-talk-chat-attach-strip video"))
        .length === 1,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".p-talk-chat-attach-strip img"))
        .length === 2 &&
      Array.from(
        document.querySelectorAll(".p-talk-chat-attach-strip img"),
      ).every((image) => image.naturalWidth === 1),
    undefined,
    { timeout: 10_000 },
  );
  requireTalk(
    (await stagedImages.nth(0).evaluate((image) => image.naturalWidth === 1)) &&
      (await stagedImages.nth(1).evaluate((image) => image.naturalWidth === 1)),
    "staged PNG previews did not decode",
  );
  await page.waitForFunction(
    () => {
      const video = document.querySelector(".p-talk-chat-attach-strip video");
      return (
        video instanceof HTMLVideoElement &&
        video.readyState >= 1 &&
        video.videoWidth === 16 &&
        video.videoHeight === 16
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  requireTalk(
    (await stagedVideo.count()) === 1,
    "staged WebM preview is absent",
  );
  await page
    .locator(".p-talk-chat-attach-name")
    .filter({ hasText: "旅行.webm" })
    .waitFor({
      state: "visible",
      timeout: 10_000,
    });
  checks.push("browser-talk-ascii-and-unicode-image-and-video-upload-preview");

  const mediaText = `browser media ${crypto.randomUUID()}`;
  await textarea.fill(mediaText);
  const mediaResponseWait = waitForDmPost(page, origin, peerApId, mediaText);
  await sendButton.click();
  const mediaResponse = await mediaResponseWait;
  requireTalk(
    mediaResponse.status() === 201,
    "UI media DM did not return HTTP 201",
  );
  const mediaBody = await jsonResponse(mediaResponse, "UI media DM");
  const mediaRow = await assertDmPersistence(db, {
    apId: mediaBody.message?.id,
    actorApId,
    peerApId,
    content: mediaText,
  });
  const attachments = JSON.parse(mediaRow.attachments_json);
  requireTalk(
    attachments.length === mediaFiles.length &&
      attachments[2]?.name === "旅行.webm" &&
      attachments.every(
        (attachment, index) =>
          uploads[index] &&
          attachment.url === uploads[index].url &&
          attachment.r2_key === uploads[index].r2_key &&
          attachment.content_type === uploads[index].content_type,
      ),
    "media DM lost the uploaded identities or original video filename",
  );
  const media = await worker.getR2Bucket("MEDIA");
  for (const upload of uploads) {
    const uploadRow = await first(
      db,
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE r2_key = ?",
      upload.r2_key,
    );
    requireTalk(
      uploadRow?.uploader_ap_id === actorApId &&
        uploadRow.content_type === upload.content_type &&
        uploadRow.size === upload.bytes.length,
      `${upload.name} upload row did not persist owner/type/size`,
    );
    const object = await media.get(upload.r2_key);
    requireTalk(object, `${upload.name} R2 object is missing`);
    const stored = new Uint8Array(await object.arrayBuffer());
    requireTalk(
      equalBytes(stored, new Uint8Array(upload.bytes)),
      `${upload.name} R2 bytes differ from the selected file`,
    );
    const readback = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "include" });
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, upload.url);
    requireTalk(
      readback.status === 200 &&
        readback.contentType === upload.content_type &&
        /^private, max-age=\d+$/.test(readback.cacheControl ?? "") &&
        equalBytes(
          new Uint8Array(readback.bytes),
          new Uint8Array(upload.bytes),
        ),
      `${upload.name} authenticated HTTP media readback differs from source`,
    );
    const anonymous = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "omit" });
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.json(),
      };
    }, upload.url);
    requireTalk(
      anonymous.status === 403 &&
        anonymous.cacheControl === "no-store" &&
        anonymous.body?.error === "Authentication required" &&
        Object.keys(anonymous.body).length === 1,
      `${upload.name} direct-message media was readable without a session`,
    );
  }
  await settledBubble(page, mediaText);
  await page.getByText(mediaText, { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  const sentMediaRow = page
    .locator("li.c-talk-chat")
    .filter({ hasText: mediaText });
  await page.waitForFunction(
    (content) => {
      const row = Array.from(document.querySelectorAll("li.c-talk-chat")).find(
        (candidate) => candidate.textContent?.includes(content),
      );
      const images = row?.querySelectorAll(".c-talk-chat-media img");
      const video = row?.querySelector(".c-talk-chat-media video");
      return (
        images?.length === 2 &&
        Array.from(images).every((image) => image.naturalWidth === 1) &&
        video instanceof HTMLVideoElement &&
        video.readyState >= 1 &&
        video.videoWidth === 16 &&
        video.videoHeight === 16
      );
    },
    mediaText,
    { timeout: 20_000 },
  );
  requireTalk(
    (await sentMediaRow.count()) === 1,
    "sent media DM bubble is missing",
  );
  await page.waitForFunction(
    () => document.querySelector('textarea[name="message"]')?.value === "",
    undefined,
    { timeout: 10_000 },
  );
  checks.push("browser-talk-media-dm-d1-r2-http-readback-and-private-denial");

  const failedText = `browser controlled failure ${crypto.randomUUID()}`;
  const failedPng = await sendMediaFile(page, {
    name: "recovery.png",
    mimeType: "image/png",
    buffer: pngBytes,
  });
  requireTalk(
    typeof failedPng.url === "string" &&
      typeof failedPng.r2_key === "string" &&
      failedPng.content_type === "image/png",
    "recovery PNG upload lacks its real object reference",
  );
  await page
    .locator(".p-talk-chat-attach-strip img")
    .waitFor({ state: "visible", timeout: 10_000 });
  let releaseAbort;
  let notifyIntercept;
  const abortGate = new Promise((resolve) => (releaseAbort = resolve));
  const intercepted = new Promise((resolve) => (notifyIntercept = resolve));
  let abortCount = 0;
  let beforeBackendAbortError = null;
  let heldSendPayload = null;
  const abortedSendRequest = page.waitForEvent("requestfailed", {
    predicate: (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
      request.postDataJSON()?.content === failedText,
    timeout: 10_000,
  });
  abortedSendRequest.catch(() => {});
  const abortBeforeBackend = async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      new URL(request.url()).origin === origin &&
      new URL(request.url()).pathname ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
      request.postDataJSON()?.content === failedText
    ) {
      abortCount += 1;
      heldSendPayload = request.postDataJSON();
      notifyIntercept();
      await abortGate;
      try {
        await route.abort("failed");
      } catch (error) {
        beforeBackendAbortError =
          error instanceof Error ? error.message : String(error);
      }
      return;
    }
    await route.fallback();
  };
  const failedRow = page
    .locator("li.c-talk-chat")
    .filter({ hasText: failedText });
  const failedPostTargets = [];
  const recordFailedPost = (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.content === failedText
    ) {
      failedPostTargets.push(new URL(request.url()).pathname);
    }
  };
  page.on("request", recordFailedPost);
  await page.route("**/api/dm/user/**/messages", abortBeforeBackend);
  let interceptTimeout;
  try {
    await textarea.fill(failedText);
    await sendButton.click();
    await Promise.race([
      intercepted,
      new Promise((_, reject) => {
        interceptTimeout = setTimeout(
          () =>
            reject(
              new Error(
                "release-browser talk before-backend DM request was not intercepted",
              ),
            ),
          10_000,
        );
      }),
    ]);
    const pending = page
      .locator("li.c-talk-chat.is-pending")
      .filter({ hasText: failedText });
    await pending.waitFor({ state: "visible", timeout: 10_000 });
    const awayContact = page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: unreadPeerName });
    await awayContact.waitFor({ state: "visible", timeout: 10_000 });
    await awayContact.click();
    await page.getByText(unreadOpenerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const awayComposer = page.locator('textarea[name="message"]');
    await awayComposer.waitFor({ state: "visible", timeout: 10_000 });
    requireTalk(
      (await awayComposer.inputValue()) === "" &&
        (await page
          .locator("li.c-talk-chat")
          .filter({ hasText: failedText })
          .count()) === 0,
      "pending recovery payload leaked into the other talk",
    );
    releaseAbort();
    await abortedSendRequest;
    requireTalk(
      (
        await all(
          db,
          "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
          actorApId,
          failedText,
        )
      ).length === 0,
      "held send reached the backend while another talk was selected",
    );
    await page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: peerName })
      .click();
    await page.getByText(openerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const unknownRow = await expectUnknownDelivery(page, failedText);
    const failedImage = unknownRow.locator(".c-talk-chat-media img");
    await failedImage.waitFor({ state: "visible", timeout: 10_000 });
    const failedImageUrl = await failedImage.getAttribute("src");
    requireTalk(
      failedImageUrl === new URL(failedPng.url, origin).href,
      "recovered failed row did not retain the exact uploaded PNG reference",
    );
    checks.push("browser-talk-switch-failed-media-retains-uploaded-png");
  } finally {
    clearTimeout(interceptTimeout);
    releaseAbort();
    await page.unroute("**/api/dm/user/**/messages", abortBeforeBackend);
  }
  requireTalk(
    abortCount === 1 && !beforeBackendAbortError,
    `before-backend abort did not complete exactly once: ${beforeBackendAbortError ?? "count mismatch"}`,
  );
  const failedDbRows = await all(
    db,
    "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
    actorApId,
    failedText,
  );
  requireTalk(failedDbRows.length === 0, "before-backend abort left a D1 Note");
  requireTalk(
    abortCount === 1 &&
      heldSendPayload &&
      JSON.stringify(heldSendPayload).includes(failedPng.url) &&
      JSON.stringify(heldSendPayload).includes(failedPng.r2_key),
    "held request did not carry the staged text and actual uploaded PNG reference exactly once",
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page
    .locator("li.c-talk-rooms > button")
    .filter({ hasText: peerName })
    .click();
  await page.getByText(openerText, { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const reloadedUnknownRow = await expectUnknownDelivery(page, failedText);
  await reloadedUnknownRow
    .locator(".c-talk-chat-media img")
    .waitFor({ state: "visible", timeout: 10_000 });
  requireTalk(
    (await reloadedUnknownRow
      .locator(".c-talk-chat-media img")
      .getAttribute("src")) === new URL(failedPng.url, origin).href,
    "reload recovery changed or lost the actual uploaded PNG reference",
  );
  requireTalk(
    failedPostTargets.length === 1 &&
      failedPostTargets[0] ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
    "reload recovery automatically posted or targeted a different conversation",
  );
  requireTalk(
    (
      await all(
        db,
        "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
        actorApId,
        failedText,
      )
    ).length === 0,
    "reload recovery persisted a Note without an explicit retry",
  );
  checks.push("browser-talk-reload-recovery-does-not-auto-post");

  const retryWait = waitForDmPost(page, origin, peerApId, failedText);
  await failedRow.getByRole("button", { name: "再送" }).click();
  const retry = await retryWait;
  requireTalk(retry.status() === 201, "known-empty retry did not return 201");
  const retryBody = await jsonResponse(retry, "before-backend retry");
  const retriedObject = await assertDmPersistence(db, {
    apId: retryBody.message?.id,
    actorApId,
    peerApId,
    content: failedText,
  });
  const retriedAttachments = JSON.parse(retriedObject.attachments_json);
  requireTalk(
    retriedObject.conversation === conversationId &&
      retriedAttachments.length === 1 &&
      retriedAttachments[0].url === failedPng.url &&
      retriedAttachments[0].r2_key === failedPng.r2_key &&
      retriedAttachments[0].content_type === failedPng.content_type &&
      (
        await all(
          db,
          "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
          actorApId,
          failedText,
        )
      ).length === 1,
    "before-backend retry did not create exactly one persisted Note",
  );
  requireTalk(
    failedPostTargets.length === 2 &&
      failedPostTargets.every(
        (pathname) =>
          pathname === `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
      ),
    "explicit retry duplicated or changed the failed send target",
  );
  const retriedRow = page
    .locator("li.c-talk-chat")
    .filter({ hasText: failedText });
  await retriedRow.waitFor({ state: "visible", timeout: 10_000 });
  await settledBubble(page, failedText);
  requireTalk(
    (await retriedRow.count()) === 1 &&
      !(await retriedRow.evaluate(
        (element) =>
          element.classList.contains("is-pending") ||
          element.classList.contains("is-failed"),
      )),
    "manual recovery retry did not reconcile to one canonical message row",
  );
  await page.waitForFunction(
    () => document.querySelector('textarea[name="message"]')?.value === "",
    undefined,
    { timeout: 10_000 },
  );
  checks.push("browser-talk-reload-recovery-explicit-manual-retry");
  page.off("request", recordFailedPost);
  checks.push(
    "browser-talk-before-backend-loss-shows-unknown-warning-and-real-retry-persists-one",
  );

  const pendingReloadText = `browser pending reload ${crypto.randomUUID()}`;
  let releasePendingReload;
  let notifyPendingReload;
  const pendingReloadGate = new Promise(
    (resolve) => (releasePendingReload = resolve),
  );
  const pendingReloadIntercepted = new Promise(
    (resolve) => (notifyPendingReload = resolve),
  );
  let pendingReloadPostCount = 0;
  let pendingReloadAbortError = null;
  let pendingReloadRequestFailure = null;
  let resolvePendingReloadRouteDone;
  const pendingReloadRouteDone = new Promise(
    (resolve) => (resolvePendingReloadRouteDone = resolve),
  );
  const pendingReloadTargets = [];
  const recordPendingReloadPost = (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.content === pendingReloadText
    ) {
      pendingReloadTargets.push(new URL(request.url()).pathname);
    }
  };
  const pendingReloadRequestFailed = (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.content === pendingReloadText
    ) {
      pendingReloadRequestFailure =
        request.failure()?.errorText ?? "unknown request failure";
    }
  };
  const holdPendingBeforeBackend = async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      new URL(request.url()).origin === origin &&
      new URL(request.url()).pathname ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
      request.postDataJSON()?.content === pendingReloadText
    ) {
      pendingReloadPostCount += 1;
      notifyPendingReload();
      await pendingReloadGate;
      try {
        await route.abort("failed");
      } catch (error) {
        pendingReloadAbortError =
          error instanceof Error ? error.message : String(error);
      } finally {
        resolvePendingReloadRouteDone();
      }
      return;
    }
    await route.fallback();
  };
  page.on("request", recordPendingReloadPost);
  page.on("requestfailed", pendingReloadRequestFailed);
  await page.route("**/api/dm/user/**/messages", holdPendingBeforeBackend);
  let pendingReloadTimeout;
  let pendingEnvelopeBeforeReload = null;
  let pendingReloadOutcome = null;
  let pendingReloadPrimaryFailure = false;
  try {
    await textarea.fill(pendingReloadText);
    await sendButton.click();
    await Promise.race([
      pendingReloadIntercepted,
      new Promise((_, reject) => {
        pendingReloadTimeout = setTimeout(
          () =>
            reject(new Error("pending reload DM request was not intercepted")),
          10_000,
        );
      }),
    ]);
    const pendingReloadRow = page
      .locator("li.c-talk-chat.is-pending")
      .filter({ hasText: pendingReloadText });
    await pendingReloadRow.waitFor({ state: "visible", timeout: 10_000 });
    pendingEnvelopeBeforeReload = await page.evaluate(
      ({ base, principal, target, content }) => {
        const prefix = `yurume:outgoing:v1:${encodeURIComponent(base)}:${encodeURIComponent(principal)}:`;
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const envelope = JSON.parse(sessionStorage.getItem(key) ?? "null");
            const record = envelope?.record;
            if (
              envelope?.scope?.serverOrigin === base &&
              envelope.scope.principalApId === principal &&
              record?.target?.type === "user" &&
              record.target.ap_id === target &&
              record.content === content
            )
              return { key, state: record.state, record };
          } catch {
            // Malformed records cannot qualify the requested durable pending state.
          }
        }
        return null;
      },
      {
        base: origin,
        principal: actorApId,
        target: peerApId,
        content: pendingReloadText,
      },
    );
    requireTalk(
      pendingReloadPostCount === 1 &&
        pendingReloadTargets.length === 1 &&
        pendingReloadTargets[0] ===
          `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
        pendingEnvelopeBeforeReload?.record?.state === "pending",
      "pending reload did not capture exactly one held POST and its real pending journal envelope",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: peerName })
      .click();
    await page.getByText(openerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const restoredPendingRow = await expectUnknownDelivery(
      page,
      pendingReloadText,
    );
    requireTalk(
      pendingReloadPostCount === 1 &&
        pendingReloadTargets.length === 1 &&
        (await page
          .locator("li.c-talk-chat")
          .filter({ hasText: pendingReloadText })
          .count()) === 1 &&
        (
          await all(
            db,
            "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
            actorApId,
            pendingReloadText,
          )
        ).length === 0,
      "pending reload triggered another POST or created a D1 Note",
    );
    const postReloadEnvelope = await page.evaluate(
      ({ base, principal, target, content }) => {
        const prefix = `yurume:outgoing:v1:${encodeURIComponent(base)}:${encodeURIComponent(principal)}:`;
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const envelope = JSON.parse(sessionStorage.getItem(key) ?? "null");
            const record = envelope?.record;
            if (
              envelope?.scope?.serverOrigin === base &&
              envelope.scope.principalApId === principal &&
              record?.target?.type === "user" &&
              record.target.ap_id === target &&
              record.content === content
            )
              return { key, state: record.state };
          } catch {
            // Ignore unrelated or malformed scoped entries.
          }
        }
        return null;
      },
      {
        base: origin,
        principal: actorApId,
        target: peerApId,
        content: pendingReloadText,
      },
    );
    requireTalk(
      postReloadEnvelope?.key === pendingEnvelopeBeforeReload.key &&
        (postReloadEnvelope.state === "pending" ||
          postReloadEnvelope.state === "unconfirmed"),
      "reload removed or changed the identity of the pending journal entry unexpectedly",
    );
    await restoredPendingRow
      .getByRole("button", { name: "表示を消す" })
      .click();
    await restoredPendingRow.waitFor({ state: "detached", timeout: 10_000 });
    const envelopeAfterDismiss = await page.evaluate(
      ({ base, principal, target, content }) => {
        const prefix = `yurume:outgoing:v1:${encodeURIComponent(base)}:${encodeURIComponent(principal)}:`;
        for (let index = 0; index < sessionStorage.length; index += 1) {
          const key = sessionStorage.key(index);
          if (!key?.startsWith(prefix)) continue;
          try {
            const record = JSON.parse(
              sessionStorage.getItem(key) ?? "null",
            )?.record;
            if (record?.target?.ap_id === target && record.content === content)
              return key;
          } catch {
            // Ignore unrelated or malformed scoped entries.
          }
        }
        return null;
      },
      {
        base: origin,
        principal: actorApId,
        target: peerApId,
        content: pendingReloadText,
      },
    );
    requireTalk(
      envelopeAfterDismiss === null &&
        (await page
          .locator("li.c-talk-chat")
          .filter({ hasText: pendingReloadText })
          .count()) === 0 &&
        (
          await all(
            db,
            "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
            actorApId,
            pendingReloadText,
          )
        ).length === 0 &&
        pendingReloadTargets.length === 1,
      "explicit dismissal did not remove the scoped journal entry without a POST or D1 Note",
    );
    pendingReloadOutcome = {
      heldPosts: pendingReloadPostCount,
      reloadPostTargets: pendingReloadTargets.length,
      pendingBeforeReload: pendingEnvelopeBeforeReload.record.state,
      stateAfterReload: "unconfirmed",
      diskStateAfterReload: postReloadEnvelope.state,
      journalRemovedAfterDismiss: envelopeAfterDismiss === null,
      noD1Note: true,
    };
  } catch (error) {
    pendingReloadPrimaryFailure = true;
    throw error;
  } finally {
    clearTimeout(pendingReloadTimeout);
    releasePendingReload();
    const cleanupErrors = [];
    try {
      await page.unroute(
        "**/api/dm/user/**/messages",
        holdPendingBeforeBackend,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (pendingReloadPostCount > 0) {
      let routeDeadline;
      try {
        await Promise.race([
          pendingReloadRouteDone,
          new Promise((_, reject) => {
            routeDeadline = setTimeout(
              () => reject(new Error("pending reload route cleanup timed out")),
              10_000,
            );
          }),
        ]);
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        clearTimeout(routeDeadline);
      }
    }
    if (cleanupErrors.length) {
      if (pendingReloadPrimaryFailure)
        process.stderr.write(
          `pending reload cleanup also failed (${cleanupErrors.length})\n`,
        );
      else
        throw new AggregateError(
          cleanupErrors,
          "pending reload cleanup failed",
        );
    }
  }
  requireTalk(
    pendingReloadPostCount === 1 && pendingReloadTargets.length === 1,
    "held pending reload send created another POST",
  );
  requireTalk(
    (
      await all(
        db,
        "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
        actorApId,
        pendingReloadText,
      )
    ).length === 0,
    "aborting the held pending reload request left a D1 Note",
  );
  pendingReloadOutcome = {
    ...pendingReloadOutcome,
    requestFailureDiagnostic: pendingReloadRequestFailure,
    abortError: pendingReloadAbortError,
  };
  page.off("request", recordPendingReloadPost);
  page.off("requestfailed", pendingReloadRequestFailed);
  checks.push(
    "browser-talk-pending-journal-reload-restores-unconfirmed-without-repost",
  );

  const committedAwayText = `browser acknowledged while away ${crypto.randomUUID()}`;
  let releaseCommittedResponse;
  let notifyCommittedResponse;
  const committedResponseGate = new Promise(
    (resolve) => (releaseCommittedResponse = resolve),
  );
  const committedResponseObserved = new Promise(
    (resolve) => (notifyCommittedResponse = resolve),
  );
  let committedResponseFailure = null;
  let committedMessage = null;
  let committedPostCount = 0;
  const holdCommittedResponse = async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      new URL(request.url()).origin === origin &&
      new URL(request.url()).pathname ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
      request.postDataJSON()?.content === committedAwayText
    ) {
      committedPostCount += 1;
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const bodyBytes = await response.body();
        const body = JSON.parse(bodyBytes.toString("utf8"));
        requireTalk(
          response.status() === 201 && typeof body.message?.id === "string",
          "while-away send did not commit through the real Worker",
        );
        await assertDmPersistence(db, {
          apId: body.message.id,
          actorApId,
          peerApId,
          content: committedAwayText,
        });
        committedMessage = {
          status: response.status(),
          body,
          headers: response.headers(),
          bodyBytes,
        };
      } catch (error) {
        committedResponseFailure =
          error instanceof Error
            ? error.message
            : "backend commit verification failed";
      }
      notifyCommittedResponse();
      await committedResponseGate;
      if (committedMessage) {
        await route.fulfill({
          status: committedMessage.status,
          headers: committedMessage.headers,
          body: committedMessage.bodyBytes,
        });
      } else {
        await route.abort("failed");
      }
      return;
    }
    await route.fallback();
  };
  const committedWait = waitForDmPost(
    page,
    origin,
    peerApId,
    committedAwayText,
  );
  await page.route("**/api/dm/user/**/messages", holdCommittedResponse);
  let committedOutcome;
  try {
    await textarea.fill(committedAwayText);
    await sendButton.click();
    await Promise.race([
      committedResponseObserved,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("while-away send did not reach the Worker")),
          15_000,
        ),
      ),
    ]);
    requireTalk(
      committedMessage?.status === 201 && !committedResponseFailure,
      `while-away Worker commit failed: ${committedResponseFailure ?? "no committed response"}`,
    );
    const awayContact = page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: unreadPeerName });
    await awayContact.waitFor({ state: "visible", timeout: 10_000 });
    await awayContact.click();
    await page.getByText(unreadOpenerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    requireTalk(
      (await page
        .locator("li.c-talk-chat")
        .filter({ hasText: committedAwayText })
        .count()) === 0 &&
        (await page.locator('textarea[name="message"]').inputValue()) === "" &&
        committedPostCount === 1,
      "committed message appeared in the other talk or was automatically reposted",
    );
    releaseCommittedResponse();
    const actualResponse = await committedWait;
    requireTalk(
      actualResponse.status() === 201,
      "held real 201 was not returned to the browser",
    );
    const actualBody = await jsonResponse(
      actualResponse,
      "while-away committed send",
    );
    requireTalk(
      actualBody.message?.id === committedMessage.body.message.id &&
        committedPostCount === 1,
      "while-away response changed canonical identity or triggered a second POST",
    );
    await page
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: peerName })
      .click();
    await page.getByText(openerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    await page.getByText(committedAwayText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const committedRow = page
      .locator("li.c-talk-chat")
      .filter({ hasText: committedAwayText });
    await settledBubble(page, committedAwayText);
    const committedRows = await all(
      db,
      "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
      actorApId,
      committedAwayText,
    );
    requireTalk(
      committedRows.length === 1 &&
        committedRows[0].ap_id === actualBody.message.id &&
        (await committedRow.count()) === 1,
      "returning after an acknowledged while-away send did not show exactly one canonical row",
    );
    committedOutcome = {
      status: actualResponse.status(),
      canonicalIdMatchesD1: true,
      persistedRows: committedRows.length,
      visibleRows: await committedRow.count(),
    };
    checks.push("browser-talk-successful-send-completes-while-away");
  } finally {
    releaseCommittedResponse();
    await page.unroute("**/api/dm/user/**/messages", holdCommittedResponse);
  }

  let storageDeniedOutcome = null;
  const deniedContext = await page
    .context()
    .browser()
    .newContext({
      locale: "ja-JP",
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
  try {
    await deniedContext.addCookies(await page.context().cookies(origin));
    const deniedPage = await deniedContext.newPage();
    await deniedPage.addInitScript(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          this === window.sessionStorage &&
          key.startsWith("yurume:outgoing:v1:")
        ) {
          throw new DOMException("storage denied", "QuotaExceededError");
        }
        return write.call(this, key, value);
      };
    });
    await deniedPage.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.protocol === "data:" ||
        url.protocol === "blob:" ||
        url.origin === origin
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    await deniedPage.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const deniedIdentity = await deniedPage.evaluate(async (base) => {
      const response = await fetch(`${base}/api/auth/me`, {
        credentials: "include",
      });
      const body = await response.json();
      return { status: response.status, apId: body.actor?.ap_id };
    }, origin);
    requireTalk(
      deniedIdentity.status === 200 && deniedIdentity.apId === actorApId,
      "storage-denied context did not retain the local signed-in principal",
    );
    const deniedContact = deniedPage
      .locator("li.c-talk-rooms > button")
      .filter({ hasText: peerName });
    await deniedContact.waitFor({ state: "visible", timeout: 10_000 });
    await deniedContact.click();
    await deniedPage.getByText(openerText, { exact: true }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const deniedUpload = await sendMediaFile(deniedPage, {
      name: "denied-recovery.png",
      mimeType: "image/png",
      buffer: pngBytes,
    });
    const deniedText = `browser storage denied ${crypto.randomUUID()}`;
    const deniedPosts = [];
    deniedPage.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.postDataJSON()?.content === deniedText
      ) {
        deniedPosts.push(new URL(request.url()).pathname);
      }
    });
    const deniedComposer = deniedPage.locator('textarea[name="message"]');
    await deniedComposer.fill(deniedText);
    await deniedPage.getByRole("button", { name: "送信" }).click();
    await deniedPage
      .getByText("送信内容を保存できません。入力を残しています", {
        exact: true,
      })
      .waitFor({ state: "visible", timeout: 10_000 });
    const deniedStagedImage = deniedPage.locator(
      ".p-talk-chat-attach-strip img",
    );
    await deniedStagedImage.waitFor({ state: "visible", timeout: 10_000 });
    requireTalk(
      (await deniedComposer.inputValue()) === deniedText &&
        (await deniedStagedImage.evaluate((image) => image.naturalWidth)) ===
          1 &&
        deniedPosts.length === 0 &&
        (await deniedPage
          .locator("li.c-talk-chat")
          .filter({ hasText: deniedText })
          .count()) === 0,
      "storage denial did not preserve text and staged media before any POST",
    );
    requireTalk(
      typeof deniedUpload.r2_key === "string" &&
        (
          await all(
            db,
            "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
            actorApId,
            deniedText,
          )
        ).length === 0,
      "storage-denied send had server-side message effects",
    );
    storageDeniedOutcome = {
      refusedBeforePost: deniedPosts.length === 0,
      composerRetained: true,
      stagedPngRetained: true,
    };
    checks.push(
      "browser-talk-storage-denial-retains-composer-and-staged-media",
    );
  } finally {
    await deniedContext.close();
  }

  const lostAckText = `browser committed lost acknowledgement ${crypto.randomUUID()}`;
  const lostAckPostTargets = [];
  const recordLostAckPost = (request) => {
    if (
      request.method() === "POST" &&
      request.postDataJSON()?.content === lostAckText
    ) {
      lostAckPostTargets.push(new URL(request.url()).pathname);
    }
  };
  page.on("request", recordLostAckPost);
  let releaseLostAck;
  let notifyLostAck;
  const lostAckGate = new Promise((resolve) => (releaseLostAck = resolve));
  const lostAckIntercepted = new Promise(
    (resolve) => (notifyLostAck = resolve),
  );
  let lostAckAbortCount = 0;
  let backendError = null;
  let browserAbortError = null;
  let lostAckObservation = null;
  let lostAckNarrowLayout = null;
  const abortAfterCommit = async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      new URL(request.url()).origin === origin &&
      new URL(request.url()).pathname ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages` &&
      request.postDataJSON()?.content === lostAckText
    ) {
      lostAckAbortCount += 1;
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const body = await response.json();
        requireTalk(
          response.status() === 201 && typeof body.message?.id === "string",
          "real backend did not return 201 before simulated lost ACK",
        );
        await assertDmPersistence(db, {
          apId: body.message.id,
          actorApId,
          peerApId,
          content: lostAckText,
        });
        const counts = await dmSideEffectCounts(db, {
          actorApId,
          peerApId,
          content: lostAckText,
        });
        requireTalk(
          hasSideEffectCounts(counts, 1),
          `pre-abort database readback was not one complete DM: ${JSON.stringify(counts)}`,
        );
        lostAckObservation = {
          status: response.status(),
          messageId: body.message.id,
          counts,
        };
      } catch (error) {
        backendError = error instanceof Error ? error.message : String(error);
      }
      notifyLostAck();
      await lostAckGate;
      try {
        await route.abort("failed");
      } catch (error) {
        browserAbortError =
          error instanceof Error ? error.message : String(error);
      }
      return;
    }
    await route.fallback();
  };
  await page.route("**/api/dm/user/**/messages", abortAfterCommit);
  let lostAckTimeout;
  try {
    await textarea.fill(lostAckText);
    await sendButton.click();
    await Promise.race([
      lostAckIntercepted,
      new Promise((_, reject) => {
        lostAckTimeout = setTimeout(
          () =>
            reject(new Error("lost-ACK backend request was not intercepted")),
          15_000,
        );
      }),
    ]);
    requireTalk(
      !backendError && lostAckObservation?.status === 201,
      `lost-ACK backend verification failed: ${backendError ?? "no observation"}`,
    );
    await page
      .locator("li.c-talk-chat.is-pending")
      .filter({ hasText: lostAckText })
      .waitFor({ state: "visible", timeout: 10_000 });
    releaseLostAck();
    const unknownRow = await expectUnknownDelivery(page, lostAckText);
    await page.setViewportSize({ width: 390, height: 844 });
    // Resizing an already-scrolled conversation may move the newest controls
    // below the viewport. Exercise the actual scroll before measuring them.
    await unknownRow
      .locator(".c-talk-chat-failed")
      .scrollIntoViewIfNeeded({ timeout: 10_000 });
    const unknownWarning = unknownRow.getByText("送信結果を確認できません", {
      exact: true,
    });
    const duplicateCaution = unknownRow.getByText(
      "再送すると重複する可能性があります。履歴を確認してください。",
      { exact: true },
    );
    const retryButton = unknownRow.getByRole("button", { name: "再送" });
    const dismissButton = unknownRow.getByRole("button", {
      name: "表示を消す",
    });
    const narrowBounds = await Promise.all(
      [unknownWarning, duplicateCaution, retryButton, dismissButton].map(
        (locator) =>
          locator.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          }),
      ),
    );
    const narrowWidth = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    lostAckNarrowLayout = { viewport: narrowWidth, bounds: narrowBounds };
    requireTalk(
      (await unknownWarning.isVisible()) &&
        (await duplicateCaution.isVisible()) &&
        (await retryButton.isVisible()) &&
        (await dismissButton.isVisible()) &&
        narrowWidth.viewport === 390 &&
        narrowWidth.content <= 390 &&
        narrowBounds.every(
          (rect) =>
            rect.top >= 0 &&
            rect.bottom <= 844 &&
            rect.left >= 0 &&
            rect.right <= 390,
        ),
      `unknown delivery controls overflow or leave the viewport at 390px: ${JSON.stringify({ narrowWidth, narrowBounds })}`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
  } finally {
    clearTimeout(lostAckTimeout);
    releaseLostAck();
    await page.unroute("**/api/dm/user/**/messages", abortAfterCommit);
  }
  requireTalk(
    lostAckAbortCount === 1 &&
      !backendError &&
      !browserAbortError &&
      lostAckObservation?.status === 201,
    `lost-ACK injection did not complete exactly once: ${backendError ?? browserAbortError ?? "missing backend result"}`,
  );
  checks.push(
    "browser-talk-after-commit-lost-ack-warns-dismisses-placeholder-and-keeps-one-real-dm",
  );

  const rejectedText = "x".repeat(5001);
  await textarea.fill(rejectedText);
  const rejectedWait = waitForDmPost(page, origin, peerApId, rejectedText);
  await sendButton.click();
  const rejectedResponse = await rejectedWait;
  requireTalk(
    rejectedResponse.status() === 400,
    "real oversized DM was not refused with HTTP 400",
  );
  const rejectedBody = await jsonResponse(
    rejectedResponse,
    "oversized DM refusal",
  );
  requireTalk(
    String(rejectedBody.error).includes("Message too long"),
    "real Core 400 did not report the length rejection",
  );
  const rejectedRow = page
    .locator("li.c-talk-chat")
    .filter({ hasText: rejectedText });
  await rejectedRow
    .getByText("送信を受け付けられませんでした", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await rejectedRow.getByRole("button", { name: "削除" }).click();
  const rejectedDbRows = await all(
    db,
    "SELECT ap_id FROM objects WHERE attributed_to = ? AND content = ?",
    actorApId,
    rejectedText,
  );
  requireTalk(rejectedDbRows.length === 0, "real HTTP 400 persisted a DM Note");
  checks.push(
    "browser-talk-real-core-400-shows-refused-outcome-without-persistence",
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page
    .locator("li.c-talk-rooms > button")
    .filter({ hasText: peerName })
    .click();
  for (const content of [text, mediaText, failedText]) {
    await page.getByText(content, { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
  }
  const persistedLostAckRows = page
    .locator("li.c-talk-chat")
    .filter({ hasText: lostAckText });
  const reloadedLostAckPlaceholder = persistedLostAckRows.filter({
    has: page.locator(".c-talk-chat-failed"),
  });
  const reloadedLostAckCanonical = page
    .locator("li.c-talk-chat")
    .filter({ hasText: lostAckText })
    .filter({
      hasNot: page.locator(".c-talk-chat-failed"),
    });
  await reloadedLostAckCanonical
    .getByText(lostAckText, { exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  await reloadedLostAckPlaceholder
    .getByText("送信結果を確認できません", { exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
  await reloadedLostAckPlaceholder
    .getByText("再送すると重複する可能性があります。履歴を確認してください。", {
      exact: true,
    })
    .waitFor({ state: "visible", timeout: 10_000 });
  requireTalk(
    (await persistedLostAckRows.count()) === 2,
    "reload did not show one canonical lost-ACK message and one cautious placeholder",
  );
  requireTalk(
    (await reloadedLostAckPlaceholder.count()) === 1 &&
      (await reloadedLostAckCanonical.count()) === 1 &&
      lostAckPostTargets.length === 1 &&
      lostAckPostTargets[0] ===
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
    "lost-ACK reload did not retain exactly one canonical row and one placeholder without an automatic POST",
  );
  const afterLostAckReload = await dmSideEffectCounts(db, {
    actorApId,
    peerApId,
    content: lostAckText,
  });
  requireTalk(
    hasSideEffectCounts(afterLostAckReload, 1),
    `lost-ACK reload changed persisted DM side effects: ${JSON.stringify(afterLostAckReload)}`,
  );
  checks.push(
    "browser-talk-lost-ack-reload-restores-canonical-and-cautious-placeholder",
  );
  await reloadedLostAckPlaceholder
    .getByRole("button", { name: "表示を消す" })
    .click();
  await reloadedLostAckPlaceholder.waitFor({
    state: "detached",
    timeout: 10_000,
  });
  const afterLostAckDismiss = await dmSideEffectCounts(db, {
    actorApId,
    peerApId,
    content: lostAckText,
  });
  requireTalk(
    (await persistedLostAckRows.count()) === 1 &&
      (await reloadedLostAckCanonical.count()) === 1 &&
      hasSideEffectCounts(afterLostAckDismiss, 1),
    `dismissing the reloaded placeholder changed the canonical row or D1 side effects: ${JSON.stringify(afterLostAckDismiss)}`,
  );
  page.off("request", recordLostAckPost);
  checks.push("browser-talk-lost-ack-dismiss-keeps-canonical-row-and-d1-count");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => {
      const viewport = document.documentElement.clientWidth;
      return document.documentElement.scrollWidth <= viewport;
    },
    undefined,
    { timeout: 10_000 },
  );
  const mobileLayout = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    composer:
      document
        .querySelector('textarea[name="message"]')
        ?.getBoundingClientRect().width ?? 0,
  }));
  requireTalk(
    mobileLayout.viewport === 390 &&
      mobileLayout.content <= mobileLayout.viewport &&
      mobileLayout.composer > 0,
    "390px selected-conversation view overflows or loses its composer",
  );
  checks.push(
    "browser-talk-reload-readback-and-390px-selected-conversation-layout",
  );

  return {
    scope:
      "local synthetic non-owner peer after actual password login; no peer auth or external federation qualification",
    peerApId,
    conversationId,
    openerMessageId: opener.body.message.id,
    textMessageId: textBody.message.id,
    mediaMessageId: mediaBody.message.id,
    mediaUploadCount: uploads.length,
    retryMessageId: retryBody.message.id,
    abortedPosts: abortCount,
    deliveryOutcomes: {
      beforeBackendAbort: {
        abortedPosts: abortCount,
        notesBeforeRetry: failedDbRows.length,
        retryStatus: retry.status(),
        retryMessageId: retryBody.message.id,
        persistedNoteCount: 1,
      },
      pendingJournalReload: pendingReloadOutcome,
      storageDenied: storageDeniedOutcome,
      successfulCompletionWhileAway: committedOutcome,
      afterCommitLostAck: {
        abortedPosts: lostAckAbortCount,
        backendStatus: lostAckObservation.status,
        firstCommittedMessageId: lostAckObservation.messageId,
        browserAbortError,
        retryAttempted: false,
        dismissPreserved: afterLostAckDismiss,
        reloadBubbleCount: await persistedLostAckRows.count(),
        unknownState390px: lostAckNarrowLayout,
      },
      actualCoreRejection: {
        status: rejectedResponse.status(),
        persistedNoteCount: rejectedDbRows.length,
      },
    },
    mobileLayout,
  };
}
