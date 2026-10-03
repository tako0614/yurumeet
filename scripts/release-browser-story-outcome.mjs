// Real-browser Story outcome qualification against a local Worker.
// Network evidence comes from real Worker upload and Story requests; only
// selected browser response deliveries are aborted by the route fixture.
import { createHash, randomUUID } from "node:crypto";

const TIMEOUT = 20_000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
  "base64",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
function need(ok, label, detail) {
  if (!ok)
    throw new Error(`story-outcome:${label}${detail ? `:${detail}` : ""}`);
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`story-outcome:${label}-timeout`)),
          TIMEOUT,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function count(db, sql, ...values) {
  let q = db.prepare(sql);
  if (values.length) q = q.bind(...values);
  const row = await q.first();
  return Number(row?.count ?? 0);
}
async function identityCounts(db) {
  const row = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
  return {
    actors: Number(row?.actors ?? -1),
    sessions: Number(row?.sessions ?? -1),
  };
}
async function ownerSession(db, actorApId) {
  return db
    .prepare(
      "SELECT a.ap_id, a.role, a.deleted_at, (SELECT COUNT(*) FROM sessions s WHERE s.member_id = a.ap_id) AS sessions FROM actors a WHERE a.ap_id = ?",
    )
    .bind(actorApId)
    .first();
}

