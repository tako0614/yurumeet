import { describe, expect, test } from "bun:test";

import { selectYurumeetServerOrigin } from "./server-config.ts";

describe("Yurumeet server origin selection", () => {
  test("production is always bound to the app origin", () => {
    expect(
      selectYurumeetServerOrigin({
        appOrigin: "https://talk.example",
        development: false,
        queryOverride: "https://attacker.example",
        buildOverride: "https://api.example",
        storedOverride: "https://old.example",
      }),
    ).toBe("https://talk.example");
  });

  test("development may explicitly target a separate local server", () => {
    expect(
      selectYurumeetServerOrigin({
        appOrigin: "http://localhost:5174",
        development: true,
        queryOverride: "http://localhost:8787",
        buildOverride: "http://localhost:8788",
        storedOverride: null,
      }),
    ).toBe("http://localhost:8787");
  });

  test("development ignores invalid overrides and falls back to the app", () => {
    expect(
      selectYurumeetServerOrigin({
        appOrigin: "http://localhost:5174",
        development: true,
        queryOverride: "javascript:alert(1)",
        buildOverride: null,
        storedOverride: null,
      }),
    ).toBe("http://localhost:5174");
  });
});
