// Real PostComposer/Worker/native-D1 regression. Successful responses are fetched
// from the Worker and only their delivery is held; failures are refused before
// forwarding. No successful Post or media response is synthesized.

function assert(condition, message) {
  if (!condition) throw new Error(`post-draft ${message}`);
}

function gate() {
  let resolve;
  const promise = new Promise((accept) => (resolve = accept));
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`post-draft ${label} timed out`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function qualifyBrowserPostDraft({ page, db, origin, actorApId }) {
  const checks = [];
  const records = [];
  const errors = [];
  const blocked = [];
  const holds = new Set();
  let nextPost;
  let nextUpload;
  const onError = (error) => errors.push(String(error));
  page.on("pageerror", onError);
  const before = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
    )
    .first();

  const holdNext = (kind, reject = false) => {
    const hold = { ready: gate(), release: gate(), done: gate(), reject };
    holds.add(hold);
    if (kind === "post") nextPost = hold;
    else nextUpload = hold;
    return hold;
  };
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      if (url.protocol === "data:" || url.protocol === "blob:") {
        await route.continue();
      } else {
        blocked.push(url.origin);
        await route.abort("blockedbyclient");
      }
      return;
    }
    const post = request.method() === "POST" && url.pathname === "/api/posts";
    const upload =
      request.method() === "POST" && url.pathname === "/api/media/upload";
    if (!post && !upload) {
      await route.continue();
      return;
    }
    const hold = post ? nextPost : nextUpload;
    if (post) nextPost = undefined;
    else nextUpload = undefined;
    if (hold) hold.started = true;
    try {
      const body = post ? request.postDataJSON() : undefined;
      if (hold?.reject) {
        records.push({ kind: post ? "post" : "upload", refused: true, body });
        hold.ready.resolve();
        await bounded(hold.release.promise, "refused response release");
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "local regression refusal" }),
        });
      } else {
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: 15_000,
        });
        const bytes = await response.body();
        const result = JSON.parse(bytes.toString("utf8"));
        const record = {
          kind: post ? "post" : "upload",
          body,
          status: response.status(),
          result,
        };
        records.push(record);
        hold?.ready.resolve(record);
        if (hold) await bounded(hold.release.promise, "Worker ACK release");
        await route.fulfill({ response, body: bytes });
      }
    } catch (error) {
      errors.push(String(error));
      hold?.ready.resolve({ error: String(error) });
      await route.abort("failed").catch(() => {});
    } finally {
      hold?.done.resolve();
    }
  };
  await page.route("**/*", handler);
  const dialog = page.getByRole("dialog", { name: "投稿を作成", exact: true });
  const text = dialog.getByPlaceholder("いまどうしてる?");
  const submit = dialog.locator(".p-composer-submit");
  const open = async () => {
    await page.getByRole("button", { name: "投稿を作成", exact: true }).click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
  };
  const responseFor = (content) =>
    page.waitForResponse(
      (response) =>
        response.url() === `${origin}/api/posts` &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.content === content,
      { timeout: 15_000 },
    );
  const idle = () =>
    page.waitForFunction(() => {
      const button = document.querySelector(".p-composer-submit");
      return button && button.textContent !== "送信中";
    });
  const verifyPost = async (response, content) => {
    const body = await response.json();
    const post = body.post;
    assert(
      response.status() === 200 && post?.content === content,
      "real Post ACK mismatch",
    );
    const native = await db
      .prepare(
        "SELECT o.content, o.attributed_to, o.visibility, (SELECT COUNT(*) FROM activities a WHERE a.object_ap_id = o.ap_id AND a.type = 'Create' AND a.direction = 'outbound') AS creates FROM objects o WHERE o.ap_id = ? AND o.deleted_at IS NULL",
      )
      .bind(post.ap_id)
      .first();
    assert(
      native?.content === content &&
        native.attributed_to === actorApId &&
        native.visibility === post.visibility &&
        native.creates === 1,
      "Post ACK must identify one actual owner Note and one outbound Create",
    );
    return post;
  };
  const send = async (content) => {
    await text.fill(content);
    const response = responseFor(content);
    await submit.click();
    const post = await verifyPost(await response, content);
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    return post;
  };
  const start = async (content, reject = false) => {
    await open();
    await text.fill(content);
    const hold = holdNext("post", reject);
    const response = responseFor(content);
    response.catch(() => {});
    await submit.click();
    const committed = await bounded(hold.ready.promise, "Post reached Worker");
    assert(!committed?.error, "held Post request failed");
    return { hold, response, content };
  };
  const release = async ({ hold, response, content }) => {
    hold.release.resolve();
    const post = await verifyPost(await response, content);
    await idle();
    return post;
  };
  try {
    const first = await start("post-draft original text");
    await text.fill("post-draft next text");
    await dialog
      .getByRole("button", { name: "内容の警告", exact: true })
      .click();
    await dialog.getByPlaceholder("内容の警告 (任意)").fill("next warning");
    await dialog
      .getByLabel("公開範囲", { exact: true })
      .selectOption("followers");
    await release(first);
    assert(
      (await text.inputValue()) === "post-draft next text" &&
        (await dialog.getByPlaceholder("内容の警告 (任意)").inputValue()) ===
          "next warning" &&
        (await dialog.getByLabel("公開範囲", { exact: true }).inputValue()) ===
          "followers" &&
        (await submit.isEnabled()) &&
        records.length === 1,
      "old ACK lost newer draft fields or submitted them automatically",
    );
    const second = await send("post-draft next text");
    assert(
      second.summary === "next warning" && second.visibility === "followers",
      "explicit next submit used stale fields",
    );
    checks.push(
      "browser-post-draft-newer-text-warning-visibility-survive-old-ack",
      "browser-post-draft-explicit-next-submit-and-unchanged-close",
    );

    const blank = await start("post-draft cleared while pending");
    await text.fill("");
    await release(blank);
    assert(
      (await text.inputValue()) === "" && (await submit.isDisabled()),
      "old ACK closed a newer empty draft",
    );
    await send("post-draft empty recovery");
    checks.push("browser-post-draft-empty-newer-draft-stays-open-and-recovers");

    const media = await start("post-draft upload while pending");
    const upload = holdNext("upload");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "next.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jqS8AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const uploaded = await bounded(upload.ready.promise, "real media upload");
    assert(uploaded?.status === 200, "real upload did not reach Worker");
    await release(media);
    assert(
      (await text.inputValue()) === media.content &&
        (await submit.isDisabled()),
      "old ACK closed a pending upload",
    );
    upload.release.resolve();
    await dialog
      .locator(".p-composer-media-alt")
      .waitFor({ state: "visible", timeout: 10_000 });
    await dialog
      .locator(".p-composer-media-alt")
      .fill("next image description");
    const imagePost = await send("post-draft image recovery");
    assert(
      imagePost.attachments?.length === 1 &&
        imagePost.attachments[0].name === "next image description",
      "new uploaded media was lost or submitted before explicit action",
    );
    checks.push("browser-post-draft-pending-real-upload-survives-old-ack");

    const uploadFailure = await start("post-draft upload failure original");
    const refusedUpload = holdNext("upload", true);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "fail.png",
      mimeType: "image/png",
      buffer: Buffer.from("local-refused-upload"),
    });
    await bounded(refusedUpload.ready.promise, "refused upload reached route");
    refusedUpload.release.resolve();
    await dialog
      .getByText("アップロードに失敗しました", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await release(uploadFailure);
    assert(
      await dialog
        .getByText("アップロードに失敗しました", { exact: true })
        .isVisible(),
      "old ACK erased the new upload error",
    );
    await send("post-draft upload failure recovery");
    checks.push(
      "browser-post-draft-upload-error-survives-old-ack-and-recovers",
    );

    const refused = await start("post-draft failed request", true);
    await text.fill("post-draft newer failed draft");
    refused.hold.release.resolve();
    assert(
      (await refused.response).status() === 503,
      "failure control was not refused",
    );
    await dialog
      .getByText("投稿に失敗しました", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    assert(
      (await text.inputValue()) === "post-draft newer failed draft" &&
        (await submit.isEnabled()),
      "failure lost the current draft or left submission locked",
    );
    await send("post-draft newer failed draft");
    checks.push(
      "browser-post-draft-failure-preserves-newer-input-explicit-retry",
    );

    const after = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM actors) AS actors, (SELECT COUNT(*) FROM sessions) AS sessions",
      )
      .first();
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      "composer changed actor/session custody",
    );
    assert(
      records.filter((record) => record.kind === "post" && !record.refused)
        .length === 9 &&
        records.filter((record) => record.kind === "post" && record.refused)
          .length === 1 &&
        records.filter((record) => record.kind === "upload").length === 2,
      "unexpected automatic/replayed request",
    );
    assert(
      errors.length === 0 && blocked.length === 0,
      "browser/route error or external request",
    );
    checks.push(
      "browser-post-draft-real-native-notes-single-create-no-auto-submit",
    );
    return {
      status: "PASSED",
      checks,
      posts: 9,
      refusedPosts: 1,
      uploads: 2,
      actorSessionCounts: { before, after },
      pageErrors: errors,
      blockedOutbound: blocked,
    };
  } finally {
    for (const hold of holds) hold.release.resolve();
    for (const hold of holds) {
      if (hold.started) await bounded(hold.done.promise, "route cleanup");
    }
    await page.unroute("**/*", handler);
    page.off("pageerror", onError);
  }
}