export async function qualifyStoryOutcome({
  page,
  context,
  db,
  bucket,
  origin,
  actorApId,
  checks,
}) {
  need(
    page && context && db && bucket && Array.isArray(checks),
    "page-context-d1-r2-checks-required",
  );
  const initialIdentity = await identityCounts(db);
  const ownerBefore = await ownerSession(db, actorApId);
  need(
    initialIdentity.actors > 0 &&
      initialIdentity.sessions > 0 &&
      ownerBefore?.role === "owner" &&
      ownerBefore.deleted_at == null &&
      ownerBefore.sessions === 1,
    "authenticated-owner-required",
  );
  const sessionBefore = (await context.cookies(origin)).find(
    (cookie) => cookie.name === "session",
  )?.value;
  need(Boolean(sessionBefore), "real-browser-session-required");
  const initialStories = await count(
    db,
    "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
    actorApId,
  );
  const initialCreates = await count(
    db,
    "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
    actorApId,
  );
  const initialUploads = await count(
    db,
    "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
    actorApId,
  );
  const intentKey = `yurumeet:story-intent:v1:${encodeURIComponent(origin)}:${encodeURIComponent(actorApId)}:${encodeURIComponent(`${origin}/api/stories`)}`;
  const readIntent = async () =>
    page.evaluate((key) => {
      const raw = sessionStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    }, intentKey);
  const installIntentWriteObserver = async () =>
    page.evaluate((key) => {
      const storage = window.sessionStorage;
      if (window.__storyIntentWriteObserver) return;
      const descriptor = Object.getOwnPropertyDescriptor(
        Storage.prototype,
        "setItem",
      );
      const original = descriptor?.value;
      if (typeof original !== "function")
        throw new Error("Storage.setItem observer unavailable");
      const observer = { key, descriptor, original, writes: [] };
      observer.wrapper = function (name, value) {
        const result = original.call(this, name, value);
        if (this === storage && name === observer.key) {
          try {
            observer.writes.push(JSON.parse(value));
          } catch {}
        }
        return result;
      };
      Object.defineProperty(Storage.prototype, "setItem", {
        ...descriptor,
        value: observer.wrapper,
      });
      window.__storyIntentWriteObserver = observer;
    }, intentKey);
  const readIntentWrites = async () =>
    page.evaluate(() => window.__storyIntentWriteObserver?.writes ?? []);
  const restoreIntentWriteObserver = async () =>
    page
      .evaluate(() => {
        const observer = window.__storyIntentWriteObserver;
        if (
          observer &&
          Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
            ?.value === observer.wrapper
        ) {
          Object.defineProperty(
            Storage.prototype,
            "setItem",
            observer.descriptor,
          );
        }
        delete window.__storyIntentWriteObserver;
      })
      .catch(() => {});
  const caption = `Lost Story acknowledgement ${randomUUID()}`;
  const filename = "story-outcome-lost-ack.png";
  await page
    .locator(".yc-story-add")
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await page.locator(".yc-story-add").click();
  const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({ name: filename, mimeType: "image/png", buffer: PNG });
  await dialog.getByPlaceholder("キャプション").fill(caption);
  const submit = dialog.locator('button[type="submit"]');
  await submit.focus();

  const records = { upload: null, story: null, retry: null };
  const intentLifecycle = {
    key: intentKey,
    initial: null,
    afterClose: null,
    afterReopen: null,
    afterReload: null,
    afterRetryAbort: null,
    writes: [],
  };
  const errors = { page: [], fiveHundreds: [] };
  const unexpected = [];
  let routeCount = 0;
  let routeError;
  const browserRequestFailures = [];
  let active = 0;
  const idleWaiters = [];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() !== "POST" ||
      url.origin !== origin ||
      !["/api/media/upload", "/api/stories"].includes(url.pathname)
    )
      return route.fallback();
    active += 1;
    try {
      if (url.pathname === "/api/media/upload") {
        if (records.upload) {
          unexpected.push("duplicate-upload");
          return route.abort("failed");
        }
        const upstream = await route.fetch({
          maxRedirects: 0,
          timeout: TIMEOUT,
        });
        const bytes = await upstream.body();
        const uploadRequestBytes = request.postDataBuffer() ?? Buffer.alloc(0);
        records.upload = {
          status: upstream.status(),
          requestBytes: uploadRequestBytes.length,
          requestSha256: sha(uploadRequestBytes),
          requestContainsPng: uploadRequestBytes.includes(PNG),
          responseBody: JSON.parse(bytes.toString("utf8")),
          responseSha256: sha(bytes),
          fulfilledSha256: null,
        };
        await route.fulfill({ response: upstream, body: bytes });
        records.upload.fulfilledSha256 = sha(bytes);
        return;
      }
      routeCount += 1;
      let requestBody;
      try {
        requestBody = request.postDataJSON();
      } catch {
        requestBody = null;
      }
      if (routeCount > 1) {
        records.retry = {
          requestBody,
          requestSha256: sha(request.postDataBuffer() ?? Buffer.alloc(0)),
        };
        await route.abort("failed");
        return;
      }
      const upstream = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      const bytes = await upstream.body();
      let responseBody;
      try {
        responseBody = JSON.parse(bytes.toString("utf8"));
      } catch {
        responseBody = null;
      }
      records.story = {
        upstreamStatus: upstream.status(),
        requestBody,
        requestSha256: sha(request.postDataBuffer() ?? Buffer.alloc(0)),
        responseBody,
        responseSha256: sha(bytes),
        responseBytes: bytes.length,
      };
      need(
        upstream.status() === 201 &&
          responseBody?.story?.ap_id &&
          responseBody.story.attachment?.r2_key,
        "actual-worker-commit-response-shape",
      );
      await route.abort("failed");
      records.story.browserResponseAborted = true;
    } catch (error) {
      routeError = error;
      try {
        await route.abort("failed");
      } catch {}
    } finally {
      active -= 1;
      if (active === 0) for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  const waitIdle = async () => {
    if (active === 0) return;
    await bounded(
      new Promise((resolve) => idleWaiters.push(resolve)),
      "routes-idle",
    );
  };
  page.on("pageerror", (error) => errors.page.push(String(error)));
  page.on("requestfailed", (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === "/api/stories")
        browserRequestFailures.push({
          method: request.method(),
          path: url.pathname,
          errorText: request.failure()?.errorText ?? null,
        });
    } catch {}
  });
  page.on("response", (response) => {
    try {
      if (new URL(response.url()).origin === origin && response.status() >= 500)
        errors.fiveHundreds.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    } catch {}
  });
  await page.route("**/api/media/upload", handler);
  await page.route("**/api/stories", handler);
  try {
    await installIntentWriteObserver();
    await submit.click();
    await bounded(
      (async () => {
        while (!records.story && !routeError) await page.waitForTimeout(10);
      })(),
      "story-route-observed",
    );
    await page
      .getByText("投稿結果を確認できません", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await waitIdle();
    await page.waitForTimeout(350);
    const story = records.story;
    const upload = records.upload;
    need(
      upload?.status === 200 &&
        upload.requestContainsPng &&
        story?.upstreamStatus === 201 &&
        story.responseBytes > 0,
      "real-upload-and-story-response-captured",
    );
    need(
      story.requestBody?.caption === caption &&
        story.requestBody?.displayDuration === "PT5S" &&
        story.requestBody?.attachment?.content_type === "image/png",
      "actual-story-post-payload-matches-ui",
    );
    const r2Key = story.requestBody.attachment.r2_key;
    need(
      typeof r2Key === "string" &&
        story.responseBody.story.attachment.r2_key === r2Key,
      "uploaded-media-reference-carried-to-story",
    );
    const object = await db
      .prepare(
        "SELECT ap_id, type, attributed_to, content, attachments_json, end_time, deleted_at FROM objects WHERE ap_id = ?",
      )
      .bind(story.responseBody.story.ap_id)
      .first();
    const storyData = object ? JSON.parse(object.attachments_json) : null;
    const createRows = await db
      .prepare(
        "SELECT ap_id, type, actor_ap_id, object_ap_id, direction FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
      )
      .bind(actorApId, story.responseBody.story.ap_id)
      .all();
    const mediaRows = await db
      .prepare(
        "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE r2_key = ? AND uploader_ap_id = ?",
      )
      .bind(r2Key, actorApId)
      .all();
    const currentStories = await count(
      db,
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
      actorApId,
    );
    const currentCreates = await count(
      db,
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
      actorApId,
    );
    const currentUploads = await count(
      db,
      "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
      actorApId,
    );
    const nativeCountsBefore = {
      stories: initialStories,
      outboundCreates: initialCreates,
      uploads: initialUploads,
    };
    const nativeCountsAfterCommit = {
      stories: currentStories,
      outboundCreates: currentCreates,
      uploads: currentUploads,
    };
    const nativeCountsCommitDelta = {
      stories: currentStories - initialStories,
      outboundCreates: currentCreates - initialCreates,
      uploads: currentUploads - initialUploads,
    };
    const objectBytes = await bucket.get(r2Key);
    const storedBytes = objectBytes
      ? new Uint8Array(await objectBytes.arrayBuffer())
      : null;
    need(
      object?.type === "Story" &&
        object.attributed_to === actorApId &&
        object.content === "" &&
        object.deleted_at == null &&
        storyData?.caption === caption &&
        storyData.displayDuration === "PT5S" &&
        storyData.attachment?.r2_key === r2Key,
      "native-story-row-matches-post",
    );
    need(
      createRows.results?.length === 1 &&
        createRows.results[0].object_ap_id === object.ap_id,
      "exactly-one-native-outbound-create",
    );
    need(
      currentStories === initialStories + 1 &&
        currentCreates === initialCreates + 1 &&
        currentUploads === initialUploads + 1,
      "exactly-one-story-create-and-media-delta",
    );
    need(
      mediaRows.results?.length === 1 &&
        mediaRows.results[0].content_type === "image/png" &&
        mediaRows.results[0].size === PNG.length,
      "one-native-media-upload-row",
    );
    need(
      storedBytes && sha(storedBytes) === sha(PNG),
      "native-r2-bytes-match-uploaded-png",
    );
    const identityAfter = await identityCounts(db);
    const ownerAfter = await ownerSession(db, actorApId);
    const cookieAfter = (await context.cookies(origin)).find(
      (cookie) => cookie.name === "session",
    )?.value;
    need(
      JSON.stringify(initialIdentity) === JSON.stringify(identityAfter) &&
        ownerAfter?.role === "owner" &&
        ownerAfter.deleted_at == null &&
        ownerAfter.sessions === 1 &&
        ownerAfter.ap_id === actorApId &&
        cookieAfter === sessionBefore,
      "actor-session-invariance",
    );
    need(
      routeCount === 1 &&
        story.browserResponseAborted === true &&
        !unexpected.length &&
        !routeError,
      "one-real-story-post-no-hidden-retry",
    );
    const warning = page.getByText("投稿結果を確認できません", { exact: true });
    await warning.waitFor({ state: "visible", timeout: TIMEOUT });
    intentLifecycle.initial = await readIntent();
    intentLifecycle.writes = await readIntentWrites();
    need(
      intentLifecycle.initial?.status === "unconfirmed" &&
        intentLifecycle.initial.origin === origin &&
        intentLifecycle.initial.principal === actorApId &&
        intentLifecycle.initial.endpoint === `${origin}/api/stories`,
      "candidate-intent-unconfirmed-after-lost-ack",
    );
    need(
      canonical(intentLifecycle.initial.payload) ===
        canonical(story.requestBody),
      "candidate-intent-retains-exact-story-payload-and-media-reference",
    );
    need(
      intentLifecycle.writes.some((entry) => entry.status === "ready") &&
        intentLifecycle.writes.some((entry) => entry.status === "pending") &&
        intentLifecycle.writes.some((entry) => entry.status === "unconfirmed"),
      "candidate-intent-ready-pending-unconfirmed-writes-observed",
    );
    await bounded(
      (async () => {
        while (browserRequestFailures.length < 1) await page.waitForTimeout(10);
      })(),
      "first-browser-response-abort-observed",
    );
    need(
      browserRequestFailures[0].method === "POST" &&
        browserRequestFailures[0].path === "/api/stories",
      "first-lost-ack-browser-request-failed",
    );
    need(routeCount === 1, "candidate-no-auto-retry-before-close");
    const ui = {};
    let nativeCountsAfterRetry;
    const close = dialog
      .locator(".p-story-composer-head")
      .getByRole("button", { name: "閉じる", exact: true });
    await close.click({ timeout: TIMEOUT });
    await dialog.waitFor({ state: "hidden", timeout: TIMEOUT });
    intentLifecycle.afterClose = await readIntent();
    need(
      intentLifecycle.afterClose?.status === "unconfirmed" &&
        canonical(intentLifecycle.afterClose.payload) ===
          canonical(story.requestBody),
      "candidate-intent-retained-after-close",
    );
    await page.locator(".yc-story-add").click();
    const reopened = page.getByRole("dialog", { name: "ストーリー作成" });
    await reopened.waitFor({ state: "visible", timeout: TIMEOUT });
    await reopened
      .getByText("投稿結果を確認できません", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    intentLifecycle.afterReopen = await readIntent();
    need(
      intentLifecycle.afterReopen?.status === "unconfirmed" &&
        canonical(intentLifecycle.afterReopen.payload) ===
          canonical(story.requestBody),
      "candidate-intent-retained-after-reopen",
    );
    need(routeCount === 1, "candidate-no-auto-retry-after-reopen");
    await restoreIntentWriteObserver();
    await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await page.locator(".yc-story-add").click({ timeout: TIMEOUT });
    const restoredDialog = page.getByRole("dialog", { name: "ストーリー作成" });
    await restoredDialog.waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .getByText("投稿結果を確認できません", { exact: true })
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await installIntentWriteObserver();
    intentLifecycle.afterReload = await readIntent();
    need(
      intentLifecycle.afterReload?.status === "unconfirmed" &&
        canonical(intentLifecycle.afterReload.payload) ===
          canonical(story.requestBody),
      "candidate-intent-retained-after-reload",
    );
    await page.waitForTimeout(350);
    need(routeCount === 1, "candidate-no-auto-retry-after-reload");
    const riskButton = page.getByRole("button", {
      name: "重複の可能性を理解して再投稿",
      exact: true,
    });
    await riskButton.click({ timeout: TIMEOUT });
    let confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor({ state: "visible", timeout: TIMEOUT });
    const confirmationButtons = confirmation.getByRole("button");
    await confirmationButtons.last().focus();
    const confirmationFocusInitiallyInside = await confirmation.evaluate(
      (root) => root.contains(document.activeElement),
    );
    await page.keyboard.press("Tab");
    const confirmationTabInside = await confirmation.evaluate((root) =>
      root.contains(document.activeElement),
    );
    const confirmationTabWrapped = await confirmation
      .getByRole("button", { name: "戻る", exact: true })
      .evaluate((element) => element === document.activeElement);
    await page.keyboard.press("Shift+Tab");
    const confirmationShiftTabInside = await confirmation.evaluate((root) =>
      root.contains(document.activeElement),
    );
    const confirmationShiftTabWrapped = await confirmationButtons
      .last()
      .evaluate((element) => element === document.activeElement);
    await page.keyboard.press("Escape");
    await confirmation.waitFor({ state: "hidden", timeout: TIMEOUT });
    need(
      confirmationFocusInitiallyInside &&
        confirmationTabInside &&
        confirmationShiftTabInside &&
        confirmationTabWrapped &&
        confirmationShiftTabWrapped,
      "retry-confirmation-focus-contained",
    );
    need(
      routeCount === 1 && !records.retry,
      "retry-confirmation-escape-does-not-post",
    );
    await riskButton.click({ timeout: TIMEOUT });
    confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor({ state: "visible", timeout: TIMEOUT });
    await confirmation
      .getByRole("button", { name: "戻る", exact: true })
      .click({ timeout: TIMEOUT });
    await confirmation.waitFor({ state: "hidden", timeout: TIMEOUT });
    need(
      routeCount === 1 && !records.retry,
      "retry-confirmation-cancel-does-not-post",
    );
    await riskButton.click({ timeout: TIMEOUT });
    confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor({ state: "visible", timeout: TIMEOUT });
    const explicitRetry = confirmation.getByRole("button", {
      name: "再投稿する",
      exact: true,
    });
    await explicitRetry.click({ timeout: TIMEOUT });
    await bounded(
      (async () => {
        while (!records.retry && !routeError) await page.waitForTimeout(10);
      })(),
      "explicit-retry-intercepted",
    );
    await waitIdle();
    await page.waitForTimeout(200);
    need(
      routeCount === 2 &&
        records.retry &&
        canonical(records.retry.requestBody) === canonical(story.requestBody),
      "explicit-retry-same-payload-and-media-reference",
    );
    intentLifecycle.afterRetryAbort = await readIntent();
    need(
      intentLifecycle.afterRetryAbort?.status === "unconfirmed" &&
        canonical(intentLifecycle.afterRetryAbort.payload) ===
          canonical(story.requestBody),
      "candidate-intent-retained-after-explicit-retry-response-loss",
    );
    await bounded(
      (async () => {
        while (browserRequestFailures.length < 2) await page.waitForTimeout(10);
      })(),
      "explicit-retry-browser-abort-observed",
    );
    need(
      browserRequestFailures[1].method === "POST" &&
        browserRequestFailures[1].path === "/api/stories",
      "explicit-retry-browser-request-failed",
    );
    intentLifecycle.writes.push(...(await readIntentWrites()));
    const retryButton = page.getByRole("button", {
      name: "重複の可能性を理解して再投稿",
      exact: true,
    });
    const retryEnabledAfterAbort = await retryButton.isEnabled();
    const fileInputDisabled = await restoredDialog
      .locator('input[type="file"]')
      .isDisabled();
    const captionDisabled = await restoredDialog
      .getByPlaceholder("キャプション")
      .isDisabled();
    need(
      retryEnabledAfterAbort && fileInputDisabled && captionDisabled,
      "candidate-retry-remains-explicit-and-editor-remains-locked",
    );
    need(
      !records.upload || records.upload.status === 200,
      "original-upload-retained",
    );
    need(
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
        actorApId,
      )) ===
        initialStories + 1,
      "no-second-native-story-after-aborted-retry",
    );
    need(
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
        actorApId,
      )) ===
        initialCreates + 1,
      "no-second-outbound-create-after-aborted-retry",
    );
    need(
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
        actorApId,
      )) ===
        initialUploads + 1,
      "no-second-media-upload-after-retry",
    );
    need(
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
        actorApId,
        story.responseBody.story.ap_id,
      )) === 1,
      "no-second-create-after-aborted-retry",
    );
    need(
      (await count(
        db,
        "SELECT COUNT(*) AS count FROM media_uploads WHERE r2_key = ? AND uploader_ap_id = ?",
        r2Key,
        actorApId,
      )) === 1,
      "no-second-upload-after-retry",
    );
    nativeCountsAfterRetry = {
      stories: await count(
        db,
        "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
        actorApId,
      ),
      outboundCreates: await count(
        db,
        "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
        actorApId,
      ),
      uploads: await count(
        db,
        "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
        actorApId,
      ),
    };
    need(
      canonical(nativeCountsAfterRetry) === canonical(nativeCountsAfterCommit),
      "native-counts-stable-after-aborted-explicit-retry",
    );
    Object.assign(ui, {
      warningVisible: await warning.isVisible(),
      closedAndReopened: true,
      reloadRecovered: true,
      retryConfirmationFocusContained: true,
      retryConfirmationTabWrapped: confirmationTabWrapped,
      retryConfirmationShiftTabWrapped: confirmationShiftTabWrapped,
      retryConfirmationEscapeCancelled: true,
      retryConfirmationButtonCancelled: true,
      explicitRiskAcknowledged: true,
      explicitConfirmation: true,
      retryInterceptedBeforeWorker: true,
      retryEnabledAfterAbort,
      fileInputDisabled,
      captionDisabled,
    });
    need(
      errors.fiveHundreds.length === 0 && !errors.page.length,
      "no-worker-5xx-or-page-runtime-errors",
    );
    checks.push(
      "story-outcome-candidate-native-story-committed-once-before-response-loss",
    );
    checks.push(
      "story-outcome-candidate-unconfirmed-record-restored-without-auto-retry",
    );
    checks.push(
      "story-outcome-candidate-explicit-duplicate-risk-retry-reuses-payload",
    );
    return {
      mode: "candidate",
      result: "PASSED",
      story: {
        requestCount: routeCount,
        upstreamStatus: story.upstreamStatus,
        browserResponseAborted: story.browserResponseAborted,
        responseBytes: story.responseBytes,
        responseSha256: story.responseSha256,
        requestSha256: story.requestSha256,
        requestBody: story.requestBody,
        responseBody: story.responseBody,
      },
      upload: {
        status: upload.status,
        requestBytes: upload.requestBytes,
        requestSha256: upload.requestSha256,
        responseSha256: upload.responseSha256,
        fulfilledSha256: upload.fulfilledSha256,
        responseBody: upload.responseBody,
      },
      native: {
        story: object,
        storyData,
        outboundCreate: createRows.results[0],
        mediaUpload: mediaRows.results[0],
        r2Bytes: { size: storedBytes.length, sha256: sha(storedBytes) },
      },
      nativeCounts: {
        before: nativeCountsBefore,
        afterCommit: nativeCountsAfterCommit,
        commitDelta: nativeCountsCommitDelta,
        afterAbortedRetry: nativeCountsAfterRetry,
      },
      intentLifecycle,
      ui,
      identityBefore: {
        counts: initialIdentity,
        authenticatedActor: ownerBefore,
      },
      identityAfter: { counts: identityAfter, authenticatedActor: ownerAfter },
      errors,
      browserRequestFailures,
      routeCounts: {
        upload: upload ? 1 : 0,
        story: routeCount,
        unexpected: unexpected.length,
      },
    };
  } finally {
    await restoreIntentWriteObserver();
    await page.unroute("**/api/stories", handler);
    await page.unroute("**/api/media/upload", handler);
    await waitIdle();
  }
}

