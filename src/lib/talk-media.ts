import { getYurucommuApiTransport } from "@takosjp/yurucommu-api";
import type { JournalTarget } from "./outgoing-journal.ts";

export type TalkMediaScope = {
  origin: string;
  principal: string;
  authEpoch: number;
  target: JournalTarget;
};

/** Capture public SDK destination and local owner before any asynchronous work. */
export function captureTalkMediaGuard(
  readScope: () => TalkMediaScope,
  isViewCurrent: () => boolean,
): () => boolean {
  const input = readScope();
  const scope = { ...input, target: { ...input.target } };
  const transport = getYurucommuApiTransport();
  const path =
    scope.target.type === "community"
      ? `/api/communities/${encodeURIComponent(scope.target.ap_id)}/messages`
      : `/api/dm/user/${encodeURIComponent(scope.target.ap_id)}/messages`;
  const uploadUrl = new URL(
    transport.resolveUrl("/api/media/upload"),
    scope.origin,
  ).href;
  const sendUrl = new URL(transport.resolveUrl(path), scope.origin).href;
  const expectedUpload = new URL("/api/media/upload", scope.origin).href;
  const expectedSend = new URL(path, scope.origin).href;
  return () => {
    try {
      const current = readScope();
      return (
        isViewCurrent() &&
        scope.origin === current.origin &&
        scope.principal === current.principal &&
        scope.authEpoch === current.authEpoch &&
        scope.target.type === current.target.type &&
        scope.target.ap_id === current.target.ap_id &&
        uploadUrl === expectedUpload &&
        sendUrl === expectedSend &&
        getYurucommuApiTransport() === transport &&
        new URL(transport.resolveUrl("/api/media/upload"), scope.origin)
          .href === uploadUrl &&
        new URL(transport.resolveUrl(path), scope.origin).href === sendUrl
      );
    } catch {
      return false;
    }
  };
}

/** Only a valid advertised deadline can locally establish expiration. */
export function talkMediaExpired(
  expiresAt?: string,
  now = Date.now(),
): boolean {
  const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(deadline) && deadline <= now;
}
