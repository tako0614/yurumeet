import { describe, expect, test } from "bun:test";
import {
  claimTakosumiOidcAutoStart,
  parseAuthConfig,
  shouldAutoStartTakosumiOidc,
  suppressTakosumiOidcAutoStart,
} from "./auth-config.ts";

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

describe("Takosumi OIDC auto-start breaker", () => {
  const fakeStorage = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  };

  test("allows exactly one automatic redirect per browser tab", () => {
    // Without this, a failed OIDC round-trip re-renders the signed-out screen
    // and redirects again — a loop with no visible provider button.
    const storage = fakeStorage();
    expect(claimTakosumiOidcAutoStart(storage)).toBe(true);
    expect(claimTakosumiOidcAutoStart(storage)).toBe(false);
  });

  test("an explicit sign-out blocks the next auto-start", () => {
    // The Takosumi session outlives ours: an unsuppressed auto-start redirects
    // and signs the user straight back in, so logging out does nothing. The
    // logout paths reload the page, and sessionStorage survives that.
    const storage = fakeStorage();
    suppressTakosumiOidcAutoStart(storage);
    expect(claimTakosumiOidcAutoStart(storage)).toBe(false);
  });

  test("a browser that refuses sessionStorage still reaches sign-in", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(claimTakosumiOidcAutoStart(refusing)).toBe(true);
    expect(() => suppressTakosumiOidcAutoStart(refusing)).not.toThrow();
    expect(claimTakosumiOidcAutoStart(undefined)).toBe(true);
  });
});