function storyIntentKey(origin, principal) {
  return `yurumeet:story-intent:v1:${encodeURIComponent(origin)}:${encodeURIComponent(principal)}:${encodeURIComponent(`${origin}/api/stories`)}`;
}

function installIntentStorageObserver(
  page,
  key,
  { failWrite = false, failRemove = false } = {},
) {
  return page.evaluate(
    ({ key: targetKey, failWrite: denyWrite, failRemove: denyRemove }) => {
      const storage = window.sessionStorage;
      const setDescriptor = Object.getOwnPropertyDescriptor(
        Storage.prototype,
        "setItem",
      );
      const removeDescriptor = Object.getOwnPropertyDescriptor(
        Storage.prototype,
        "removeItem",
      );
      const originalSet = setDescriptor?.value;
      const originalRemove = removeDescriptor?.value;
      if (
        typeof originalSet !== "function" ||
        typeof originalRemove !== "function"
      ) {
        throw new Error("Story intent storage methods are unavailable");
      }
      const observer = {
        key: targetKey,
        events: [],
        setDescriptor,
        removeDescriptor,
      };
      observer.setWrapper = function (name, value) {
        if (this === storage && name === observer.key) {
          let record = null;
          try {
            record = JSON.parse(value);
          } catch {}
          observer.events.push({ operation: "setItem", record });
          if (denyWrite) throw new Error("fixture denied Story intent write");
        }
        return originalSet.call(this, name, value);
      };
      observer.removeWrapper = function (name) {
        if (this === storage && name === observer.key) {
          observer.events.push({
            operation: "removeItem",
            current: storage.getItem(name),
          });
          if (denyRemove)
            throw new Error("fixture denied Story intent removal");
        }
        return originalRemove.call(this, name);
      };
      Object.defineProperty(Storage.prototype, "setItem", {
        ...setDescriptor,
        value: observer.setWrapper,
      });
      Object.defineProperty(Storage.prototype, "removeItem", {
        ...removeDescriptor,
        value: observer.removeWrapper,
      });
      window.__storyOutcomeStorageObserver = observer;
    },
    { key, failWrite, failRemove },
  );
}

