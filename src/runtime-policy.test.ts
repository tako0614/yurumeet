import { describe, expect, test } from "bun:test";

import {
  allowHttpsMedia,
  withYurumeetDocumentPolicy,
} from "./runtime-policy.ts";

describe("Yurumeet runtime document policy", () => {
  test("allows remote HTTPS video without broadening other directives", () => {
    expect(
      allowHttpsMedia(
        "default-src 'self'; media-src 'self' data: blob:; frame-ancestors 'none'",
      ),
    ).toBe(
      "default-src 'self'; media-src 'self' data: blob: https:; frame-ancestors 'none'",
    );
  });

  test("enables camera only for the same-origin QR scanner", () => {
    const response = withYurumeetDocumentPolicy(
      new Response("<!doctype html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; media-src 'self' data: blob:",
        },
      }),
    );

    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(self), microphone=(), geolocation=()",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "media-src 'self' data: blob: https:",
    );
  });

  test("does not rewrite API responses", () => {
    const response = new Response("{}", {
      headers: { "content-type": "application/json" },
    });
    expect(withYurumeetDocumentPolicy(response)).toBe(response);
  });
});
