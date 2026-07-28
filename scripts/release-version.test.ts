import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource, takoformModuleSource] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;
const expectedReleaseTag = `v${packageVersion}`;

describe("release version", () => {
  test("keeps the OpenTofu artifact default aligned", () => {
    for (const source of [moduleSource, takoformModuleSource]) {
      const releaseVariable = source.match(
        /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
      )?.[1];

      expect(releaseVariable).toBeDefined();
      expect(releaseVariable).toContain(
        `default     = "${expectedReleaseTag}"`,
      );
      if (source === takoformModuleSource) {
        expect(source).toContain(
          `/releases/download/${expectedReleaseTag}/worker.js`,
        );
        expect(source).toMatch(/default\s+=\s+"sha256:[a-f0-9]{64}"/);
      }
    }
  });

  test("matches the Git tag when the release workflow runs", () => {
    const isTagRef =
      process.env.GITHUB_REF_TYPE === "tag" ||
      process.env.GITHUB_REF?.startsWith("refs/tags/");
    if (!isTagRef) return;

    expect(process.env.GITHUB_REF_NAME).toBe(expectedReleaseTag);
  });
});