async function readIntentStorageObserver(page) {
  return page.evaluate(
    () => window.__storyOutcomeStorageObserver?.events ?? [],
  );
}

async function restoreIntentStorageObserver(page) {
  await page
    .evaluate(() => {
      const observer = window.__storyOutcomeStorageObserver;
      if (!observer) return;
      if (
        Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")?.value ===
        observer.setWrapper
      ) {
        Object.defineProperty(
          Storage.prototype,
          "setItem",
          observer.setDescriptor,
        );
      }
      if (
        Object.getOwnPropertyDescriptor(Storage.prototype, "removeItem")
          ?.value === observer.removeWrapper
      ) {
        Object.defineProperty(
          Storage.prototype,
          "removeItem",
          observer.removeDescriptor,
        );
      }
      delete window.__storyOutcomeStorageObserver;
    })
    .catch(() => {});
}

function outcomeRouteController(page, origin) {
  const records = { uploads: [], stories: [] };
  const unexpected = [];
  const failures = [];
  let active = 0;
  const waiters = [];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isUpload =
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/media/upload";
    const isStory =
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/stories";
    if (!isUpload && !isStory) return route.fallback();
    const lane = isUpload ? records.uploads : records.stories;
    if (lane.length > 0) {
      unexpected.push({ method: request.method(), path: url.pathname });
      await route.abort("failed");
      return;
    }
    active += 1;
    try {
      const upstream = await route.fetch({ maxRedirects: 0, timeout: TIMEOUT });
      const bytes = await upstream.body();
      let body = null;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {}
      const record = {
        status: upstream.status(),
        method: request.method(),
        path: url.pathname,
        requestBody: isStory ? request.postDataJSON() : null,
        responseBody: body,
        responseSha256: sha(bytes),
        fulfilledSha256: null,
        responseBytes: bytes.length,
      };
      if (isUpload) {
        const requestBytes = request.postDataBuffer() ?? Buffer.alloc(0);
        record.requestBytes = requestBytes.length;
        record.requestSha256 = sha(requestBytes);
        record.requestContainsPng = requestBytes.includes(PNG);
      }
      lane.push(record);
      need(
        upstream.status() === (isUpload ? 200 : 201),
        `real-worker-${isUpload ? "upload" : "story"}-status`,
        String(upstream.status()),
      );
      if (isStory) {
        need(
          body?.story?.ap_id && body.story.attachment?.r2_key,
          "real-worker-story-response-shape",
        );
        if (requestBodyCheckFailure(record))
          throw new Error("story request did not retain its JSON body");
      }
      await route.fulfill({ response: upstream, body: bytes });
      record.fulfilledSha256 = sha(bytes);
    } catch (error) {
      failures.push(String(error));
      try {
        await route.abort("failed");
      } catch {}
    } finally {
      active -= 1;
      if (active === 0) for (const resolve of waiters.splice(0)) resolve();
    }
  };
  return {
    handler,
    records,
    unexpected,
    failures,
    get counts() {
      return {
        uploads: records.uploads.length,
        stories: records.stories.length,
        unexpected: unexpected.length,
      };
    },
    async waitIdle() {
      if (active === 0) return;
      await bounded(
        new Promise((resolve) => waiters.push(resolve)),
        "outcome routes idle",
      );
    },
    async install() {
      await page.route("**/api/media/upload", handler);
      await page.route("**/api/stories", handler);
    },
    async close() {
      await page.unroute("**/api/stories", handler);
      await page.unroute("**/api/media/upload", handler);
      if (active !== 0)
        await bounded(
          new Promise((resolve) => waiters.push(resolve)),
          "outcome routes idle",
        );
    },
  };
}

