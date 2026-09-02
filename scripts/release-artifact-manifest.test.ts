import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  RELEASE_ASSET_NAME,
  RELEASE_CHECKSUM_NAME,
  RELEASE_MANIFEST_NAME,
  buildReleaseChecksum,
  buildReleaseLockEntry,
  buildReleaseManifest,
} from "./release-artifact-manifest.mjs";

const releaseLock = JSON.parse(
  await readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
) as ReleaseLock;

const rawDigest = (value: string) => value.replace(/^sha256:/, "");

describe("release artifact manifest", () => {
  // The two published releases were produced by a GitHub Actions workflow that
  // no longer exists. The `yurumeet-worker-release` surface replaced it, so the
  // bytes it writes have to be the bytes those releases already have: `main.tf`
  // fetches takosumi-artifact.json at plan time and requires its SHA-256 to
  // equal the digest pinned here. A stray key or a changed indent would mint a
  // manifest no published pin matches.
  test.each(Object.keys(releaseLock.releases))(
    "rebuilds the published %s manifest byte for byte",
    (tag) => {
      const pin = releaseLock.releases[tag];
      const built = buildReleaseManifest({
        commit: pin.commit,
        tag,
        bundleDigest: rawDigest(pin.artifact.sha256),
      });

      expect(built.digest).toBe(rawDigest(pin.manifest.sha256));
      expect(built.manifest.artifact.url).toBe(pin.artifact.url);
      expect(built.manifest.manifestUrl).toBe(pin.manifest.url);
      expect(built.manifest.artifact.filename).toBe(pin.artifact.filename);
      expect(built.manifest.commit).toBe(pin.commit);
      expect(built.manifest.ref).toBe(tag);
      expect(built.manifest.releaseTag).toBe(tag);
    },
  );

  test("rebuilds each published lock entry from the release bytes", () => {
    for (const [tag, pin] of Object.entries(releaseLock.releases)) {
      const bundleDigest = rawDigest(pin.artifact.sha256);
      const rebuilt = buildReleaseLockEntry({
        commit: pin.commit,
        tag,
        bundleDigest,
        manifestDigest: buildReleaseManifest({
          commit: pin.commit,
          tag,
          bundleDigest,
        }).digest,
      });
      const { seededFrom, ...recorded } = pin;
      expect(seededFrom).toBeTypeOf("string");
      expect(rebuilt).toEqual(recorded);
    }
  });

  test("writes the checksum sidecar the published releases carry", () => {
    const digest = "a".repeat(64);
    const bytes = buildReleaseChecksum(digest);
    expect(bytes.toString("utf8")).toBe(`${digest}  ${RELEASE_ASSET_NAME}\n`);
    expect(RELEASE_CHECKSUM_NAME).toBe(`${RELEASE_ASSET_NAME}.sha256`);
    expect(RELEASE_MANIFEST_NAME).toBe("takosumi-artifact.json");
  });
});

describe("release identity", () => {
  // v0.1.1 and v0.1.2 legitimately share one artifact digest: the commits
  // between them changed only docs and module metadata, so the Worker built
  // byte for byte the same. That makes the artifact digest unusable as an
  // identity — a reader who assumes otherwise reads one of these entries as a
  // copy-paste mistake. The tag is the identity, and the manifest is what
  // distinguishes two releases that ship the same bytes.
  test("does not treat a shared artifact digest as a defect", () => {
    const artifactDigests = Object.values(releaseLock.releases).map(
      (pin) => pin.artifact.sha256,
    );
    expect(artifactDigests.length).toBeGreaterThan(1);
    expect(new Set(artifactDigests).size).toBeLessThanOrEqual(
      artifactDigests.length,
    );
  });

  test("gives every release a distinct commit and manifest", () => {
    const entries = Object.entries(releaseLock.releases);
    const commits = entries.map(([, pin]) => pin.commit);
    const manifests = entries.map(([, pin]) => pin.manifest.sha256);
    expect(new Set(commits).size).toBe(entries.length);
    expect(new Set(manifests).size).toBe(entries.length);
  });

  test("keeps every pinned URL under its own release tag", () => {
    for (const [tag, pin] of Object.entries(releaseLock.releases)) {
      expect(pin.artifact.url).toContain(`/download/${tag}/`);
      expect(pin.manifest.url).toContain(`/download/${tag}/`);
      expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(pin.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(pin.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });
});

interface ReleaseLock {
  kind: string;
  app: string;
  releases: Record<
    string,
    {
      commit: string;
      artifact: { filename: string; url: string; sha256: string };
      manifest: { url: string; sha256: string };
      seededFrom?: string;
    }
  >;
}
