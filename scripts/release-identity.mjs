// Do five hand-edited documents describe one release?
//
// A Yurumeet release is not one file. `package.json` carries the version the tag
// comes from; `main.tf` says which release the direct-Cloudflare module installs;
// `release.lock.json` pins the artifact and manifest digests; the repository
// manifest says those pins are module defaults rather than questions asked of an
// installer; and `deploy/takoform` must build from the selected source instead of
// downloading a release. They are edited at different times, by hand, and
// nothing before this made them agree.
//
// This is a pure function over already-read documents so `bun run check` can ask
// the question of the current worktree, not only a publish can. The list it
// returns is empty or it is the reason to refuse.

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

  const moduleDefaults = [
    ["worker_release_tag", tag],
    // The lock is the authority in release mode. A non-empty URL or digest
    // default would install bytes the lock never pinned.
    ["worker_bundle_url", ""],
    ["worker_bundle_sha256", ""],
  ];
  for (const [variable, expected] of moduleDefaults) {
    const actual = terraformStringDefault(moduleSource, variable);
    if (actual !== expected) {
      failures.push(
        `main.tf ${variable} default is ${show(actual)}, expected ${JSON.stringify(expected)}`,
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

export function terraformStringDefault(source, variable) {
  return source
    .match(
      new RegExp(`variable\\s+"${variable}"\\s*\\{([\\s\\S]*?)\\n\\}`, "u"),
    )?.[1]
    ?.match(/default\s+=\s+"([^"]*)"/u)?.[1];
}

const show = (value) =>
  value === undefined ? "<missing>" : JSON.stringify(value);