function requestBodyCheckFailure(record) {
  return (
    !record.requestBody ||
    typeof record.requestBody.caption !== "string" ||
    !record.requestBody.attachment?.r2_key
  );
}

function assertStrictStoryAck(story, origin, principal, payload) {
  const attachment = story?.attachment;
  const expectedMediaUrl = `/media/${payload.attachment.r2_key.startsWith("uploads/") ? payload.attachment.r2_key.slice(8) : payload.attachment.r2_key}`;
  const published =
    typeof story?.published === "string" ? Date.parse(story.published) : NaN;
  const endTime =
    typeof story?.end_time === "string" ? Date.parse(story.end_time) : NaN;
  need(
    typeof story?.ap_id === "string" &&
      new URL(story.ap_id).origin === origin &&
      /^\/ap\/objects\/[A-Za-z0-9._~-]+$/.test(new URL(story.ap_id).pathname),
    "strict-ack-local-story-id",
  );
  need(story.author?.ap_id === principal, "strict-ack-authenticated-author");
  need(
    attachment?.r2_key === payload.attachment.r2_key &&
      attachment?.url === expectedMediaUrl &&
      attachment?.mediaType === payload.attachment.content_type &&
      attachment?.type ===
        (payload.attachment.content_type.startsWith("video/")
          ? "Video"
          : "Document"),
    "strict-ack-media-reference",
  );
  need(
    (story.caption?.trim() || undefined) ===
      (payload.caption?.trim() || undefined) &&
      story.displayDuration === payload.displayDuration &&
      canonical(story.overlays ?? []) === canonical(payload.overlays ?? []),
    "strict-ack-story-metadata",
  );
  need(
    Number.isFinite(published) &&
      Number.isFinite(endTime) &&
      new Date(published).toISOString() === story.published &&
      new Date(endTime).toISOString() === story.end_time &&
      endTime > published,
    "strict-ack-coherent-times",
  );
}

