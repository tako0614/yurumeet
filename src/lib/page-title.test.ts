import { describe, expect, test } from "bun:test";
import { APP_TITLE, formatYurumeetTitle } from "./page-title.ts";

describe("formatYurumeetTitle", () => {
  test("returns base app title when section is empty", () => {
    expect(formatYurumeetTitle()).toBe(APP_TITLE);
    expect(formatYurumeetTitle("")).toBe(APP_TITLE);
    expect(formatYurumeetTitle("   ")).toBe(APP_TITLE);
    expect(formatYurumeetTitle(null)).toBe(APP_TITLE);
  });

  test("prepends trimmed section name to app title", () => {
    expect(formatYurumeetTitle("トーク")).toBe("トーク — Yurumeet");
    expect(formatYurumeetTitle("  Kissa Builders  ")).toBe(
      "Kissa Builders — Yurumeet",
    );
  });
});
