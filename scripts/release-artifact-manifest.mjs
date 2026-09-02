// The bytes a Yurumeet worker release publishes, and the lock entry that pins
// them.
//
// This lives apart from `deploy.mjs` for one reason: the two releases already
// published — v0.1.1 and v0.1.2 — were produced by a GitHub Actions workflow
// that has since been deleted, and their manifest digests are recorded in
// `release.lock.json`. A release surface that produced even a byte of different
// manifest formatting would mint a digest no existing pin matches, and nothing
// would notice until an operator ran a publish. Keeping the builder importable
// lets `release-artifact-manifest.test.ts` rebuild both published manifests from
// their lock entries and require the recorded digests back.
//
// `worker.js` is the asset name, not `yurumeet-worker.js`: `main.tf` resolves a
// release through `release.lock.json`, whose entries name that file, and the
// lock is append-only.

import { createHash } from "node:crypto";

export const RELEASE_REPOSITORY = "tako0614/yurumeet";
export const RELEASE_APP = "yurumeet";
export const RELEASE_ASSET_NAME = "worker.js";
export const RELEASE_MANIFEST_NAME = "takosumi-artifact.json";
export const RELEASE_CHECKSUM_NAME = `${RELEASE_ASSET_NAME}.sha256`;

export const releaseAssetUrl = (tag, name) =>
  `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The `takosumi.worker-artifact@v1` manifest for one release, plus the exact
 * bytes and digest that will be uploaded. `main.tf` fetches this document at
 * plan time and compares every field against the lock pin, so the field set and
 * the serialization are both part of the published contract.
 */
export function buildReleaseManifest({ commit, tag, bundleDigest }) {
  const manifest = {
    kind: "takosumi.worker-artifact@v1",
    app: RELEASE_APP,
    commit,
    ref: tag,
    releaseTag: tag,
    artifact: {
      filename: RELEASE_ASSET_NAME,
      url: releaseAssetUrl(tag, RELEASE_ASSET_NAME),
      sha256: bundleDigest,
      sha256Prefixed: `sha256:${bundleDigest}`,
      contentType: "application/javascript",
    },
    manifestUrl: releaseAssetUrl(tag, RELEASE_MANIFEST_NAME),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, bytes, digest: sha256(bytes) };
}

/** The `worker.js.sha256` sidecar, in the shape the published releases use. */
export function buildReleaseChecksum(bundleDigest) {
  return Buffer.from(`${bundleDigest}  ${RELEASE_ASSET_NAME}\n`, "utf8");
}

/**
 * The `release.lock.json` entry a release must already carry before it is
 * published. The lock is append-only and is written by hand from a `--dry-run`,
 * so this is what the dry run prints and what the publish requires back.
 */
export function buildReleaseLockEntry({
  commit,
  tag,
  bundleDigest,
  manifestDigest,
  seededFrom,
}) {
  return {
    artifact: {
      filename: RELEASE_ASSET_NAME,
      url: releaseAssetUrl(tag, RELEASE_ASSET_NAME),
      sha256: `sha256:${bundleDigest}`,
    },
    manifest: {
      url: releaseAssetUrl(tag, RELEASE_MANIFEST_NAME),
      sha256: `sha256:${manifestDigest}`,
    },
    commit,
    ...(seededFrom ? { seededFrom } : {}),
  };
}