async function nativeSnapshot(db, actorApId) {
  return {
    stories: await count(
      db,
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
      actorApId,
    ),
    outboundCreates: await count(
      db,
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND direction = 'outbound'",
      actorApId,
    ),
    uploads: await count(
      db,
      "SELECT COUNT(*) AS count FROM media_uploads WHERE uploader_ap_id = ?",
      actorApId,
    ),
  };
}

async function queryStoryEvidence(
  db,
  actorApId,
  storyApId,
  r2Key,
  expectedCaption,
) {
  const object = await db
    .prepare(
      "SELECT ap_id, type, attributed_to, content, attachments_json, end_time, deleted_at FROM objects WHERE ap_id = ? AND type = 'Story' AND attributed_to = ?",
    )
    .bind(storyApId, actorApId)
    .first();
  const activities = await db
    .prepare(
      "SELECT ap_id, type, actor_ap_id, object_ap_id, direction FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId, storyApId)
    .all();
  const uploads = await db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE r2_key = ? AND uploader_ap_id = ?",
    )
    .bind(r2Key, actorApId)
    .all();
  const storyData = object ? JSON.parse(object.attachments_json) : null;
  need(
    object?.ap_id === storyApId &&
      object.type === "Story" &&
      object.attributed_to === actorApId &&
      object.content === "" &&
      object.deleted_at == null,
    "native-story-object-matches-authenticated-actor",
  );
  need(
    storyData?.caption === expectedCaption &&
      storyData.displayDuration === "PT5S" &&
      storyData.attachment?.r2_key === r2Key &&
      storyData.attachment?.content_type === "image/png",
    "native-story-payload-matches-post",
  );
  need(
    activities.results?.length === 1 &&
      activities.results[0].object_ap_id === storyApId &&
      activities.results[0].actor_ap_id === actorApId,
    "native-story-has-one-outbound-create",
  );
  need(
    uploads.results?.length === 1 &&
      uploads.results[0].r2_key === r2Key &&
      uploads.results[0].uploader_ap_id === actorApId &&
      uploads.results[0].content_type === "image/png" &&
      uploads.results[0].size === PNG.length,
    "native-story-media-row-matches-upload",
  );
  return {
    object,
    storyData,
    outboundCreate: activities.results[0],
    mediaUpload: uploads.results[0],
  };
}

async function freshAuthenticatedTimeline(context, origin) {
  const page = await context.newPage();
  await page.goto(`${origin}/?tab=timeline`, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT,
  });
  await page
    .locator(".yc-story-add")
    .waitFor({ state: "visible", timeout: TIMEOUT });
  return page;
}

async function freshComposer(page, caption, filename) {
  await page.locator(".yc-story-add").click();
  const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  const input = dialog.locator('input[type="file"]');
  await input.setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByPlaceholder("キャプション").fill(caption);
  return { dialog, input, submit: dialog.locator('button[type="submit"]') };
}

async function captureUploadNative(db, bucket, actorApId, uploadRecord) {
  need(
    uploadRecord?.status === 200 && uploadRecord.responseBody?.r2_key,
    "native-upload-reference-required",
  );
  const key = uploadRecord.responseBody.r2_key;
  const row = await db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE r2_key = ? AND uploader_ap_id = ?",
    )
    .bind(key, actorApId)
    .first();
  const object = await bucket.get(key);
  const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
  need(
    uploadRecord.requestContainsPng &&
      row?.content_type === "image/png" &&
      row.size === PNG.length &&
      bytes &&
      sha(bytes) === sha(PNG),
    "native-upload-d1-r2-readback",
  );
  return {
    row,
    requestBytes: uploadRecord.requestBytes,
    requestSha256: uploadRecord.requestSha256,
    responseSha256: uploadRecord.responseSha256,
    fulfilledSha256: uploadRecord.fulfilledSha256,
    r2Bytes: { size: bytes.length, sha256: sha(bytes) },
  };
}

