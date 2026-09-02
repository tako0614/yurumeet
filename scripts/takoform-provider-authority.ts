import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Where OpenTofu is told to look for the Takoform Provider.
 *
 * Only the development-override path uses this string: a registry `init` reads
 * the source address out of `deploy/takoform/main.tf` instead. The two must
 * agree, or an operator who supplies local Provider bytes gets an override that
 * silently applies to nothing and a registry download anyway.
 */
export const TAKOFORM_PROVIDER_SOURCE =
  "registry.terraform.io/tako0614/takoform";

type Environment = Readonly<Record<string, string | undefined>>;

export interface LocalProviderAuthority {
  readonly providerBinary: string;
  readonly providerSha256: string;
}

/**
 * Reads the explicit authority for validating an unpublished Provider build.
 *
 * Both values are required together. Accepting the path alone would let a
 * caller point validation at arbitrary bytes; accepting neither and falling
 * back to the registry silently is the same mistake in the other direction, so
 * a half-configured environment fails instead of choosing a lane for the caller.
 */
export function readLocalProviderAuthority(
  environment: Environment,
): LocalProviderAuthority {
  const providerBinary = environment.TAKOFORM_PROVIDER_BINARY?.trim() ?? "";
  const providerSha256 = environment.TAKOFORM_PROVIDER_SHA256?.trim() ?? "";
  if (!providerBinary || !providerSha256) {
    throw new Error(
      "TAKOFORM_PROVIDER_BINARY and TAKOFORM_PROVIDER_SHA256 are required; unpublished Provider bytes are explicit tracer authority",
    );
  }
  if (!isAbsolute(providerBinary)) {
    throw new Error("TAKOFORM_PROVIDER_BINARY must be an absolute path");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(providerSha256)) {
    throw new Error(
      "TAKOFORM_PROVIDER_SHA256 must be canonical sha256:<lowercase hex>",
    );
  }
  return { providerBinary, providerSha256 };
}

/**
 * Copies the declared Provider executable into `workdir` and writes the CLI
 * configuration that points OpenTofu at that copy.
 *
 * The digest is verified on the source bytes and again on the copy, so the
 * override cannot be pointed at one file and satisfied by another. The returned
 * config replaces `TF_CLI_CONFIG_FILE` wholesale rather than extending an
 * inherited one.
 */
export async function prepareProviderDevOverride(
  config: LocalProviderAuthority,
  workdir: string,
): Promise<{ readonly cliConfigPath: string }> {
  let metadata;
  try {
    metadata = await stat(config.providerBinary);
  } catch {
    throw new Error("TAKOFORM_PROVIDER_BINARY does not exist");
  }
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error("TAKOFORM_PROVIDER_BINARY must be an executable file");
  }
  const bytes = await readFile(config.providerBinary);
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (digest !== config.providerSha256) {
    throw new Error("Provider binary digest mismatch");
  }

  const providerDirectory = join(workdir, "provider-dev-override");
  await mkdir(providerDirectory, { recursive: true });
  const providerCopy = join(providerDirectory, "terraform-provider-takoform");
  await copyFile(config.providerBinary, providerCopy);
  await chmod(providerCopy, 0o755);
  const copiedDigest =
    "sha256:" +
    createHash("sha256")
      .update(await readFile(providerCopy))
      .digest("hex");
  if (copiedDigest !== config.providerSha256) {
    throw new Error("Copied Provider binary digest mismatch");
  }

  const cliConfigPath = join(workdir, "tofu.rc");
  await writeFile(
    cliConfigPath,
    `provider_installation {\n  dev_overrides {\n    "${TAKOFORM_PROVIDER_SOURCE}" = ${JSON.stringify(providerDirectory)}\n  }\n  direct {}\n}\n`,
    { mode: 0o600 },
  );
  return { cliConfigPath };
}
