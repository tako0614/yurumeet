import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

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
          label: { ja: string; en: string };
          secret?: boolean;
        }>;
        requires?: Array<{
          kind: string;
          deliver?: Record<string, unknown>;
        }>;
        interfaces?: Array<{
          name: string;
          spec: {
            type: string;
            version: string;
            access: Record<string, unknown>;
          };
        }>;
        installExperience?: {
          projections: Array<
            Record<string, unknown> & {
              kind: string;
              variable?: string;
              variables?: Record<string, string>;
            }
          >;
        };
        features?: Array<{
          id: string;
          optional: boolean;
          label: { ja: string; en: string };
          inputs: string[];
        }>;
      }
    >;
  };
};
const rootModuleSource = await readFile(new URL("main.tf", rootUrl), "utf8");
const site = await readFile(new URL("site/index.html", rootUrl), "utf8");

function projectionVariables(projection: {
  variable?: string;
  variables?: Record<string, string>;
}): string[] {
  return [
    ...(projection.variable ? [projection.variable] : []),
    ...Object.values(projection.variables ?? {}),
  ];
}

describe("repository-owned Takosumi install UX", () => {
  test("publishes repository input and service hints", () => {
    expect(Object.keys(manifest).sort()).toEqual([
      "apiVersion",
      "install",
      "kind",
    ]);
    expect(manifest.apiVersion).toBe("takosumi.com/v1");
    expect(manifest.kind).toBe("Repository");
    expect(Object.keys(manifest.install)).toEqual(["modules"]);
    expect(Object.keys(manifest.install.modules)).toEqual(["."]);
    expect(manifest.install.modules["."]).toBeDefined();
  });

  test("repository install hints reference real root-module variables and services", () => {
    const module = manifest.install.modules["."];
    const moduleVariables = new Set(
      Array.from(
        rootModuleSource.matchAll(/variable\s+"([^"]+)"\s*\{/g),
        (match) => match[1],
      ),
    );
    const referencedVariables = new Set([
      ...module.inputs.map((input) => input.name),
      ...(module.installExperience?.projections ?? []).flatMap(
        projectionVariables,
      ),
      ...(module.features ?? []).flatMap((feature) => feature.inputs),
    ]);
    expect(
      [...referencedVariables].filter((name) => !moduleVariables.has(name)),
    ).toEqual([]);
    for (const input of module.inputs.filter(
      (candidate) => candidate.source.kind === "module_default",
    )) {
      const blockStart = rootModuleSource.indexOf(`variable "${input.name}" {`);
      const nextBlock = rootModuleSource.indexOf("\nvariable ", blockStart + 1);
      expect(
        rootModuleSource.slice(
          blockStart,
          nextBlock < 0 ? undefined : nextBlock,
        ),
      ).toMatch(/\n\s+default\s+=/);
    }
    for (const input of module.inputs) {
      expect(input.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      expect(typeof input.label.ja).toBe("string");
      expect(typeof input.label.en).toBe("string");
    }
    for (const requirement of module.requires ?? []) {
      expect(["http.endpoint", "identity.oidc", "interface.consume"]).toContain(
        requirement.kind,
      );
      if (requirement.deliver) {
        expect(Object.keys(requirement.deliver)).toHaveLength(1);
      }
    }
    for (const service of module.interfaces ?? []) {
      expect(typeof service.name).toBe("string");
      expect(typeof service.spec.type).toBe("string");
      expect(typeof service.spec.version).toBe("string");
      expect(service.spec.access).toBeDefined();
    }
  });

  test("keeps host authority and unpublished module paths out of metadata", () => {
    for (const forbidden of [
      "cloudflare_account_id",
      "enable_cloudflare_resources",
      "enable_cloudflare_worker_script",
      "encryption_key",
      "oidc_owner_sub",
      "allow_unpinned_owner_claim",
      "deploy/takoform",
    ]) {
      expect(manifestText).not.toContain(forbidden);
    }
    expect(site).not.toContain("https://app.takosumi.com/install?");
    expect(site).toContain("Takosumi 導入は検証中");
  });

  test("marks only user-provided authentication material as secret", () => {
    const module = manifest.install.modules["."];
    expect(
      module.inputs
        .filter((input) => input.secret)
        .map((input) => [input.name, input.source.kind]),
    ).toEqual([["auth_password_hash", "user"]]);
    expect(module.features).toEqual([
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
  });
});
