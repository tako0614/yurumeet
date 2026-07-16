import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;
const expectedReleaseTag = `v${packageVersion}`;

describe("release version", () => {
  test("keeps the OpenTofu artifact default aligned", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];

    expect(releaseVariable).toBeDefined();
    expect(releaseVariable).toContain(`default     = "${expectedReleaseTag}"`);
  });

  test("matches the Git tag when the release workflow runs", () => {
    const isTagRef =
      process.env.GITHUB_REF_TYPE === "tag" ||
      process.env.GITHUB_REF?.startsWith("refs/tags/");
    if (!isTagRef) return;

    expect(process.env.GITHUB_REF_NAME).toBe(expectedReleaseTag);
  });
});
