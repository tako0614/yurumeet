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
  test("keeps the direct Cloudflare module's release default aligned", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];

    expect(releaseVariable).toBeDefined();
    expect(releaseVariable).toContain(`default     = "${expectedReleaseTag}"`);
    // The digest is not repeated in HCL: the root module reads the lock.
    expect(moduleSource).toContain(
      'release_lock                   = jsondecode(file("${path.module}/release.lock.json"))',
    );
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
  });

  // The portable module used to pin the same GitHub asset by URL and digest,
  // which made a Takoform install's identity depend on a published release
  // rather than on the revision being installed. Provider 4.0.0 has no
  // fetch-the-artifact bundle shape, so the bytes are module content prepared
  // from this worktree — and no release pin may creep back in.
  test("keeps the portable module's bytes out of the release lock entirely", () => {
    for (const variable of [
      "worker_release_tag",
      "worker_bundle_url",
      "worker_bundle_sha256",
    ]) {
      expect(takoformModuleSource).not.toContain(`variable "${variable}"`);
    }
    expect(takoformModuleSource).not.toContain("releases/download");
    expect(takoformModuleSource).not.toContain("release.lock.json");
    expect(takoformModuleSource).toContain(
      'worker_bundle_path  = "${path.module}/.generated/yurumeet-worker.js"',
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
