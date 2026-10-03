function requireCommunityPreview(condition, message) {
  if (!condition) {
    throw new Error(`community delete-preview qualification ${message}`);
  }
}

async function first(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .first();
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
      let result;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      return { status: response.status, body: result };
    },
    { path, body },
  );
}

async function communityContact(page, origin, communityApId) {
  return page.evaluate(
    async ({ origin, communityApId }) => {
      const response = await fetch(`${origin}/api/dm/contacts`, {
        credentials: "include",
      });
      let body;
      try {
        body = await response.json();
      } catch {
        return { status: response.status, contact: null, json: false };
      }
      const row = Array.isArray(body?.communities)
        ? body.communities.find((entry) => entry?.ap_id === communityApId)
        : undefined;
      return {
        status: response.status,
        json: true,
        contact: row
          ? {
              ap_id: row.ap_id,
              last_message: row.last_message
                ? {
                    content: row.last_message.content,
                    is_mine: row.last_message.is_mine,
                  }
                : null,
              last_message_at: row.last_message_at,
            }
          : null,
      };
    },
    { origin, communityApId },
  );
}

async function sendCommunityText(page, origin, communityApId, content) {
  const path = `/api/communities/${encodeURIComponent(communityApId)}/messages`;
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).origin === origin &&
      new URL(response.url()).pathname === path &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  responsePromise.catch(() => {});
  await page.locator('textarea[name="message"]').fill(content);
  await page.getByRole("button", { name: "送信", exact: true }).click();
  const response = await responsePromise;
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  requireCommunityPreview(
    response.status() === 201 && typeof body?.message?.id === "string",
    `real community POST was not accepted: status=${response.status()}`,
  );
  await page.waitForFunction(
    ({ text }) => {
      const rows = Array.from(document.querySelectorAll("li.c-talk-chat"));
      const matches = rows.filter((row) => row.textContent?.includes(text));
      return (
        matches.length === 1 &&
        !matches[0].classList.contains("is-pending") &&
        !matches[0].classList.contains("is-failed")
      );
    },
    { text: content },
    { timeout: 10_000 },
  );
  return body.message;
}

function messageDeletePath(origin, communityApId, messageId) {
  return `${origin}/api/communities/${encodeURIComponent(communityApId)}/messages/${encodeURIComponent(messageId)}`;
}

async function openDeleteMenu(page, content) {
  const row = page.locator("li.c-talk-chat").filter({ hasText: content });
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row
    .getByRole("button", { name: "メッセージ操作", exact: true })
    .click();
  await row.getByRole("menuitem", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "メッセージを削除" });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  return dialog;
}

async function deletePreviewText(page, communityName) {
  return page.evaluate((name) => {
    const row = Array.from(document.querySelectorAll("li.c-talk-rooms")).find(
      (item) => item.textContent?.includes(name),
    );
    return row?.querySelector(".c-talk-rooms-msg")?.textContent?.trim() ?? null;
  }, communityName);
}

