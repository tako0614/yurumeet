import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  RELEASE_ASSET_NAME,
  buildReleaseManifest,
  releaseAssetUrl,
} from "./release-artifact-manifest.mjs";
import {
  releaseCandidateIdentityFailures,
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

const publishedTag = Object.keys(lock.releases).at(-1)!;
const candidateTag = "v99.0.0";
const candidateCommit = "f".repeat(40);
const candidateBundleDigest = "0".repeat(64);
const replaceDefault = (source: string, variable: string, value: string) =>
  source.replace(
    new RegExp(`(variable "${variable}"[\\s\\S]*?default\\s+= )"[^"]*"`),
    `$1"${value}"`,
  );
const withReleaseDefaults = (tag: string, url: string, digest: string) =>
  replaceDefault(
    replaceDefault(
      replaceDefault(moduleSource, "worker_release_tag", tag),
      "worker_bundle_url",
      url,
    ),
    "worker_bundle_sha256",
    digest,
  );
const publishedModuleSource = withReleaseDefaults(publishedTag, "", "");
const candidateModuleSource = withReleaseDefaults(
  candidateTag,
  releaseAssetUrl(candidateTag, RELEASE_ASSET_NAME),
  candidateBundleDigest,
);

function checkCandidate(overrides: Record<string, unknown> = {}) {
  return releaseCandidateIdentityFailures({
    tag: candidateTag,
    commit: candidateCommit,
    assetName: RELEASE_ASSET_NAME,
    assetUrl: releaseAssetUrl(candidateTag, RELEASE_ASSET_NAME),
    manifestUrl: releaseAssetUrl(candidateTag, "takosumi-artifact.json"),
    bundleDigest: candidateBundleDigest,
    manifestDigest: buildReleaseManifest({
      commit: candidateCommit,
      tag: candidateTag,
      bundleDigest: candidateBundleDigest,
    }).digest,
    moduleSource: candidateModuleSource,
    lock,
    repository,
    takoformSource,
    ...overrides,
  });
}

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
    moduleSource: publishedModuleSource,
    lock,
    repository,
    takoformSource,
    ...overrides,
  });
}

describe("release identity", () => {
  test("the existing published release remains valid in lock mode", () => {
    expect(lock.releases[publishedTag]).toBeDefined();
    expect(checkTag(publishedTag)).toEqual([]);
  });

  test("a published release also accepts an exact pinned URL and digest", () => {
    const pin = lock.releases[publishedTag];
    const explicit = withReleaseDefaults(
      publishedTag,
      releaseAssetUrl(publishedTag, RELEASE_ASSET_NAME),
      pin.artifact.sha256.replace(/^sha256:/, ""),
    );
    expect(checkTag(publishedTag, { moduleSource: explicit })).toEqual([]);
  });

  test("the worktree selects its package tag through a valid candidate or published pin", async () => {
    const { version } = JSON.parse(await read("package.json"));
    const tag = `v${version}`;
    expect(terraformStringDefault(moduleSource, "worker_release_tag")).toBe(
      tag,
    );
    if (lock.releases[tag]) {
      expect(checkTag(tag, { moduleSource })).toEqual([]);
    } else {
      expect(
        checkCandidate({
          tag,
          bundleDigest:
            "3b952ec6c0ee048bfd303344f8053c21c01ae8bdca780db57c908c6e171d1bd0",
          manifestDigest: buildReleaseManifest({
            commit: candidateCommit,
            tag,
            bundleDigest:
              "3b952ec6c0ee048bfd303344f8053c21c01ae8bdca780db57c908c6e171d1bd0",
          }).digest,
          assetUrl: releaseAssetUrl(tag, RELEASE_ASSET_NAME),
          manifestUrl: releaseAssetUrl(tag, "takosumi-artifact.json"),
          moduleSource,
        }),
      ).toEqual([]);
    }
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
      moduleSource: publishedModuleSource,
      lock,
      repository,
      takoformSource,
    });
    expect(failures.join("\n")).toContain(
      "release.lock.json releases.v99.0.0.artifact.filename is <missing>",
    );
  });

  test("accepts a measured unpublished candidate with its exact module URL and digest", () => {
    expect(checkCandidate()).toEqual([]);
    expect(lock.releases[candidateTag]).toBeUndefined();
  });

  test("refuses a fabricated candidate lock entry", () => {
    const fabricated = structuredClone(lock);
    fabricated.releases[candidateTag] = structuredClone(
      lock.releases[publishedTag],
    );
    expect(checkCandidate({ lock: fabricated }).join("\n")).toContain(
      `release.lock.json releases.${candidateTag} already exists`,
    );
  });

  test("refuses a candidate whose manifest or Worker digest is not measured", () => {
    expect(
      checkCandidate({ manifestDigest: "1".repeat(64) }).join("\n"),
    ).toContain("candidate manifest digest does not match");
    expect(
      checkCandidate({ bundleDigest: "not-a-digest" }).join("\n"),
    ).toContain("candidate Worker digest");
  });

  test("refuses a candidate whose selected tag, URL, or digest differs", () => {
    expect(
      checkCandidate({
        moduleSource: withReleaseDefaults(
          "v99.0.1",
          releaseAssetUrl(candidateTag, RELEASE_ASSET_NAME),
          candidateBundleDigest,
        ),
      }).join("\n"),
    ).toContain("main.tf worker_release_tag default is");
    expect(
      checkCandidate({
        moduleSource: withReleaseDefaults(
          candidateTag,
          releaseAssetUrl(publishedTag, RELEASE_ASSET_NAME),
          candidateBundleDigest,
        ),
      }).join("\n"),
    ).toContain("main.tf worker_bundle_url default is");
    expect(
      checkCandidate({
        moduleSource: withReleaseDefaults(
          candidateTag,
          releaseAssetUrl(candidateTag, RELEASE_ASSET_NAME),
          "1".repeat(64),
        ),
      }).join("\n"),
    ).toContain("main.tf worker_bundle_sha256 default is");
  });

  test("refuses a candidate that bypasses the installed lock with an explicit URL", () => {
    const bypassed = withReleaseDefaults(
      candidateTag,
      "https://example.invalid/worker.js",
      candidateBundleDigest,
    );
    expect(checkCandidate({ moduleSource: bypassed }).join("\n")).toContain(
      "main.tf worker_bundle_url default is",
    );
  });

  test("refuses a module default that bypasses the lock", () => {
    const bypassed = withReleaseDefaults(
      publishedTag,
      "https://example.invalid/worker.js",
      lock.releases[publishedTag].artifact.sha256.replace(/^sha256:/, ""),
    );
    expect(bypassed).not.toBe(publishedModuleSource);
    expect(
      checkTag(publishedTag, { moduleSource: bypassed }).join("\n"),
    ).toContain("main.tf worker_bundle_url default is");
  });

  test("refuses a portable module that installs a published release", () => {
    const failures = checkTag(publishedTag, {
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
    expect(checkTag(publishedTag, { repository: asked }).join("\n")).toContain(
      "does not declare worker_bundle_sha256 as a module_default pin",
    );
  });
});
