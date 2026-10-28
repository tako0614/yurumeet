// Optional read-only browser regression using README's in-memory dev:mock.
// This synthetic actor fixture does not qualify authentication or live data.
import { chromium } from "playwright-core";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve(
  process.env.YURUMEET_UX_EVIDENCE ?? ".yurumeet-ux-results",
);
await mkdir(output, { recursive: true, mode: 0o700 });
const result = {
  baseSource: "32ec3d75857a50a9997b147be263e9c3e300b988",
  scope: "local UI mock only",
  checks: [],
  blockedWrites: 0,
  blockedExternal: 0,
};
const check = (name, pass) => result.checks.push({ name, pass });
let browser;
let context;
try {
  const url = new URL(process.env.YURUMEET_UX_BASE_URL);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Loopback origin required");
  const origin = url.origin;
  result.origin = origin;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/opt/google/chrome/chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "ja-JP",
  });
  await context.route("**/*", (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) {
      result.blockedExternal++;
      return route.abort();
    }
    if (request.method() !== "GET") {
      result.blockedWrites++;
      return route.abort();
    }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, (ws) => ws.close());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const field = page.getByPlaceholder("トークを検索", { exact: true });
  const settle = async () => {
    await field.waitFor({ state: "visible" });
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
  };
  const back = async () => {
    await page.goBack({ waitUntil: "networkidle" });
    await settle();
  };
  const forward = async () => {
    await page.goForward({ waitUntil: "networkidle" });
    await settle();
  };
  const openProfile = async (name) => {
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const title = page
      .locator(".p-talk-chat-title-link")
      .filter({ hasText: name });
    await title.waitFor({ state: "visible" });
    await title.click();
    await page.waitForURL(/\/profile\//);
  };
  const privateTermAbsent = (term) =>
    page.evaluate(
      (term) =>
        ![
          location.href,
          JSON.stringify(history.state),
          ...Object.values(localStorage),
          ...Object.values(sessionStorage),
        ].some((value) => value?.includes(term)),
      term,
    );
  await page.goto(origin + "/", { waitUntil: "networkidle" });
  await settle();
  await field.fill("Akari");
  await openProfile("Akari");
  await back();
  check(
    "profile Back restores the submitted filter and rows",
    (await field.inputValue()) === "Akari" &&
      (await page.getByRole("button", { name: /^Ren/ }).count()) === 0,
  );
  if (!process.argv.includes("--single")) {
    await page.goForward({ waitUntil: "networkidle" });
    await page.waitForURL(/\/profile\//);
    await back();
    check(
      "profile Forward and Back retain the same entry",
      (await field.inputValue()) === "Akari",
    );
    // '/' and '/?tab=talk' are distinct existing navigation entries that keep
    // the same talk pane mounted. A global last-filter cannot pass this case.
    await page.locator('a[href="/?tab=talk"]').first().click();
    await settle();
    check("new talk entry starts empty", (await field.inputValue()) === "");
    await field.fill("Ren");
    await openProfile("Ren");
    await back();
    check(
      "second entry restores its own filter",
      (await field.inputValue()) === "Ren",
    );
    await back();
    check(
      "Back between mounted talk entries restores first filter",
      (await field.inputValue()) === "Akari",
    );
    await forward();
    check(
      "Forward between mounted talk entries restores second filter",
      (await field.inputValue()) === "Ren",
    );
    const historyBefore = await page.evaluate(() => history.length);
    await field.fill("A");
    await field.pressSequentially("kari  ");
    check(
      "keystrokes do not push history entries",
      (await page.evaluate(() => history.length)) === historyBefore,
    );
    check(
      "query plaintext is absent from URL and browser storage",
      await privateTermAbsent("Akari  "),
    );
    await page.reload({ waitUntil: "networkidle" });
    await settle();
    check(
      "reload clears the volatile filter",
      (await field.inputValue()) === "",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      await page
        .locator(".app-main")
        .evaluate((e) => e.classList.contains("is-chat-open"))
    )
      await page.locator(".p-talk-chat-prev").click();
    await settle();
    check(
      "mobile prior overlay is closed",
      !(await page
        .locator(".app-main")
        .evaluate((e) => e.classList.contains("is-chat-open"))),
    );
    await field.fill("Akari");
    await page.getByRole("button", { name: /^Akari/ }).click();
    await page
      .locator(".p-talk-chat-title-link")
      .filter({ hasText: "Akari" })
      .waitFor({ state: "visible" });
    check(
      "mobile overlay retains its original history flag",
      await page.evaluate(() => history.state?.yurumeChatOpen === true),
    );
    await page
      .locator(".p-talk-chat-title-link")
      .filter({ hasText: "Akari" })
      .click();
    await page.waitForURL(/\/profile\//);
    await back();
    check(
      "mobile profile Back retains its list filter",
      (await field.inputValue()) === "Akari",
    );
    await page.goBack({ waitUntil: "networkidle" });
    await settle();
    check(
      "mobile Back closes the overlay and retains filter",
      (await field.inputValue()) === "Akari" &&
        !(await page
          .locator(".app-main")
          .evaluate((e) => e.classList.contains("is-chat-open"))),
    );
    check(
      "mobile viewport does not overflow",
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await settle();
    check(
      "direct URL starts with no private filter",
      (await field.inputValue()) === "",
    );
  }
  check("no uncaught browser error", errors.length === 0);
  result.status = result.checks.every((x) => x.pass) ? "PASS" : "RED";
} catch (error) {
  result.status = "HARNESS_ERROR";
  result.error = error instanceof Error ? error.name : "UnknownError";
} finally {
  try {
    await context?.close();
  } catch {
    result.status = "HARNESS_ERROR";
    result.cleanup = "context close failed";
  }
  try {
    await browser?.close();
  } catch {
    result.status = "HARNESS_ERROR";
    result.cleanup = "browser close failed";
  }
  await writeFile(
    resolve(output, "RESULT.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
}
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "PASS" ? 0 : 1;
