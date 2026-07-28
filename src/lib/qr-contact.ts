/**
 * What a scanned friend-add code resolves to before the actor lookup:
 * - local: an AP id served by this server, fetched directly
 * - remote: a `@user@host` handle resolved through WebFinger
 */
export type ScanTarget =
  { kind: "local"; apId: string } | { kind: "remote"; handle: string };

const HANDLE_PATTERN = /^@?([^@\s]+)@([^@\s/]+)$/;

/**
 * Accept every payload shape a friend's code can carry, so codes from
 * yurucommu (profile URL + `#username`), a raw AP id, or a typed-out
 * `@user@host` handle all land on the same lookup:
 *
 * - `https://host/profile/<encoded ap_id>#username` (yurucommu/yurumeet QR)
 * - `https://host/ap/users/name` (bare AP id = the user id itself)
 * - `https://host/users/name`
 * - `@user@host` / `user@host`
 */
export function parseScannedContact(
  text: string,
  myHost: string,
  myOrigin: string,
): ScanTarget | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const handleMatch = HANDLE_PATTERN.exec(trimmed);
  if (handleMatch) {
    const [, user, host] = handleMatch;
    if (host === myHost) {
      return { kind: "local", apId: `${myOrigin}/ap/users/${user}` };
    }
    return { kind: "remote", handle: `@${user}@${host}` };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const profileMatch = url.pathname.match(/^\/profile\/([^/?]+)/);
  if (profileMatch) {
    const apId = decodeURIComponent(profileMatch[1]);
    if (url.host === myHost) return { kind: "local", apId };
    // Remote profile URL: derive `@user@host` from the embedded AP id, or
    // fall back to the `#username` fragment yurucommu appends for this case.
    const apMatch = /^https?:\/\/([^/]+)\/ap\/users\/([^/?#]+)/.exec(apId);
    if (apMatch) {
      return { kind: "remote", handle: `@${apMatch[2]}@${apMatch[1]}` };
    }
    const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) : "";
    if (fragment) return { kind: "remote", handle: `@${fragment}@${url.host}` };
    return null;
  }

  const userMatch = url.pathname.match(/^\/(?:ap\/)?users\/([^/?#]+)/);
  if (userMatch) {
    const username = decodeURIComponent(userMatch[1]);
    if (url.host === myHost) {
      return { kind: "local", apId: `${myOrigin}/ap/users/${username}` };
    }
    return { kind: "remote", handle: `@${username}@${url.host}` };
  }

  return null;
}
