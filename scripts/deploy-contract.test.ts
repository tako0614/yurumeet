import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The control repository probes this exact command and validates the answer it
// gets. Running it here means a surface that names a script nobody wrote, or an
// obligation the policy does not know, fails in `bun run check` rather than the
// first time an operator tries to publish.
const repo = fileURLToPath(new URL("..", import.meta.url));
const probe = Bun.spawnSync(
  ["bun", "run", "--silent", "deploy", "--", "--contract"],
  { cwd: repo, stdout: "pipe", stderr: "pipe" },
);
const stdout = probe.stdout.toString();
const contract = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Contract;
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const wranglerConfig = JSON.parse(
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
) as { secrets?: unknown };

const surfaceOf = (name: string) =>
  contract.surfaces.find((entry) => entry.surface === name);

// engineering.policy.json: every surface owes these, and a published-identity
// surface owes no-overwrite on top.
const BASELINE = [
  "provenance",
  "post-conditions",
  "reversal",
  "failure-handling",
];

describe("deploy contract", () => {
  test("prints one contract with no side effects", () => {
    expect(probe.exitCode).toBe(0);
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    expect(contract.surfaces.map((entry) => entry.surface)).toEqual([
      "yurumeet-worker",
      "yurumeet-worker-release",
      "yurumeet-site",
    ]);
  });

  test("answers every obligation each surface owes", () => {
    for (const entry of contract.surfaces) {
      for (const obligation of BASELINE) {
        expect(entry.obligations[obligation]?.trim()).toBeTruthy();
      }
    }
  });

  test("declares the Worker release as a published identity", () => {
    const release = surfaceOf("yurumeet-worker-release");
    expect(release?.triggers).toEqual(["published-identity", "authority"]);
    expect(release?.obligations["no-overwrite"]).toContain(
      "immutable-releases",
    );
    expect(release?.obligations["independent-review"]).toContain(
      "required YURUCOMMU_SESSION_HASH_SALT",
    );
    expect(release?.obligations["independent-review"]).toContain(
      "operator-owned custody",
    );
    expect(release?.target).toContain("github-release:tako0614/yurumeet/");
  });

  test("keeps the Worker and site surfaces free of a published identity", () => {
    // A Cloudflare Worker version and a Pages deployment are both replaceable
    // through provider history, so neither mints an identity a consumer pins.
    expect(surfaceOf("yurumeet-worker")?.triggers).toEqual(["authority"]);
    expect(surfaceOf("yurumeet-site")?.triggers).toEqual([]);
    expect(surfaceOf("yurumeet-site")?.target).toBe(
      "cloudflare-pages:yurumeet-website",
    );
  });

  test("declares the read-only Core 4.1.11 migration 0030 preflight before Worker publication", () => {
    const worker = surfaceOf("yurumeet-worker");
    expect(worker?.triggers).toEqual(["authority"]);
    expect(worker?.obligations.provenance).toContain(
      "read-only D1 metadata query",
    );
    expect(worker?.obligations.provenance).toContain("migration 0030");
    expect(worker?.obligations["failure-handling"]).toContain(
      "missing session-salt config blocks before any gate",
    );
    expect(worker?.obligations["failure-handling"]).toContain(
      "schema mismatch blocks before publication",
    );
    expect(worker?.obligations["independent-review"]).toContain(
      "strict secret inheritance",
    );
    expect(worker?.obligations["independent-review"]).toContain(
      "not the secret value or active Worker binding",
    );
    expect(worker?.covers).toContain("scripts/deploy.mjs");
    expect(worker?.covers).toContain("scripts/yurumeet-worker-bindings.ts");
  });

  test("keeps the checked-in Wrangler config as the flexible local-dev template", () => {
    expect(wranglerConfig.secrets).toBeUndefined();
  });

  test("names only package scripts that exist", () => {
    for (const entry of contract.surfaces) {
      for (const script of entry.requiresScripts ?? []) {
        expect(packageJson.scripts?.[script]).toBeTypeOf("string");
      }
    }
  });

  test("lets an operator discover every variable a surface requires", () => {
    for (const entry of contract.surfaces) {
      const answers = Object.values(entry.obligations).join("\n");
      for (const variable of entry.requiresEnv ?? []) {
        expect(answers).toContain(variable);
      }
    }
  });
});

interface Contract {
  kind: string;
  surfaces: Array<{
    surface: string;
    target: string;
    covers?: string[];
    triggers: string[];
    requiresScripts?: string[];
    requiresEnv?: string[];
    obligations: Record<string, string>;
  }>;
}
