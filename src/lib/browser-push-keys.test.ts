import { expect, test } from "bun:test";
import type { BrowserNotificationPushRuntime } from "@takosjp/yurucommu-api";
import { createGuardedBrowserPushRuntime } from "./browser-push.ts";

const ORIGIN = "https://meet.example.test";

// A native PushSubscription checks `this`; the wrapper must call through.
class NativeLikeSubscription {
  readonly endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  readonly options = { applicationServerKey: new ArrayBuffer(65) };
  #p256dh = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i));
  #auth = new Uint8Array(16).fill(7);
  getKey(name: "p256dh" | "auth"): ArrayBuffer | null {
    if (!(this instanceof NativeLikeSubscription)) {
      throw new TypeError("Illegal invocation");
    }
    return (name === "p256dh" ? this.#p256dh : this.#auth).slice().buffer;
  }
  toJSON() {
    if (!(this instanceof NativeLikeSubscription)) {
      throw new TypeError("Illegal invocation");
    }
    return {
      endpoint: this.endpoint,
      keys: {
        p256dh: Buffer.from(this.#p256dh).toString("base64url"),
        auth: Buffer.from(this.#auth).toString("base64url"),
      },
    };
  }
  async unsubscribe() {
    return true;
  }
}

function runtime(): BrowserNotificationPushRuntime {
  const subscription = new NativeLikeSubscription();
  const worker = {
    state: "activated",
    addEventListener() {},
    removeEventListener() {},
  };
  const registration = {
    active: worker,
    installing: null,
    waiting: null,
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => subscription,
    },
  };
  return {
    serviceWorker: {
      register: async () => registration,
      getRegistration: async () => registration,
    },
  } as unknown as BrowserNotificationPushRuntime;
}

test("the guarded runtime keeps the subscription keys a webpush registration needs", async () => {
  const guarded = createGuardedBrowserPushRuntime(
    new AbortController().signal,
    ORIGIN,
    runtime(),
    () => ORIGIN,
  );
  const registration = await guarded.serviceWorker!.getRegistration();
  const subscription = (await registration!.pushManager.getSubscription()) as {
    getKey?(name: "p256dh" | "auth"): ArrayBuffer | null;
    toJSON?(): { keys?: Record<string, string> };
  } | null;
  expect(subscription?.getKey?.("auth")?.byteLength).toBe(16);
  expect(subscription?.getKey?.("p256dh")?.byteLength).toBe(65);
  expect(subscription?.toJSON?.().keys?.auth).toBe(
    Buffer.from(new Uint8Array(16).fill(7)).toString("base64url"),
  );
  expect(
    (registration as unknown as { active?: { state: string } }).active?.state,
  ).toBe("activated");
});

test("the guarded key accessors stop working once the cleanup scope is gone", async () => {
  const abort = new AbortController();
  const guarded = createGuardedBrowserPushRuntime(
    abort.signal,
    ORIGIN,
    runtime(),
    () => ORIGIN,
  );
  const registration = await guarded.serviceWorker!.getRegistration();
  const subscription = (await registration!.pushManager.getSubscription()) as {
    getKey?(name: "p256dh" | "auth"): ArrayBuffer | null;
  } | null;
  abort.abort();
  expect(() => subscription?.getKey?.("auth")).toThrow(
    "Browser push cleanup superseded",
  );
});
