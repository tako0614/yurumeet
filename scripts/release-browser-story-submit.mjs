// Real-browser qualification for Yurumeet StoryComposer submission snapshots.
// Worker responses and multipart uploads reach the local Worker; only response
// delivery is held. No browser-side API call is used to create the story.

import { createHash } from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new Error(`story-submit ${message}`);
}

function deferred(label) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, label };
}

async function bounded(promise, label, timeoutMs = 20_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`story-submit ${label} timeout`)),
      timeoutMs,
    );
  });
  timeout.catch(() => {});
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function counts(db) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();
}

async function storyCount(db, actorApId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM objects WHERE type = 'Story' AND attributed_to = ? AND deleted_at IS NULL",
    )
    .bind(actorApId)
    .first();
  return row?.count ?? 0;
}

async function storyCreateCount(db, actorApId) {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id IN (SELECT ap_id FROM objects WHERE type = 'Story' AND attributed_to = ?) AND direction = 'outbound'",
    )
    .bind(actorApId, actorApId)
    .first();
  return row?.count ?? 0;
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
  const uploads = await db
    .prepare(
      "SELECT id, r2_key, uploader_ap_id, content_type, size FROM media_uploads WHERE r2_key = ? AND uploader_ap_id = ?",
    )
    .bind(r2Key, actorApId)
    .all();
  const activities = await db
    .prepare(
      "SELECT ap_id, type, actor_ap_id, object_ap_id, direction FROM activities WHERE type = 'Create' AND actor_ap_id = ? AND object_ap_id = ? AND direction = 'outbound'",
    )
    .bind(actorApId, storyApId)
    .all();
  const storyData = object ? JSON.parse(object.attachments_json) : null;
  assert(
    object?.ap_id === storyApId &&
      object.content === "" &&
      object.deleted_at === null,
    `native Story object missing or malformed: ${JSON.stringify(object)}`,
  );
  assert(
    storyData?.caption === expectedCaption &&
      storyData.displayDuration === "PT5S" &&
      storyData.attachment?.r2_key === r2Key &&
      storyData.attachment?.content_type === "image/png",
    `native Story payload mismatched: ${JSON.stringify(storyData)}`,
  );
  assert(
    uploads.results?.length === 1 &&
      uploads.results[0].r2_key === r2Key &&
      uploads.results[0].content_type === "image/png" &&
      uploads.results[0].size > 0,
    `native media_uploads row mismatch: ${JSON.stringify(uploads.results)}`,
  );
  assert(
    activities.results?.length === 1 &&
      activities.results[0].object_ap_id === storyApId,
    `native outbound Create count was not exactly one: ${JSON.stringify(activities.results)}`,
  );
  return {
    object,
    storyData,
    mediaUpload: uploads.results[0],
    outboundCreate: activities.results[0],
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

function routeController(page, origin) {
  let uploadReady = deferred("real upload response");
  let uploadAborted = deferred("upload aborted before forwarding");
  let uploadRelease = deferred("upload response release");
  let storyReady = deferred("real story response");
  let storyRelease = deferred("story response release");
  const records = [];
  const unexpected = [];
  let uploadCount = 0;
  let storyCount = 0;
  let active = 0;
  let idleWaiters = [];
  let error = null;
  const abortedRequests = [];
  let holdUpload = true;
  let holdStory = false;
  let abortUploadNumber = null;
  let maxUploads = 1;
  let maxStories = 1;
  const settle = () => {
    active -= 1;
    if (active === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters = [];
    }
  };
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const upload =
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/media/upload";
    const story =
      request.method() === "POST" &&
      url.origin === origin &&
      url.pathname === "/api/stories";
    if (!upload && !story) return route.fallback();
    if (upload) {
      uploadCount += 1;
      if (uploadCount > maxUploads) {
        unexpected.push({ method: request.method(), url: url.href });
        return route.abort("failed");
      }
    } else {
      storyCount += 1;
      let body;
      try {
        body = request.postDataJSON();
      } catch {
        body = null;
      }
      if (storyCount > maxStories) {
        unexpected.push({ method: request.method(), url: url.href, body });
        return route.abort("failed");
      }
      if (!body?.attachment?.r2_key || typeof body.caption !== "string") {
        unexpected.push({ method: request.method(), url: url.href, body });
        return route.abort("failed");
      }
    }
    active += 1;
    try {
      if (upload && abortUploadNumber === uploadCount) {
        abortUploadNumber = null;
        await route.abort("failed");
        records.push({
          method: "POST",
          url: url.href,
          abortedBeforeForward: true,
        });
        abortedRequests.push({
          method: "POST",
          url: url.href,
          abortedBeforeForward: true,
        });
        uploadAborted.resolve({ abortedBeforeForward: true, url: url.href });
        return;
      }
      const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
      const bytes = await response.body();
      const record = {
        method: request.method(),
        url: url.href,
        status: response.status(),
        requestBody: story ? request.postDataJSON() : null,
        rawBodySha256: sha256(bytes),
        fulfilledBodySha256: null,
        body: JSON.parse(bytes.toString("utf8")),
      };
      records.push(record);
      if (upload && holdUpload) {
        uploadReady.resolve(record);
        await bounded(uploadRelease.promise, "upload release", 60_000);
      } else if (story && holdStory) {
        storyReady.resolve(record);
        await bounded(storyRelease.promise, "story release", 60_000);
      }
      await route.fulfill({ response, body: bytes });
      record.fulfilledBodySha256 = sha256(bytes);
      if (upload) uploadReady.resolve(record);
      if (story) storyReady.resolve(record);
    } catch (cause) {
      error = cause;
      uploadReady.reject(cause);
      storyReady.reject(cause);
      try {
        await route.abort("failed");
      } catch {}
    } finally {
      settle();
    }
  };
  return {
    handler,
    records,
    unexpected,
    abortedRequests,
    get error() {
      return error;
    },
    get counts() {
      return {
        uploads: uploadCount,
        stories: storyCount,
        records: records.length,
      };
    },
    get upload() {
      return bounded(uploadReady.promise, "upload response", 20_000);
    },
    get abortedUpload() {
      return bounded(uploadAborted.promise, "upload abort", 20_000);
    },
    get story() {
      return bounded(storyReady.promise, "story response", 20_000);
    },
    configure({
      holdUpload: nextUpload = false,
      holdStory: nextStory = false,
      abortUpload = false,
      uploads = 1,
      stories = 1,
      resetSignals = false,
    } = {}) {
      holdUpload = nextUpload;
      holdStory = nextStory;
      abortUploadNumber = abortUpload ? uploadCount + 1 : null;
      maxUploads = uploads;
      maxStories = stories;
      if (resetSignals) {
        uploadReady = deferred("real upload response");
        uploadAborted = deferred("upload aborted before forwarding");
        uploadRelease = deferred("upload response release");
        storyReady = deferred("real story response");
        storyRelease = deferred("story response release");
      }
    },
    releaseUpload() {
      uploadRelease.resolve();
    },
    releaseStory() {
      storyRelease.resolve();
    },
    async waitIdle() {
      if (active === 0) return;
      await bounded(
        new Promise((resolve) => idleWaiters.push(resolve)),
        "routes idle",
      );
    },
  };
}

