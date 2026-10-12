import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terraformStringDefault } from "./release-identity.mjs";

const [packageSource, moduleSource, takoformModuleSource, releaseLockSource] =
  await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../main.tf", import.meta.url), "utf8"),
    readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
    readFile(new URL("../release.lock.json", import.meta.url), "utf8"),
  ]);

const packageVersion = (JSON.parse(packageSource) as { version: string })
  .version;
const expectedReleaseTag = `v${packageVersion}`;
const releaseLock = JSON.parse(releaseLockSource) as ReleaseLock;
const moduleReleaseTag = terraformStringDefault(
  moduleSource,
  "worker_release_tag",
);
const moduleBundleUrl = terraformStringDefault(
  moduleSource,
  "worker_bundle_url",
);
const moduleBundleDigest = terraformStringDefault(
  moduleSource,
  "worker_bundle_sha256",
);
const currentRelease = releaseLock.releases[expectedReleaseTag];
const expectedAssetUrl = `https://github.com/tako0614/yurumeet/releases/download/${expectedReleaseTag}/worker.js`;

describe("release version", () => {
  test("makes the source tag the direct Cloudflare module's selected tag", () => {
    const releaseVariable = moduleSource.match(
      /variable\s+"worker_release_tag"\s*\{([\s\S]*?)\n\}/,
    )?.[1];

    expect(releaseVariable).toBeDefined();
    expect(releaseVariable).toContain(`default     = "${expectedReleaseTag}"`);
    expect(moduleReleaseTag).toBe(expectedReleaseTag);
    expect(moduleSource).toContain(
      'release_lock                   = jsondecode(file("${path.module}/release.lock.json"))',
    );
  });

  test("keeps unpublished source on its exact asset URL and measured digest", () => {
    expect(releaseLock.kind).toBe("takos.release-artifact-lock@v1");
    expect(releaseLock.app).toBe("yurumeet");
    if (currentRelease) return;
    expect(moduleBundleUrl).toBe(expectedAssetUrl);
    expect(moduleBundleDigest).toBe(
      "3b952ec6c0ee048bfd303344f8053c21c01ae8bdca780db57c908c6e171d1bd0",
    );
  });

  test("covers the published selected release with an append-only pin", () => {
    if (!currentRelease) return;
    expect(currentRelease.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(currentRelease.artifact.filename).toBe("worker.js");
    expect(currentRelease.artifact.url).toBe(expectedAssetUrl);
    expect(currentRelease.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(currentRelease.manifest.url).toBe(
      `https://github.com/tako0614/yurumeet/releases/download/${expectedReleaseTag}/takosumi-artifact.json`,
    );
    expect(currentRelease.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      (moduleBundleUrl === "" && moduleBundleDigest === "") ||
        (moduleBundleUrl === expectedAssetUrl &&
          (moduleBundleDigest === currentRelease.artifact.sha256 ||
            moduleBundleDigest ===
              currentRelease.artifact.sha256.replace(/^sha256:/, ""))),
    ).toBe(true);
  });

  // The portable module used to pin the same GitHub asset by URL and digest,
  // which made a Takoform install's identity depend on a published release
  // rather than on the revision being installed. Provider 4.0.0 has no
  // fetch-the-artifact bundle shape, so the bytes are module content prepared
  // from this worktree — and no release pin may creep back in.
  test("keeps the portable module's bytes out of the release lock entirely", () => {
    for (const variable of [
      "worker_release_tag",
      "worker_bundle_url",
      "worker_bundle_sha256",
    ]) {
      expect(takoformModuleSource).not.toContain(`variable "${variable}"`);
    }
    expect(takoformModuleSource).not.toContain("releases/download");
    expect(takoformModuleSource).not.toContain("release.lock.json");
    expect(takoformModuleSource).toContain(
      'worker_bundle_path  = "${path.module}/.generated/yurumeet-worker.js"',
    );
  });

  test("matches the Git tag when the release workflow runs", () => {
    const isTagRef =
      process.env.GITHUB_REF_TYPE === "tag" ||
      process.env.GITHUB_REF?.startsWith("refs/tags/");
    if (!isTagRef) return;

    expect(process.env.GITHUB_REF_NAME).toBe(expectedReleaseTag);
  });
});

interface ReleaseLock {
  kind: string;
  app: string;
  releases: Record<string, ReleasePin>;
}

interface ReleasePin {
  commit: string;
  artifact: {
    filename: string;
    url: string;
    sha256: string;
  };
  manifest: {
    url: string;
    sha256: string;
  };
}

// Exercise the actual publisher's command order in an isolated directory. The
// three CLI names resolve only to these local fixtures; no git remote, GitHub
// Release, build, or native runtime is contacted by this test.
const publisherSource = fileURLToPath(new URL("..", import.meta.url));
const publisherCommit = "f".repeat(40);
const publisherTag = "v99.0.0";
const fixtureWorkerBytes =
  "export default {fetch(){return new Response('ok')}};\n";
const fixtureWorkerDigest = createHash("sha256")
  .update(fixtureWorkerBytes)
  .digest("hex");
const setFixtureDefault = (source: string, variable: string, value: string) =>
  source.replace(
    new RegExp(`(variable "${variable}"[\\s\\S]*?default\\s+= )"[^"]*"`),
    `$1"${value}"`,
  );
const mockCli = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const statePath = process.env.MOCK_RELEASE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const sha = (file) => "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
state.events.push(command + " " + args.join(" "));
if (command === "git") {
  if (args[0] === "status") {
    // clean
  } else if (args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
    process.stdout.write("origin/main\\n");
  } else if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
    process.stdout.write("main\\n");
  } else if (args[0] === "rev-parse" && args[1] === "HEAD") {
    process.stdout.write(state.commit + "\\n");
  } else if (args[0] === "rev-parse" && args[1] === "origin/main") {
    state.remoteChecks++;
    process.stdout.write((state.mode === "late-head" && state.remoteChecks > 1
      ? "e".repeat(40) : state.commit) + "\\n");
  } else if (args[0] === "fetch" || args[0] === "tag") {
    // no output
  } else if (args[0] === "ls-remote") {
    state.tagReads++;
    if (state.published || (state.mode === "late-tag" && state.tagReads > 1)) {
      process.stdout.write(state.commit + "\\trefs/tags/" + state.tag + "\\n");
    }
  } else {
    process.stderr.write("unmocked git " + args.join(" ") + "\\n");
    process.exitCode = 2;
  }
} else if (command === "bun") {
  if (args[0] === "run" && args[1] === "check") {
    fs.mkdirSync("dist", { recursive: true });
    fs.writeFileSync("dist/takos-worker.js", ${JSON.stringify(fixtureWorkerBytes)});
  } else if (args[0] === "run" && args[1] === "smoke:release-artifact") {
    if (state.mode === "changed-asset") fs.appendFileSync(args[3], "// changed after smoke\\n");
  } else {
    process.stderr.write("unmocked bun " + args.join(" ") + "\\n");
    process.exitCode = 2;
  }
} else if (command === "gh") {
  if (args[0] === "api" && args[1].endsWith("/immutable-releases")) {
    process.stdout.write(JSON.stringify({ enabled: state.mode !== "immutable-disabled" }));
  } else if (args[0] === "release" && args[1] === "view") {
    if (!state.published) {
      process.stderr.write("release not found\\n");
      process.exitCode = 1;
    } else {
      const assets = state.assets.map((asset) => ({ ...asset }));
      if (state.mode === "extra-asset") assets.push({ name: "unexpected.txt", digest: "sha256:" + "0".repeat(64) });
      if (state.mode === "duplicate-asset") assets.push({ ...assets[0] });
      process.stdout.write(JSON.stringify({
        isDraft: false, isPrerelease: false, isImmutable: true,
        tagName: state.tag, url: "https://example.invalid/release", assets,
      }));
    }
  } else if (args[0] === "release" && args[1] === "create") {
    const notesIndex = args.indexOf("--notes-file");
    if (notesIndex < 0) {
      process.stderr.write("missing --notes-file\\n");
      process.exitCode = 2;
    } else {
      state.notes = fs.readFileSync(args[notesIndex + 1], "utf8");
    }
    state.published = true;
    state.creates++;
    state.assets = args.slice(3, 6).map((file) => ({ name: path.basename(file), digest: sha(file), path: file }));
    process.stdout.write("created\\n");
  } else if (args[0] === "release" && args[1] === "download") {
    const destination = args[args.indexOf("--dir") + 1];
    for (const asset of state.assets) fs.copyFileSync(asset.path, path.join(destination, asset.name));
  } else {
    process.stderr.write("unmocked gh " + args.join(" ") + "\\n");
    process.exitCode = 2;
  }
} else {
  process.stderr.write("unmocked command " + command + "\\n");
  process.exitCode = 2;
}
save();
`;

async function probePublisher(mode: string, flag: "--dry-run" | "--execute") {
  const fixture = await mkdtemp(join(tmpdir(), "yurumeet-publisher-test-"));
  const bin = join(fixture, "bin");
  const statePath = join(fixture, "state.json");
  const state = {
    mode,
    commit: publisherCommit,
    tag: publisherTag,
    events: [] as string[],
    remoteChecks: 0,
    tagReads: 0,
    creates: 0,
    published: false,
    notes: "",
    assets: [] as Array<{ name: string; digest: string; path: string }>,
  };
  const sourceFiles = [
    "scripts/deploy.mjs",
    "scripts/release-artifact-manifest.mjs",
    "scripts/release-identity.mjs",
    "scripts/check-media-deletion-schema.mjs",
    "scripts/core-upgrade-schema.mjs",
    "scripts/yurumeet-code-only-provider.mjs",
    "release.lock.json",
    ".well-known/takosumi.json",
    "deploy/takoform/main.tf",
  ];
  try {
    await mkdir(bin);
    for (const name of sourceFiles) {
      await mkdir(dirname(join(fixture, name)), { recursive: true });
      await copyFile(join(publisherSource, name), join(fixture, name));
    }
    const fakeModule = setFixtureDefault(
      setFixtureDefault(
        setFixtureDefault(moduleSource, "worker_release_tag", publisherTag),
        "worker_bundle_url",
        `https://github.com/tako0614/yurumeet/releases/download/${publisherTag}/worker.js`,
      ),
      "worker_bundle_sha256",
      fixtureWorkerDigest,
    );
    await writeFile(join(fixture, "main.tf"), fakeModule);
    await writeFile(join(fixture, "package.json"), '{"version":"99.0.0"}\n');
    await writeFile(
      join(fixture, "CHANGELOG.md"),
      mode === "missing-notes"
        ? "# Changelog\n\n## 0.1.2\n\n- Existing release.\n"
        : "# Changelog\n\n## 99.0.0 - 2026-10-12\n\n- Candidate note.\n",
    );
    await writeFile(statePath, JSON.stringify(state));
    for (const name of ["git", "bun", "gh"]) {
      await writeFile(join(bin, name), mockCli, { mode: 0o755 });
    }
    const run = spawnSync(
      process.execPath,
      [join(fixture, "scripts/deploy.mjs"), "yurumeet-worker-release", flag],
      {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          TMPDIR: fixture,
          MOCK_RELEASE_STATE: statePath,
        },
        encoding: "utf8",
      },
    );
    return {
      status: run.status,
      output: `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
      state: JSON.parse(await readFile(statePath, "utf8")) as typeof state,
    };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe("release publisher command sequence", () => {
  test("verifies a candidate without writing a future lock pin", async () => {
    const result = await probePublisher("normal", "--dry-run");
    expect(result.status).toBe(0);
    expect(result.output).toContain('"status": "DRY_RUN_VERIFIED"');
    expect(result.state.creates).toBe(0);
    expect(result.state.remoteChecks).toBe(2);
    expect(result.state.tagReads).toBe(2);
  });

  test("publishes exactly the measured candidate and current version notes", async () => {
    const result = await probePublisher("normal", "--execute");
    expect(result.status).toBe(0);
    expect(result.output).toContain('"status": "PUBLISHED"');
    expect(result.state.creates).toBe(1);
    expect(result.state.assets.map((asset) => asset.name).sort()).toEqual([
      "takosumi-artifact.json",
      "worker.js",
      "worker.js.sha256",
    ]);
    expect(result.state.notes).toBe(
      "## 99.0.0 - 2026-10-12\n\n- Candidate note.\n",
    );
  });

  test.each([
    ["late-head", "does not equal"],
    ["late-tag", "remote tag v99.0.0 already exists"],
    ["immutable-disabled", "is not enabled"],
    ["changed-asset", "changed after native verification"],
    ["missing-notes", "CHANGELOG.md has no section"],
  ])("blocks %s before publication", async (mode, reason) => {
    const result = await probePublisher(mode, "--execute");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(reason);
    expect(result.state.creates).toBe(0);
  });

  test.each(["extra-asset", "duplicate-asset"])(
    "refuses %s after create without claiming publication success",
    async (mode) => {
      const result = await probePublisher(mode, "--execute");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("asset inventory");
      expect(result.output).not.toContain('"status": "PUBLISHED"');
      expect(result.state.creates).toBe(1);
      expect(result.state.notes).toBe(
        "## 99.0.0 - 2026-10-12\n\n- Candidate note.\n",
      );
    },
  );
});
