// Do the installed release and a proposed release each have a truthful identity?
//
// A Yurumeet release is not one file. `package.json` carries the version the tag
// comes from; `main.tf` says which release the direct-Cloudflare module installs;
// `release.lock.json` pins only published artifact and manifest digests; the
// repository manifest says module inputs are defaults rather than questions
// asked of an installer; and `deploy/takoform` builds from selected source.
// A new release cannot have a lock pin in its own source commit: that pin would
// contain the commit and manifest digest of the commit that contains the pin.
// Publication therefore validates an exact URL and measured digest candidate,
// then appends the actual pin afterward.
//
// This is a pure function over already-read documents so `bun run check` can ask
// the question of the current worktree, not only a publish can. The list it
// returns is empty or it is the reason to refuse.

import {
  RELEASE_ASSET_NAME,
  RELEASE_MANIFEST_NAME,
  buildReleaseManifest,
  releaseAssetUrl,
} from "./release-artifact-manifest.mjs";

export function releaseIdentityFailures({
  tag,
  commit,
  assetName,
  assetUrl,
  manifestUrl,
  bundleDigest,
  manifestDigest,
  moduleSource,
  lock,
  repository,
  takoformSource,
}) {
  const failures = [];

  const moduleTag = terraformStringDefault(moduleSource, "worker_release_tag");
  const moduleUrl = terraformStringDefault(moduleSource, "worker_bundle_url");
  const moduleDigest = terraformStringDefault(
    moduleSource,
    "worker_bundle_sha256",
  );
  if (moduleTag !== tag) {
    failures.push(
      `main.tf worker_release_tag default is ${show(moduleTag)}, expected ${JSON.stringify(tag)}`,
    );
  }
  if (moduleUrl === "" && moduleDigest === "") {
    // Published lock mode: the pin supplies the artifact URL and digest.
  } else {
    if (moduleUrl !== assetUrl) {
      failures.push(
        `main.tf worker_bundle_url default is ${show(moduleUrl)}, expected ${JSON.stringify(assetUrl)}`,
      );
    }
    if (
      moduleDigest !== bundleDigest &&
      moduleDigest !== `sha256:${bundleDigest}`
    ) {
      failures.push(
        `main.tf worker_bundle_sha256 default is ${show(moduleDigest)}, expected ${JSON.stringify(bundleDigest)}`,
      );
    }
  }

  if (
    lock?.kind !== "takos.release-artifact-lock@v1" ||
    lock?.app !== "yurumeet"
  ) {
    failures.push(
      "release.lock.json is not a yurumeet takos.release-artifact-lock@v1",
    );
  }
  const pin = lock?.releases?.[tag];
  const required = {
    "artifact.filename": [pin?.artifact?.filename, assetName],
    "artifact.url": [pin?.artifact?.url, assetUrl],
    "artifact.sha256": [pin?.artifact?.sha256, `sha256:${bundleDigest}`],
    "manifest.url": [pin?.manifest?.url, manifestUrl],
    "manifest.sha256": [pin?.manifest?.sha256, `sha256:${manifestDigest}`],
    commit: [pin?.commit, commit],
  };
  const lockFailures = Object.entries(required)
    .filter(([, [actual, expected]]) => actual !== expected)
    .map(
      ([field, [actual, expected]]) =>
        `release.lock.json releases.${tag}.${field} is ${show(actual)}, expected ${JSON.stringify(expected)}`,
    );
  failures.push(...lockFailures);

  failures.push(...releaseRepositoryFailures({ repository, takoformSource }));
  return failures;
}

function releaseRepositoryFailures({ repository, takoformSource }) {
  const failures = [];
  if (
    repository?.apiVersion !== "takosumi.com/v2.4" ||
    repository?.kind !== "Repository"
  ) {
    failures.push(
      ".well-known/takosumi.json has an unexpected repository kind",
    );
  }
  const modules = repository?.install?.modules;
  const rootModule = modules?.["."];
  const takoformModule = modules?.["deploy/takoform"];
  const inputs = new Map(
    (Array.isArray(rootModule?.inputs) ? rootModule.inputs : []).map(
      (input) => [input?.name, input],
    ),
  );
  for (const name of [
    "worker_release_tag",
    "worker_bundle_url",
    "worker_bundle_sha256",
  ]) {
    if (inputs.get(name)?.source?.kind !== "module_default") {
      failures.push(
        `.well-known/takosumi.json root module does not declare ${name} as a module_default pin`,
      );
    }
  }

  const commands = Array.isArray(takoformModule?.sourceBuild?.commands)
    ? takoformModule.sourceBuild.commands.map((command) => command?.argv)
    : undefined;
  if (
    JSON.stringify(commands) !==
    JSON.stringify([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "run", "build:takos-worker"],
      ["bun", "scripts/prepare-takoform-v1-source.ts"],
    ])
  ) {
    failures.push(
      "deploy/takoform sourceBuild does not build and prepare the selected source worktree",
    );
  }
  if (
    JSON.stringify(takoformModule?.sourceBuild?.outputs) !==
    JSON.stringify([
      "deploy/takoform/.generated/yurumeet-worker.js",
      "deploy/takoform/migrations/sql",
    ])
  ) {
    failures.push(
      "deploy/takoform sourceBuild does not pin the generated Worker and migration assets",
    );
  }
  if (
    !takoformSource.includes(
      'worker_bundle_path  = "${path.module}/.generated/yurumeet-worker.js"',
    )
  ) {
    failures.push(
      "deploy/takoform does not consume the Worker prepared from its selected source worktree",
    );
  }
  if (takoformSource.includes("releases/download")) {
    failures.push(
      "deploy/takoform pins a published release URL; the portable module installs the revision being installed",
    );
  }

  return failures;
}

