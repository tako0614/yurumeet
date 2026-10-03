import { expect, test } from "bun:test";
import type {
  BrowserNotificationPushConfig,
  BrowserNotificationPushRuntime,
} from "@takosjp/yurucommu-api";
import {
  clearBrowserPushBeforeSignOutWithRuntime,
  createGuardedBrowserPushRuntime,
} from "./browser-push.ts";

const ORIGIN = "https://meet.example.test";
const CONFIG: BrowserNotificationPushConfig = {
  product: "yurume",
  appId: "jp.takos.yurume.web",
  appDisplayName: "Yurumeet",
  serverOrigin: ORIGIN,
  gatewayUrl: "https://push.example.test/notify",
  // Valid uncompressed P-256 key shape; no cryptographic operation is done here.
  vapidPublicKey: `B${"A".repeat(86)}`,
  serviceWorkerPath: "/notification-push-sw.js",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(runtime: BrowserNotificationPushRuntime) {
  const abort = new AbortController();
  let origin: string | null = ORIGIN;
  const currentOrigin = () => origin;
  return {
    abort,
    setOrigin(value: string | null) {
      origin = value;
    },
    guarded: createGuardedBrowserPushRuntime(
      abort.signal,
      ORIGIN,
      runtime,
      currentOrigin,
    ),
    clear(resolveConfig: () => Promise<BrowserNotificationPushConfig | null>) {
      return clearBrowserPushBeforeSignOutWithRuntime(
        abort.signal,
        ORIGIN,
        runtime,
        resolveConfig,
        currentOrigin,
      );
    },
  };
}

test("delayed runtime config abort prevents service worker access", async () => {
  const config = deferred<BrowserNotificationPushConfig | null>();
  let registrations = 0;
  const h = harness({
    serviceWorker: {
      async getRegistration() {
        registrations += 1;
        return undefined;
      },
      async register() {
        registrations += 1;
        throw new Error("unexpected registration");
      },
    },
  });

  const clearing = h.clear(() => config.promise);
  h.abort.abort();
  config.resolve(CONFIG);
  await expect(clearing).rejects.toMatchObject({ name: "AbortError" });
  expect(registrations).toBe(0);
});

test("origin change while runtime config is pending prevents fallback mutation", async () => {
  const config = deferred<BrowserNotificationPushConfig | null>();
  let getRegistration = 0;
  const h = harness({
    serviceWorker: {
      async getRegistration() {
        getRegistration += 1;
        return undefined;
      },
      async register() {
        throw new Error("unexpected registration");
      },
    },
  });
  const clearing = h.clear(() => config.promise);
  h.setOrigin("https://new.example.test");
  config.resolve(null);
  await expect(clearing).rejects.toMatchObject({ name: "AbortError" });
  expect(getRegistration).toBe(0);
});

test("abort after getRegistration prevents later getSubscription and storage mutation", async () => {
  const registration =
    deferred<
      NonNullable<
        Awaited<
          ReturnType<
            NonNullable<
              BrowserNotificationPushRuntime["serviceWorker"]
            >["getRegistration"]
          >
        >
      >
    >();
  let getSubscription = 0;
  let storageWrites = 0;
  const h = harness({
    serviceWorker: {
      getRegistration: () => registration.promise,
      async register() {
        throw new Error("unexpected registration");
      },
    },
    storage: {
      getItem: () => null,
      setItem() {
        storageWrites += 1;
      },
      removeItem() {
        storageWrites += 1;
      },
    },
  });

  const getting = h.guarded.serviceWorker!.getRegistration!();
  h.abort.abort();
  registration.resolve({
    pushManager: {
      async getSubscription() {
        getSubscription += 1;
        return null;
      },
      async subscribe() {
        throw new Error("unexpected subscribe");
      },
    },
  });
  await expect(getting).rejects.toMatchObject({ name: "AbortError" });
  expect(getSubscription).toBe(0);
  expect(storageWrites).toBe(0);
});

test("abort after getSubscription prevents unregister, unsubscribe, and storage writes", async () => {
  const subscription = deferred<{
    endpoint: string;
    unsubscribe(): Promise<boolean>;
  } | null>();
  let unregisterRequests = 0;
  let unsubscribes = 0;
  let storageWrites = 0;
  const h = harness({
    serviceWorker: {
      async getRegistration() {
        return {
          pushManager: {
            getSubscription: () => subscription.promise,
            async subscribe() {
              throw new Error("unexpected subscribe");
            },
          },
        };
      },
      async register() {
        throw new Error("unexpected registration");
      },
    },
    notification: {
      permission: "granted",
      async requestPermission() {
        return "granted";
      },
    },
    storage: {
      getItem: () => null,
      setItem() {
        storageWrites += 1;
      },
      removeItem() {
        storageWrites += 1;
      },
    },
  });

  // Configured disable path performs no mutation before waiting for the
  // subscription, then the guarded continuation must stop before SDK unregister.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    unregisterRequests += 1;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const clearing = h.clear(async () => CONFIG);
    await Promise.resolve();
    await Promise.resolve();
    h.abort.abort();
    subscription.resolve({
      endpoint: "https://push.example.test/subscription",
      async unsubscribe() {
        unsubscribes += 1;
        return true;
      },
    });
    await expect(clearing).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(unregisterRequests).toBe(0);
  expect(unsubscribes).toBe(0);
  expect(storageWrites).toBe(0);
});

test("abort after unregister request starts cannot retract it but blocks local cleanup", async () => {
  const unregisterResponse = deferred<Response>();
  const unregisterStarted = deferred<void>();
  let unsubscribeCalls = 0;
  let storageWrites = 0;
  const h = harness({
    serviceWorker: {
      async getRegistration() {
        return {
          pushManager: {
            async getSubscription() {
              return {
                endpoint: "https://push.example.test/subscription",
                async unsubscribe() {
                  unsubscribeCalls += 1;
                  return true;
                },
              };
            },
            async subscribe() {
              throw new Error("unexpected subscribe");
            },
          },
        };
      },
      async register() {
        throw new Error("unexpected registration");
      },
    },
    notification: {
      permission: "granted",
      async requestPermission() {
        return "granted";
      },
    },
    storage: {
      getItem: () => null,
      setItem() {
        storageWrites += 1;
      },
      removeItem() {
        storageWrites += 1;
      },
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    unregisterStarted.resolve();
    return unregisterResponse.promise;
  }) as unknown as typeof fetch;
  try {
    const clearing = h.clear(async () => CONFIG);
    await unregisterStarted.promise;
    h.abort.abort();
    unregisterResponse.resolve(new Response(null, { status: 204 }));
    await expect(clearing).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(unsubscribeCalls).toBe(0);
  expect(storageWrites).toBe(0);
});
