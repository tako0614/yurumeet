export const RELEASE_REPOSITORY: string;
export const RELEASE_APP: string;
export const RELEASE_ASSET_NAME: string;
export const RELEASE_MANIFEST_NAME: string;
export const RELEASE_CHECKSUM_NAME: string;

export function releaseAssetUrl(tag: string, name: string): string;

export type ReleaseManifest = {
  kind: "takosumi.worker-artifact@v1";
  app: string;
  commit: string;
  ref: string;
  releaseTag: string;
  artifact: {
    filename: string;
    url: string;
    sha256: string;
    sha256Prefixed: string;
    contentType: string;
  };
  manifestUrl: string;
};

export function buildReleaseManifest(input: {
  commit: string;
  tag: string;
  bundleDigest: string;
}): { manifest: ReleaseManifest; bytes: Buffer; digest: string };

export function buildReleaseChecksum(bundleDigest: string): Buffer;

export type ReleaseLockEntry = {
  artifact: { filename: string; url: string; sha256: string };
  manifest: { url: string; sha256: string };
  commit: string;
  seededFrom?: string;
};

export function buildReleaseLockEntry(input: {
  commit: string;
  tag: string;
  bundleDigest: string;
  manifestDigest: string;
  seededFrom?: string;
}): ReleaseLockEntry;