export async function qualifyStoryOutcomeConfirmed({
  context,
  db,
  bucket,
  origin,
  actorApId,
  checks,
}) {
  need(
    context && db && bucket && Array.isArray(checks),
    "confirmed-context-native-d1-r2-checks-required",
  );
  const startIdentity = await identityCounts(db);
  const startOwner = await ownerSession(db, actorApId);
  const startCookie = (await context.cookies(origin)).find(
    (cookie) => cookie.name === "session",
  )?.value;
  need(
    startIdentity.actors > 0 &&
      startIdentity.sessions > 0 &&
      startOwner?.role === "owner" &&
      startOwner.deleted_at == null &&
      startOwner.sessions === 1 &&
      startCookie,
    "confirmed-authenticated-owner-session-required",
  );
  const runSuccessfulConfirmation = async ({ failRemove = false } = {}) => {
    const page = await freshAuthenticatedTimeline(context, origin);
    const key = storyIntentKey(origin, actorApId);
    const caption = `Confirmed Story ${randomUUID()}`;
    const before = await nativeSnapshot(db, actorApId);
    const observer = installIntentStorageObserver(page, key, { failRemove });
    const routes = outcomeRouteController(page, new URL(origin).origin);
    try {
      await observer;
      await routes.install();
      const { dialog, submit } = await freshComposer(
        page,
        caption,
        `confirmed-${failRemove ? "remove-fails" : "remove-succeeds"}.png`,
      );
      const refreshPromise = failRemove
        ? null
        : page.waitForResponse(
            (response) =>
              new URL(response.url()).origin === origin &&
              new URL(response.url()).pathname === "/api/stories" &&
              response.request().method() === "GET",
            { timeout: TIMEOUT },
          );
      refreshPromise?.catch(() => {});
      await submit.click();
      await bounded(
        (async () => {
          while (routes.counts.stories === 0 && routes.failures.length === 0)
            await page.waitForTimeout(10);
        })(),
        "confirmed-story-response-observed",
      );
      await routes.waitIdle();
      need(
        routes.counts.uploads === 1 &&
          routes.counts.stories === 1 &&
          !routes.unexpected.length &&
          !routes.failures.length,
        "confirmed-exactly-one-real-upload-and-story-request",
      );
      const upload = routes.records.uploads[0];
      const storyRecord = routes.records.stories[0];
      const payload = storyRecord.requestBody;
      assertStrictStoryAck(
        storyRecord.responseBody?.story,
        origin,
        actorApId,
        payload,
      );
      const evidence = await queryStoryEvidence(
        db,
        actorApId,
        storyRecord.responseBody.story.ap_id,
        payload.attachment.r2_key,
        caption,
      );
      const uploadNative = await captureUploadNative(
        db,
        bucket,
        actorApId,
        upload,
      );
      const after = await nativeSnapshot(db, actorApId);
      need(
        after.stories === before.stories + 1 &&
          after.outboundCreates === before.outboundCreates + 1 &&
          after.uploads === before.uploads + 1,
        "confirmed-native-story-create-upload-delta",
      );
      if (failRemove) {
        await page
          .getByText("ストーリーは保存されました", { exact: true })
          .waitFor({ state: "visible", timeout: TIMEOUT });
      } else {
        await dialog.waitFor({ state: "hidden", timeout: TIMEOUT });
      }
      const events = await readIntentStorageObserver(page);
      const confirmedIndex = events.findIndex(
        (event) =>
          event.operation === "setItem" &&
          event.record?.status === "confirmed" &&
          event.record.storyId === storyRecord.responseBody.story.ap_id,
      );
      const removeIndex = events.findIndex(
        (event) => event.operation === "removeItem",
      );
      need(
        events.some(
          (event) =>
            event.operation === "setItem" && event.record?.status === "ready",
        ) &&
          events.some(
            (event) =>
              event.operation === "setItem" &&
              event.record?.status === "pending",
          ),
        "confirmed-journal-ready-and-pending-saved",
      );
      need(
        confirmedIndex >= 0 && removeIndex > confirmedIndex,
        "confirmed-record-saved-before-remove-attempt",
      );
      const rawAfterSubmit = await page.evaluate(
        (intentKey) => sessionStorage.getItem(intentKey),
        key,
      );

      if (!failRemove) {
        await dialog.waitFor({ state: "hidden", timeout: TIMEOUT });
        const refresh = await refreshPromise;
        need(
          refresh.status() === 200 && rawAfterSubmit === null,
          "confirmed-success-closes-clears-journal-and-refreshes-story-list",
        );
        return {
          caption,
          storyStatus: storyRecord.status,
          storyResponseSha256: storyRecord.responseSha256,
          storyFulfilledSha256: storyRecord.fulfilledSha256,
          strictAck: true,
          journalEvents: events,
          native: evidence,
          uploadNative,
          nativeCounts: { before, after },
          refreshStatus: refresh.status(),
          dialogClosed: true,
          journalRemoved: true,
          routeCounts: routes.counts,
        };
      }

      // A received strict ACK is conclusive, but failed storage cleanup keeps
      // the recovered item open and disables retry across reload.
      need(
        await dialog.isVisible(),
        "confirmed-remove-failure-keeps-recovery-dialog-open",
      );
      await page
        .getByText("ストーリーは保存されました", { exact: true })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      need(
        rawAfterSubmit !== null &&
          JSON.parse(rawAfterSubmit)?.status === "confirmed" &&
          JSON.parse(rawAfterSubmit)?.storyId ===
            storyRecord.responseBody.story.ap_id,
        "remove-failure-retains-confirmed-record",
      );
      need(
        (await page
          .getByRole("button", {
            name: "重複の可能性を理解して再投稿",
            exact: true,
          })
          .count()) === 0,
        "confirmed-remove-failure-hides-retry",
      );
      await page.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT });
      const routesCountBeforeOpen = routes.counts.stories;
      await page.locator(".yc-story-add").click({ timeout: TIMEOUT });
      const restored = page.getByRole("dialog", { name: "ストーリー作成" });
      await restored.waitFor({ state: "visible", timeout: TIMEOUT });
      await page
        .getByText("ストーリーは保存されました", { exact: true })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      await page.waitForTimeout(300);
      const afterReloadRaw = await page.evaluate(
        (intentKey) => sessionStorage.getItem(intentKey),
        key,
      );
      need(
        routes.counts.stories === routesCountBeforeOpen &&
          routes.counts.stories === 1 &&
          JSON.parse(afterReloadRaw)?.status === "confirmed" &&
          JSON.parse(afterReloadRaw)?.storyId ===
            storyRecord.responseBody.story.ap_id,
        "confirmed-reloaded-without-resend",
      );
      need(
        (await page
          .getByRole("button", {
            name: "重複の可能性を理解して再投稿",
            exact: true,
          })
          .count()) === 0 &&
          (await restored.locator('input[type="file"]').isDisabled()),
        "confirmed-reload-remains-locked",
      );
      return {
        caption,
        storyStatus: storyRecord.status,
        storyResponseSha256: storyRecord.responseSha256,
        storyFulfilledSha256: storyRecord.fulfilledSha256,
        strictAck: true,
        journalEvents: events,
        native: evidence,
        uploadNative,
        nativeCounts: { before, after },
        confirmedRawAfterSubmit: JSON.parse(rawAfterSubmit),
        confirmedRawAfterReload: JSON.parse(afterReloadRaw),
        dialogClosed: false,
        lockedAfterReload: true,
        noResendAfterReload: true,
        routeCounts: routes.counts,
      };
    } finally {
      await restoreIntentStorageObserver(page);
      await routes.close();
      await page.close();
    }
  };

  const runStorageWriteFailure = async () => {
    const page = await freshAuthenticatedTimeline(context, origin);
    const key = storyIntentKey(origin, actorApId);
    const caption = `Story storage write failure ${randomUUID()}`;
    const before = await nativeSnapshot(db, actorApId);
    const observer = installIntentStorageObserver(page, key, {
      failWrite: true,
    });
    const routes = outcomeRouteController(page, new URL(origin).origin);
    try {
      await observer;
      await routes.install();
      const { dialog, submit } = await freshComposer(
        page,
        caption,
        "storage-write-failure.png",
      );
      await submit.click();
      await bounded(
        (async () => {
          while (routes.counts.uploads === 0 && routes.failures.length === 0)
            await page.waitForTimeout(10);
        })(),
        "storage-failure-upload-observed",
      );
      await page
        .getByText("このタブの保存を確認できません", { exact: false })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      await routes.waitIdle();
      const after = await nativeSnapshot(db, actorApId);
      const upload = routes.records.uploads[0];
      const uploadNative = await captureUploadNative(
        db,
        bucket,
        actorApId,
        upload,
      );
      const events = await readIntentStorageObserver(page);
      need(
        routes.counts.uploads === 1 &&
          routes.counts.stories === 0 &&
          !routes.unexpected.length,
        "storage-write-failure-blocks-story-post",
      );
      need(
        after.stories === before.stories &&
          after.outboundCreates === before.outboundCreates &&
          after.uploads === before.uploads + 1,
        "storage-write-failure-no-native-story-or-create",
      );
      need(
        events.some(
          (event) =>
            event.operation === "setItem" && event.record?.status === "ready",
        ),
        "storage-write-failure-observed-stage-record",
      );
      need(
        (await dialog.locator('input[type="file"]').isDisabled()) &&
          (await dialog.getByPlaceholder("キャプション").isDisabled()),
        "storage-write-failure-keeps-editor-blocked",
      );
      const raw = await page.evaluate(
        (intentKey) => sessionStorage.getItem(intentKey),
        key,
      );
      need(
        raw === null,
        "storage-write-failure-did-not-create-a-corrupt-partial-record",
      );
      return {
        caption,
        before,
        after,
        routeCounts: routes.counts,
        events,
        rawAfterFailure: raw,
        uploadNative,
      };
    } finally {
      await restoreIntentStorageObserver(page);
      await routes.close();
      await page.close();
    }
  };

  const runCorruptPreservation = async () => {
    const page = await freshAuthenticatedTimeline(context, origin);
    const key = storyIntentKey(origin, actorApId);
    const corrupt = "{not-json";
    const before = await nativeSnapshot(db, actorApId);
    await page.evaluate(
      ({ key: intentKey, raw }) => sessionStorage.setItem(intentKey, raw),
      { key, raw: corrupt },
    );
    const routes = outcomeRouteController(page, new URL(origin).origin);
    try {
      await routes.install();
      await page.locator(".yc-story-add").click();
      const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
      await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
      await page
        .getByText("このタブの保存を確認できません", { exact: false })
        .waitFor({ state: "visible", timeout: TIMEOUT });
      await page.waitForTimeout(250);
      const rawAfter = await page.evaluate(
        (intentKey) => sessionStorage.getItem(intentKey),
        key,
      );
      const after = await nativeSnapshot(db, actorApId);
      need(rawAfter === corrupt, "corrupt-intent-bytes-preserved-exactly");
      need(
        routes.counts.uploads === 0 &&
          routes.counts.stories === 0 &&
          !routes.unexpected.length,
        "corrupt-intent-blocks-upload-and-story-post",
      );
      need(
        canonical(before) === canonical(after),
        "corrupt-intent-no-native-story-create-or-upload",
      );
      need(
        await dialog.locator('input[type="file"]').isDisabled(),
        "corrupt-intent-editor-remains-blocked",
      );
      return {
        key,
        rawBefore: corrupt,
        rawAfter,
        before,
        after,
        routeCounts: routes.counts,
      };
    } finally {
      await routes.close();
      await page.close();
    }
  };

  const normal = await runSuccessfulConfirmation();
  const writeFailure = await runStorageWriteFailure();
  const corruptPreservation = await runCorruptPreservation();
  const removeFailure = await runSuccessfulConfirmation({ failRemove: true });
  const endIdentity = await identityCounts(db);
  const endOwner = await ownerSession(db, actorApId);
  const endCookie = (await context.cookies(origin)).find(
    (cookie) => cookie.name === "session",
  )?.value;
  need(
    canonical(startIdentity) === canonical(endIdentity) &&
      endOwner?.ap_id === actorApId &&
      endOwner.role === "owner" &&
      endOwner.deleted_at == null &&
      endOwner.sessions === 1 &&
      endCookie === startCookie,
    "confirmed-cases-preserve-full-actor-session-identity",
  );
  checks.push(
    "story-outcome-confirmed-real-201-strict-ack-journal-before-remove-close-refresh",
    "story-outcome-confirmed-remove-failure-locked-after-reload-no-resend",
    "story-outcome-storage-write-failure-blocks-story-post-after-upload",
    "story-outcome-corrupt-intent-preserved-no-upload-or-story-post",
  );
  return {
    result: "PASSED",
    identityBefore: { counts: startIdentity, authenticatedActor: startOwner },
    identityAfter: { counts: endIdentity, authenticatedActor: endOwner },
    sameSessionCookie: true,
    normal,
    writeFailure,
    corruptPreservation,
    removeFailure,
  };
}
