import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";

import { TAKOFORM_PROVIDER_PIN } from "./takoform-provider-pin.ts";

const rootUrl = new URL("../", import.meta.url);
const manifestText = await readFile(
  new URL(".well-known/takosumi.json", rootUrl),
  "utf8",
);
const manifest = JSON.parse(manifestText) as {
  apiVersion: string;
  kind: string;
  install: {
    modules: Record<
      string,
      {
        inputs: Array<{
          name: string;
          source: { kind: string };
          type?: string;
          format?: string;
          required?: boolean;
          label: { ja: string; en: string };
          helper?: { ja: string; en: string };
          placeholder?: string;
          advanced?: boolean;
          secret?: boolean;
        }>;
        requires?: Array<Record<string, unknown>>;
        sourceBuild?: {
          commands: Array<{ argv: string[] }>;
          outputs: string[];
        };
        features?: Array<{
          id: string;
          optional: boolean;
          label: { ja: string; en: string };
          inputs: string[];
        }>;
        interfaces: Array<{
          key: string;
          name: string;
          spec: {
            type: string;
            version: string;
            document: {
              launcher: boolean;
              display: { title: string; icon?: string };
            };
            inputs: Record<
              string,
              { source: string; outputName?: string; outputType?: string }
            >;
            access: { visibility: string };
          };
          bindingRequests: Array<{
            key: string;
            subject: { source: string };
            permissions: string[];
            delivery: { type: string };
          }>;
        }>;
      }
    >;
  };
};
const rootModule = manifest.install.modules["."];
const managedModule = manifest.install.modules["deploy/takoform"];
const rootModuleSource = await readFile(new URL("main.tf", rootUrl), "utf8");
const rootOutputsSource = await readFile(
  new URL("outputs.tf", rootUrl),
  "utf8",
);
const managedModuleSource = await readFile(
  new URL("deploy/takoform/main.tf", rootUrl),
  "utf8",
);
const managedModuleOutputsSource = await readFile(
  new URL("deploy/takoform/outputs.tf", rootUrl),
  "utf8",
);
const site = await readFile(new URL("site/index.html", rootUrl), "utf8");

// The Host materializes these itself and hands them to the Worker as bindings.
// The manifest names the SLOTS; it never carries a value.
const expectedManagedRuntimeRequirements = [
  {
    kind: "secret.generated",
    bytes: 32,
    encoding: "hex",
    deliver: {
      bindings: {
        value: "ENCRYPTION_KEY",
      },
    },
  },
  {
    kind: "identity.oidc",
    callbackPath: "/api/auth/callback/takos",
    scopes: ["openid", "profile", "email"],
    deliver: {
      bindings: {
        issuerUrl: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
        clientId: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
        ownerSubject: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
        redirectUri: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
      },
    },
  },
];
const sourceKinds = new Set([
  "user",
  "capsule_name",
  "workspace_scoped_capsule_name",
  "module_default",
]);

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  expect(Object.keys(value).sort()).toEqual([...allowedKeys].sort());
}

function collectForbiddenKeys(
  value: unknown,
  path = "$",
): Array<{ key: string; path: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectForbiddenKeys(item, `${path}[${index}]`),
    );
  }
  const forbidden = new Set([
    "credential",
    "credentialId",
    "lifecycle",
    "lifecycleActions",
    "outputAllowlist",
    "policy",
    "provider",
    "providerId",
    "providerConnectionId",
    "runner",
    "runnerId",
    "secretValue",
    "target",
    "targetId",
  ]);
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => [
      ...(forbidden.has(key) ? [{ key, path: `${path}.${key}` }] : []),
      ...collectForbiddenKeys(child, `${path}.${key}`),
    ],
  );
}

