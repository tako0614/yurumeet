import { generateKeyPairSync } from "node:crypto";

const PREFIX = "yurume:draft:v2:";

function requireDraft(condition, message) {
  if (!condition) throw new Error(`release-browser draft-storage ${message}`);
}

async function first(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .first();
}

async function postMessage(page, peerApId, content) {
  return page.evaluate(
    async ({ peerApId, content }) => {
      const response = await fetch(
        `/api/dm/user/${encodeURIComponent(peerApId)}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    },
    { peerApId, content },
  );
}

async function addPeer(db, apId, username, name) {
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  await db
    .prepare(
      `INSERT INTO actors (
       ap_id, type, preferred_username, name, inbox, outbox, followers_url,
       following_url, public_key_pem, private_key_pem, role
     ) VALUES (?, 'Person', ?, ?, ?, ?, ?, ?, ?,
               '', 'member')`,
    )
    .bind(
      apId,
      username,
      name,
      `${apId}/inbox`,
      `${apId}/outbox`,
      `${apId}/followers`,
      `${apId}/following`,
      publicKey,
    )
    .run();
  const peer = await first(
    db,
    "SELECT ap_id, role, owner_actor_ap_id FROM actors WHERE ap_id = ?",
    apId,
  );
  requireDraft(
    peer?.ap_id === apId &&
      peer.role === "member" &&
      peer.owner_actor_ap_id === null,
    "synthetic contact crossed the member-only fixture boundary",
  );
}

async function createContact(page, db, origin, actorApId, name, index) {
  const apId = `${origin}/ap/users/${name}`;
  await addPeer(db, apId, name, `Draft ${name}`);
  const openerText = `draft-storage-fixture-opener-${index}-${crypto.randomUUID()}`;
  const response = await postMessage(page, apId, openerText);
  requireDraft(
    response.status === 201 &&
      typeof response.body?.conversation_id === "string",
    "native authenticated DM API did not create the fixture contact",
  );
  const note = await first(
    db,
    "SELECT ap_id, type, attributed_to, content FROM objects WHERE ap_id = ?",
    response.body.message?.id,
  );
  const create = await first(
    db,
    "SELECT ap_id, type, actor_ap_id, object_ap_id FROM activities WHERE object_ap_id = ? AND type = 'Create'",
    response.body.message?.id,
  );
  requireDraft(
    note?.type === "Note" &&
      note.attributed_to === actorApId &&
      note.content === openerText &&
      create?.type === "Create" &&
      create.actor_ap_id === actorApId &&
      create.object_ap_id === note.ap_id,
    "contact opener did not persist as one local native DM Note/Create",
  );
  return { apId, name: `Draft ${name}`, openerText, messageId: note.ap_id };
}

async function selectContact(page, contact) {
  const button = page
    .locator("li.c-talk-rooms > button")
    .filter({ hasText: contact.name });
  await button.waitFor({ state: "visible", timeout: 15_000 });
  await button.click({ timeout: 10_000 });
  await page.getByText(contact.openerText, { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await page
    .locator('textarea[name="message"]')
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function captureDraftKey(page, contact, origin, actorApId) {
  await page.evaluate(() => {
    const prototype = Storage.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, "getItem");
    window.__draftStorageCapture = { original, keys: [] };
    Object.defineProperty(prototype, "getItem", {
      ...original,
      value(key) {
        if (this === window.localStorage)
          window.__draftStorageCapture.keys.push(String(key));
        return original.value.call(this, key);
      },
    });
  });
  let captured = [];
  try {
    await selectContact(page, contact);
    captured = await page.evaluate(
      () =>
        window.__draftStorageCapture?.keys.filter((key) =>
          key.startsWith("yurume:draft:v2:"),
        ) ?? [],
    );
  } finally {
    await page
      .evaluate(() => {
        const state = window.__draftStorageCapture;
        if (state)
          Object.defineProperty(Storage.prototype, "getItem", state.original);
        delete window.__draftStorageCapture;
      })
      .catch(() => {});
  }
  const matching = [...new Set(captured)]
    .map((key) => {
      try {
        return { key, identity: JSON.parse(key.slice(PREFIX.length)) };
      } catch {
        return { key, identity: null };
      }
    })
    .filter(
      ({ identity }) =>
        Array.isArray(identity) &&
        identity.length === 5 &&
        identity[0] === 1 &&
        identity[1] === new URL(origin).origin &&
        identity[2] === actorApId &&
        identity[3] === "user" &&
        identity[4] === contact.apId,
    );
  requireDraft(
    matching.length === 1,
    "could not observe exactly one current scoped draft key",
  );
  const { key, identity } = matching[0];
  requireDraft(
    Array.isArray(identity) &&
      identity.length === 5 &&
      identity[0] === 1 &&
      identity[1] === new URL(origin).origin &&
      identity[1] === new URL(page.url()).origin &&
      identity[2] === actorApId &&
      identity[3] === "user" &&
      identity[4] === contact.apId,
    "observed storage key does not match the current v1 origin/principal/user/AP ID tuple",
  );
  return { key, identity };
}

async function installSetFault(page, key, mode) {
  return page.evaluate(
    ({ key, mode }) => {
      const prototype = Storage.prototype;
      const original = Object.getOwnPropertyDescriptor(prototype, "setItem");
      const state = { original, key, mode, hits: 0 };
      window.__draftStorageFault = state;
      Object.defineProperty(prototype, "setItem", {
        ...original,
        value(storageKey, value) {
          if (this === window.localStorage && String(storageKey) === key) {
            state.hits += 1;
            if (mode === "deny")
              throw new DOMException(
                "fixture denied localStorage",
                "QuotaExceededError",
              );
            if (mode === "noop") return undefined;
          }
          return original.value.call(this, storageKey, value);
        },
      });
    },
    { key, mode },
  );
}

async function restoreSetFault(page) {
  await page.evaluate(() => {
    const state = window.__draftStorageFault;
    if (state)
      Object.defineProperty(Storage.prototype, "setItem", state.original);
    delete window.__draftStorageFault;
  });
}

async function setFaultHits(page) {
  return page.evaluate(() => window.__draftStorageFault?.hits ?? 0);
}

async function installOneReadFaultBeforeReload(page, key) {
  await page.addInitScript(
    ({ key }) => {
      const prototype = Storage.prototype;
      const original = Object.getOwnPropertyDescriptor(prototype, "getItem");
      const state = { original, denied: false };
      window.__draftStorageReadFault = state;
      Object.defineProperty(prototype, "getItem", {
        ...original,
        value(storageKey) {
          if (
            !state.denied &&
            this === window.localStorage &&
            String(storageKey) === key
          ) {
            state.denied = true;
            Object.defineProperty(Storage.prototype, "getItem", original);
            delete window.__draftStorageReadFault;
            throw new DOMException(
              "fixture denied localStorage read",
              "SecurityError",
            );
          }
          return original.value.call(this, storageKey);
        },
      });
    },
    { key },
  );
}

async function restoreReadFault(page) {
  await page.evaluate(() => {
    const state = window.__draftStorageReadFault;
    if (state)
      Object.defineProperty(Storage.prototype, "getItem", state.original);
    delete window.__draftStorageReadFault;
  });
}

async function storageValue(page, key) {
  return page.evaluate((key) => localStorage.getItem(key), key);
}

async function warning(page, expectedStatus) {
  const locator = page.locator("[data-draft-storage-warning]");
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  const details = await locator.evaluate((node) => ({
    role: node.getAttribute("role"),
    status: node.getAttribute("data-draft-storage-status"),
    text: node.textContent?.trim() ?? "",
  }));
  requireDraft(
    details.role === "alert" &&
      details.status === expectedStatus &&
      details.text.includes("下書き"),
    `draft warning did not expose alert status ${expectedStatus}`,
  );
  return details;
}

async function nativeDraftEffects(db, draftTexts, actorApId) {
  const result = [];
  for (const content of draftTexts) {
    const notes = await first(
      db,
      "SELECT COUNT(*) AS count FROM objects WHERE attributed_to = ? AND content = ? AND type = 'Note'",
      actorApId,
      content,
    );
    const creates = await first(
      db,
      `SELECT COUNT(*) AS count FROM activities a
        JOIN objects o ON o.ap_id = a.object_ap_id
       WHERE o.attributed_to = ? AND o.content = ? AND a.type = 'Create'`,
      actorApId,
      content,
    );
    result.push({
      content,
      notes: notes?.count ?? null,
      creates: creates?.count ?? null,
    });
  }
  return result;
}

async function ownerSessionCounts(db) {
  const owner = await first(
    db,
    "SELECT COUNT(*) AS count FROM actors WHERE role = 'owner' AND deleted_at IS NULL",
  );
  const sessions = await first(db, "SELECT COUNT(*) AS count FROM sessions");
  return { owners: owner?.count ?? null, sessions: sessions?.count ?? null };
}

export async function qualifyBrowserDraftStorage({
  page,
  db,
  origin,
  actorApId,
  checks,
}) {
  requireDraft(
    page && db && Array.isArray(checks),
    "page, native D1, and checks are required",
  );
  requireDraft(
    new URL(actorApId).origin === new URL(origin).origin,
    "owner must belong to fixture origin",
  );

  const base = new URL(origin).origin;
  const contacts = [
    await createContact(
      page,
      db,
      base,
      actorApId,
      `draft-peer-a-${crypto.randomUUID()}`,
      "a",
    ),
    await createContact(
      page,
      db,
      base,
      actorApId,
      `draft-peer-b-${crypto.randomUUID()}`,
      "b",
    ),
  ];
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  const texts = {
    failedWrite: `draft-storage-write-denied-${crypto.randomUUID()}`,
    readRetry: `draft-storage-read-existing-${crypto.randomUUID()}`,
    noOp: `draft-storage-noop-${crypto.randomUUID()}`,
    conflictMemory: `draft-storage-conflict-memory-${crypto.randomUUID()}`,
    conflictStored: `draft-storage-conflict-stored-${crypto.randomUUID()}`,
  };
  const matchedDraftPosts = [];
  const trackedDraftTexts = Object.values(texts);
  const recordDraftPost = (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (
      !url.pathname.startsWith("/api/dm/user/") ||
      !url.pathname.endsWith("/messages")
    )
      return;
    try {
      const content = request.postDataJSON()?.content;
      if (trackedDraftTexts.includes(content))
        matchedDraftPosts.push({ path: url.pathname, content });
    } catch {
      // Non-JSON DM requests cannot contain any exact unique draft marker.
    }
  };
  page.on("request", recordDraftPost);
  const countsBefore = await ownerSessionCounts(db);
  const checksAdded = [];
  let faultInstalled = false;
  let readFaultInstalled = false;
  try {
    await selectContact(page, contacts[1]);
    const { key: keyA, identity: identityA } = await captureDraftKey(
      page,
      contacts[0],
      origin,
      actorApId,
    );
    await installSetFault(page, keyA, "deny");
    faultInstalled = true;
    const composer = page.locator('textarea[name="message"]');
    await composer.fill(texts.failedWrite);
    const deniedWarning = await warning(page, "write-error");
    requireDraft(
      (await setFaultHits(page)) > 0,
      "Storage.prototype.setItem denial did not intercept the real scoped key",
    );
    await selectContact(page, contacts[1]);
    await selectContact(page, contacts[0]);
    requireDraft(
      (await composer.inputValue()) === texts.failedWrite,
      "A→B→A did not retain failed-write draft in mounted memory",
    );
    requireDraft(
      deniedWarning.text.includes("再読込") ||
        deniedWarning.text.includes("画面を閉じる"),
      "write warning omitted reload/close loss disclosure",
    );
    await page
      .getByRole("button", { name: "入力を選択", exact: true })
      .click({ timeout: 10_000 });
    const selection = await composer.evaluate((node) => ({
      focused: document.activeElement === node,
      start: node.selectionStart,
      end: node.selectionEnd,
      describedBy: node.getAttribute("aria-describedby"),
    }));
    requireDraft(
      selection.focused &&
        selection.start === 0 &&
        selection.end === texts.failedWrite.length &&
        selection.describedBy === "talk-draft-storage-warning",
      "draft selection or warning description is not available to the composer",
    );
    await restoreSetFault(page);
    faultInstalled = false;
    await page
      .getByRole("button", { name: "下書きを保存", exact: true })
      .click({ timeout: 10_000 });
    requireDraft(
      (await storageValue(page, keyA)) === texts.failedWrite,
      "explicit save did not persist exact failed-write text",
    );
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await selectContact(page, contacts[0]);
    requireDraft(
      (await page.locator('textarea[name="message"]').inputValue()) ===
        texts.failedWrite,
      "explicitly saved draft did not survive reload",
    );
    checksAdded.push(
      "browser-draft-write-denial-retains-memory-and-explicit-save-reloads",
    );

    const { key: keyB } = await captureDraftKey(
      page,
      contacts[1],
      origin,
      actorApId,
    );
    await page.locator('textarea[name="message"]').fill(texts.readRetry);
    requireDraft(
      (await storageValue(page, keyB)) === texts.readRetry,
      "read-failure scenario could not seed exact preexisting bytes",
    );
    await installOneReadFaultBeforeReload(page, keyB);
    readFaultInstalled = true;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    await selectContact(page, contacts[1]);
    const deniedRead = await warning(page, "read-error");
    await selectContact(page, contacts[0]);
    requireDraft(
      (await storageValue(page, keyB)) === texts.readRetry,
      "switch after denied getItem removed or changed hidden saved bytes",
    );
    await selectContact(page, contacts[1]);
    await page
      .getByRole("button", { name: "保存済みの下書きを読み込む", exact: true })
      .click({ timeout: 10_000 });
    requireDraft(
      (await page.locator('textarea[name="message"]').inputValue()) ===
        texts.readRetry,
      "explicit reload did not recover bytes after read denial",
    );
    await restoreReadFault(page);
    readFaultInstalled = false;
    checksAdded.push(
      "browser-draft-read-denial-preserves-hidden-bytes-and-explicit-reload",
    );

    const composerB = page.locator('textarea[name="message"]');
    await installSetFault(page, keyB, "noop");
    faultInstalled = true;
    await composerB.fill(texts.noOp);
    await warning(page, "write-error");
    requireDraft(
      (await setFaultHits(page)) > 0,
      "no-op setItem hook did not intercept scoped storage write",
    );
    requireDraft(
      (await composerB.inputValue()) === texts.noOp,
      "no-op storage write erased mounted-memory text",
    );
    await restoreSetFault(page);
    faultInstalled = false;
    await page
      .getByRole("button", { name: "下書きを保存", exact: true })
      .click({ timeout: 10_000 });
    requireDraft(
      (await storageValue(page, keyB)) === texts.noOp,
      "readback mismatch recovery did not save exact bytes",
    );
    checksAdded.push("browser-draft-noop-write-detected-and-recovered");

    await composerB.fill(texts.conflictMemory);
    requireDraft(
      (await storageValue(page, keyB)) === texts.conflictMemory,
      "conflict fixture did not first persist current bytes",
    );
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: keyB,
      value: texts.conflictStored,
    });
    await composerB.fill(`${texts.conflictMemory}-edited`);
    await warning(page, "conflict");
    const conflictedText = `${texts.conflictMemory}-edited`;
    trackedDraftTexts.push(conflictedText);
    await selectContact(page, contacts[0]);
    requireDraft(
      (await storageValue(page, keyB)) === texts.conflictStored,
      "switch overwrote a newer external draft value",
    );
    await selectContact(page, contacts[1]);
    requireDraft(
      (await page.locator('textarea[name="message"]').inputValue()) ===
        conflictedText,
      "conflict did not preserve current mounted-memory text",
    );
    await page
      .getByRole("button", { name: "保存済みの下書きを読み込む", exact: true })
      .click({ timeout: 10_000 });
    const confirm = page.getByRole("alertdialog", {
      name: "保存済みの下書きを読み込みますか？",
    });
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    await confirm
      .getByRole("button", { name: "読み込む", exact: true })
      .click({ timeout: 10_000 });
    requireDraft(
      (await page.locator('textarea[name="message"]').inputValue()) ===
        texts.conflictStored,
      "explicit conflict reload did not replace memory with chosen saved bytes",
    );
    checksAdded.push(
      "browser-draft-conflict-preserves-both-versions-until-explicit-reload",
    );

    const identityVariants = [
      [
        identityA[0],
        identityA[1],
        `${identityA[2]}/other-principal`,
        identityA[3],
        identityA[4],
      ],
      [
        identityA[0],
        "http://127.0.0.1:1",
        identityA[2],
        identityA[3],
        identityA[4],
      ],
      [identityA[0], identityA[1], identityA[2], "community", identityA[4]],
      [
        identityA[0],
        identityA[1],
        identityA[2],
        identityA[3],
        `${identityA[4]}/other-target`,
      ],
    ];
    const variantEntries = identityVariants.map((identity, index) => ({
      key: `${PREFIX}${JSON.stringify(identity)}`,
      value: `draft-storage-scoped-sentinel-${index}-${crypto.randomUUID()}`,
    }));
    const legacyKey = `yurume:draft:${contacts[0].apId}`;
    const legacyValue = `draft-storage-legacy-sentinel-${crypto.randomUUID()}`;
    await page.evaluate(
      ({ entries, legacyKey, legacyValue }) => {
        for (const { key, value } of entries) localStorage.setItem(key, value);
        localStorage.setItem(legacyKey, legacyValue);
      },
      { entries: variantEntries, legacyKey, legacyValue },
    );
    const beforeScoped = await page.evaluate(
      ({ entries, legacyKey }) => ({
        values: entries.map(({ key }) => localStorage.getItem(key)),
        legacy: localStorage.getItem(legacyKey),
      }),
      { entries: variantEntries, legacyKey },
    );
    await selectContact(page, contacts[0]);
    const scopeTouchText = `draft-storage-scope-touch-${crypto.randomUUID()}`;
    trackedDraftTexts.push(scopeTouchText);
    await page.locator('textarea[name="message"]').fill(scopeTouchText);
    await selectContact(page, contacts[1]);
    const afterScoped = await page.evaluate(
      ({ entries, legacyKey }) => ({
        values: entries.map(({ key }) => localStorage.getItem(key)),
        legacy: localStorage.getItem(legacyKey),
      }),
      { entries: variantEntries, legacyKey },
    );
    requireDraft(
      JSON.stringify(afterScoped) === JSON.stringify(beforeScoped) &&
        JSON.stringify(beforeScoped.values) ===
          JSON.stringify(variantEntries.map(({ value }) => value)) &&
        beforeScoped.legacy === legacyValue,
      "other-principal/origin/target-type/target or legacy contact-only bytes changed",
    );
    checksAdded.push("browser-draft-scope-and-legacy-bytes-remain-isolated");

    const dmRequestEvidence = matchedDraftPosts.slice();
    const sideEffects = await nativeDraftEffects(
      db,
      trackedDraftTexts,
      actorApId,
    );
    const countsAfter = await ownerSessionCounts(db);
    requireDraft(
      dmRequestEvidence.length === 0,
      "a unique draft text was submitted through native DM POST",
    );
    requireDraft(
      sideEffects.every(({ notes, creates }) => notes === 0 && creates === 0),
      "a unique draft text produced native D1 Note/Create side effects",
    );
    requireDraft(
      JSON.stringify(countsAfter) === JSON.stringify(countsBefore),
      "draft storage journey changed owner or session counts",
    );
    checksAdded.push(
      "browser-draft-storage-has-no-dm-side-effects-or-owner-session-mutation",
    );

    checks.push(...checksAdded);
    return {
      kind: "yurumeet.draft-storage@v1",
      checks: checksAdded,
      cases: {
        failedWrite: {
          hook: "Storage.prototype.setItem-deny",
          interceptedWrites: true,
          returnedText: texts.failedWrite,
          explicitlySaved: true,
          reloadRestored: true,
        },
        deniedRead: {
          hook: "Storage.prototype.getItem-one-shot-deny",
          preexistingBytesPreserved: true,
          explicitReloadRestored: true,
          warningStatus: deniedRead.status,
        },
        noopWrite: {
          hook: "Storage.prototype.setItem-noop",
          readbackMismatchReported: true,
          explicitlyRecovered: true,
        },
        conflict: {
          externalBytesPreserved: true,
          inMemoryTextPreserved: true,
          explicitReloadValue: texts.conflictStored,
        },
        scope: {
          identity: identityA,
          preservedVariantCount: variantEntries.length,
          legacyKey,
          legacyUnchanged: true,
        },
      },
      sideEffects: {
        matchedDraftDmPosts: dmRequestEvidence,
        exactTextNativeNoteCreateCounts: sideEffects,
        ownerSessionCounts: { before: countsBefore, after: countsAfter },
      },
    };
  } finally {
    page.off("request", recordDraftPost);
    if (faultInstalled) await restoreSetFault(page).catch(() => {});
    if (readFaultInstalled) await restoreReadFault(page).catch(() => {});
  }
}