async function installRoutes(page, routes) {
  await page.route("**/api/media/upload", routes.handler);
  await page.route("**/api/stories", routes.handler);
}

async function removeRoutes(page, routes) {
  routes.releaseUpload();
  routes.releaseStory();
  await page.unroute("**/api/stories", routes.handler);
  await page.unroute("**/api/media/upload", routes.handler);
  await routes.waitIdle();
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
  "base64",
);

async function prepareStoryComposer(page, caption, filename) {
  await page
    .locator(".yc-story-add")
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".yc-story-add").click();
  const dialog = page.getByRole("dialog", { name: "ストーリー作成" });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const fileInput = dialog.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: filename,
    mimeType: "image/png",
    buffer: PNG,
  });
  await dialog.getByPlaceholder("キャプション").fill(caption);
  const submit = dialog.locator('button[type="submit"]');
  await submit.focus();
  return {
    dialog,
    fileInput,
    submit,
    beforeSubmitFocus: await page.evaluate(
      () => document.activeElement?.outerHTML ?? null,
    ),
  };
}

async function runBaseline({ page, db, origin, actorApId, routes, checks }) {
  const captionA = `Story caption A ${crypto.randomUUID()}`;
  const captionB = `Story caption B ${crypto.randomUUID()}`;
  const { dialog, submit: submitButton } = await prepareStoryComposer(
    page,
    captionA,
    "baseline-story.png",
  );
  routes.configure({ holdUpload: true, uploads: 1, stories: 1 });
  const responseWait = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  responseWait.catch(() => {});
  const storyRefreshPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/stories" &&
      response.request().method() === "GET",
    { timeout: 20_000 },
  );
  storyRefreshPromise.catch(() => {});
  await submitButton.click();
  const upload = await routes.upload;
  const beforeReleaseCaption = await dialog
    .getByPlaceholder("キャプション")
    .inputValue();
  await dialog.getByPlaceholder("キャプション").fill(captionB);
  routes.releaseUpload();
  const uploadPageResponse = await responseWait;
  const story = await routes.story;
  await dialog.waitFor({ state: "hidden", timeout: 20_000 });
  const storyRefresh = await storyRefreshPromise;
  const native = await queryStoryEvidence(
    db,
    actorApId,
    story.body.story.ap_id,
    story.body.story.attachment.r2_key,
    captionB,
  );
  assert(
    story.status === 201 &&
      storyRefresh.status() === 200 &&
      upload.status === 200 &&
      beforeReleaseCaption === captionA &&
      story.requestBody.caption === captionB &&
      upload.rawBodySha256 === upload.fulfilledBodySha256 &&
      story.rawBodySha256 === story.fulfilledBodySha256 &&
      routes.counts.uploads === 1 &&
      routes.counts.stories === 1 &&
      routes.error === null &&
      routes.unexpected.length === 0,
    `baseline race evidence mismatch: ${JSON.stringify({ upload, story, beforeReleaseCaption, native })}`,
  );
  checks.push(
    "baseline-upload-response-held-real-bytes",
    "baseline-story-post-used-post-upload-caption-B",
    "baseline-native-story-and-create-caption-B",
  );
  return {
    result: "EXPECTED_BASELINE_RED",
    mode: "baseline",
    race: {
      captionA,
      captionB,
      upload: {
        status: upload.status,
        rawBodySha256: upload.rawBodySha256,
        fulfilledBodySha256: upload.fulfilledBodySha256,
      },
      uploadPageResponse: uploadPageResponse.status(),
      story: {
        status: story.status,
        requestBody: story.requestBody,
        response: story.body,
        rawBodySha256: story.rawBodySha256,
        fulfilledBodySha256: story.fulfilledBodySha256,
      },
      native,
    },
    routeCounts: routes.counts,
    storyRefreshStatus: storyRefresh.status(),
  };
}

