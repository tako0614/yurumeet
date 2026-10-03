import { afterEach, expect, test } from "bun:test";
import { configureYurumeetServerOrigin } from "../server-config.ts";
import {
  postYurumeetLogout,
  readYurumeetCurrentActor,
} from "./auth-request.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  configureYurumeetServerOrigin("https://reset.example.test");
});

function respond(response: () => Response) {
  const calls: { url: string; method: string; credentials?: string }[] = [];
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      credentials: init?.credentials,
    });
    return response();
  }) as unknown as typeof fetch;
  return calls;
}

test("a logout response preserves non2xx and the captured server origin", async () => {
  configureYurumeetServerOrigin("https://new.example.test");
  const calls = respond(() => new Response(null, { status: 503 }));
  expect(
    (await postYurumeetLogout("https://original.example.test")).status,
  ).toBe(503);
  expect(calls).toEqual([
    {
      url: "https://original.example.test/api/auth/logout",
      method: "POST",
      credentials: "include",
    },
  ]);
});

test("only the current-user route anonymous status produces null", async () => {
  respond(() => new Response(null, { status: 401 }));
  expect(
    await readYurumeetCurrentActor("https://server.example.test"),
  ).toBeNull();
  for (const status of [403, 429, 503]) {
    respond(() => new Response(null, { status }));
    await expect(
      readYurumeetCurrentActor("https://server.example.test"),
    ).rejects.toThrow();
  }
});

test("malformed200 never invents an anonymous or authenticated principal", async () => {
  for (const value of [
    {},
    { actor: null },
    { actor: [] },
    { actor: { ap_id: "" } },
    { actor: { ap_id: "not-a-url", username: "a", preferred_username: "a" } },
    {
      actor: {
        ap_id: "javascript:alert(1)",
        username: "a",
        preferred_username: "a",
      },
    },
    {
      actor: {
        ap_id: "https://a:b@server.example.test/a",
        username: "a",
        preferred_username: "a",
      },
    },
  ]) {
    respond(() => Response.json(value));
    await expect(
      readYurumeetCurrentActor("https://server.example.test"),
    ).rejects.toThrow();
  }
});

test("valid observed identity is returned from a read-only request", async () => {
  const actor = {
    ap_id: "https://canonical.example.test/ap/actors/a",
    username: "a@canonical.example.test",
    preferred_username: "a",
  };
  const calls = respond(() => Response.json({ actor }));
  const observed: unknown = await readYurumeetCurrentActor(
    "https://server.example.test",
  );
  expect(observed).toEqual(actor);
  expect(calls).toEqual([
    {
      url: "https://server.example.test/api/auth/me",
      method: "GET",
      credentials: "include",
    },
  ]);
});

test("a stalled successful body reaches the authentication deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requestSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('{"actor":'));
        },
      }),
    );
  }) as unknown as typeof fetch;
  try {
    await expect(
      readYurumeetCurrentActor("https://server.example.test"),
    ).rejects.toThrow("認証状態を確認できませんでした");
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    bodyController?.close();
  }
}, 20_000);
