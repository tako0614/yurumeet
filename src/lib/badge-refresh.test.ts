import { expect, test } from "bun:test";
import {
  createUnreadBadgeRefresh,
  type UnreadBadgeChannel,
} from "./badge-refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("a late older badge poll cannot replace the count from a newer refresh", async () => {
  const olderTalk = deferred<number>();
  const newerTalk = deferred<number>();
  let talkRead = 0;
  let readNumber = 0;
  const applied: [UnreadBadgeChannel, number][] = [];
  const badge = createUnreadBadgeRefresh({
    readers: {
      talk: () => (++readNumber === 1 ? olderTalk.promise : newerTalk.promise),
      notifications: async () => 0,
    },
    captureScope: () => ({
      origin: "https://one.example.test",
      actorApId: "https://one.example.test/users/alice",
      authEpoch: 1,
      transport: transport,
      talkUrl: "https://one.example.test/api/dm/unread/count",
      notificationsUrl:
        "https://one.example.test/api/notifications/unread/count",
    }),
    isScopeCurrent: () => true,
    apply: (channel, count) => {
      applied.push([channel, count]);
      if (channel === "talk") talkRead = count;
    },
    clear: () => {
      talkRead = 0;
    },
  });

  badge.refresh();
  badge.refresh();
  newerTalk.resolve(0);
  await flush();
  expect(talkRead).toBe(0);
  olderTalk.resolve(1);
  await flush();

  expect(talkRead).toBe(0);
  expect(applied.filter(([channel]) => channel === "talk")).toEqual([
    ["talk", 0],
  ]);
});

test("a failed newest badge refresh preserves the last good value and retires older work", async () => {
  const older = deferred<number>();
  const newest = deferred<number>();
  let count = 6;
  let reads = 0;
  const badge = createUnreadBadgeRefresh({
    readers: {
      talk: () => (++reads === 1 ? older.promise : newest.promise),
      notifications: async () => 0,
    },
    captureScope: () => ({
      origin: "https://one.example.test",
      actorApId: "https://one.example.test/users/alice",
      authEpoch: 1,
      transport,
      talkUrl: "https://one.example.test/api/dm/unread/count",
      notificationsUrl:
        "https://one.example.test/api/notifications/unread/count",
    }),
    isScopeCurrent: () => true,
    apply: (channel, value) => {
      if (channel === "talk") count = value;
    },
    clear: () => {
      count = 0;
    },
  });

  badge.refresh();
  badge.refresh();
  newest.reject(new Error("latest read failed"));
  await flush();
  older.resolve(2);
  await flush();

  expect(count).toBe(6);
});

test("notification and talk badge channels apply independently", async () => {
  const talk = deferred<number>();
  const notifications = deferred<number>();
  const applied: [UnreadBadgeChannel, number][] = [];
  const badge = createUnreadBadgeRefresh({
    readers: {
      talk: () => talk.promise,
      notifications: () => notifications.promise,
    },
    captureScope: () => defaultScope,
    isScopeCurrent: () => true,
    apply: (channel, count) => applied.push([channel, count]),
    clear: () => {},
  });
  badge.refresh();
  notifications.resolve(4);
  await flush();
  expect(applied).toEqual([["notifications", 4]]);
  talk.resolve(1);
  await flush();

  expect(applied).toEqual([
    ["notifications", 4],
    ["talk", 1],
  ]);
});

test("retiring an auth scope clears both channels and ignores pending responses", async () => {
  const talk = deferred<number>();
  const notifications = deferred<number>();
  let scope = defaultScope;
  let talkCount = 3;
  let notificationCount = 8;
  const badge = createUnreadBadgeRefresh({
    readers: {
      talk: () => talk.promise,
      notifications: () => notifications.promise,
    },
    captureScope: () => scope,
    isScopeCurrent: (captured) => captured === scope,
    apply: (channel, count) => {
      if (channel === "talk") talkCount = count;
      else notificationCount = count;
    },
    clear: () => {
      talkCount = 0;
      notificationCount = 0;
    },
  });

  badge.refresh();
  scope = { ...scope, authEpoch: 2 };
  badge.retire();
  talk.resolve(5);
  notifications.resolve(12);
  await flush();

  expect([talkCount, notificationCount]).toEqual([0, 0]);
});

test("scope drift on response retires its pending sibling channel", async () => {
  const talk = deferred<number>();
  const notifications = deferred<number>();
  let scope = defaultScope;
  let talkCount = 0;
  let notificationCount = 0;
  const badge = createUnreadBadgeRefresh({
    readers: {
      talk: () => talk.promise,
      notifications: () => notifications.promise,
    },
    captureScope: () => scope,
    isScopeCurrent: (captured) => captured === scope,
    apply: (channel, count) => {
      if (channel === "talk") talkCount = count;
      else notificationCount = count;
    },
    clear: () => {
      talkCount = 0;
      notificationCount = 0;
    },
  });
  badge.refresh();

  scope = { ...scope, actorApId: "https://one.example.test/users/bob" };
  talk.resolve(1);
  await flush();
  notifications.resolve(9);
  await flush();

  expect([talkCount, notificationCount]).toEqual([0, 0]);
});

const transport = {};
const defaultScope = {
  origin: "https://one.example.test",
  actorApId: "https://one.example.test/users/alice",
  authEpoch: 1,
  transport,
  talkUrl: "https://one.example.test/api/dm/unread/count",
  notificationsUrl: "https://one.example.test/api/notifications/unread/count",
};