async function runCandidate({
  page,
  db,
  origin,
  actorApId,
  routes,
  checks,
  bucket,
}) {
  const caption = `Story candidate ${crypto.randomUUID()}`;
  const filename = "candidate-story.png";
  const {
    dialog,
    fileInput,
    submit: submitButton,
  } = await prepareStoryComposer(page, caption, filename);
  const focusedBeforeSubmit = await page.evaluate(
    () => document.activeElement?.outerHTML ?? null,
  );
  routes.configure({
    holdUpload: true,
    holdStory: true,
    uploads: 1,
    stories: 1,
  });
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  uploadResponsePromise.catch(() => {});
  await submitButton.click();
  const upload = await routes.upload;
  const busyState = {
    submitDisabled: await submitButton.isDisabled(),
    focusedVisibleStatus: await dialog
      .getByRole("status")
      .isVisible()
      .catch(() => false),
    statusText: await dialog
      .getByRole("status")
      .textContent()
      .catch(() => null),
    statusOutsideBusyRegion: await dialog.evaluate((root) => {
      const status = root.querySelector('[role="status"]');
      return Boolean(status && !status.closest('[aria-busy="true"]'));
    }),
    focusedStatus: await dialog.evaluate(
      () => document.activeElement?.getAttribute("role") === "status",
    ),
  };
  const fileInputDisabled = await fileInput.isDisabled();
  const captionDisabled = await dialog
    .getByPlaceholder("キャプション")
    .isDisabled();
  const closeButton = dialog.getByRole("button", { name: "閉じる" }).last();
  const dismissButton = dialog.locator(".p-story-composer-dismiss");
  const closeDisabled = await closeButton.isDisabled();
  const dismissDisabled = await dismissButton.isDisabled();
  const captionBefore = await dialog
    .getByPlaceholder("キャプション")
    .inputValue();
  let disabledCaptionFillRejected = false;
  let captionAfterAttempt = captionBefore;
  try {
    await dialog
      .getByPlaceholder("キャプション")
      .fill(`${caption} changed`, { timeout: 1_000 });
  } catch {
    disabledCaptionFillRejected = true;
    captionAfterAttempt = await dialog
      .getByPlaceholder("キャプション")
      .inputValue();
  }
  const fileDisplayedName = await dialog
    .locator(".p-story-file span")
    .textContent();
  if (!closeDisabled) await closeButton.click();
  if (!dismissDisabled) await dismissButton.click();
  const dialogRemainedOpen = await dialog.isVisible();
  await page.keyboard.press("Escape");
  const remainedOpenAfterEscape = await dialog.isVisible();
  await page.keyboard.press("Tab");
  const tabInside = await dialog.evaluate((root) =>
    root.contains(document.activeElement),
  );
  await page.keyboard.press("Shift+Tab");
  const shiftTabInside = await dialog.evaluate((root) =>
    root.contains(document.activeElement),
  );
  const storyPageResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/stories" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  storyPageResponsePromise.catch(() => {});
  const storyRefreshPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/stories" &&
      response.request().method() === "GET",
    { timeout: 20_000 },
  );
  storyRefreshPromise.catch(() => {});
  routes.releaseUpload();
  const uploadPageResponse = await uploadResponsePromise;
  const story = await routes.story;
  const storyAckBusy = {
    submitDisabled: await submitButton.isDisabled(),
    visibleStatus: await dialog
      .getByRole("status")
      .isVisible()
      .catch(() => false),
    focusedStatus: await dialog.evaluate(
      () => document.activeElement?.getAttribute("role") === "status",
    ),
  };
  routes.releaseStory();
  const storyPageResponse = await storyPageResponsePromise;
  await routes.waitIdle();
  const response = story.body;
  await dialog.waitFor({ state: "hidden", timeout: 20_000 });
  const storyRefresh = await storyRefreshPromise;
  const native = await queryStoryEvidence(
    db,
    actorApId,
    response.story.ap_id,
    response.story.attachment.r2_key,
    caption,
  );
  const media = await bucket.get(response.story.attachment.r2_key);
  const storedBytes = media ? new Uint8Array(await media.arrayBuffer()) : null;
  assert(
    upload.status === 200 &&
      uploadPageResponse.status() === 200 &&
      story.status === 201 &&
      story.requestBody.caption === caption &&
      story.requestBody.attachment.content_type === "image/png" &&
      story.requestBody.displayDuration === "PT5S" &&
      captionBefore === caption &&
      captionAfterAttempt === caption &&
      busyState.submitDisabled &&
      busyState.focusedVisibleStatus &&
      busyState.statusText === "ストーリーを投稿しています" &&
      busyState.focusedStatus &&
      busyState.statusOutsideBusyRegion &&
      tabInside &&
      shiftTabInside &&
      storyAckBusy.submitDisabled &&
      storyAckBusy.visibleStatus &&
      storyAckBusy.focusedStatus &&
      storyPageResponse.status() === 201 &&
      storyRefresh.status() === 200 &&
      fileInputDisabled &&
      captionDisabled &&
      disabledCaptionFillRejected &&
      closeDisabled &&
      dismissDisabled &&
      fileDisplayedName === filename &&
      dialogRemainedOpen &&
      remainedOpenAfterEscape &&
      upload.rawBodySha256 === upload.fulfilledBodySha256 &&
      story.rawBodySha256 === story.fulfilledBodySha256 &&
      storedBytes &&
      sha256(storedBytes) === sha256(PNG) &&
      native.mediaUpload.size === PNG.length &&
      routes.error === null &&
      routes.unexpected.length === 0,
    `candidate click-time snapshot or stored media mismatch: ${JSON.stringify({ busyState, fileInputDisabled, captionDisabled, disabledCaptionFillRejected, captionBefore, captionAfterAttempt, tabInside, shiftTabInside, upload, story, storedHash: storedBytes && sha256(storedBytes), originalHash: sha256(PNG), native })}`,
  );
  checks.push(
    "candidate-upload-busy-state-and-focus",
    "candidate-story-ack-busy-state-and-focus",
    "candidate-dialog-close-dismiss-escape-guarded",
    "candidate-dialog-keyboard-focus-contained",
    "candidate-exact-click-time-story-payload",
    "candidate-native-story-media-create-once",
    "candidate-r2-bytes-match-selected-file",
  );
  return {
    result: "green",
    mode: "candidate",
    story: response.story,
    storyRequestBody: story.requestBody,
    native,
    upload: {
      status: upload.status,
      rawBodySha256: upload.rawBodySha256,
      fulfilledBodySha256: upload.fulfilledBodySha256,
    },
    storyAckBusy,
    storyPageResponseStatus: storyPageResponse.status(),
    storyRefreshStatus: storyRefresh.status(),
    storedMedia: { size: storedBytes.length, sha256: sha256(storedBytes) },
    busyState,
    fileInputDisabled,
    captionDisabled,
    focusedBeforeSubmit,
    routeCounts: routes.counts,
  };
}

