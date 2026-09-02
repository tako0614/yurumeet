#!/usr/bin/env bun

// yurumeet の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。
//
//   bun run deploy -- yurumeet-worker
//   bun run deploy -- yurumeet-worker-release [--dry-run|--execute]
//   bun run deploy -- yurumeet-site --environment=integration|production
//
// 3 つの surface は publish するものが違い、負う obligation も違います。
// worker は code だけを差し替える routine な surface、worker-release は consumer
// が pin する identity を mint する published-identity surface、site は静的な
// landing site です。
//
// どの surface も publish するのは **code と静的 asset だけ** です。durable store
// (D1 DB / KV / R2 MEDIA) には触れません。schema 変更は `irreversible` な別の作業で、
// この entrypoint の副作用として起きてはいけないからです。
// ⚠ yurucommu 系の live D1 は `_cf_migrations` 台帳が実態とずれています。
// `wrangler d1 migrations apply` を絶対に走らせないこと。schema 変更は
// 直接 `d1 execute` で行う operator 手順です。この script は D1 に触れません。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  RELEASE_ASSET_NAME,
  RELEASE_CHECKSUM_NAME,
  RELEASE_MANIFEST_NAME,
  RELEASE_REPOSITORY,
  buildReleaseChecksum,
  buildReleaseLockEntry,
  buildReleaseManifest,
  releaseAssetUrl,
} from "./release-artifact-manifest.mjs";
import { releaseIdentityFailures } from "./release-identity.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER_GATE = "bun run check";

const W = {
  surface: "yurumeet-worker",
  worker: "yurumeet",
  config: "wrangler.jsonc",
  bundle: "dist/takos-worker.js",
  build: ["bun", "run", "build:takos-worker"],
  url: "https://yurumeet.com",
  smoke: ["bun", "run", "smoke:postdeploy"],
};

// The published identity. `worker.js` is the asset name because
// `release.lock.json` is append-only and its two existing entries name that
// file; `main.tf` resolves a release through the lock, so renaming the asset
// would strand every published pin.
const R = {
  surface: "yurumeet-worker-release",
  repository: RELEASE_REPOSITORY,
  bundle: W.bundle,
  asset: RELEASE_ASSET_NAME,
  manifest: RELEASE_MANIFEST_NAME,
  checksum: RELEASE_CHECKSUM_NAME,
  lock: "release.lock.json",
  smokeScript: "smoke:release-artifact",
};

const S = {
  surface: "yurumeet-site",
  project: "yurumeet-website",
  productionBranch: "main",
  source: "site",
  publicOrigin: "https://yurumeet.com",
};