function assertModuleVariablesExistWithDefaults(
  module: (typeof manifest.install.modules)[string],
  moduleSource: string,
): void {
  const moduleVariables = new Set(
    Array.from(
      moduleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
      (match) => match[1],
    ),
  );
  const referenced = new Set([
    ...module.inputs.map((input) => input.name),
    ...(module.features ?? []).flatMap((feature) => feature.inputs),
  ]);
  expect([...referenced].filter((name) => !moduleVariables.has(name))).toEqual(
    [],
  );
  for (const input of module.inputs.filter(
    (candidate) => candidate.source.kind === "module_default",
  )) {
    const blockStart = moduleSource.indexOf(`variable "${input.name}" {`);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    const nextBlock = moduleSource.indexOf("\nvariable ", blockStart + 1);
    expect(
      moduleSource.slice(blockStart, nextBlock < 0 ? undefined : nextBlock),
    ).toMatch(/\n\s+default\s+=/);
  }
}

// The launcher used to be a `takoform_interface` resource inside the portable
// graph. That resource type was withdrawn, so the repository's own manifest is
// where a Host reads it — and it now describes BOTH modules, so the direct
// Cloudflare install gets the same launcher the portable one does.
function assertLauncherInterface(
  module: (typeof manifest.install.modules)[string],
): void {
  expect(module.interfaces).toHaveLength(1);
  const launcher = module.interfaces[0];
  assertExactKeys(launcher as unknown as Record<string, unknown>, [
    "bindingRequests",
    "key",
    "name",
    "spec",
  ]);
  expect(launcher.key).toBe("launcher");
  expect(launcher.name).toBe("yurumeet.launcher");
  assertExactKeys(launcher.spec as unknown as Record<string, unknown>, [
    "access",
    "document",
    "inputs",
    "type",
    "version",
  ]);
  expect(launcher.spec.type).toBe("interface.ui.surface");
  expect(launcher.spec.version).toBe("1");
  assertExactKeys(
    launcher.spec.document as unknown as Record<string, unknown>,
    ["display", "launcher"],
  );
  expect(launcher.spec.document.launcher).toBe(true);
  assertExactKeys(
    launcher.spec.document.display as unknown as Record<string, unknown>,
    ["icon", "title"],
  );
  expect(launcher.spec.document.display.title).toBe("Yurumeet");
  // Served by the Worker's own asset path, so the icon resolves for whoever
  // can already reach the app.
  expect(launcher.spec.document.display.icon).toBe("/yurumeet-logo.png");
  assertExactKeys(launcher.spec.inputs as Record<string, unknown>, ["url"]);
  expect(launcher.spec.inputs.url).toEqual({
    source: "output",
    outputName: "launch_url",
    outputType: "url",
  });
  assertExactKeys(launcher.spec.access as Record<string, unknown>, [
    "visibility",
  ]);
  expect(launcher.spec.access.visibility).toBe("workspace");
  expect(launcher.bindingRequests).toHaveLength(1);
  const [installer] = launcher.bindingRequests;
  assertExactKeys(installer as unknown as Record<string, unknown>, [
    "delivery",
    "key",
    "permissions",
    "subject",
  ]);
  expect(installer.key).toBe("installer");
  expect(installer.subject).toEqual({ source: "installing_principal" });
  expect(installer.permissions).toEqual(["ui.open"]);
  expect(installer.delivery).toEqual({ type: "none" });
}

