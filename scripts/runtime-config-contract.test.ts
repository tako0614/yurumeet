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

  test("the direct module owns Cloudflare compatibility while the portable graph stays generic", () => {
    expect(rootModule).toContain(
      'jsondecode(file("${path.module}/wrangler.jsonc"))',
    );
    expect(takoformModule).not.toContain("compatibility_date");
    expect(takoformModule).not.toContain("compatibility_flags");
    expect(takoformModule).not.toContain("wrangler.jsonc");
    expect(takoformModule).toContain('runtime         = "javascript"');
  });
});
