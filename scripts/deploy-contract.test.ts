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
      "yurumeet-integration",
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

  test("declares read-only migration 0030–0036 metadata preflights before Worker publication", () => {
    const worker = surfaceOf("yurumeet-worker");
    expect(worker?.triggers).toEqual(["authority"]);
    expect(worker?.obligations.provenance).toContain(
      "read-only D1 metadata queries",
    );
    expect(worker?.obligations.provenance).toContain("migration 0030");
    expect(worker?.obligations.provenance).toContain("migration 0031–0036");
    expect(worker?.obligations.provenance).toContain(
      "without applying migrations or writing schema/data",
    );
    expect(worker?.covers).toContain("scripts/core-upgrade-schema.mjs");
    expect(worker?.obligations["failure-handling"]).toMatch(
      /session-salt config blocks before .*gate/u,
    );
    expect(worker?.obligations["failure-handling"]).toContain(
      "migration 0030–0036 metadata prerequisites blocks before Version upload",
    );
    expect(worker?.obligations["independent-review"]).toContain(
      "strict secret inheritance",
    );
    expect(worker?.obligations["independent-review"]).toContain(
      "not the secret value or entropy",
    );
    expect(worker?.covers).toContain("scripts/deploy.mjs");
    expect(worker?.covers).toContain("scripts/yurumeet-worker-bindings.ts");
  });

  test("declares the serving traffic map, explicit target, and controlled Wrangler env file", () => {
    const worker = surfaceOf("yurumeet-worker");
    expect(worker?.covers).toContain(
      "scripts/worker-publish-empty.env.example",
    );
    expect(worker?.obligations.provenance).toContain("account_id");
    expect(worker?.obligations.provenance).toContain("zero-byte");
    expect(worker?.obligations.provenance).toContain("--env-file");
    expect(worker?.obligations.provenance).toContain("active Deployment");
    expect(worker?.obligations.reversal).toContain(
      "complete version/percentage traffic map",
    );
    expect(worker?.obligations.reversal).toContain("versions deploy");
    expect(worker?.obligations.reversal).toContain(
      "manual POST Deployment API",
    );
    expect(worker?.obligations.reversal).toContain(
      "not an atomic compare-and-swap",
    );
    expect(worker?.obligations.reversal).toContain("operator serialization");
  });

  test("keeps the checked-in Wrangler config as the flexible local-dev template", () => {
    expect(wranglerConfig.secrets).toBeUndefined();
  });

  test("declares the isolated Yurumeet integration phases and safeguards", () => {
    const integration = surfaceOf("yurumeet-integration");
    expect(integration?.target).toContain("ga-meet-20261012.yurucommu.com");
    expect(integration?.triggers).toEqual(["authority", "irreversible"]);
    expect(integration?.covers).toContain("scripts/deploy-integration.mjs");
    expect(integration?.covers).toContain(
      "scripts/deploy-integration-parser-probe.mjs",
    );
    expect(integration?.covers).toContain(
      "scripts/deploy-integration-parser-probe.d.mts",
    );
    expect(integration?.covers).toContain(
      "scripts/deploy-integration-parser-probe.test.ts",
    );
    expect(integration?.covers).toContain(
      "scripts/deploy-integration-schema.mjs",
    );
    expect(integration?.covers).toContain("wrangler.jsonc");
    expect(integration?.obligations.provenance).toContain("v0.2.0");
    expect(integration?.obligations["post-conditions"]).toContain("fresh D1");
    expect(integration?.obligations["post-conditions"]).toContain(
      "fresh-schema executes the pinned Core 4.2.1 migration set on that fresh D1 with the same exact 0034 CASE projection",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "recover-prefix32 accepts only the exact existing integration D1",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "writes only the final three pinned migration batches in order",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "probe-case-parser is diagnostic-only",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "probe-case-parser-comparison creates only the two remaining parenthesized/values fixtures",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "native-full35 creates only the one fixed standalone D1 fixture",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "the same exact 0034 CASE projection",
    );
    expect(integration?.obligations["post-conditions"]).toContain(
      "persists private 0600 raw before/after sqlite_master responses with SHA-256 values",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "complete unfiltered D1 inventory with page=1&per_page=10000",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "requests the complete unfiltered D1 inventory with page=1&per_page=10000",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "empty SQLite schema",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "before recover-prefix32 writes, reads only the exact D1 UUID/name from private OpenTofu state",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "native-full35 uses only the exact new name yurumeet-ga-20261012-0938-native-full35",
    );
    expect(integration?.obligations["pre-mutation-proof"]).toContain(
      "no retry, reuse, or deletion",
    );
    expect(integration?.obligations.reversal).toContain(
      "automatic rollback path",
    );
    for (const phase of [
      "POST_APPLY_INDETERMINATE",
      "POST_SCHEMA_INDETERMINATE",
      "PREFIX32_PREFLIGHT_REFUSED",
      "POST_PARSER_PROBE_INDETERMINATE",
      "POST_NATIVE_FULL35_INDETERMINATE",
      "POST_DOMAIN_INDETERMINATE",
    ]) {
      expect(integration?.obligations["failure-handling"]).toContain(phase);
    }
    expect(integration?.obligations["independent-review"]).toContain(
      "custom-domain changeset/no-overwrite flags",
    );
    expect(integration?.obligations["independent-review"]).toContain(
      "same exact 0034 CASE projection on normal fresh and recovery paths",
    );
    expect(integration?.obligations["independent-review"]).toContain(
      "comparison-only parenthesized/values names",
    );
  });

  test("declares the supported Node host for native release qualification", () => {
    expect(surfaceOf("yurumeet-worker")?.requiresTools).toContain("node");
    expect(surfaceOf("yurumeet-worker-release")?.requiresTools).toContain(
      "node",
    );
    expect(packageJson.scripts?.["smoke:release-artifact"]).toBe(
      "node scripts/smoke-release-worker.mjs",
    );
    expect(packageJson.scripts?.["smoke:release-browser"]).toBe(
      "node scripts/smoke-release-browser.mjs",
    );
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
    requiresTools?: string[];
    requiresEnv?: string[];
    obligations: Record<string, string>;
  }>;
}
