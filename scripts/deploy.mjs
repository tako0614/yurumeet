#!/usr/bin/env bun

// yurumeet の唯一の deploy entrypoint です。
//
// 共通の obligation と trigger は takos-control の
// `engineering.policy.json` → `deploy` が正本です。
//
//   bun run deploy -- yurumeet-worker
//   bun run deploy -- yurumeet-worker-release [--dry-run|--execute]
//   bun run deploy -- yurumeet-site --environment=integration|production
//   bun run deploy -- yurumeet-integration --environment=integration --phase=<phase>
//
// 既存の3つの surface は publish するものが違い、負う obligation も違います。
// worker は session secret の継承設定を admission する authority-sensitive surface、
// worker-release は consumer が pin する identity を mint する published-identity
// surface、site は静的な landing site です。
//
// これら3つが publish するのは **code と静的 asset だけ** です。durable store
// (D1 DB / KV / R2 MEDIA) は変更しません。Worker publish 前には D1 を SELECT だけで
// 読み、Core 4.1.14 が必要とする migration 0030–0036 の metadata を確認します。
// ⚠ yurucommu 系の live D1 は `_cf_migrations` 台帳が実態とずれています。
// `wrangler d1 migrations apply` を絶対に走らせないこと。schema 変更は
// operator が別途行う手順です。この script は台帳と schema metadata を read-only で確認します。
// yurumeet-integration は別 surface であり、厳密に固定した新規 Cloudflare
// resources、empty D1 fresh-schema、Worker activation と isolated custom domain だけを扱います。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  buildReleaseManifest,
  releaseAssetUrl,
} from "./release-artifact-manifest.mjs";
import { releaseCandidateIdentityFailures } from "./release-identity.mjs";
import { MEDIA_DELETION_SCHEMA_QUERY } from "./check-media-deletion-schema.mjs";
import {
  CORE_UPGRADE_MIGRATIONS,
  CORE_UPGRADE_SCHEMA_QUERY,
} from "./core-upgrade-schema.mjs";
import {
  createYurumeetCodeOnlyProvider,
  YurumeetProviderFailure,
} from "./yurumeet-code-only-provider.mjs";

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
const WORKER_EMPTY_ENV_FILE = resolve(
  repo,
  "scripts/worker-publish-empty.env.example",
);

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
      covers: [
        "wrangler.jsonc",
        "scripts/deploy.mjs",
        "scripts/yurumeet-worker-bindings.ts",
        "scripts/worker-publish-empty.env.example",
        "scripts/yurumeet-code-only-provider.mjs",
        "scripts/check-media-deletion-schema.mjs",
        "scripts/core-upgrade-schema.mjs",
      ],
      requiresScripts: ["check", "build:takos-worker", "smoke:postdeploy"],
      requiresTools: ["git", "bun", "node", "wrangler"],
      requiresEnv: [
        "TAKOSUMI_CAPSULE_OUTPUTS_FILE",
        "YURUMEET_E2E_PASSWORD",
        "YURUMEET_E2E_SESSION_COOKIE",
        "YURUMEET_WRANGLER_CONFIG",
      ],
      // active Deployment と full traffic map を再確認してから code を差し替えます。
      // re-read は CAS ではないため、同時 publisher を避ける operator 協調が必要です。
      triggers: ["authority"],
      obligations: {
        provenance: `requires the realized YURUMEET_WRANGLER_CONFIG to declare YURUCOMMU_SESSION_HASH_SALT in root secrets.required and pin name=${W.worker} plus an account_id; rejects selected Wrangler environments and non-default Cloudflare endpoints; uses a verified zero-byte --env-file only for Wrangler auth token --json to read existing authentication, never to create permissions; captures the active Deployment and one exact 100% predecessor before ${OWNER_GATE}, refusing split traffic and config/binding drift; refuses dirty or changed source, builds ${W.bundle}, records commit and bundle sha256, and runs fixed read-only D1 metadata queries against the actual predecessor DB requiring migration 0030 structure plus migration 0031–0036 ledger/schema prerequisites, without applying migrations or writing schema/data; uploads one Version with strict secret inheritance and every binding explicitly pinned to that predecessor, then promotes through the fixed Deployment API without resource, Secret, settings or trigger writes.`,
        "post-conditions":
          "checks authoritative uploaded code and complete non-code closure before promotion; runs bun run smoke:postdeploy through the launch URL from TAKOSUMI_CAPSULE_OUTPUTS_FILE with YURUMEET_E2E_SESSION_COOKIE for OIDC-only installations or YURUMEET_E2E_PASSWORD; finally rechecks exact acknowledged Deployment/Version, code and non-code settings plus predecessor availability; local and CI fixtures do not qualify live permission or API behavior",
        reversal:
          "captures the active Deployment id and complete version/percentage traffic map; prints a credential-free manual POST Deployment API request restoring that map, never Wrangler versions deploy because that command may also patch settings; reconcile current traffic and review predecessor availability/secret custody before manual recovery; re-read is not an atomic compare-and-swap, so operator serialization is required",
        "failure-handling":
          "invalid target/environment/endpoint/empty-env-file/session-salt config blocks before authentication or gate work; malformed active state or missing/invalid migration 0030–0036 metadata prerequisites blocks before Version upload; prints bounded credential-masked provider code/messages, never raw authentication or binding bodies; PRE_UPLOAD_FAILURE before upload, monotonic indeterminate recovery after any attempted Version or Deployment write, with full prior traffic map and exact rollbackRequest; no automatic retry or rollback",
        "independent-review":
          "review exact source/native/CI evidence and API contracts for strict secret inheritance with explicit predecessor version_id, actual DB authority, code/non-code readbacks, authentication-output suppression, fixed target, no auxiliary mutations and full recovery state; metadata proves the active Worker binding declaration, not the secret value or entropy; existing secrets remain credential-owner custody and must not rotate",
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
        "CHANGELOG.md",
        "release.lock.json",
        "scripts/release-identity.mjs",
        "scripts/build-takos-worker.ts",
        "scripts/release-artifact-manifest.mjs",
        "scripts/smoke-release-worker.mjs",
        "scripts/yurumeet-worker-bindings.ts",
      ],
      requiresScripts: ["check", "build:takos-worker", R.smokeScript],
      requiresTools: ["git", "bun", "node", "gh"],
      requiresEnv: [],
      triggers: ["published-identity", "authority"],
      obligations: {
        provenance:
          "refuses a dirty, detached, or unpushed worktree; requires main for publication; requires the exact package version's CHANGELOG.md section as release notes; runs `bun run check`; copies and boots the embedded Worker from that exact commit; requires the new package.json tag to be absent from release.lock.json while the direct-Cloudflare module defaults name that exact tag, GitHub worker.js asset URL, and measured Worker SHA-256; verifies repository module_default inputs and deploy/takoform sourceBuild assets; records the source commit and SHA-256 in the release manifest; rechecks clean remote HEAD and candidate bytes immediately before create",
        "post-conditions":
          "reads the create-only tag and GitHub Release back, requires the tag to resolve to the source commit and the Release to report isImmutable:true, requires exactly the three expected assets, downloads them, requires their exact SHA-256 digests, and boots the downloaded Worker in workerd with runtime-native DB/KV/MEDIA/queue bindings; only after this readback may a separate source commit append the actual release.lock.json pin and optionally switch the root module from exact explicit URL/digest defaults to lock mode",
        reversal:
          "the release identity is never replaced or deleted by this entrypoint; consumers remain able to pin the preceding release through release.lock.json, and a defect is repaired by publishing a higher version",
        "failure-handling":
          "fails before mutation when the candidate tag/release already exists, a candidate lock pin was prewritten, the root module candidate URL/digest differs from measured bytes, source moved, or copied assets changed; after release creation starts it reports an indeterminate publication and requires authoritative tag/release readback before any retry",
        "no-overwrite":
          "derives one SemVer tag from package.json, checks existing local/remote tag and GitHub Release both before and after qualification, reads repos/tako0614/yurumeet/immutable-releases immediately before create and requires enabled:true, requires post-readback isImmutable:true, and uses GitHub create-only release publication without update or delete paths",
        "independent-review":
          "before publishing, independently review exact source, native artifact, and CI evidence for the immutable Worker's required YURUCOMMU_SESSION_HASH_SALT runtime contract and the direct publisher's strict config declaration; this release proves no deployed secret value or active binding, which remains separate operator-owned custody and must be preserved exactly",
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
    {
      surface: "yurumeet-integration",
      target:
        "cloudflare:isolated Yurumeet GA integration resources and ga-meet-20261012.yurucommu.com",
      covers: [
        "scripts/deploy.mjs",
        "scripts/deploy-integration.mjs",
        "scripts/deploy-integration.d.mts",
        "scripts/deploy-integration.test.ts",
        "scripts/deploy-integration-parser-probe.mjs",
        "scripts/deploy-integration-parser-probe.d.mts",
        "scripts/deploy-integration-parser-probe.test.ts",
        "scripts/deploy-integration-schema.mjs",
        "scripts/deploy-integration-schema.d.mts",
        "scripts/deploy-integration-schema.test.ts",
        "main.tf",
        "outputs.tf",
        "package.json",
        "release.lock.json",
        "wrangler.jsonc",
        ".terraform.lock.hcl",
        "docs/deploy-integration.md",
      ],
      requiresScripts: ["deploy"],
      requiresTools: ["git", "bun", "tofu", "node"],
      requiresEnv: [
        "YURUMEET_INTEGRATION_TARGET",
        "CLOUDFLARE_API_TOKEN",
        "TF_VAR_encryption_key",
        "TF_VAR_session_hash_salt",
        "TF_VAR_auth_password_hash",
      ],
      triggers: ["authority", "irreversible"],
      obligations: {
        provenance:
          "requires YURUMEET_INTEGRATION_TARGET and ephemeral CLOUDFLARE_API_TOKEN; binds one private target file to the exact clean reviewed source commit, existing Cloudflare account/zone, isolated origin and resource prefix, and immutable release.lock.json v0.2.0 Worker SHA-256; activation requires ephemeral TF_VAR_encryption_key, TF_VAR_session_hash_salt, and TF_VAR_auth_password_hash; runs each explicit integration phase independently and preserves private OpenTofu state/plan outside Git worktrees",
        "post-conditions":
          "preflight proves exact zone ownership and complete paginated no-takeover inventories; resources creates only the new D1/R2/KV/Queues/random identifier with Worker disabled; fresh-schema executes only the published Core 4.1.14 migration set on that fresh D1; probe-case-parser is diagnostic-only and creates only three exact standalone D1 fixtures, while probe-case-parser-comparison creates only the two remaining parenthesized/values fixtures and never reuses or recreates the observed bare fixture; each sends one bounded rollback-observation batch per new D1, persists private 0600 raw before/after sqlite_master responses with SHA-256 values, and verifies the full schema is unchanged against a complete unfiltered single-page inventory capped at 10000; activate creates only the Worker/queue consumers/cron with ephemeral test credentials; domain requires one exact changeset addition and reads back the exact hostname/service/zone before checking the public origin; APPLIED state, parser diagnostics, and HTTP 2xx do not qualify Worker binding closure or product use, which require a separate exact provider GET/readback and scoped authenticated user smoke before any live-qualified or GA claim",
        reversal:
          "all resources are isolated integration fixtures; on failure, stop and inspect authoritative Cloudflare and private OpenTofu state, then use an independently reviewed forward cleanup after preserving evidence; no destroy or automatic rollback path is included",
        "failure-handling":
          "denied, malformed, incomplete, colliding, or uncertain preflight refuses progress; apply/state-readback failures are POST_APPLY_INDETERMINATE, fresh-schema executor errors are POST_SCHEMA_INDETERMINATE, parser-probe create/write/readback uncertainty is POST_PARSER_PROBE_INDETERMINATE, and domain PUT/provider/public-readback failures are POST_DOMAIN_INDETERMINATE; each requires authoritative state/provider readback before another invocation; parser probes never retry or delete, diagnostics remain in private 0600 files, and credentials are never printed",
        "pre-mutation-proof":
          "before resource creation, requires exact zone ownership and complete paginated no-takeover inventories; before each parser probe, requests the complete unfiltered D1 inventory with page=1&per_page=10000 and requires one complete page (page 1, per_page 10000, count equals rows and total_count no greater than 10000), the exact reserved D1 name to be absent, the target Worker to be absent, one exact account-scoped create UUID/name readback, and a fresh SQLite schema; each newly created database receives one seven-statement batch only and must read back the complete pre-write sqlite_master schema after the expected late duplicate-key failure, with no retry, reuse, or deletion; comparison mode covers only parenthesized and values variants and never adopts the observed bare database; before the first whole-script migration request, verifies the new D1 UUID/name, absent target Worker, empty SQLite schema, ledger absence, exact Core 4.1.14 runner and 35 SQL hashes, and identical whole-script REST {sql} duplicate-key rollback behavior; before domain attachment, requires a changeset with one exact addition and no updates, deletions, or conflicts, then sends both override flags false",
        "independent-review":
          "require a non-author review of exact source, immutable artifact pin, private state custody, fresh-database-only migration executor, exact create-only plans, test credential custody, resource inventories, the three original parser-probe D1 names plus comparison-only parenthesized/values names and one-batch rollback/readback bounds, and custom-domain changeset/no-overwrite flags before any live mutation; separately inspect exact provider binding closure and run scoped authenticated user smoke before any live-qualified or GA claim",
      },
    },
  ],
};

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const requestedSurface = process.argv[2];
if (
  ![W.surface, R.surface, S.surface, "yurumeet-integration"].includes(
    requestedSurface,
  )
) {
  process.stderr.write(
    `usage: bun run deploy -- ${W.surface}\n` +
      `       bun run deploy -- ${R.surface} [--dry-run|--execute]\n` +
      `       bun run deploy -- ${S.surface} --environment=integration|production\n` +
      "       bun run deploy -- yurumeet-integration --environment=integration --phase=<phase>\n",
  );
  process.exit(1);
}

