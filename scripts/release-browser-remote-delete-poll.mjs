// Real local Worker/D1 + existing UI polling. No fulfilled or rewritten reads.
function check(condition, message) {
  if (!condition) throw new Error(`remote-delete-poll ${message}`);
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
async function nativePoll(page, path, expectedIds) {
  const pending = page.waitForResponse(
    async (response) => {
      if (
        new URL(response.url()).pathname !== path ||
        response.request().method() !== "GET" ||
        response.status() !== 200
      )
        return false;
      const body = await response.json();
      return (
        body.has_more === false &&
        Array.isArray(body.messages) &&
        JSON.stringify(body.messages.map((row) => row.id)) ===
          JSON.stringify(expectedIds)
      );
    },
    { timeout: 10_000 },
  );
  pending.catch(() => {});
  // This is the product's existing foreground catch-up listener.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await pending;
}
export async function qualifyBrowserRemoteDeletePoll({
  page,
  db,
  origin,
  communityApId,
  communityDisplayName,
  messageId,
  checks = [],
}) {
  const start = checks.length;
  check(
    new URL(communityApId).origin === origin,
    "community is outside the local fixture",
  );
  const path = `/api/communities/${encodeURIComponent(communityApId)}/messages`;
  const before = await api(page, "GET", path);
  check(
    before.status === 200 &&
      before.body.has_more === false &&
      before.body.messages.length === 1 &&
      before.body.messages[0].id === messageId,
    "requires the preceding native one-message community",
  );
  const original = before.body.messages[0];
  await page.goto(`${origin}/?tab=talk`, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  const room = page
    .locator("li.c-talk-rooms")
    .filter({ hasText: communityDisplayName });
  await room.waitFor({ state: "visible", timeout: 15_000 });
  if (
    !((await room.getAttribute("class")) ?? "")
      .split(/\s+/)
      .includes("is-active")
  )
    await room.locator("button").first().click();
  const oldBubble = page
    .locator("li.c-talk-chat")
    .filter({ hasText: original.content });
  await oldBubble.waitFor({ state: "visible", timeout: 10_000 });
  const content = `remote-newest-${crypto.randomUUID()}`;
  const created = await api(page, "POST", path, { content });
  check(
    created.status === 201 && typeof created.body?.message?.id === "string",
    "native companion POST failed",
  );
  const newestId = created.body.message.id;
  const stored = await db
    .prepare("SELECT content FROM objects WHERE ap_id = ?")
    .bind(newestId)
    .first();
  check(stored?.content === content, "native companion row is absent");
  await nativePoll(page, path, [messageId, newestId]);
  const newestBubble = page
    .locator("li.c-talk-chat")
    .filter({ hasText: content });
  await newestBubble.waitFor({ state: "visible", timeout: 10_000 });
  // Establish the real contacts preview before deleting. Reload also starts
  // a fresh 20s contacts cadence; the 3s assertion below cannot pass on it.
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await room.waitFor({ state: "visible", timeout: 15_000 });
  if (
    !((await room.getAttribute("class")) ?? "")
      .split(/\s+/)
      .includes("is-active")
  )
    await room.locator("button").first().click();
  await newestBubble.waitFor({ state: "visible", timeout: 10_000 });
  await room.filter({ hasText: content }).waitFor({ state: "visible" });
  const remove = async (id) => {
    const response = await api(
      page,
      "DELETE",
      `${path}/${encodeURIComponent(id)}`,
    );
    check(response.status === 200, "second-client native DELETE failed");
    check(
      !(await db
        .prepare("SELECT ap_id FROM objects WHERE ap_id = ?")
        .bind(id)
        .first()),
      "deleted native row is still present",
    );
  };
  // Deletes run through another normal API client, not chat.deleteMessage's
  // optimistic local removal. The open UI must learn about them from polling.
  await remove(newestId);
  await nativePoll(page, path, [messageId]);
  await newestBubble.waitFor({ state: "hidden", timeout: 10_000 });
  await room
    .filter({ hasText: content })
    .waitFor({ state: "hidden", timeout: 3_000 });
  check(
    (await oldBubble.count()) === 1,
    "newest deletion removed the remaining message",
  );
  checks.push("browser-history-poll-removes-remote-newest-message");
  await remove(messageId);
  await nativePoll(page, path, []);
  await oldBubble.waitFor({ state: "hidden", timeout: 10_000 });
  await room
    .filter({ hasText: original.content })
    .waitFor({ state: "hidden", timeout: 3_000 });
  check(
    (await page.locator("li.c-talk-chat").count()) === 0,
    "last deleted message remains visible",
  );
  checks.push("browser-history-poll-clears-remote-last-message");
  check(
    checks.length === start + 2,
    "did not run exactly the two deletion cases",
  );
  return {
    status: "PASSED",
    communityApId,
    nativeDeletedIds: [newestId, messageId],
    checks: checks.slice(start),
  };
}
