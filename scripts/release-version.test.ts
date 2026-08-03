import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [packageSource, moduleSource, takoformModuleSource, releaseLockSource] =
  await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../main.tf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
    readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
  ]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;
const expectedReleaseTag = `v${packageVersion}`;
const releaseLock = JSON.parse(releaseLockSource) as ReleaseLock;
const currentRelease = releaseLock.releases[expectedReleaseTag];

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

  test("covers the current deploy defaults with an append-only release pin", () => {
    expect(releaseLock.kind).toBe("takos.release-artifact-lock@v1");
    expect(releaseLock.app).toBe("yurumeet");
    expect(currentRelease).toBeDefined();
    if (!currentRelease) return;

    expect(currentRelease.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(currentRelease.artifact.filename).toBe("worker.js");
    expect(currentRelease.artifact.url).toBe(
      `https://github.com/tako0614/yurumeet/releases/download/${expectedReleaseTag}/worker.js`,
    );
    expect(currentRelease.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(currentRelease.manifest.url).toBe(
      `https://github.com/tako0614/yurumeet/releases/download/${expectedReleaseTag}/takosumi-artifact.json`,
    );
    expect(currentRelease.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(takoformModuleSource).toContain(currentRelease.artifact.url);
    expect(takoformModuleSource).toContain(
      `default     = "${currentRelease.artifact.sha256}"`,
    );
  });

  test("matches the Git tag when the release workflow runs", () => {
    const isTagRef =
      process.env.GITHUB_REF_TYPE === "tag" ||
      process.env.GITHUB_REF?.startsWith("refs/tags/");
    if (!isTagRef) return;

    expect(process.env.GITHUB_REF_NAME).toBe(expectedReleaseTag);
  });
});

interface ReleaseLock {
  kind: string;
  app: string;
  releases: Record<string, ReleasePin>;
}

interface ReleasePin {
  commit: string;
  artifact: {
    filename: string;
    url: string;
    sha256: string;
  };
  manifest: {
    url: string;
    sha256: string;
  };
}
