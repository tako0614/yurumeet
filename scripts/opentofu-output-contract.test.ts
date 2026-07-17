import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const outputsSource = await readFile(
  new URL("../outputs.tf", import.meta.url),
  "utf8",
);

const outputNames = Array.from(
  outputsSource.matchAll(/output\s+"([^"]+)"\s*\{/g),
  (match) => match[1],
);

describe("OpenTofu output contract", () => {
  test("keeps only the ordinary runtime URL outputs mapped by the InstallConfig", () => {
    expect(outputNames.filter((name) => name.endsWith("_url"))).toEqual([
      "launch_url",
      "api_url",
    ]);
  });

  test("does not reintroduce retired runtime or lifecycle authority outputs", () => {
    for (const retired of [
      "takosumi_release",
      "app_deployment",
      "service_exports",
      "service_bindings",
    ]) {
      expect(outputNames).not.toContain(retired);
      expect(outputsSource).not.toContain(`output "${retired}"`);
    }
  });
});
