import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const site = await readFile(
  new URL("../site/index.html", import.meta.url),
  "utf8",
);
const smoke = await readFile(
  new URL("./post-deploy-smoke.ts", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const siteText = site.replace(/\s+/g, " ");

describe("public install surface", () => {
  test("does not link to an unverified managed installation", () => {
    expect(site).not.toContain("https://app.takosumi.com/install?");
    expect(site).not.toContain("data-takosumi-add");
    expect(siteText).toContain("Takosumi 導入は検証中");
  });

  test("keeps the future managed source in the repository instructions", () => {
    expect(site).not.toContain("ref=main");
    // The landing links to the repository; the unavailable installation's
    // precise source tuple is documented there, without becoming a live CTA.
    expect(site).toContain('href="https://github.com/tako0614/yurumeet"');
    expect(readme).toContain(
      '"url": "https://github.com/tako0614/yurumeet.git"',
    );
    expect(readme).toContain('"ref": "<verified-release-tag>"');
    expect(readme).toContain('"path": "deploy/takoform"');
  });
});

describe("post-deploy evidence", () => {
  test("checks readiness and delegates lifecycle cleanup to destroy", () => {
    expect(smoke).toContain('requestJson("/readyz", 200)');
    expect(smoke).toContain("cleanupDelegatedToDestroy: true");
    expect(smoke).not.toContain("cleanupVerified: true");
  });

  test("can probe passwordless OIDC installs with a private session", () => {
    expect(smoke).toContain("YURUMEET_E2E_SESSION_COOKIE");
  });
});
