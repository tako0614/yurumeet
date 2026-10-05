/** Unread badge channels remain independent because each has its own endpoint. */
export type UnreadBadgeChannel = "talk" | "notifications";

export type UnreadBadgeReaders = Record<
  UnreadBadgeChannel,
  () => Promise<number>
>;

export type UnreadBadgeScope = {
  origin: string;
  actorApId: string;
  authEpoch: number;
  transport: object;
  talkUrl: string;
  notificationsUrl: string;
};

export type UnreadBadgeRefresh = {
  refresh(): void;
  retire(): void;
};

/**
 * Track completion order independently for each channel and bind requests to
 * one actor/auth/transport scope. A failed newest read still retires older
 * reads while leaving the last applied count intact.
 */
export function createUnreadBadgeRefresh(options: {
  readers: UnreadBadgeReaders;
  captureScope: () => UnreadBadgeScope | null;
  isScopeCurrent: (scope: UnreadBadgeScope) => boolean;
  apply: (channel: UnreadBadgeChannel, count: number) => void;
  clear: () => void;
}): UnreadBadgeRefresh {
  const generation: Record<UnreadBadgeChannel, number> = {
    talk: 0,
    notifications: 0,
  };
  let activeScope: UnreadBadgeScope | null = null;

  const sameScope = (left: UnreadBadgeScope, right: UnreadBadgeScope) =>
    left.origin === right.origin &&
    left.actorApId === right.actorApId &&
    left.authEpoch === right.authEpoch &&
    left.transport === right.transport &&
    left.talkUrl === right.talkUrl &&
    left.notificationsUrl === right.notificationsUrl;

  const retire = () => {
    activeScope = null;
    generation.talk += 1;
    generation.notifications += 1;
    options.clear();
  };

  const refresh = () => {
    const scope = options.captureScope();
    if (!scope) {
      if (activeScope) retire();
      return;
    }
    if (!activeScope || !sameScope(activeScope, scope)) {
      if (activeScope) retire();
      activeScope = scope;
    }
    for (const channel of ["talk", "notifications"] as const) {
      const ticket = ++generation[channel];
      void options.readers[channel]()
        .then((count) => {
          if (ticket !== generation[channel]) return;
          if (!options.isScopeCurrent(scope)) {
            retire();
            return;
          }
          options.apply(channel, count);
        })
        .catch(() => {});
    }
  };

  return { refresh, retire };
}
