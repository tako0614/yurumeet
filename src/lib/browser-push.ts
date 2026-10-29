import {
  clearBrowserNotificationPush,
  createBrowserPushConfigResolver,
  disableBrowserNotificationPush,
  type BrowserNotificationPushConfig,
  type BrowserNotificationPushRuntime,
} from "@takosjp/yurucommu-api";
import { readYurumeetServerOrigin } from "../server-config.ts";

type BrowserServiceWorkerRuntime = NonNullable<
  BrowserNotificationPushRuntime["serviceWorker"]
>;
type BrowserServiceWorkerRegistration = NonNullable<
  Awaited<ReturnType<BrowserServiceWorkerRuntime["getRegistration"]>>
>;

export function captureBrowserPushRuntime(): BrowserNotificationPushRuntime {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    ...(globalThis.navigator?.serviceWorker
      ? { serviceWorker: globalThis.navigator.serviceWorker }
      : {}),
    ...(globalThis.Notification
      ? { notification: globalThis.Notification }
      : {}),
    ...(storage ? { storage } : {}),
  };
}

const browserPushIdentity = {
  product: "yurume" as const,
  appId: "jp.takos.yurume.web",
  appDisplayName: "Yurume",
  serviceWorkerPath: "/notification-push-sw.js",
};

/**
 * The shared yurucommu-core resolver owns which runtime values enable browser
 * push: the server's `GET /api/notifications/pushers/config`, with the
 * build-time values below only as an offline fallback. On a core that sends
 * standard Web Push itself, the server's own VAPID key is enough.
 */
function resolver() {
  const lang = currentLanguage();
  return createBrowserPushConfigResolver({
    identity: { ...browserPushIdentity, ...(lang ? { lang } : {}) },
    resolveServerOrigin: readYurumeetServerOrigin,
    buildTimeValues: () => {
      const env = (
        import.meta as unknown as {
          readonly env?: Readonly<Record<string, string | undefined>>;
        }
      ).env;
      return {
        gatewayUrl: env?.VITE_YURUME_NOTIFICATION_PUSH_GATEWAY_URL,
        vapidPublicKey: env?.VITE_YURUME_WEB_PUSH_PUBLIC_KEY,
      };
    },
  });
}

/** The page language (<html lang>) so the server writes push text in it. */
function currentLanguage(): string | null {
  if (typeof document === "undefined") return null;
  const lang = document.documentElement.lang.trim();
  return /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(lang) ? lang : null;
}

export function yurumeBrowserPushConfig(): BrowserNotificationPushConfig | null {
  return resolver().buildTimeConfig();
}

export async function resolveYurumeBrowserPushConfig(): Promise<BrowserNotificationPushConfig | null> {
  return resolver().resolveConfig();
}

/**
 * Standard PushSubscription key accessors. A core that registers `webpush`
 * pushers reads p256dh/auth through these, so the guarded wrapper must keep
 * them (bound to the real subscription).
 */
type SubscriptionKeyAccess = {
  getKey?(name: "p256dh" | "auth"): ArrayBuffer | null;
  toJSON?(): {
    readonly endpoint?: string | null;
    readonly keys?: Readonly<Record<string, string>>;
  };
};

function guardedKeyAccess(subscription: object, guard: () => void) {
  const access = subscription as SubscriptionKeyAccess;
  return {
    ...(access.getKey
      ? {
          getKey(name: "p256dh" | "auth") {
            guard();
            return access.getKey!.call(subscription, name);
          },
        }
      : {}),
    ...(access.toJSON
      ? {
          toJSON() {
            guard();
            return access.toJSON!.call(subscription);
          },
        }
      : {}),
  };
}

/** Registration worker fields, so the SDK can wait for activation. */
type RegistrationWorkers = {
  readonly active?: ServiceWorker | null;
  readonly installing?: ServiceWorker | null;
  readonly waiting?: ServiceWorker | null;
};

function throwIfPushCleanupInactive(
  signal: AbortSignal,
  origin: string,
  currentOrigin: () => string | null,
): void {
  if (signal.aborted || currentOrigin() !== origin) {
    throw new DOMException("Browser push cleanup superseded", "AbortError");
  }
}

/**
 * Wrap the SDK runtime so an async result from an old root/session cannot begin
 * later local mutations. The SDK starts server unregister synchronously after
 * getSubscription resolves; throwing from that wrapper prevents the call.
 */