describe("repository-owned Takosumi install UX", () => {
  test("describes both real module paths without choosing a default", () => {
    expect(
      new TextEncoder().encode(manifestText).byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
    assertExactKeys(manifest as unknown as Record<string, unknown>, [
      "apiVersion",
      "kind",
      "install",
    ]);
    expect(manifest.apiVersion).toBe("takosumi.com/v2.4");
    expect(manifest.kind).toBe("Repository");
    assertExactKeys(manifest.install as unknown as Record<string, unknown>, [
      "modules",
    ]);
    expect(Object.keys(manifest.install.modules).sort()).toEqual([
      ".",
      "deploy/takoform",
    ]);
    expect(rootModule).toBeDefined();
    expect(managedModule).toBeDefined();
    for (const module of [rootModule, managedModule]) {
      expect(module.inputs.length).toBeLessThanOrEqual(128);
      expect(module.requires?.length ?? 0).toBeLessThanOrEqual(16);
      expect(module.features?.length ?? 0).toBeLessThanOrEqual(32);
    }
    assertExactKeys(rootModule as unknown as Record<string, unknown>, [
      "inputs",
      "requires",
      "features",
      "interfaces",
    ]);
    assertExactKeys(managedModule as unknown as Record<string, unknown>, [
      "inputs",
      "requires",
      "sourceBuild",
      "interfaces",
    ]);
    assertLauncherInterface(rootModule);
    assertLauncherInterface(managedModule);
    expect(manifestText).not.toContain('"defaultModule"');
  });

  // The chooser document is retired: a repository describes its modules, and
  // the installer picks one by ordinary Git URL + module path. Reintroducing
  // it would be a second, competing answer to the same question.
  test("has no CapsuleSourceOptions chooser", async () => {
    await expect(
      access(new URL("install-options.json", rootUrl)),
    ).rejects.toThrow();
    expect(manifestText).not.toContain("CapsuleSourceOptions");
  });

  test("uses only the bounded repository presentation vocabulary", () => {
    for (const module of Object.values(manifest.install.modules)) {
      for (const input of module.inputs) {
        expect(sourceKinds.has(input.source.kind)).toBe(true);
        assertExactKeys(input.source as unknown as Record<string, unknown>, [
          "kind",
        ]);
        expect(input.name.length).toBeLessThanOrEqual(128);
        expect(input.label.ja.length).toBeGreaterThan(0);
        expect(input.label.en.length).toBeGreaterThan(0);
        expect(input.label.ja.length).toBeLessThanOrEqual(512);
        expect(input.label.en.length).toBeLessThanOrEqual(512);
      }
      for (const feature of module.features ?? []) {
        expect(feature.id.length).toBeLessThanOrEqual(64);
        expect(feature.inputs.length).toBeLessThanOrEqual(32);
        // A feature can only toggle something the installer supplies.
        expect(
          feature.inputs.filter(
            (name) =>
              module.inputs.find((input) => input.name === name)?.source
                .kind !== "user",
          ),
        ).toEqual([]);
      }
      for (const declaration of module.interfaces) {
        for (const input of Object.values(declaration.spec.inputs)) {
          expect(input.source).toBe("output");
          expect(input.outputName).toBe("launch_url");
          expect(input.outputType).toBe("url");
        }
      }
    }
  });

  test("references only declared module variables and ordinary outputs", () => {
    assertModuleVariablesExistWithDefaults(rootModule, rootModuleSource);
    assertModuleVariablesExistWithDefaults(managedModule, managedModuleSource);
    expect(rootOutputsSource).toContain('output "launch_url"');
    expect(managedModuleOutputsSource).toContain('output "launch_url"');
  });

  test("marks only user-provided authentication material as secret", () => {
    expect(
      rootModule.inputs
        .filter((input) => input.secret)
        .map((input) => [input.name, input.source.kind]),
    ).toEqual([["auth_password_hash", "user"]]);
    expect(rootModule.features).toEqual([
      {
        id: "password-authentication",
        inputs: ["auth_password_hash"],
        label: {
          ja: "パスワードでログイン",
          en: "Sign in with a password",
        },
        optional: true,
      },
    ]);
    // The portable lane has no password variable at all: Accounts OIDC is its
    // only authentication method, delivered as a runtime binding.
    expect(managedModule.features).toBeUndefined();
    expect(JSON.stringify(managedModule)).not.toContain("password");
  });

  test("declares only provider-neutral runtime requirements", () => {
    expect(managedModule.requires).toEqual(expectedManagedRuntimeRequirements);
    expect(manifestText).toContain('"kind": "identity.oidc"');
    expect(manifestText).toContain('"kind": "secret.generated"');
    expect(JSON.stringify(managedModule.requires).toLowerCase()).not.toContain(
      "provider",
    );
    expect(JSON.stringify(managedModule.requires).toLowerCase()).not.toContain(
      "cloudflare",
    );
    // Every binding slot the manifest promises must be a value the module
    // actually refuses to run without.
    for (const name of [
      "ENCRYPTION_KEY",
      "TAKOSUMI_ACCOUNTS_ISSUER_URL",
      "TAKOSUMI_ACCOUNTS_CLIENT_ID",
      "TAKOSUMI_ACCOUNTS_OWNER_SUB",
      "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    ]) {
      expect(managedModuleSource).toContain(JSON.stringify(name));
    }
    expect(managedModuleSource).toContain("required_sensitive_vars");
    // MEDIA is a Form the module owns, not a standard service the installer's
    // Host has to be able to supply out of band.
    expect(managedModuleSource).toContain(
      'resource "takoform_edge_object_bucket" "media"',
    );
    expect(managedModuleSource).toContain("bucket_bindings");
    expect(managedModuleSource).not.toContain("com.amazonaws.s3");
    expect(managedModuleSource).not.toContain("external_services");
  });

  test("keeps host authority and secret values out of repository metadata", () => {
    expect(collectForbiddenKeys(manifest)).toEqual([]);
    for (const forbidden of [
      "cloudflare_account_id",
      "enable_cloudflare_resources",
      "enable_cloudflare_worker_script",
      "encryption_key",
      "oidc_owner_sub",
      "oidc_allowed_subs",
      "allow_unpinned_owner_claim",
    ]) {
      expect(manifestText).not.toContain(forbidden);
    }
  });

  test("Takoform install asks no provider or runtime-internal questions", () => {
    const moduleVariables = new Set(
      Array.from(
        managedModuleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    expect(managedModule.inputs.map((input) => input.name)).toEqual([
      "project_name",
    ]);
    expect(
      managedModule.inputs.filter((input) => input.source.kind === "user"),
    ).toEqual([]);
    for (const forbidden of [
      "cloudflare",
      "provider",
      "credential",
      "encryption_key",
      "database_id",
      "queue_id",
    ]) {
      expect(JSON.stringify(managedModule.inputs).toLowerCase()).not.toContain(
        forbidden,
      );
    }
    expect(managedModule.sourceBuild).toEqual({
      commands: [
        { argv: ["bun", "install", "--frozen-lockfile"] },
        { argv: ["bun", "run", "build:takos-worker"] },
        { argv: ["bun", "scripts/prepare-takoform-v1-source.ts"] },
      ],
      outputs: [
        "deploy/takoform/.generated/yurumeet-worker.js",
        "deploy/takoform/migrations/sql",
      ],
    });
    expect(
      managedModule.sourceBuild?.outputs.every((output) =>
        output.startsWith("deploy/takoform/"),
      ),
    ).toBe(true);
    expect(managedModuleSource).toContain(
      'migration_root      = "${path.module}/migrations/sql"',
    );
    expect(managedModuleSource).not.toContain("${path.module}/../");
    expect(managedModuleSource).toContain(TAKOFORM_PROVIDER_PIN);

    // runtime_lane is a module variable but deliberately NOT an install input:
    // it names the binding shape the destination Host projects, which the
    // installer cannot be asked about, and its default is the raw-binding lane
    // that both plain Cloudflare and the production Takoserver backend are.
    expect(moduleVariables).toContain("runtime_lane");
    expect(manifestText).not.toContain("runtime_lane");
    expect(manifestText).not.toContain("YURUCOMMU_RUNTIME_LANE");
  });

  // The graph is current, but no Host has applied it yet. The public CTA stays
  // closed until the create/rollback/destroy evidence exists — describing the
  // module and offering it are different acts.
  test("still keeps the public managed CTA closed", () => {
    expect(site).not.toContain("https://app.takosumi.com/install?");
    expect(site).toContain("Takosumi 導入は検証中");
  });
});