/**
 * Verify an unpublished candidate without inventing a future lock entry.
 * The root module selects the candidate's exact tag, URL, and measured Worker
 * digest while its lock entry is absent. This function is separate from the
 * strict published-pin validator above; ordinary callers cannot accept a
 * missing lock entry by accident.
 */
export function releaseCandidateIdentityFailures(candidate) {
  const {
    tag,
    commit,
    assetName,
    assetUrl,
    manifestUrl,
    bundleDigest,
    manifestDigest,
    moduleSource,
    lock,
    repository,
    takoformSource,
  } = candidate;
  const failures = [];
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) {
    failures.push(`candidate tag ${show(tag)} is not a SemVer release tag`);
  }
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    failures.push(`candidate commit ${show(commit)} is not a full Git SHA`);
  }
  if (!/^[a-f0-9]{64}$/u.test(bundleDigest)) {
    failures.push(
      `candidate Worker digest ${show(bundleDigest)} is not SHA-256`,
    );
  }
  if (
    assetName !== RELEASE_ASSET_NAME ||
    assetUrl !== releaseAssetUrl(tag, RELEASE_ASSET_NAME)
  ) {
    failures.push("candidate Worker asset name or URL does not match its tag");
  }
  if (manifestUrl !== releaseAssetUrl(tag, RELEASE_MANIFEST_NAME)) {
    failures.push("candidate manifest URL does not match its tag");
  }
  if (
    /^[a-f0-9]{40}$/u.test(commit) &&
    /^[a-f0-9]{64}$/u.test(bundleDigest) &&
    manifestDigest !==
      buildReleaseManifest({ commit, tag, bundleDigest }).digest
  ) {
    failures.push(
      "candidate manifest digest does not match the exact manifest bytes",
    );
  }
  if (Object.hasOwn(lock?.releases ?? {}, tag)) {
    failures.push(
      `release.lock.json releases.${tag} already exists; a candidate must be unpublished`,
    );
  }

  if (
    lock?.kind !== "takos.release-artifact-lock@v1" ||
    lock?.app !== "yurumeet"
  ) {
    failures.push(
      "release.lock.json is not a yurumeet takos.release-artifact-lock@v1",
    );
  }
  const moduleTag = terraformStringDefault(moduleSource, "worker_release_tag");
  const moduleUrl = terraformStringDefault(moduleSource, "worker_bundle_url");
  const moduleDigest = terraformStringDefault(
    moduleSource,
    "worker_bundle_sha256",
  );
  if (moduleTag !== tag) {
    failures.push(
      `main.tf worker_release_tag default is ${show(moduleTag)}, expected ${JSON.stringify(tag)}`,
    );
  }
  if (moduleUrl !== assetUrl) {
    failures.push(
      `main.tf worker_bundle_url default is ${show(moduleUrl)}, expected ${JSON.stringify(assetUrl)}`,
    );
  }
  if (
    moduleDigest !== bundleDigest &&
    moduleDigest !== `sha256:${bundleDigest}`
  ) {
    failures.push(
      `main.tf worker_bundle_sha256 default is ${show(moduleDigest)}, expected ${JSON.stringify(bundleDigest)}`,
    );
  }
  failures.push(...releaseRepositoryFailures({ repository, takoformSource }));
  return failures;
}

export function terraformStringDefault(source, variable) {
  return source
    .match(
      new RegExp(`variable\\s+"${variable}"\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    )?.[1]
    ?.match(/default\s+=\s+"([^"]*)"/u)?.[1];
}

const show = (value) =>
  value === undefined ? "<missing>" : JSON.stringify(value);
