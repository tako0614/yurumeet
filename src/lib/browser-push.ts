import {
  clearBrowserNotificationPush,
  disableBrowserNotificationPush,
  fetchNotificationPusherPublicConfig,
  type BrowserNotificationPushConfig,
} from "@takosjp/yurucommu-api";
import { readYurumeetServerOrigin } from "../server-config.ts";

const browserPushIdentity = {
  product: "yurume" as const,
  appId: "jp.takos.yurume.web",
  serviceWorkerPath: "/notification-push-sw.js",
};

export function yurumeBrowserPushConfig(): BrowserNotificationPushConfig | null {
  const env = (
    import.meta as unknown as {
      readonly env?: Readonly<Record<string, string | undefined>>;
    }
  ).env;
  const gatewayUrl = env?.VITE_YURUME_NOTIFICATION_PUSH_GATEWAY_URL?.trim();
  const vapidPublicKey = env?.VITE_YURUME_WEB_PUSH_PUBLIC_KEY?.trim();
  if (!gatewayUrl || !vapidPublicKey) return null;
  return createConfig(gatewayUrl, vapidPublicKey);
}

export async function resolveYurumeBrowserPushConfig(): Promise<BrowserNotificationPushConfig | null> {
  try {
    const runtime = await fetchNotificationPusherPublicConfig();
    if (
      !runtime.enabled ||
      !runtime.gateway_url ||
      !runtime.web_push_public_key
    ) {
      return null;
    }
    return createConfig(runtime.gateway_url, runtime.web_push_public_key);
  } catch {
    return yurumeBrowserPushConfig();
  }
}

function createConfig(
  gatewayUrl: string,
  vapidPublicKey: string,
): BrowserNotificationPushConfig | null {
  const serverOrigin = readYurumeetServerOrigin();
  if (!serverOrigin) return null;
  return {
    ...browserPushIdentity,
    appDisplayName: "Yurume",
    serverOrigin,
    gatewayUrl,
    vapidPublicKey,
  };
}

export async function clearYurumeBrowserPushBeforeSignOut(): Promise<void> {
  const config = await resolveYurumeBrowserPushConfig().catch(() => null);
  if (config) {
    try {
      await disableBrowserNotificationPush(config);
      return;
    } catch {
      // Fall through to local endpoint invalidation.
    }
  }
  await clearBrowserNotificationPush(browserPushIdentity).catch(
    () => undefined,
  );
}