function die(message, detail = []) {
  process.stderr.write(`deploy blocked: ${message}\n`);
  for (const line of detail) process.stderr.write(`- ${line}\n`);
  process.exit(1);
}
if (requestedSurface === "yurumeet-integration") {
  try {
    const { deployIntegration } = await import("./deploy-integration.mjs");
    const result = await deployIntegration(process.argv.slice(3));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const phase = error.phase ?? "PRE_MUTATION_FAILURE";
    process.stderr.write(
      `integration deploy stopped (${phase}): ${error.message}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
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
 * An unpublished candidate is measured from this source commit. Its future
 * lock pin cannot be in this same commit, so verify that it is absent while
 * the root module resolves this exact tag, URL, and measured Worker digest.
 * A separate follow-up commit records the pin after publication readback.
 */
function requireCandidateIdentity({
  tag,
  commit,
  bundleDigest,
  manifestDigest,
}) {
  const read = (path) => readFileSync(resolve(repo, path), "utf8");
  const failures = releaseCandidateIdentityFailures({
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
  die(
    "candidate identity, root module tag/URL/digest, repository manifest, and copied Worker do not agree",
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

function requireReleaseAbsent(tag) {
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
}

function requireCandidateAssetsUnchanged(paths, expectedDigests) {
  for (const [name, path] of Object.entries(paths)) {
    const actual = digest(readFileSync(path));
    if (actual !== expectedDigests[name]) {
      die(
        `candidate ${name} changed after native verification: sha256:${actual}`,
      );
    }
  }
}

function requireReleaseNotes(version) {
  const source = readFileSync(resolve(repo, "CHANGELOG.md"), "utf8");
  const headings = [...source.matchAll(/^## ([^\s]+)[^\n]*$/gmu)];
  const current = headings.find((heading) => heading[1] === version);
  if (!current)
    die(`CHANGELOG.md has no section for package version ${version}`);
  const next = headings.find((heading) => heading.index > current.index);
  const section = `${source.slice(current.index, next?.index ?? source.length).trimEnd()}\n`;
  if (!section.slice(current[0].length).trim()) {
    die(
      `CHANGELOG.md section for package version ${version} has no release notes`,
    );
  }
  return section;
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
  const releaseNotes = requireReleaseNotes(version);
  requireReleaseAbsent(tag);

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
  requireCandidateIdentity({ tag, commit, bundleDigest, manifestDigest });

  const releaseDir = mkdtempSync(resolve(tmpdir(), "yurumeet-release-"));
  const artifactPath = resolve(releaseDir, R.asset);
  const manifestPath = resolve(releaseDir, R.manifest);
  const checksumPath = resolve(releaseDir, R.checksum);
  const notesPath = resolve(releaseDir, "release-notes.md");
  copyFileSync(bundlePath, artifactPath);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(checksumPath, buildReleaseChecksum(bundleDigest));
  writeFileSync(notesPath, releaseNotes);
  const expectedDigests = {
    [R.asset]: bundleDigest,
    [R.manifest]: manifestDigest,
    [R.checksum]: digest(readFileSync(checksumPath)),
  };

  smokeReleaseArtifact(artifactPath, bundleDigest);
  const candidatePaths = {
    [R.asset]: artifactPath,
    [R.manifest]: manifestPath,
    [R.checksum]: checksumPath,
  };
  const refreshed = requireCleanPushedSource(execute);
  if (refreshed.commit !== commit || refreshed.branch !== branch) {
    die(
      `source moved after candidate verification: ${branch} ${commit} -> ${refreshed.branch} ${refreshed.commit}`,
    );
  }
  requireReleaseAbsent(tag);
  requireCandidateAssetsUnchanged(candidatePaths, expectedDigests);
  if (readFileSync(notesPath, "utf8") !== releaseNotes) {
    die("candidate release notes changed after source verification");
  }
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
          sourceIdentity: "UNPUBLISHED_CANDIDATE_EXACT_MODULE_ASSET_VALIDATED",
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
      "--notes-file",
      notesPath,
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
  if (!Array.isArray(release.assets)) {
    die(`published Release ${tag} did not report an asset inventory`);
  }
  const remoteAssets = new Map(
    release.assets.map((asset) => [asset.name, asset.digest]),
  );
  const expectedNames = Object.keys(expectedDigests).sort();
  const actualNames = release.assets.map((asset) => asset.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    die(
      `published Release ${tag} asset inventory ${JSON.stringify(actualNames)} does not equal ${JSON.stringify(expectedNames)}`,
    );
  }
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
  const downloadedNames = readdirSync(downloadDir).sort();
  if (JSON.stringify(downloadedNames) !== JSON.stringify(expectedNames)) {
    die(
      `downloaded Release ${tag} asset inventory ${JSON.stringify(downloadedNames)} does not equal ${JSON.stringify(expectedNames)}`,
    );
  }
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
        sourceIdentity: "UNPUBLISHED_CANDIDATE_EXACT_MODULE_ASSET_VALIDATED",
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
  : resolve(configPath);
if (!existsSync(resolvedConfig)) {
  die(
    `deploy config ${configPath} does not exist; set ${CONFIG_ENV} to the operator's realized config`,
  );
}
const configText = readFileSync(resolvedConfig, "utf8");
function requireSessionSaltConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    die(
      "the realized Wrangler config must be strict JSON and declare the required session-salt secret; publication was not attempted",
    );
  }

  const required = config?.secrets?.required;
  const requiredIsValid =
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    config.secrets &&
    typeof config.secrets === "object" &&
    !Array.isArray(config.secrets) &&
    Array.isArray(required) &&
    required.length > 0 &&
    required.every((name) => typeof name === "string" && name.trim() !== "") &&
    new Set(required).size === required.length &&
    required.filter((name) => name === "YURUCOMMU_SESSION_HASH_SALT").length ===
      1;
  const hasPlaintextSalt = (bindings) =>
    bindings &&
    typeof bindings === "object" &&
    !Array.isArray(bindings) &&
    Object.hasOwn(bindings, "YURUCOMMU_SESSION_HASH_SALT");
  const hasEnvironmentPlaintextSalt =
    config?.env &&
    typeof config.env === "object" &&
    !Array.isArray(config.env) &&
    Object.values(config.env).some(
      (environment) =>
        environment &&
        typeof environment === "object" &&
        !Array.isArray(environment) &&
        hasPlaintextSalt(environment.vars),
    );

  if (
    !requiredIsValid ||
    hasPlaintextSalt(config?.vars) ||
    hasEnvironmentPlaintextSalt
  ) {
    die(
      "the realized Wrangler config must declare YURUCOMMU_SESSION_HASH_SALT exactly once in root secrets.required and must not set it in plaintext vars; publication was not attempted",
    );
  }
  return config;
}
const realizedWorkerConfig = requireSessionSaltConfig(configText);
if (realizedWorkerConfig.name !== W.worker) {
  die(
    `the realized Wrangler config must target Worker ${W.worker}; publication was not attempted`,
  );
}
if (
  typeof realizedWorkerConfig.account_id !== "string" ||
  !/^[a-f0-9]{32}$/u.test(realizedWorkerConfig.account_id)
) {
  die(
    "the realized Wrangler config must pin a 32-character lowercase account_id; publication was not attempted",
  );
}
if (
  typeof process.env.CLOUDFLARE_ENV === "string" &&
  process.env.CLOUDFLARE_ENV !== ""
) {
  die(
    "CLOUDFLARE_ENV selects an unpinned Wrangler environment; publication was not attempted",
  );
}
if (
  process.env.WRANGLER_API_ENVIRONMENT !== undefined &&
  process.env.WRANGLER_API_ENVIRONMENT !== "production"
) {
  die(
    "WRANGLER_API_ENVIRONMENT must be production; publication was not attempted",
  );
}
if (
  process.env.CLOUDFLARE_COMPLIANCE_REGION !== undefined &&
  process.env.CLOUDFLARE_COMPLIANCE_REGION !== "public"
) {
  die(
    "CLOUDFLARE_COMPLIANCE_REGION must be public; publication was not attempted",
  );
}
if (
  realizedWorkerConfig.compliance_region !== undefined &&
  realizedWorkerConfig.compliance_region !== "public"
) {
  die(
    "the realized Wrangler config compliance_region must be public; publication was not attempted",
  );
}
const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
for (const variable of ["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL"]) {
  const value = process.env[variable];
  if (value !== undefined && value !== DEFAULT_CLOUDFLARE_API_BASE_URL) {
    die(
      `${variable} selects a non-default Cloudflare API endpoint; publication was not attempted`,
    );
  }
}
try {
  requireEmptyWranglerEnvFile("Worker config admission");
} catch (error) {
  die(error.message);
}
const configValues = configText
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

