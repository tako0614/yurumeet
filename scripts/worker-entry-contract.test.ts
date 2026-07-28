import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { createEntrySource } from "./build-takos-worker.ts";

const entrySource = createEntrySource({});

const wranglerConfig = await readFile(
  new URL("../wrangler.jsonc", import.meta.url),
  "utf8",
);

const moduleSource = await readFile(
  new URL("../main.tf", import.meta.url),
  "utf8",
);

describe("generated worker entry", () => {
  // The cron trigger fires whatever the deployed module exports. This entry
  // builds its own default object rather than re-exporting the core one, so a
  // missing scheduled() here means the retention sweep never runs anywhere.
  test("exports a scheduled handler that forwards to the core retention sweep", () => {
    expect(entrySource).toContain("async scheduled(");
    expect(entrySource).toContain("yurucommuCore");
    expect(entrySource).toContain("runRetention(controller, env, ctx)");
  });

  test("allows only the camera feature the Yurumeet document actually uses", () => {
    expect(entrySource).toContain(
      'import { withYurumeetDocumentPolicy } from "../src/runtime-policy.ts"',
    );
    expect(entrySource).toContain("withYurumeetDocumentPolicy(response)");
  });
});

describe("retention cron surface", () => {
  test("wrangler config schedules the sweep", () => {
    expect(wranglerConfig).toContain('"crons"');
  });

  // The Capsule path has no wrangler.jsonc, so the trigger must also exist as a
  // resource or an OpenTofu install silently never sweeps.
  test("the Capsule module schedules the sweep", () => {
    expect(moduleSource).toContain(
      'resource "cloudflare_workers_cron_trigger" "retention"',
    );
  });
});

describe("owner-slot pin", () => {
  // OIDC-seeded installs force AUTH_PASSWORD_HASH empty, so the first sign-in
  // takes the single owner slot. The pin must be settable and the unpinned case
  // must require an explicit acknowledgement.
  test("projects the owner pin and the member allowlist as bindings", () => {
    expect(moduleSource).toContain('variable "oidc_owner_sub"');
    expect(moduleSource).toContain('variable "oidc_allowed_subs"');
    expect(moduleSource).toContain('name = "OIDC_OWNER_SUB"');
    expect(moduleSource).toContain('name = "OIDC_ALLOWED_SUBS"');
  });

  test("refuses an OIDC install with no pin unless the race is acknowledged", () => {
    expect(moduleSource).toContain("var.allow_unpinned_owner_claim");
  });

  test("does not generate a hidden bootstrap credential", () => {
    expect(moduleSource).not.toContain(
      'resource "random_id" "bootstrap_auth_token"',
    );
    expect(moduleSource).toContain(
      '!local.cloudflare_worker_enabled || local.provided_auth_password_hash != "" || local.has_takosumi_accounts_oidc',
    );
  });
});
