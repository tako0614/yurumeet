import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  RELEASE_ASSET_NAME,
  buildReleaseManifest,
  releaseAssetUrl,
} from "./release-artifact-manifest.mjs";
import {
  releaseIdentityFailures,
  terraformStringDefault,
} from "./release-identity.mjs";

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [moduleSource, lockSource, repositorySource, takoformSource] =
  await Promise.all([
    read("main.tf"),
    read("release.lock.json"),
    read(".well-known/takosumi.json"),
    read("deploy/takoform/main.tf"),
  ]);

const lock = JSON.parse(lockSource) as {
  releases: Record<
    string,
    {
      commit: string;
      artifact: { sha256: string };
      manifest: { sha256: string };
    }
  >;
};
const repository = JSON.parse(repositorySource);

// The release the direct-Cloudflare module currently installs. Asking about
// that one turns "these five documents agree" into something `bun run check`
// answers on every commit, not something a publish discovers.
const pinnedTag = terraformStringDefault(moduleSource, "worker_release_tag");

function checkTag(tag: string, overrides: Record<string, unknown> = {}) {
  const pin = lock.releases[tag];
  const bundleDigest = pin.artifact.sha256.replace(/^sha256:/, "");
  return releaseIdentityFailures({
    tag,
    commit: pin.commit,
    assetName: RELEASE_ASSET_NAME,
    assetUrl: releaseAssetUrl(tag, RELEASE_ASSET_NAME),
    manifestUrl: releaseAssetUrl(tag, "takosumi-artifact.json"),
    bundleDigest,
    manifestDigest: buildReleaseManifest({
      commit: pin.commit,
      tag,
      bundleDigest,
    }).digest,
    moduleSource,
    lock,
    repository,
    takoformSource,
    ...overrides,
  });
}

describe("release identity", () => {
  test("the worktree's five documents describe the pinned release", () => {
    expect(pinnedTag).toBeTruthy();
    expect(lock.releases[pinnedTag!]).toBeDefined();
    expect(checkTag(pinnedTag!)).toEqual([]);
  });

  test("refuses a tag the append-only lock never pinned", () => {
    const failures = releaseIdentityFailures({
      tag: "v99.0.0",
      commit: "f".repeat(40),
      assetName: RELEASE_ASSET_NAME,
      assetUrl: releaseAssetUrl("v99.0.0", RELEASE_ASSET_NAME),
      manifestUrl: releaseAssetUrl("v99.0.0", "takosumi-artifact.json"),
      bundleDigest: "0".repeat(64),
      manifestDigest: "1".repeat(64),
      moduleSource,
      lock,
      repository,
      takoformSource,
    });
    expect(failures.join("\n")).toContain(
      "release.lock.json releases.v99.0.0.artifact.filename is <missing>",
    );
  });

  test("refuses a module default that bypasses the lock", () => {
    const bypassed = moduleSource.replace(
      /(variable "worker_bundle_url"[\s\S]*?default\s+= )""/,
      '$1"https://example.invalid/worker.js"',
    );
    expect(bypassed).not.toBe(moduleSource);
    expect(
      checkTag(pinnedTag!, { moduleSource: bypassed }).join("\n"),
    ).toContain("main.tf worker_bundle_url default is");
  });

  test("refuses a portable module that installs a published release", () => {
    const failures = checkTag(pinnedTag!, {
      takoformSource: `${takoformSource}\n# releases/download/v0.1.2/worker.js\n`,
    });
    expect(failures.join("\n")).toContain(
      "deploy/takoform pins a published release URL",
    );
  });

  test("refuses a repository manifest that asks an installer for the pin", () => {
    const asked = structuredClone(repository);
    const input = asked.install.modules["."].inputs.find(
      (candidate: { name: string }) =>
        candidate.name === "worker_bundle_sha256",
    );
    input.source = { kind: "user" };
    expect(checkTag(pinnedTag!, { repository: asked }).join("\n")).toContain(
      "does not declare worker_bundle_sha256 as a module_default pin",
    );
  });
});