export function createGuardedBrowserPushRuntime(
  signal: AbortSignal,
  origin: string,
  runtime: BrowserNotificationPushRuntime = captureBrowserPushRuntime(),
  currentOrigin: () => string | null = readYurumeetServerOrigin,
): BrowserNotificationPushRuntime {
  const guard = () => throwIfPushCleanupInactive(signal, origin, currentOrigin);
  const storage = runtime.storage
    ? {
        getItem(key: string) {
          guard();
          return runtime.storage!.getItem(key);
        },
        setItem(key: string, value: string) {
          guard();
          runtime.storage!.setItem(key, value);
        },
        removeItem(key: string) {
          guard();
          runtime.storage!.removeItem(key);
        },
      }
    : undefined;
  const serviceWorker = runtime.serviceWorker
    ? {
        async register(scriptURL: string, options?: RegistrationOptions) {
          guard();
          const registration = await runtime.serviceWorker!.register(
            scriptURL,
            options,
          );
          guard();
          return guardRegistration(registration);
        },
        async getRegistration(clientURL?: string) {
          guard();
          const registration =
            await runtime.serviceWorker!.getRegistration(clientURL);
          guard();
          return registration ? guardRegistration(registration) : undefined;
        },
      }
    : undefined;
  const notification = runtime.notification
    ? {
        get permission() {
          guard();
          return runtime.notification!.permission;
        },
        async requestPermission() {
          guard();
          const permission = await runtime.notification!.requestPermission();
          guard();
          return permission;
        },
      }
    : undefined;

  return {
    ...(storage ? { storage } : {}),
    ...(serviceWorker ? { serviceWorker } : {}),
    ...(notification ? { notification } : {}),
  };

  function guardRegistration(registration: BrowserServiceWorkerRegistration) {
    const pushManager = registration.pushManager;
    const workers = registration as unknown as RegistrationWorkers;
    return {
      get active() {
        guard();
        return workers.active;
      },
      get installing() {
        guard();
        return workers.installing;
      },
      get waiting() {
        guard();
        return workers.waiting;
      },
      pushManager: {
        async getSubscription() {
          guard();
          const subscription = await pushManager.getSubscription();
          guard();
          if (!subscription) return null;
          return {
            get endpoint() {
              guard();
              return subscription.endpoint;
            },
            get options() {
              guard();
              return subscription.options;
            },
            async unsubscribe() {
              guard();
              const result = await subscription.unsubscribe();
              guard();
              return result;
            },
            ...guardedKeyAccess(subscription, guard),
          };
        },
        subscribe: async (options: {
          readonly userVisibleOnly: true;
          readonly applicationServerKey: BufferSource;
        }) => {
          guard();
          const subscription = await pushManager.subscribe(options);
          guard();
          return {
            get endpoint() {
              guard();
              return subscription.endpoint;
            },
            get options() {
              guard();
              return subscription.options;
            },
            async unsubscribe() {
              guard();
              const result = await subscription.unsubscribe();
              guard();
              return result;
            },
            ...guardedKeyAccess(subscription, guard),
          };
        },
      },
    };
  }
}

export async function clearBrowserPushBeforeSignOutWithRuntime(
  signal: AbortSignal,
  origin: string,
  runtime: BrowserNotificationPushRuntime,
  resolveConfig: () => Promise<BrowserNotificationPushConfig | null>,
  currentOrigin: () => string | null,
): Promise<void> {
  const ensureActive = () =>
    throwIfPushCleanupInactive(signal, origin, currentOrigin);
  ensureActive();
  let config: BrowserNotificationPushConfig | null = null;
  try {
    config = await resolveConfig();
  } catch {
    // Runtime config may be unavailable; continue to local invalidation only.
  }
  ensureActive();
  const guardedRuntime = createGuardedBrowserPushRuntime(
    signal,
    origin,
    runtime,
    currentOrigin,
  );
  if (config && config.serverOrigin === origin) {
    try {
      await disableBrowserNotificationPush(config, guardedRuntime);
      ensureActive();
      return;
    } catch (error) {
      ensureActive();
      // Fall through to local endpoint invalidation while this scope is active.
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
    }
  }
  ensureActive();
  try {
    await clearBrowserNotificationPush(browserPushIdentity, guardedRuntime);
  } catch (error) {
    ensureActive();
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
  }
  ensureActive();
}

export async function clearYurumeBrowserPushBeforeSignOut(
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const origin = readYurumeetServerOrigin();
  if (!origin || signal.aborted) return;
  const runtime = captureBrowserPushRuntime();
  await clearBrowserPushBeforeSignOutWithRuntime(
    signal,
    origin,
    runtime,
    () => resolveYurumeBrowserPushConfig(),
    readYurumeetServerOrigin,
  );
}