async function runAbortRetry({ page, db, origin, actorApId, routes, checks }) {
  const caption = `Story retry ${crypto.randomUUID()}`;
  const filename = "retry-story.png";
  const {
    dialog,
    fileInput,
    submit: submitButton,
  } = await prepareStoryComposer(page, caption, filename);
  const originalFocus = await page.evaluate(
    () => document.activeElement?.outerHTML ?? null,
  );
  routes.configure({
    abortUpload: true,
    uploads: routes.counts.uploads + 2,
    stories: routes.counts.stories,
  });
  const before = await counts(db);
  const storyCountBefore = await storyCount(db, actorApId);
  const storyCreateCountBefore = await storyCreateCount(db, actorApId);
  await submitButton.click();
  const abortEvidence = await routes.abortedUpload;
  await dialog
    .getByText("ストーリーの作成に失敗しました", { exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  const preserved = {
    caption: await dialog.getByPlaceholder("キャプション").inputValue(),
    file: await fileInput.evaluate((input) => ({
      name: input.files?.[0]?.name,
      type: input.files?.[0]?.type,
      size: input.files?.[0]?.size,
    })),
    focusRestored: await submitButton.evaluate(
      (element) => element === document.activeElement,
    ),
    mountedAndOpen: await dialog.isVisible(),
    submitEnabled: !(await submitButton.isDisabled()),
    fileEnabled: !(await fileInput.isDisabled()),
    captionEnabled: await dialog.getByPlaceholder("キャプション").isEnabled(),
    counts: await counts(db),
  };
  const retryStoryResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/stories" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  retryStoryResponsePromise.catch(() => {});
  const storyRows = await storyCount(db, actorApId);
  const createRows = await storyCreateCount(db, actorApId);
  assert(
    preserved.caption === caption &&
      preserved.file.name === filename &&
      preserved.file.type === "image/png" &&
      preserved.mountedAndOpen &&
      preserved.submitEnabled &&
      preserved.fileEnabled &&
      preserved.captionEnabled &&
      preserved.focusRestored &&
      JSON.stringify(before) === JSON.stringify(preserved.counts) &&
      storyRows === storyCountBefore &&
      createRows === storyCreateCountBefore,
    `upload abort changed durable story state or discarded draft: ${JSON.stringify({ before, preserved, storyRows, createRows })}`,
  );
  const storyCountBeforeRetry = routes.counts.stories;
  routes.configure({
    uploads: routes.counts.uploads + 1,
    stories: storyCountBeforeRetry + 1,
    resetSignals: true,
  });
  const uploadWait = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/media/upload" &&
      response.request().method() === "POST",
    { timeout: 20_000 },
  );
  uploadWait.catch(() => {});
  const storyRefreshPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/stories" &&
      response.request().method() === "GET",
    { timeout: 20_000 },
  );
  storyRefreshPromise.catch(() => {});
  await submitButton.click();
  const uploadResponse2 = await uploadWait;
  const upload = await routes.upload;
  const response = await routes.story;
  const retryStoryPageResponse = await retryStoryResponsePromise;
  await dialog.waitFor({ state: "hidden", timeout: 20_000 });
  const storyRefresh = await storyRefreshPromise;
  const native = await queryStoryEvidence(
    db,
    actorApId,
    response.body.story.ap_id,
    response.body.story.attachment.r2_key,
    caption,
  );
  assert(
    upload.status === 200 &&
      uploadResponse2.status() === 200 &&
      response.status === 201 &&
      retryStoryPageResponse.status() === 201 &&
      storyRefresh.status() === 200 &&
      routes.counts.uploads === 3 &&
      routes.counts.stories === storyCountBeforeRetry + 1 &&
      (await storyCreateCount(db, actorApId)) === storyCreateCountBefore + 1 &&
      routes.error === null &&
      routes.unexpected.length === 0,
    `explicit retry did not create exactly one story: ${JSON.stringify({ upload, response, counts: routes.counts })}`,
  );
  checks.push(
    "abort-before-forward-created-no-story-or-create",
    "abort-preserved-file-caption-focus-and-retry",
    "explicit-retry-created-one-coherent-story",
  );
  return {
    result: "green",
    retry: {
      caption,
      filename,
      originalFocus,
      abortEvidence,
      preserved,
      uploadStatus: upload.status,
      storyStatus: response.status,
      story: response.body.story,
      native,
      routeCounts: routes.counts,
    },
  };
}