function requireStableDeployConfig(phase) {
  let current;
  try {
    current = readFileSync(resolvedConfig, "utf8");
  } catch {
    throw new Error(
      `cannot re-read the realized deploy config before ${phase}`,
    );
  }
  if (current !== configText)
    throw new Error(`the realized deploy config changed before ${phase}`);
}
function requireEmptyWranglerEnvFile(phase) {
  let bytes;
  try {
    bytes = readFileSync(WORKER_EMPTY_ENV_FILE);
  } catch {
    throw new Error(
      `the explicit Wrangler env-file is missing before ${phase}`,
    );
  }
  if (bytes.byteLength !== 0)
    throw new Error(
      `the explicit Wrangler env-file must remain zero bytes before ${phase}`,
    );
}
function readExistingWranglerAuthentication() {
  requireStableDeployConfig("existing authentication read");
  requireEmptyWranglerEnvFile("existing authentication read");
  let output;
  try {
    output = execFileSync(
      "wrangler",
      [
        "auth",
        "token",
        "--json",
        "--config",
        resolvedConfig,
        "--env-file",
        WORKER_EMPTY_ENV_FILE,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024,
      },
    );
  } catch {
    // Even failed auth output may contain credential material. Never print it.
    throw new Error(
      "cannot obtain existing Wrangler authentication; no credential or permission was created; auth output was suppressed",
    );
  }
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(
      "Wrangler authentication output is invalid; credential output was suppressed",
    );
  }
  const text = (item) =>
    typeof item === "string" &&
    item !== "" &&
    item.trim() === item &&
    !/[\r\n]/u.test(item);
  const keys = (names) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name));
  if (
    keys(["type", "token"]) &&
    ["api_token", "oauth"].includes(value.type) &&
    text(value.token)
  )
    return value;
  if (
    keys(["type", "key", "email"]) &&
    value.type === "api_key" &&
    text(value.key) &&
    text(value.email)
  )
    return value;
  throw new Error(
    "Wrangler authentication metadata is unsupported; credential output was suppressed",
  );
}

