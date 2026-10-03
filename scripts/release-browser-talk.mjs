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

async function addLocalMemberPeer(db, peerApId) {
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
      "ga-talk-peer",
      "GA talk peer",
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

  const textarea = page.locator('textarea[name="message"]');
  const sendButton = page.getByRole("button", { name: "送信" });
  const text = `browser text ${crypto.randomUUID()}`;
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
  let releaseAbort;
  let notifyIntercept;
  const abortGate = new Promise((resolve) => (releaseAbort = resolve));
  const intercepted = new Promise((resolve) => (notifyIntercept = resolve));
  let abortCount = 0;
  let beforeBackendAbortError = null;
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
    releaseAbort();
    const unknownRow = await expectUnknownDelivery(page, failedText);
    await unknownRow.getByRole("button", { name: "再送" }).waitFor({
      state: "visible",
      timeout: 10_000,
    });
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
  requireTalk(
    retriedObject.conversation === conversationId &&
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
  const retriedRow = page
    .locator("li.c-talk-chat")
    .filter({ hasText: failedText });
  await retriedRow.waitFor({ state: "visible", timeout: 10_000 });
  await settledBubble(page, failedText);
  await page.waitForFunction(
    () => document.querySelector('textarea[name="message"]')?.value === "",
    undefined,
    { timeout: 10_000 },
  );
  checks.push(
    "browser-talk-before-backend-loss-shows-unknown-warning-and-real-retry-persists-one",
  );

  const lostAckText = `browser committed lost acknowledgement ${crypto.randomUUID()}`;
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
    await unknownRow.getByRole("button", { name: "表示を消す" }).click();
    await page
      .getByText(
        "再送すると重複する可能性があります。履歴を確認してください。",
        {
          exact: true,
        },
      )
      .waitFor({ state: "detached", timeout: 10_000 });
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
  const afterLostAckDismiss = await dmSideEffectCounts(db, {
    actorApId,
    peerApId,
    content: lostAckText,
  });
  requireTalk(
    hasSideEffectCounts(afterLostAckDismiss, 1),
    `dismissing an unknown placeholder changed persisted DM side effects: ${JSON.stringify(afterLostAckDismiss)}`,
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
  for (const content of [text, mediaText, failedText, lostAckText]) {
    await page.getByText(content, { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
  }
  const persistedLostAckRows = page
    .locator("li.c-talk-chat")
    .filter({ hasText: lostAckText });
  requireTalk(
    (await persistedLostAckRows.count()) === 1,
    "reload did not show exactly one server-persisted lost-ACK message",
  );
  await persistedLostAckRows
    .getByText("送信結果を確認できません", { exact: true })
    .waitFor({ state: "detached", timeout: 10_000 });
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
