import { describe, expect, test } from "bun:test";
import { parseAuthConfig, shouldAutoStartTakosumiOidc } from "./auth-config.ts";

describe("Yurumeet auth configuration", () => {
  test("accepts the server auth provider response", () => {
    expect(
      parseAuthConfig({
        providers: [{ id: "takos", name: "Takosumi", icon: "/icon.svg" }],
        password_enabled: false,
      }),
    ).toEqual({
      providers: [{ id: "takos", name: "Takosumi", icon: "/icon.svg" }],
      password_enabled: false,
    });
  });

  test("rejects malformed or unsafe providers", () => {
    expect(
      parseAuthConfig({ providers: [], password_enabled: "yes" }),
    ).toBeNull();
    expect(
      parseAuthConfig({
        providers: [{ id: "../callback", name: "Bad", icon: "" }],
        password_enabled: true,
      }),
    ).toBeNull();
  });

  test("auto-starts only a sole passwordless Takosumi provider", () => {
    const takosOnly = {
      providers: [{ id: "takos", name: "Takosumi", icon: "" }],
      password_enabled: false,
    };
    expect(shouldAutoStartTakosumiOidc(takosOnly)).toBe(true);
    expect(
      shouldAutoStartTakosumiOidc({ ...takosOnly, password_enabled: true }),
    ).toBe(false);
    expect(
      shouldAutoStartTakosumiOidc({
        providers: [{ id: "google", name: "Google", icon: "" }],
        password_enabled: false,
      }),
    ).toBe(false);
  });
});
