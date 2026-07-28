import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const [wranglerSource, rootModule, takoformModule] = await Promise.all([
  readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  readFile(new URL("../main.tf", import.meta.url), "utf8"),
  readFile(new URL("../deploy/takoform/main.tf", import.meta.url), "utf8"),
]);

describe("Worker runtime configuration", () => {
  test("keeps one parseable repo-owned compatibility source", () => {
    const config = JSON.parse(wranglerSource) as {
      compatibility_date?: unknown;
      compatibility_flags?: unknown;
    };
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config.compatibility_flags).toEqual([
      "nodejs_compat",
      "global_fetch_strictly_public",
    ]);
  });

  test("both OpenTofu modules read the canonical config instead of copying it", () => {
    expect(rootModule).toContain(
      'jsondecode(file("${path.module}/wrangler.jsonc"))',
    );
    expect(takoformModule).toContain(
      'jsondecode(file("${path.module}/../../wrangler.jsonc"))',
    );
    for (const moduleSource of [rootModule, takoformModule]) {
      expect(moduleSource).not.toMatch(
        /variable\s+"worker_compatibility_date"\s*\{[\s\S]*?default\s*=\s*"\d{4}-\d{2}-\d{2}"/,
      );
    }
  });
});