export async function qualifyStorySubmit({
  page,
  context,
  db,
  bucket,
  origin,
  actorApId,
  mode = "candidate",
  checks,
}) {
  assert(
    page && context && db && bucket && Array.isArray(checks),
    "page/context/native D1/R2/checks required",
  );
  assert(
    mode === "baseline" || mode === "candidate",
    "mode must be baseline or candidate",
  );
  const owner = await ownerSession(db, actorApId);
  assert(
    owner?.role === "owner" &&
      owner.deleted_at === null &&
      owner.sessions === 1,
    `pre-existing owner session required: ${JSON.stringify(owner)}`,
  );
  const cookiesBefore = await context.cookies(origin);
  const session = cookiesBefore.find((cookie) => cookie.name === "session");
  assert(session?.value, "authenticated owner cookie required");
  const before = await counts(db);
  const initialStoryCount = await storyCount(db, actorApId);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
  await page
    .locator(".yc-story-add")
    .waitFor({ state: "visible", timeout: 20_000 });
  const afterReload = await counts(db);
  assert(
    JSON.stringify(before) === JSON.stringify(afterReload),
    "reload seeded extra identity/session rows",
  );
  const routes = routeController(page, new URL(origin).origin);
  const checksStart = checks.length;
  let primaryError;
  try {
    await installRoutes(page, routes);
    if (mode === "baseline")
      return await runBaseline({ page, db, origin, actorApId, routes, checks });
    const candidate = await runCandidate({
      page,
      db,
      origin,
      actorApId,
      routes,
      checks,
      bucket,
    });
    const retry = await runAbortRetry({
      page,
      db,
      origin,
      actorApId,
      routes,
      checks,
    });
    const finalCounts = await counts(db);
    const finalStoryCount = await storyCount(db, actorApId);
    const finalOwner = await ownerSession(db, actorApId);
    const cookiesAfter = await context.cookies(origin);
    const sessionAfter = cookiesAfter.find(
      (cookie) => cookie.name === "session",
    );
    assert(
      JSON.stringify(before) === JSON.stringify(finalCounts) &&
        finalOwner?.sessions === 1 &&
        finalStoryCount === initialStoryCount + 2,
      `actor/session counts or two Story operations changed: ${JSON.stringify({ before, finalCounts, finalOwner, initialStoryCount, finalStoryCount })}`,
    );
    assert(
      session.value === sessionAfter?.value,
      "authenticated owner session cookie changed",
    );
    checks.push("same-owner-session-no-actor-session-drift");
    return {
      result: "green",
      mode,
      initialActorSessionCounts: before,
      actorSessionCounts: finalCounts,
      sameSession: true,
      sameSessionCookie: true,
      candidate,
      retry,
      checks: checks.slice(checksStart),
      lostCreateAck:
        "Not qualified: after a POST may have committed, no automatic resend is attempted; exact ACK-loss recovery requires a separate idempotency/lookup contract.",
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await removeRoutes(page, routes);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}