export async function qualifyBrowserCommunityDeletePreview({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  const countsBefore = {
    actors: await first(db, "SELECT COUNT(*) AS count FROM actors"),
    owners: await first(
      db,
      "SELECT COUNT(*) AS count FROM actors WHERE role = 'owner' AND deleted_at IS NULL",
    ),
    sessions: await first(db, "SELECT COUNT(*) AS count FROM sessions"),
    communities: await first(db, "SELECT COUNT(*) AS count FROM communities"),
    memberships: await first(
      db,
      "SELECT COUNT(*) AS count FROM community_members",
    ),
  };
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const communityName = `ga_del_${suffix}`;
  const communityDisplayName = `GA Delete ${suffix}`;
  const created = await postFromPage(page, "/api/communities", {
    name: communityName,
    display_name: communityDisplayName,
    summary: "Disposable native browser qualification group",
  });
  requireCommunityPreview(
    created.status === 201 &&
      typeof created.body?.community?.ap_id === "string",
    `authenticated community create failed: status=${created.status}`,
  );
  const communityApId = created.body.community.ap_id;
  const communityRow = await first(
    db,
    `SELECT ap_id, type, preferred_username, name, visibility, join_policy,
            post_policy, member_count, created_by
       FROM communities WHERE ap_id = ?`,
    communityApId,
  );
  const membership = await first(
    db,
    "SELECT role FROM community_members WHERE community_ap_id = ? AND actor_ap_id = ?",
    communityApId,
    actorApId,
  );
  requireCommunityPreview(
    communityRow?.type === "Group" &&
      communityRow.created_by === actorApId &&
      communityRow.member_count === 1 &&
      membership?.role === "owner",
    "Core did not create exactly the expected Group plus authenticated-user membership",
  );
  const countsAfterCreate = {
    actors: await first(db, "SELECT COUNT(*) AS count FROM actors"),
    owners: await first(
      db,
      "SELECT COUNT(*) AS count FROM actors WHERE role = 'owner' AND deleted_at IS NULL",
    ),
    sessions: await first(db, "SELECT COUNT(*) AS count FROM sessions"),
    communities: await first(db, "SELECT COUNT(*) AS count FROM communities"),
    memberships: await first(
      db,
      "SELECT COUNT(*) AS count FROM community_members",
    ),
  };
  requireCommunityPreview(
    countsAfterCreate.actors?.count === countsBefore.actors?.count &&
      countsAfterCreate.owners?.count === countsBefore.owners?.count &&
      countsAfterCreate.sessions?.count === countsBefore.sessions?.count &&
      countsAfterCreate.communities?.count ===
        countsBefore.communities?.count + 1 &&
      countsAfterCreate.memberships?.count ===
        countsBefore.memberships?.count + 1,
    "community creation changed human actors/sessions or created an unexpected group/membership count",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  const appTalkRouteStartedAt = Date.now();
  const contactRequestTimes = [];
  const onContactRequest = (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === "/api/dm/contacts") {
      contactRequestTimes.push(Date.now());
    }
  };
  page.on("request", onContactRequest);
  try {
    await page.goto(`${origin}/?tab=talk`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    const contactRow = page
      .locator("li.c-talk-rooms")
      .filter({ hasText: communityDisplayName });
    await contactRow.waitFor({ state: "visible", timeout: 10_000 });
    await contactRow.locator("button").first().click();
    await page
      .locator(".p-talk-chat .p-talk-chat-title")
      .waitFor({ state: "visible", timeout: 10_000 });
    await page.locator('textarea[name="message"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });
    const groupContact = await communityContact(page, origin, communityApId);
    requireCommunityPreview(
      groupContact.status === 200 &&
        groupContact.contact?.ap_id === communityApId,
      "native contacts API did not expose the newly created Group to its member",
    );

    const firstText = `delete-preview before ${crypto.randomUUID()}`;
    const firstMessage = await sendCommunityText(
      page,
      origin,
      communityApId,
      firstText,
    );
    const firstRow = await first(
      db,
      "SELECT ap_id, attributed_to, content, published FROM objects WHERE ap_id = ?",
      firstMessage.id,
    );
    requireCommunityPreview(
      firstRow?.attributed_to === actorApId && firstRow.content === firstText,
      "first UI message was not persisted under the authenticated actor",
    );

    // Keep strict message ordering even on a fast local Worker.
    await page.waitForTimeout(25);
    const latestText = `delete-preview latest ${crypto.randomUUID()}`;
    const latestMessage = await sendCommunityText(
      page,
      origin,
      communityApId,
      latestText,
    );
    const latestRow = await first(
      db,
      "SELECT ap_id, attributed_to, content, published FROM objects WHERE ap_id = ?",
      latestMessage.id,
    );
    const orderedRows = await db
      .prepare(
        `SELECT o.ap_id, o.published, o.content
           FROM objects o
           JOIN object_recipients r ON r.object_ap_id = o.ap_id
          WHERE r.recipient_ap_id = ? AND r.type = 'audience'
            AND o.attributed_to = ? AND o.ap_id IN (?, ?)
          ORDER BY o.published DESC, o.ap_id DESC`,
      )
      .bind(communityApId, actorApId, firstMessage.id, latestMessage.id)
      .all();
    requireCommunityPreview(
      latestRow?.attributed_to === actorApId &&
        latestRow.content === latestText &&
        latestRow.published > firstRow.published &&
        orderedRows.results?.[0]?.ap_id === latestMessage.id &&
        orderedRows.results?.[1]?.ap_id === firstMessage.id,
      "native message IDs/publication times do not prove a unique latest message order",
    );
    const latestContact = await communityContact(page, origin, communityApId);
    requireCommunityPreview(
      latestContact.status === 200 &&
        latestContact.contact?.last_message?.content === latestText &&
        latestContact.contact.last_message.is_mine === true,
      "native community contact did not identify the newest own message before delete",
    );
    await page.waitForFunction(
      ({ name, expected }) => {
        const row = Array.from(
          document.querySelectorAll("li.c-talk-rooms"),
        ).find((item) => item.textContent?.includes(name));
        return row
          ?.querySelector(".c-talk-rooms-msg")
          ?.textContent?.includes(expected);
      },
      { name: communityDisplayName, expected: latestText },
      { timeout: 5_000 },
    );
    requireCommunityPreview(
      contactRequestTimes.length > 0 &&
        Date.now() - appTalkRouteStartedAt < 14_000,
      "community preview setup is too close to the 20-second contacts poll",
    );

    // Intercept one exact DELETE at the browser boundary. It never reaches the
    // Worker; this qualifies local optimistic rollback, not a Core 4xx reply.
    const firstDeleteUrl = messageDeletePath(
      origin,
      communityApId,
      firstMessage.id,
    );
    let interceptedDeleteCount = 0;
    const refuseFirstDelete = async (route) => {
      if (route.request().method() === "DELETE") {
        interceptedDeleteCount += 1;
        await route.abort("failed");
        return;
      }
      await route.continue();
    };
    await page.route(firstDeleteUrl, refuseFirstDelete);
    try {
      const firstBubble = page
        .locator("li.c-talk-chat")
        .filter({ hasText: firstText });
      const dialog = await openDeleteMenu(page, firstText);
      const deleteRequest = page.waitForRequest(
        (request) =>
          request.method() === "DELETE" && request.url() === firstDeleteUrl,
        { timeout: 10_000 },
      );
      deleteRequest.catch(() => {});
      await dialog.getByRole("button", { name: "削除", exact: true }).click();
      await deleteRequest;
      await page
        .getByText("削除に失敗しました", { exact: true })
        .waitFor({ state: "visible", timeout: 5_000 });
      await firstBubble.waitFor({ state: "visible", timeout: 5_000 });
      const firstStillPresent = await first(
        db,
        "SELECT ap_id FROM objects WHERE ap_id = ? AND content = ?",
        firstMessage.id,
        firstText,
      );
      const latestStillPresent = await first(
        db,
        "SELECT ap_id FROM objects WHERE ap_id = ? AND content = ?",
        latestMessage.id,
        latestText,
      );
      requireCommunityPreview(
        interceptedDeleteCount === 1 &&
          firstStillPresent?.ap_id === firstMessage.id &&
          latestStillPresent?.ap_id === latestMessage.id &&
          (await communityContact(page, origin, communityApId)).contact
            ?.last_message?.content === latestText,
        "controlled no-write DELETE abort did not restore the bubble and preserve native state",
      );
    } finally {
      await page.unroute(firstDeleteUrl, refuseFirstDelete);
    }

    const deleteStart = Date.now();
    requireCommunityPreview(
      deleteStart - appTalkRouteStartedAt < 14_000,
      "no-write recovery exhausted the pre-poll window before real delete",
    );
    const latestDeleteUrl = messageDeletePath(
      origin,
      communityApId,
      latestMessage.id,
    );
    const latestDeleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url() === latestDeleteUrl,
      { timeout: 15_000 },
    );
    latestDeleteResponse.catch(() => {});
    const latestDeleteDialog = await openDeleteMenu(page, latestText);
    await latestDeleteDialog
      .getByRole("button", { name: "削除", exact: true })
      .click();
    const deletedResponse = await latestDeleteResponse;
    requireCommunityPreview(
      deletedResponse.status() === 200,
      `actual Core DELETE did not succeed: status=${deletedResponse.status()}`,
    );
    requireCommunityPreview(
      Date.now() - appTalkRouteStartedAt < 15_000,
      "real DELETE completed too close to the periodic contact refresh",
    );
    await page
      .locator("li.c-talk-chat")
      .filter({ hasText: latestText })
      .waitFor({ state: "detached", timeout: 5_000 });
    const deletedRow = await first(
      db,
      "SELECT ap_id FROM objects WHERE ap_id = ?",
      latestMessage.id,
    );
    const previousRow = await first(
      db,
      "SELECT ap_id, content FROM objects WHERE ap_id = ?",
      firstMessage.id,
    );
    requireCommunityPreview(
      deletedRow === null &&
        previousRow?.ap_id === firstMessage.id &&
        previousRow.content === firstText,
      "successful real DELETE did not remove only the newest object",
    );
    const restoredContact = await communityContact(page, origin, communityApId);
    requireCommunityPreview(
      restoredContact.status === 200 &&
        restoredContact.contact?.last_message?.content === firstText &&
        restoredContact.contact.last_message.is_mine === true,
      "native contacts API did not move the community preview back to the prior message",
    );

    const priorPreview = page.waitForFunction(
      ({ name, previous, deleted }) => {
        const row = Array.from(
          document.querySelectorAll("li.c-talk-rooms"),
        ).find((item) => item.textContent?.includes(name));
        const text = row?.querySelector(".c-talk-rooms-msg")?.textContent ?? "";
        return text.includes(previous) && !text.includes(deleted);
      },
      {
        name: communityDisplayName,
        previous: firstText,
        deleted: latestText,
      },
      { timeout: 5_000 },
    );
    priorPreview.catch(() => {});
    try {
      await priorPreview;
    } catch {
      const previewText = await deletePreviewText(page, communityDisplayName);
      const elapsedMs = Date.now() - deleteStart;
      throw new Error(
        `community delete left a stale Talk-list preview before the 20-second poll; elapsedMs=${elapsedMs}; nativeLastMessage=${JSON.stringify(restoredContact.contact?.last_message)}; visiblePreview=${JSON.stringify(previewText)}; deletedObjectAbsent=${deletedRow === null}; previousObjectPresent=${previousRow?.ap_id === firstMessage.id}; appRouteElapsedMs=${Date.now() - appTalkRouteStartedAt}`,
      );
    }
    const previewElapsedMs = Date.now() - deleteStart;
    requireCommunityPreview(
      previewElapsedMs < 5_000 && Date.now() - appTalkRouteStartedAt < 20_000,
      "Talk-list preview updated only after its periodic refresh window",
    );
    checks.push("browser-community-delete-refreshes-last-message-preview");

    const countsAfter = {
      actors: await first(db, "SELECT COUNT(*) AS count FROM actors"),
      owners: await first(
        db,
        "SELECT COUNT(*) AS count FROM actors WHERE role = 'owner' AND deleted_at IS NULL",
      ),
      sessions: await first(db, "SELECT COUNT(*) AS count FROM sessions"),
      communities: await first(db, "SELECT COUNT(*) AS count FROM communities"),
      memberships: await first(
        db,
        "SELECT COUNT(*) AS count FROM community_members",
      ),
    };
    requireCommunityPreview(
      countsAfter.actors?.count === countsAfterCreate.actors?.count &&
        countsAfter.owners?.count === countsAfterCreate.owners?.count &&
        countsAfter.sessions?.count === countsAfterCreate.sessions?.count &&
        countsAfter.communities?.count ===
          countsAfterCreate.communities?.count &&
        countsAfter.memberships?.count === countsAfterCreate.memberships?.count,
      "message deletion changed human/session/group membership inventory",
    );
    checks.push(
      "browser-community-delete-keeps-existing-owner-and-session-counts",
    );

    return {
      scope:
        "one API-created Community Group and its owner membership attached to the existing authenticated human; no additional actor or session is seeded",
      communityApId,
      communityName,
      ownerActorCountBefore: countsBefore.owners.count,
      ownerActorCountAfter: countsAfter.owners.count,
      actorCountBefore: countsBefore.actors.count,
      actorCountAfter: countsAfter.actors.count,
      sessionCountBefore: countsBefore.sessions.count,
      sessionCountAfter: countsAfter.sessions.count,
      groupRowsAdded:
        countsAfter.communities.count - countsBefore.communities.count,
      membershipRowsAdded:
        countsAfter.memberships.count - countsBefore.memberships.count,
      messages: {
        refusedDeleteMessageId: firstMessage.id,
        refusedDeleteTransportIntercepts: interceptedDeleteCount,
        refusedDeleteTransportOutcome: "aborted-before-worker",
        realDeleteMessageId: latestMessage.id,
        realDeleteStatus: deletedResponse.status(),
        deletedObjectAbsent: deletedRow === null,
        priorObjectStillPresent: previousRow?.ap_id === firstMessage.id,
        nativeLastMessageAfterDelete: firstText,
        previewUpdateMs: previewElapsedMs,
      },
    };
  } finally {
    page.off("request", onContactRequest);
  }
}
