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

describe("public install surface", () => {
  test("does not link to an unverified managed installation", () => {
    expect(site).not.toContain("https://app.takosumi.com/install?");
    expect(site).not.toContain("data-takosumi-add");
    expect(site).toContain("Takosumi 導入は検証中");
  });

  test("documents the canonical future managed module precisely", () => {
    expect(site).not.toContain("ref=main");
    expect(site).toContain("ref=&lt;verified-release-tag&gt;");
    expect(site).toContain("path=deploy/takoform");
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