// Recovery is an explicit provider request, never an automatic CLI rollback.
function rollbackRequest(trafficMap) {
  return {
    method: "POST",
    path: `/accounts/${realizedWorkerConfig.account_id}/workers/scripts/${W.worker}/deployments`,
    body: {
      strategy: "percentage",
      versions: trafficMap.map(({ versionId, percentage }) => ({
        version_id: versionId,
        percentage,
      })),
    },
  };
}
let phase = "PRE_UPLOAD_FAILURE";
let snapshot, commit, bundleDigest, versionId, deploymentId;
let postConditions = "NOT_RUN";
let authentication;
function safeWorkerText(value) {
  const secrets = [];
  const add = (item) => {
    if (typeof item === "string" && item !== "")
      secrets.push(item, JSON.stringify(item).slice(1, -1));
    else if (item && typeof item === "object") Object.values(item).forEach(add);
  };
  add(realizedWorkerConfig.vars);
  for (const item of [
    authentication?.token,
    authentication?.key,
    authentication?.email,
    process.env.YURUMEET_E2E_PASSWORD,
    process.env.YURUMEET_E2E_SESSION_COOKIE,
  ])
    add(item);
  let text = String(value ?? "");
  for (const item of [...new Set(secrets)].sort((a, b) => b.length - a.length))
    text = text.replaceAll(item, "[REDACTED]");
  return text.slice(0, 4096);
}
function recoveryRecord(status, fallback) {
  const prior = snapshot ?? fallback;
  return {
    kind: "takos.deploy-result@v1",
    surface: W.surface,
    target: `cloudflare-worker:${W.worker}`,
    accountId: realizedWorkerConfig.account_id,
    commit,
    bundleDigest,
    phase,
    status,
    postConditions,
    ...(prior
      ? {
          previousDeployment: {
            id: prior.deploymentId,
            versions: prior.trafficMap.map(({ versionId, percentage }) => ({
              version_id: versionId,
              percentage,
            })),
          },
          predecessorVersionId: prior.predecessorVersionId,
          closureDigest: prior.closureDigest,
          rollbackRequest: rollbackRequest(prior.trafficMap),
        }
      : {}),
    versionId: versionId ?? fallback?.versionId,
    deploymentId: deploymentId ?? fallback?.publishedDeploymentId,
    operatorSerializationRequired: true,
  };
}
function requireReviewedSource() {
  if (
    git("status", "--porcelain") !== "" ||
    (commit && git("rev-parse", "HEAD") !== commit)
  ) {
    throw new Error("the worktree is not clean at the captured source commit");
  }
}
try {
  requireReviewedSource();
  commit = git("rev-parse", "HEAD");
  process.stdout.write(`source ${commit}\n`);
  authentication = readExistingWranglerAuthentication();
  const provider = createYurumeetCodeOnlyProvider({
    accountId: realizedWorkerConfig.account_id,
    workerName: W.worker,
    authentication,
  });
  snapshot = await provider.readTrafficAndVersion({
    requiredSecretNames: realizedWorkerConfig.secrets.required,
    expectedConfig: realizedWorkerConfig,
  });
  process.stdout.write(
    `active Deployment ${snapshot.deploymentId}; predecessor ${snapshot.predecessorVersionId}; non-code sha256 ${snapshot.closureDigest}\n`,
  );
  process.stdout.write(`\n==> ${OWNER_GATE}\n`);
  execFileSync("bun", ["run", "check"], { cwd: repo, stdio: "inherit" });
  process.stdout.write(`\n==> bun run build:takos-worker\n`);
  execFileSync(W.build[0], W.build.slice(1), { cwd: repo, stdio: "inherit" });
  const bundleBytes = readFileSync(resolve(repo, W.bundle));
  bundleDigest = digest(bundleBytes);
  process.stdout.write(`candidate ${W.bundle} sha256 ${bundleDigest}\n`);
  requireStableDeployConfig("D1 schema query");
  requireEmptyWranglerEnvFile("D1 schema query");
  await provider.revalidate(snapshot);
  const schema = await provider.queryReadonlySchema(
    snapshot.activeDatabaseId,
    MEDIA_DELETION_SCHEMA_QUERY,
  );
  process.stdout.write(`D1 schema preflight ${schema.table} ${schema.scope}\n`);
  const upgrade = await provider.queryReadonlySchema(
    snapshot.activeDatabaseId,
    CORE_UPGRADE_SCHEMA_QUERY,
  );
  if (
    upgrade?.kind !== "yurumeet.core-upgrade-schema@v1" ||
    upgrade.scope !== "migration-0031-through-0036-prerequisites" ||
    !Array.isArray(upgrade.migrations) ||
    upgrade.migrations.length !== CORE_UPGRADE_MIGRATIONS.length ||
    upgrade.migrations.some(
      (name, index) => name !== CORE_UPGRADE_MIGRATIONS[index],
    )
  ) {
    throw new Error(
      "Worker provider returned invalid Core 4.1.14 D1 preflight proof",
    );
  }
  process.stdout.write(`D1 schema preflight ${upgrade.scope}\n`);
  requireReviewedSource();
  requireStableDeployConfig("Worker Version upload");
  requireEmptyWranglerEnvFile("Worker Version upload");
  const uploaded = await provider.uploadCodeOnly({
    bundleBytes,
    snapshot,
    expectedConfig: realizedWorkerConfig,
    message: `Yurumeet ${commit} sha256:${bundleDigest}`,
  });
  phase = "POST_UPLOAD_INDETERMINATE";
  versionId = uploaded.versionId;
  if (uploaded.sha256 !== bundleDigest)
    throw new Error("uploaded Worker digest differs from reviewed bytes");
  requireReviewedSource();
  requireStableDeployConfig("Deployment promotion");
  requireEmptyWranglerEnvFile("Deployment promotion");
  const promoted = await provider.promote({
    snapshot,
    versionId,
    message: `Yurumeet ${commit}`,
  });
  phase = "POST_DEPLOY_INDETERMINATE";
  deploymentId = promoted.deploymentId;
  phase = "POST_CONDITION_INDETERMINATE";
  postConditions = "FAILED";
  requireStableDeployConfig("post-conditions");
  requireEmptyWranglerEnvFile("post-conditions");
  process.stdout.write(`\n==> bun run smoke:postdeploy\n`);
  try {
    process.stdout.write(safeWorkerText(run(W.smoke[0], W.smoke.slice(1))));
  } catch (error) {
    process.stderr.write(
      safeWorkerText(`${error.stdout ?? ""}${error.stderr ?? ""}`),
    );
    throw new Error(
      "application post-conditions failed; reconcile the serving Deployment before any retry",
    );
  }
  requireReviewedSource();
  requireStableDeployConfig("final published readback");
  requireEmptyWranglerEnvFile("final published readback");
  await provider.verifyPublished({ snapshot, versionId, deploymentId });
  postConditions = "PASSED";
  process.stdout.write(
    `\n${JSON.stringify(recoveryRecord("VERIFIED"), null, 2)}\n`,
  );
} catch (error) {
  const providerFailure = error instanceof YurumeetProviderFailure;
  // Provider phase advances immediately before each actual write. Preserve a
  // later wrapper phase without classifying a pre-write refusal as a mutation.
  const phases = [
    "PRE_UPLOAD_FAILURE",
    "POST_UPLOAD_INDETERMINATE",
    "POST_DEPLOY_INDETERMINATE",
    "POST_CONDITION_INDETERMINATE",
  ];
  if (providerFailure && phases.indexOf(error.phase) > phases.indexOf(phase))
    phase = error.phase;
  const record = recoveryRecord(
    phase === "PRE_UPLOAD_FAILURE" ? "PRE_UPLOAD_FAILURE" : "INDETERMINATE",
    providerFailure ? error.recovery : undefined,
  );
  if (providerFailure)
    record.providerError = {
      operation: error.operation,
      status: error.status,
      codes: error.codes,
      diagnostic: error.diagnostic,
    };
  process.stderr.write(`${JSON.stringify(record, null, 2)}\n`);
  const message = providerFailure
    ? error.message
    : safeWorkerText(error.message);
  process.stderr.write(
    `deploy blocked: ${message}; ${phase === "PRE_UPLOAD_FAILURE" ? "publication was not attempted" : "reconcile serving state before any retry; no automatic retry or rollback"}\n`,
  );
  process.exit(1);
}