const CONTRACT = {
  kind: "takos.deploy-contract@v2",
  surfaces: [
    {
      surface: W.surface,
      target: `cloudflare-worker:${W.worker}`,
      covers: ["wrangler.jsonc"],
      requiresScripts: ["check", "build:takos-worker", "smoke:postdeploy"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: ["YURUMEET_WRANGLER_CONFIG"],
      // code だけを差し替えます。直前の version がそのまま戻し先として残るので
      // irreversible は立ちません。durable store の schema を変える作業は
      // この surface ではなく、別の deliberate な手順です。
      triggers: [],
      obligations: {
        provenance: `refuses a dirty worktree, runs \`${OWNER_GATE}\`, builds ${W.bundle} from that worktree with \`bun run build\`, and records the commit and the bundle sha256 It takes the operator's realized deploy config from YURUMEET_WRANGLER_CONFIG and refuses to publish a config that still holds a self-host template placeholder.`,
        "post-conditions": `runs \`bun run smoke:postdeploy\`, which exercises real request paths against the deployed Worker rather than a health endpoint`,
        reversal: `the current version id is read and printed before publishing; restore it with \`wrangler versions list --name ${W.worker}\` and \`wrangler versions deploy <previous-id>@100%\``,
        "failure-handling":
          "prints the provider's own stdout and stderr, names whether the failure was before or after publication, and on a failed post-condition exits non-zero naming the previous version instead of retrying",
      },
    },
    {
      surface: R.surface,
      target: `github-release:${R.repository}/v<package-version>`,
      covers: [
        ".well-known/takosumi.json",
        "deploy/takoform/main.tf",
        "main.tf",
        "package.json",
        "release.lock.json",
        "scripts/build-takos-worker.ts",
        "scripts/release-artifact-manifest.mjs",
        "scripts/smoke-release-worker.mjs",
        "scripts/yurumeet-worker-bindings.ts",
      ],
      requiresScripts: ["check", "build:takos-worker", R.smokeScript],
      requiresTools: ["git", "bun", "gh"],
      requiresEnv: [],
      triggers: ["published-identity"],
      obligations: {
        provenance:
          "refuses a dirty, detached, or unpushed worktree; requires main for publication; runs `bun run check`; builds and boots the embedded Worker from that exact commit; requires package.json, the direct-Cloudflare module's release-tag default, the append-only release.lock.json pin, the repository manifest's module_default release inputs, and the deploy/takoform sourceBuild assets to identify the same tag, commit, and artifact digest; and records the source commit plus SHA-256 in the release manifest",
        "post-conditions":
          "reads the create-only tag and GitHub Release back, requires the tag to resolve to the source commit and the Release to report isImmutable:true, downloads all three assets, requires their exact SHA-256 digests, and boots the downloaded Worker in workerd with runtime-native DB/KV/MEDIA/queue bindings",
        reversal:
          "the release identity is never replaced or deleted by this entrypoint; consumers remain able to pin the preceding release through release.lock.json, and a defect is repaired by publishing a higher version",
        "failure-handling":
          "fails before mutation when the tag, the release, or an aligned lock pin is missing or already taken, printing the exact release.lock.json entry the publish requires; after release creation starts it reports an indeterminate publication and requires authoritative tag/release readback before any retry",
        "no-overwrite":
          "derives one SemVer tag from package.json, refuses any existing local/remote tag or GitHub Release, reads repos/tako0614/yurumeet/immutable-releases immediately before create and requires enabled:true, requires post-readback isImmutable:true, and uses GitHub create-only release publication without update or delete paths",
      },
    },
    {
      surface: S.surface,
      target: `cloudflare-pages:${S.project}`,
      covers: [S.source, "scripts/release-yurumeet-site.mjs"],
      requiresScripts: ["check:site"],
      requiresTools: ["git", "bun", "wrangler"],
      requiresEnv: [],
      productionBranch: S.productionBranch,
      triggers: [],
      obligations: {
        provenance: `integration accepts the exact worktree (including dirty, non-main work) and production requires a clean main equal to freshly fetched origin/${S.productionBranch}; both run bun run check:site once and record the source commit when available plus the site/index.html digest`,
        "post-conditions": `performs one Wrangler Pages upload to ${S.project}, then GETs the immutable deployment URL; production also GETs ${S.publicOrigin} and requires the uploaded home-page bytes`,
        reversal: `use the Pages provider deployment history to roll back the published deployment, or publish a corrected higher commit through this surface`,
        "failure-handling":
          "reports PRE_UPLOAD_FAILURE before Wrangler is invoked or POST_UPLOAD_INDETERMINATE after upload begins; it never retries or rolls back automatically",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requestedSurface = process.argv[2];
if (![W.surface, R.surface, S.surface].includes(requestedSurface)) {
  process.stderr.write(
    `usage: bun run deploy -- ${W.surface}\n` +
      `       bun run deploy -- ${R.surface} [--dry-run|--execute]\n` +
      `       bun run deploy -- ${S.surface} --environment=integration|production\n`,
  );
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}
const git = (...a) =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const run = (c, a) =>
  execFileSync(c, a, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const digest = (b) => createHash("sha256").update(b).digest("hex");

/**
 * One release is identified by five documents that are edited by hand at
 * different times. `releaseIdentityFailures` asks whether they agree; this
 * reads them and, when they do not, prints the exact `release.lock.json` entry
 * the publish requires. The entry cannot be guessed by hand — its manifest
 * digest is the digest of bytes this script produces — so naming what is
 * missing is not enough to act on.
 */
function requireReleaseIdentity({ tag, commit, bundleDigest, manifestDigest }) {
  const read = (path) => readFileSync(resolve(repo, path), "utf8");
  const failures = releaseIdentityFailures({
    tag,
    commit,
    assetName: R.asset,
    assetUrl: releaseAssetUrl(tag, R.asset),
    manifestUrl: releaseAssetUrl(tag, R.manifest),
    bundleDigest,
    manifestDigest,
    moduleSource: read("main.tf"),
    lock: JSON.parse(read(R.lock)),
    repository: JSON.parse(read(".well-known/takosumi.json")),
    takoformSource: read("deploy/takoform/main.tf"),
  });
  if (failures.length === 0) return;

  if (failures.some((failure) => failure.startsWith(`${R.lock} releases.`))) {
    failures.push(
      `add this ${R.lock} entry under releases.${tag} and re-run: ${JSON.stringify(
        buildReleaseLockEntry({ commit, tag, bundleDigest, manifestDigest }),
      )}`,
    );
  }
  die(
    "package, direct-Cloudflare module, release lock, repository manifest, and built Worker do not identify one release",
    failures,
  );
}

function smokeReleaseArtifact(artifactPath, expectedDigest, publishedTag) {
  process.stdout.write(
    `\n==> bun run ${R.smokeScript} -- ${artifactPath} sha256:${expectedDigest}\n`,
  );
  try {
    const output = run("bun", [
      "run",
      R.smokeScript,
      "--",
      artifactPath,
      `sha256:${expectedDigest}`,
    ]);
    process.stdout.write(output);
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    if (publishedTag) {
      die(
        `publication of ${publishedTag} completed but the downloaded Worker failed its runtime-native smoke; inspect the immutable Release before any new-version repair`,
        detail ? detail.split("\n").slice(0, 40) : [],
      );
    }
    die(
      "the candidate Worker failed its runtime-native smoke before publication",
      detail ? detail.split("\n").slice(0, 40) : [],
    );
  }
}

function requireCleanPushedSource(execute) {
  const dirty = git("status", "--porcelain");
  if (dirty !== "") {
    die(
      "the worktree is not clean; the published bytes must belong to one commit",
      dirty.split("\n").slice(0, 20),
    );
  }
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") {
    die("release verification requires a branch, found detached HEAD");
  }
  if (execute && branch !== "main") {
    die(`release publication requires main, found ${branch}`);
  }
  const commit = git("rev-parse", "HEAD");
  let upstream;
  try {
    upstream = git(
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    );
  } catch {
    die(`branch ${branch} has no pushed upstream`);
  }
  if (upstream !== `origin/${branch}`) {
    die(`branch ${branch} must track origin/${branch}, found ${upstream}`);
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--quiet",
      "origin",
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    { cwd: repo },
  );
  const remoteCommit = git("rev-parse", upstream);
  if (commit !== remoteCommit) {
    die(`local ${branch} ${commit} does not equal ${upstream} ${remoteCommit}`);
  }
  return { branch, commit };
}

function requireRepositoryImmutableReleases() {
  const endpoint = `repos/${R.repository}/immutable-releases`;
  let body;
  try {
    body = run("gh", ["api", endpoint]);
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    die(
      `cannot read ${endpoint} immediately before release creation; refusing to publish without authoritative immutable-release settings`,
      detail ? detail.split("\n").slice(0, 20) : [],
    );
  }

  let settings;
  try {
    settings = JSON.parse(body);
  } catch (error) {
    die(
      `${endpoint} returned invalid JSON; refusing to publish without authoritative immutable-release settings`,
      [String(error.message)],
    );
  }
  if (settings?.enabled !== true) {
    die(
      `${endpoint} is not enabled (enabled=${String(settings?.enabled)}); refusing to create a mutable Release`,
    );
  }
  process.stdout.write(`${endpoint} enabled:true\n`);
}

function publishWorkerRelease() {
  if (
    process.argv.includes("--execute") &&
    process.argv.includes("--dry-run")
  ) {
    die("choose exactly one of --dry-run or --execute");
  }
  const execute = process.argv.includes("--execute");
  const { branch, commit } = requireCleanPushedSource(execute);
  const packageJson = JSON.parse(
    readFileSync(resolve(repo, "package.json"), "utf8"),
  );
  const version = String(packageJson.version ?? "");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    die(`package.json version ${JSON.stringify(version)} is not SemVer`);
  }
  const tag = `v${version}`;
  if (git("tag", "--list", tag) !== "") die(`local tag ${tag} already exists`);
  const remoteTag = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ]).trim();
  if (remoteTag !== "") die(`remote tag ${tag} already exists`);
  try {
    run("gh", ["release", "view", tag, "--repo", R.repository]);
    die(`GitHub Release ${tag} already exists`);
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (!/release not found|HTTP 404/iu.test(stderr)) {
      die(`cannot prove GitHub Release ${tag} is absent: ${stderr.trim()}`);
    }
  }

  process.stdout.write(`source ${commit} (${branch})\n`);
  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

  const bundlePath = resolve(repo, R.bundle);
  if (!existsSync(bundlePath)) die(`${R.bundle} is missing after the build`);
  const bundleDigest = digest(readFileSync(bundlePath));
  const { bytes: manifestBytes, digest: manifestDigest } = buildReleaseManifest(
    {
      commit,
      tag,
      bundleDigest,
    },
  );
  requireReleaseIdentity({ tag, commit, bundleDigest, manifestDigest });

  const releaseDir = mkdtempSync(resolve(tmpdir(), "yurumeet-release-"));
  const artifactPath = resolve(releaseDir, R.asset);
  const manifestPath = resolve(releaseDir, R.manifest);
  const checksumPath = resolve(releaseDir, R.checksum);
  copyFileSync(bundlePath, artifactPath);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(checksumPath, buildReleaseChecksum(bundleDigest));
  const expectedDigests = {
    [R.asset]: bundleDigest,
    [R.manifest]: manifestDigest,
    [R.checksum]: digest(readFileSync(checksumPath)),
  };

  smokeReleaseArtifact(artifactPath, bundleDigest);
  process.stdout.write(`candidate ${tag} ${R.bundle} sha256:${bundleDigest}\n`);
  if (!execute) {
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "takos.deploy-result@v1",
          surface: R.surface,
          target: `github-release:${R.repository}/${tag}`,
          commit,
          tag,
          sourceIdentity: "PACKAGE_MODULE_LOCK_REPOSITORY_ARTIFACT_ALIGNED",
          assetDigests: expectedDigests,
          status: "DRY_RUN_VERIFIED",
        },
        null,
        2,
      )}\n`,
    );
    rmSync(releaseDir, { recursive: true, force: true });
    return;
  }

  process.stdout.write(`\n==> create-only GitHub Release ${tag}\n`);
  requireRepositoryImmutableReleases();
  try {
    const output = run("gh", [
      "release",
      "create",
      tag,
      artifactPath,
      manifestPath,
      checksumPath,
      "--repo",
      R.repository,
      "--target",
      commit,
      "--title",
      `Yurumeet ${tag}`,
      "--notes",
      `Worker release built from ${commit}.`,
    ]);
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
    die(
      `publication of ${tag} started but did not complete cleanly; inspect the remote tag and Release before retrying`,
    );
  }

  const publishedTag = run("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
  ])
    .trim()
    .split(/\s+/u)[0];
  if (publishedTag !== commit) {
    die(
      `published tag ${tag} resolves to ${publishedTag || "<missing>"}, expected ${commit}`,
    );
  }
  const release = JSON.parse(
    run("gh", [
      "release",
      "view",
      tag,
      "--repo",
      R.repository,
      "--json",
      "isDraft,isPrerelease,isImmutable,tagName,url,assets",
    ]),
  );
  if (
    release.isDraft ||
    release.isPrerelease ||
    release.isImmutable !== true ||
    release.tagName !== tag
  ) {
    die(
      `published Release ${tag} has unexpected state (isImmutable=${String(release.isImmutable)})`,
    );
  }
  const remoteAssets = new Map(
    release.assets.map((asset) => [asset.name, asset.digest]),
  );
  for (const [name, expected] of Object.entries(expectedDigests)) {
    if (remoteAssets.get(name) !== `sha256:${expected}`) {
      die(
        `published asset ${name} digest ${remoteAssets.get(name) ?? "<missing>"} does not equal sha256:${expected}`,
      );
    }
  }

  const downloadDir = resolve(releaseDir, "readback");
  mkdirSync(downloadDir);
  run("gh", [
    "release",
    "download",
    tag,
    "--repo",
    R.repository,
    "--dir",
    downloadDir,
  ]);
  for (const [name, expected] of Object.entries(expectedDigests)) {
    const actual = digest(readFileSync(resolve(downloadDir, name)));
    if (actual !== expected) {
      die(
        `downloaded asset ${name} digest ${actual} does not equal ${expected}`,
      );
    }
  }
  smokeReleaseArtifact(resolve(downloadDir, R.asset), bundleDigest, tag);

  process.stdout.write(
    `\n${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        surface: R.surface,
        target: `github-release:${R.repository}/${tag}`,
        commit,
        tag,
        sourceIdentity: "PACKAGE_MODULE_LOCK_REPOSITORY_ARTIFACT_ALIGNED",
        releaseUrl: release.url,
        assetDigests: expectedDigests,
        postConditions: "EXACT_RELEASE_READBACK_AND_RUNTIME_NATIVE_SMOKE",
        status: "PUBLISHED",
      },
      null,
      2,
    )}\n`,
  );
  rmSync(releaseDir, { recursive: true, force: true });
}

if (requestedSurface === R.surface) {
  publishWorkerRelease();
  process.exit(0);
}

if (requestedSurface === S.surface) {
  const args = process.argv.slice(3);
  if (
    args.length !== 1 ||
    !/^--environment=(?:integration|production)$/u.test(args[0])
  ) {
    die(
      `${S.surface} requires exactly one --environment=integration|production flag`,
    );
  }
  const environment = args[0].slice("--environment=".length);
  const { deployYurumeetSite, reportYurumeetSiteReleaseFailure } =
    await import("./release-yurumeet-site.mjs");
  try {
    await deployYurumeetSite({ environment });
  } catch (error) {
    reportYurumeetSiteReleaseFailure(error);
    process.exit(1);
  }
  process.exit(0);
}

// operator の realized config を受け取れるようにします。repo の wrangler config が
// self-host 向け placeholder を含んだままなら止めます。本番と取り違えて publish
// しないためです。
const CONFIG_ENV = "YURUMEET_WRANGLER_CONFIG";
const configPath = process.env[CONFIG_ENV] ?? W.config;
const resolvedConfig = existsSync(resolve(repo, configPath))
  ? resolve(repo, configPath)
  : configPath;
if (!existsSync(resolvedConfig)) {
  die(
    `deploy config ${configPath} does not exist; set ${CONFIG_ENV} to the operator's realized config`,
  );
}
const configValues = readFileSync(resolvedConfig, "utf8")
  .split("\n")
  .filter((line) => !/^\s*(?:#|\/\/)/u.test(line))
  .join("\n");
const placeholder =
  /(?:[=:]\s*["']?[^"'\n]*)(example\.com|REPLACE_[A-Z_]+|<[a-z-]+>|xxxxx)/iu.exec(
    configValues,
  );
if (placeholder) {
  die(
    `${configPath} still contains the self-host template placeholder ${JSON.stringify(placeholder[1])}; ` +
      `set ${CONFIG_ENV} to the operator's realized config instead of publishing the template`,
  );
}

// provenance
const dirty = git("status", "--porcelain");
if (dirty !== "") {
  die(
    "the worktree is not clean; the published bundle must belong to one commit",
    dirty.split("\n").slice(0, 20),
  );
}
const commit = git("rev-parse", "HEAD");
process.stdout.write(
  `source ${commit} (${git("rev-parse", "--abbrev-ref", "HEAD")})\n`,
);

process.stdout.write(`\n==> ${OWNER_GATE}\n`);
execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });

process.stdout.write(`\n==> bun run build\n`);
execFileSync(W.build[0], W.build.slice(1), { cwd: repo, stdio: "inherit" });

const bundlePath = resolve(repo, W.bundle);
if (!existsSync(bundlePath)) die(`${W.bundle} is missing after the build`);
const bundleDigest = digest(readFileSync(bundlePath));
process.stdout.write(
  `\ncandidate ${W.bundle} sha256 ${bundleDigest.slice(0, 16)}\n`,
);

// reversal: 戻し先の version を先に読む。読めなければ publish しない。
let previous = null;
try {
  const listed = run("wrangler", [
    "versions",
    "list",
    "--name",
    W.worker,
    "--config",
    configPath,
  ]);
  previous =
    listed.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u,
    )?.[1] ?? null;
} catch (error) {
  die(`cannot read the current version list: ${error.message}`);
}
if (!previous)
  die("no current version was readable, so there is no revert point");
