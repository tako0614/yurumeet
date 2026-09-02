export function releaseIdentityFailures(input: {
  tag: string;
  commit: string;
  assetName: string;
  assetUrl: string;
  manifestUrl: string;
  bundleDigest: string;
  manifestDigest: string;
  moduleSource: string;
  lock: unknown;
  repository: unknown;
  takoformSource: string;
}): string[];

export function terraformStringDefault(
  source: string,
  variable: string,
): string | undefined;
