import type { Actor } from "@takosjp/yurucommu-api";
import { serverUrl } from "../server-config.ts";

// A captured operation must not acquire credentials/headers from a subsequently
// configured SDK transport. This product authenticates through its cookie.
async function authRequest<T>(
  origin: string,
  path: string,
  method: string,
  consume: (response: Response) => Promise<T>,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("認証状態を確認できませんでした"));
    }, 15_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(serverUrl(origin, path), {
          method,
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        return consume(response);
      })(),
      deadline,
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Read the selected server; a malformed success is not evidence of sign-out. */
export async function readYurumeetCurrentActor(
  origin: string,
): Promise<Actor | null> {
  return authRequest(origin, "/api/auth/me", "GET", parseCurrentActor);
}

async function parseCurrentActor(response: Response): Promise<Actor | null> {
  // The real current-user route declares 401 for missing authentication. A
  // denial (403), throttling or outage does not establish an anonymous browser.
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("認証状態を確認できませんでした");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("認証状態を確認できませんでした");
  }
  const actor = (value as Record<string, unknown>).actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    throw new Error("認証状態を確認できませんでした");
  }
  const record = actor as Record<string, unknown>;
  if (
    typeof record.ap_id !== "string" ||
    record.ap_id.trim() === "" ||
    typeof record.username !== "string" ||
    typeof record.preferred_username !== "string"
  ) {
    throw new Error("認証状態を確認できませんでした");
  }
  // This validates principal identity, not every optional profile field.
  const apId = new URL(record.ap_id);
  if (
    !["https:", "http:"].includes(apId.protocol) ||
    apId.username ||
    apId.password
  ) {
    throw new Error("認証状態を確認できませんでした");
  }
  return actor as Actor;
}

/** Preserve the response so the product can inspect a refused acknowledgement. */
export function postYurumeetLogout(origin: string): Promise<Response> {
  // The acknowledgement body has no authority over the follow-up observation.
  return authRequest(origin, "/api/auth/logout", "POST", async (response) => {
    await response.body?.cancel();
    return response;
  });
}