process.stdout.write(`previous version ${previous}\n`);

process.stdout.write(`\n==> publishing ${W.worker}\n`);
let output;
try {
  output = run("wrangler", ["deploy", "--config", configPath]);
} catch (error) {
  process.stderr.write(`${error.stdout ?? ""}${error.stderr ?? ""}\n`);
  die(
    "publication failed; production may be unchanged or partially updated. " +
      `Reconcile against version ${previous} before retrying.`,
  );
}
process.stdout.write(output);

// post-conditions: 実利用者の経路が通ることまで確認する。
let postOk = false;
let postDetail = null;
try {
  process.stdout.write(`\n==> bun run smoke:postdeploy\n`);
  postDetail = run(W.smoke[0], W.smoke.slice(1));
  process.stdout.write(postDetail);
  postOk = true;
} catch (error) {
  postDetail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  process.stderr.write(postDetail);
  postOk = false;
}

const result = {
  kind: "takos.deploy-result@v1",
  surface: W.surface,
  target: `cloudflare-worker:${W.worker}`,
  commit,
  bundleDigest,
  previousVersion: previous,
  postConditions: postOk ? "PASSED" : "FAILED",
  status: postOk ? "PUBLISHED" : "INDETERMINATE",
};
process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);

if (!postOk) {
  process.stderr.write(
    `\nthe new version is live on ${W.worker} but the post-conditions did not pass. ` +
      `Do not retry blindly: read \`wrangler versions list --name ${W.worker}\` and decide whether to ` +
      `roll back to ${previous}.\n`,
  );
  process.exit(1);
}
