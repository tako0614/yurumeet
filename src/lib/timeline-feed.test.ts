import { expect, test } from "bun:test";
import type { Post } from "@takosjp/yurucommu-api";
import { createTimelineFeed } from "./timeline-feed.ts";

type Page = { posts: Post[]; nextCursor: string | null; hasMore: boolean };
type Request = { limit: number; before?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function post(name: string): Post {
  return {
    ap_id: `https://example.test/ap/objects/${name}`,
    type: "Note",
    author: {
      ap_id: "https://example.test/ap/users/owner",
      username: "owner@example.test",
      preferred_username: "owner",
      name: "Owner",
      icon_url: null,
    },
    content: name,
    summary: null,
    attachments: [],
    in_reply_to: null,
    visibility: "public",
    community_ap_id: null,
    like_count: 0,
    reply_count: 0,
    announce_count: 0,
    published: "2026-01-01T00:00:00.000Z",
    edited_at: null,
    liked: false,
    bookmarked: false,
    reposted: false,
  };
}

const page = (
  posts: Post[],
  nextCursor: string | null,
  hasMore: boolean,
): Page => ({
  posts,
  nextCursor,
  hasMore,
});
const ids = (posts: Post[]) => posts.map((item) => item.ap_id);

function harness() {
  const requests: Request[] = [];
  const replies: ReturnType<typeof deferred<Page>>[] = [];
  const errors: string[] = [];
  let clock = 100;
  const feed = createTimelineFeed({
    fetchPage: (request: Request) => {
      requests.push(request);
      const reply = deferred<Page>();
      replies.push(reply);
      return reply.promise;
    },
    onError: (kind: "refresh" | "more") => errors.push(kind),
    now: () => clock,
  });
  return {
    feed,
    requests,
    replies,
    errors,
    tick: (value: number) => (clock = value),
  };
}

function acknowledgeCreated(
  feed: ReturnType<typeof createTimelineFeed>,
  created: Post,
) {
  feed.acknowledgeCreated(created);
}

test("a creation ACK survives a head fetched before its commit without changing the server cursor", async () => {
  const { feed, replies } = harness();
  const previous = post("previous");
  const created = post("created-during-refresh");
  const first = feed.refresh();
  replies[0].resolve(page([previous], "old-cursor", true));
  await first;
  const refresh = feed.refresh();
  acknowledgeCreated(feed, created);
  feed.setPosts((rows) =>
    rows.map((row) =>
      row.ap_id === created.ap_id ? { ...row, liked: true } : row,
    ),
  );
  expect(ids(feed.posts())).toEqual([created.ap_id, previous.ap_id]);
  replies[1].resolve(page([previous], "server-cursor", true));
  await refresh;
  expect(ids(feed.posts())).toEqual([created.ap_id, previous.ap_id]);
  expect(feed.posts()[0].liked).toBe(true);
  expect(feed.cursor()).toBe("server-cursor");
  expect(feed.hasMore()).toBe(true);
  expect(feed.loading()).toBe(false);
  feed.dispose();
});

test("a delayed creation ACK already present in the server head does not duplicate or revert its row", async () => {
  const { feed, replies } = harness();
  const created = post("committed-before-ack");
  const previous = post("previous");
  const newer = post("newer-than-created");
  const refresh = feed.refresh();
  replies[0].resolve(page([newer, created, previous], "raw-cursor", true));
  await refresh;
  feed.setPosts((rows) =>
    rows.map((row) =>
      row.ap_id === created.ap_id ? { ...row, liked: true } : row,
    ),
  );
  acknowledgeCreated(feed, created);
  expect(ids(feed.posts())).toEqual([
    newer.ap_id,
    created.ap_id,
    previous.ap_id,
  ]);
  expect(feed.posts()[1].liked).toBe(true);
  expect(feed.cursor()).toBe("raw-cursor");
  expect(feed.hasMore()).toBe(true);
  feed.dispose();
});

test("ACK reconciliation uses current patches/removals and ends at this full refresh", async () => {
  const { feed, replies } = harness();
  const previous = post("previous");
  const created = post("created");
  const removed = post("removed");
  const refresh = feed.refresh();
  acknowledgeCreated(feed, created);
  acknowledgeCreated(feed, removed);
  acknowledgeCreated(feed, created);
  feed.setPosts((rows) =>
    rows
      .filter((row) => row.ap_id !== removed.ap_id)
      .map((row) => ({ ...row, bookmarked: true })),
  );
  replies[0].resolve(page([removed, created, previous], "real-cursor", true));
  await refresh;
  expect(ids(feed.posts())).toEqual([created.ap_id, previous.ap_id]);
  expect(feed.posts()[0].bookmarked).toBe(true);
  expect(feed.cursor()).toBe("real-cursor");
  const next = feed.refresh();
  replies[1].resolve(page([previous], null, false));
  await next;
  expect(ids(feed.posts())).toEqual([previous.ap_id]);
  expect(feed.cursor()).toBe(null);
  expect(feed.hasMore()).toBe(false);
  feed.dispose();
});

test("a refreshed server head keeps its order while reusing a current ACK row", async () => {
  const { feed, replies } = harness();
  const previous = post("previous");
  const created = post("created");
  const newer = post("newer-server-row");
  const first = feed.refresh();
  replies[0].resolve(page([previous], "previous", true));
  await first;
  const refresh = feed.refresh();
  acknowledgeCreated(feed, created);
  feed.setPosts((rows) =>
    rows.map((row) =>
      row.ap_id === created.ap_id ? { ...row, liked: true } : row,
    ),
  );
  replies[1].resolve(page([newer, created, previous], "raw", true));
  await refresh;
  expect(ids(feed.posts())).toEqual([
    newer.ap_id,
    created.ap_id,
    previous.ap_id,
  ]);
  expect(feed.posts()[1].liked).toBe(true);
  expect(feed.cursor()).toBe("raw");
  feed.dispose();
});

test("a superseded refresh cannot clear the latest ACK window, and failed heads retain ACK rows", async () => {
  for (const staleOutcome of ["success", "failure"] as const) {
    const { feed, replies, errors } = harness();
    const stale = feed.refresh();
    const latest = feed.refresh();
    const created = post("created-in-latest-window");
    acknowledgeCreated(feed, created);
    if (staleOutcome === "success")
      replies[0].resolve(page([post("stale")], "stale", false));
    else replies[0].reject(new Error("stale failed"));
    await stale;
    expect(feed.loading()).toBe(true);
    replies[1].resolve(page([post("current")], "current", true));
    await latest;
    expect(ids(feed.posts())).toEqual([created.ap_id, post("current").ap_id]);
    expect(errors).toEqual([]);
    const failed = feed.refresh();
    const additional = post("created-before-failure");
    acknowledgeCreated(feed, additional);
    replies[2].reject(new Error("current failed"));
    await failed;
    expect(ids(feed.posts())).toEqual([
      additional.ap_id,
      created.ap_id,
      post("current").ap_id,
    ]);
    expect(feed.cursor()).toBe("current");
    expect(errors).toEqual(["refresh"]);
    const retry = feed.refresh();
    replies[3].resolve(page([post("server-after-failure")], null, false));
    await retry;
    expect(ids(feed.posts())).toEqual([post("server-after-failure").ap_id]);
    feed.dispose();
  }
});

test("ACKs remain single rows during pagination and cannot write after disposal", async () => {
  const { feed, replies } = harness();
  const previous = post("previous");
  const created = post("created-during-paging");
  const initial = feed.refresh();
  replies[0].resolve(page([previous], "cursor", true));
  await initial;
  const more = feed.loadMore();
  acknowledgeCreated(feed, created);
  acknowledgeCreated(feed, created);
  replies[1].resolve(page([created, post("tail")], null, false));
  await more;
  expect(ids(feed.posts())).toEqual([
    created.ap_id,
    previous.ap_id,
    post("tail").ap_id,
  ]);
  feed.dispose();
  acknowledgeCreated(feed, post("disposed"));
  expect(ids(feed.posts())).toEqual([
    created.ap_id,
    previous.ap_id,
    post("tail").ap_id,
  ]);
});

test("a late older page cannot append to a newer full refresh in either completion order", async () => {
  for (const order of ["old-first", "new-first"] as const) {
    const { feed, requests, replies, errors, tick } = harness();
    const old = post("old");
    const stale = post("stale-older");
    const current = post("current");
    const initial = feed.refresh();
    expect(requests[0]).toEqual({ limit: 30 });
    replies[0].resolve(page([old], "old-cursor", true));
    await initial;
    expect(ids(feed.posts())).toEqual([old.ap_id]);

    const older = feed.loadMore();
    expect(requests[1]).toEqual({ limit: 30, before: "old-cursor" });
    tick(200);
    const refresh = feed.refresh();
    expect(requests[2]).toEqual({ limit: 30 });
    if (order === "old-first") {
      replies[1].resolve(page([stale], "stale-cursor", false));
      await older;
      expect(ids(feed.posts())).toEqual([old.ap_id]);
      expect(feed.cursor()).toBe("old-cursor");
      expect(feed.hasMore()).toBe(true);
      expect(feed.loading()).toBe(true);
      expect(feed.loadingMore()).toBe(false);
      expect(feed.error()).toBe(false);
      expect(feed.loadedAt()).toBe(100);
      expect(errors).toEqual([]);
    }
    replies[2].resolve(page([current], "current-cursor", true));
    await refresh;
    if (order === "new-first") {
      tick(900);
      replies[1].resolve(page([stale], "stale-cursor", false));
      await older;
    }
    expect(ids(feed.posts())).toEqual([current.ap_id]);
    expect(feed.cursor()).toBe("current-cursor");
    expect(feed.hasMore()).toBe(true);
    expect(feed.loadedAt()).toBe(200);
    expect(feed.loading()).toBe(false);
    expect(feed.loadingMore()).toBe(false);
    expect(feed.error()).toBe(false);
    expect(errors).toEqual([]);
    feed.dispose();
  }
});

test("stale older-page rejection and finally cannot clear an active newer pager", async () => {
  const { feed, replies, requests, errors } = harness();
  const first = feed.refresh();
  replies[0].resolve(page([post("head-a")], "cursor-a", true));
  await first;
  const staleMore = feed.loadMore();
  const replacement = feed.refresh();
  replies[2].resolve(page([post("head-b")], "cursor-b", true));
  await replacement;
  const currentMore = feed.loadMore();
  expect(requests[3]).toEqual({ limit: 30, before: "cursor-b" });
  expect(feed.loadingMore()).toBe(true);
  replies[1].reject(new Error("old page failed"));
  await staleMore;
  expect(feed.loadingMore()).toBe(true);
  expect(feed.cursor()).toBe("cursor-b");
  expect(errors).toEqual([]);
  replies[3].resolve(page([post("tail-b")], null, false));
  await currentMore;
  expect(ids(feed.posts())).toEqual([
    post("head-b").ap_id,
    post("tail-b").ap_id,
  ]);
  expect(feed.cursor()).toBe(null);
  expect(feed.hasMore()).toBe(false);
  expect(feed.loadingMore()).toBe(false);
  feed.dispose();
});

test("latest of overlapping full refreshes alone controls rows, errors, timestamp and loading", async () => {
  for (const order of ["old-first", "new-first"] as const) {
    for (const staleOutcome of ["success", "failure"] as const) {
      const { feed, requests, replies, errors, tick } = harness();
      const old = feed.refresh();
      tick(400);
      const latest = feed.refresh();
      expect(requests).toEqual([{ limit: 30 }, { limit: 30 }]);
      const finishOld = async () => {
        if (staleOutcome === "success")
          replies[0].resolve(page([post("stale")], null, false));
        else replies[0].reject(new Error("stale refresh failed"));
        await old;
      };
      if (order === "old-first") {
        tick(900);
        await finishOld();
        expect(feed.loading()).toBe(true);
        expect(feed.loadedAt()).toBe(0);
        expect(feed.cursor()).toBe(null);
        expect(feed.hasMore()).toBe(false);
        expect(feed.error()).toBe(false);
        expect(errors).toEqual([]);
      }
      tick(400);
      replies[1].resolve(page([post("latest")], "latest-cursor", true));
      await latest;
      if (order === "new-first") {
        tick(900);
        await finishOld();
      }
      expect(ids(feed.posts())).toEqual([post("latest").ap_id]);
      expect(feed.cursor()).toBe("latest-cursor");
      expect(feed.hasMore()).toBe(true);
      expect(feed.error()).toBe(false);
      expect(feed.loading()).toBe(false);
      expect(feed.loadedAt()).toBe(400);
      expect(errors).toEqual([]);
      feed.dispose();
    }
  }
});

test("pagination guards duplicate requests, deduplicates IDs, and preserves local patches", async () => {
  const { feed, requests, replies } = harness();
  expect(await feed.loadMore()).toBeUndefined();
  expect(requests).toHaveLength(0);
  const first = feed.refresh();
  expect(await feed.loadMore()).toBeUndefined();
  expect(requests).toHaveLength(1);
  const a = post("a");
  const b = post("b");
  replies[0].resolve(page([a, b], "next", true));
  await first;
  feed.setPosts((rows) =>
    rows.map((row) => (row.ap_id === a.ap_id ? { ...row, liked: true } : row)),
  );
  const more = feed.loadMore();
  expect(await feed.loadMore()).toBeUndefined();
  expect(requests).toEqual([{ limit: 30 }, { limit: 30, before: "next" }]);
  replies[1].resolve(page([a, post("c"), post("c")], null, false));
  await more;
  expect(ids(feed.posts())).toEqual([a.ap_id, b.ap_id, post("c").ap_id]);
  expect(feed.posts()[0].liked).toBe(true);
  expect(feed.cursor()).toBe(null);
  expect(feed.hasMore()).toBe(false);
  expect(await feed.loadMore()).toBeUndefined();
  expect(requests).toHaveLength(2);
  feed.dispose();
});

test("current refresh failure retains rows, reports the right error, stamps time, and retries", async () => {
  const { feed, replies, requests, errors, tick } = harness();
  const initial = feed.refresh();
  replies[0].reject(new Error("initial unavailable"));
  await initial;
  expect(feed.error()).toBe(true);
  expect(feed.loading()).toBe(false);
  expect(feed.loadedAt()).toBe(100);
  expect(errors).toEqual([]);

  const ready = feed.refresh();
  replies[1].resolve(page([post("retained")], "next", true));
  await ready;
  tick(250);
  const failed = feed.refresh();
  replies[2].reject(new Error("manual refresh failed"));
  await failed;
  expect(ids(feed.posts())).toEqual([post("retained").ap_id]);
  expect(feed.cursor()).toBe("next");
  expect(feed.error()).toBe(true);
  expect(feed.loadedAt()).toBe(250);
  expect(errors).toEqual(["refresh"]);

  const retry = feed.refresh();
  replies[3].resolve(page([post("recovered")], null, false));
  await retry;
  expect(ids(feed.posts())).toEqual([post("recovered").ap_id]);
  expect(feed.error()).toBe(false);
  expect(requests).toHaveLength(4);
  feed.dispose();
});

test("current pagination failure keeps cursor and rows, reports once, then retries", async () => {
  const { feed, replies, requests, errors } = harness();
  const initial = feed.refresh();
  replies[0].resolve(page([post("head")], "resume", true));
  await initial;
  const failed = feed.loadMore();
  replies[1].reject(new Error("pager failed"));
  await failed;
  expect(ids(feed.posts())).toEqual([post("head").ap_id]);
  expect(feed.cursor()).toBe("resume");
  expect(feed.hasMore()).toBe(true);
  expect(feed.loadingMore()).toBe(false);
  expect(errors).toEqual(["more"]);
  const retry = feed.loadMore();
  expect(requests[2]).toEqual({ limit: 30, before: "resume" });
  replies[2].resolve(page([post("tail")], null, false));
  await retry;
  expect(ids(feed.posts())).toEqual([post("head").ap_id, post("tail").ap_id]);
  feed.dispose();
});

test("dispose fences late refresh and pagination completions", async () => {
  for (const operation of ["refresh", "more"] as const) {
    const { feed, replies, errors } = harness();
    if (operation === "more") {
      const initial = feed.refresh();
      replies[0].resolve(page([post("kept")], "cursor", true));
      await initial;
    }
    const pending = operation === "refresh" ? feed.refresh() : feed.loadMore();
    const reply = replies[replies.length - 1];
    feed.dispose();
    const before = {
      posts: ids(feed.posts()),
      cursor: feed.cursor(),
      hasMore: feed.hasMore(),
      loadedAt: feed.loadedAt(),
      error: feed.error(),
      loading: feed.loading(),
      loadingMore: feed.loadingMore(),
    };
    reply.resolve(page([post("late")], "late-cursor", false));
    await pending;
    expect({
      posts: ids(feed.posts()),
      cursor: feed.cursor(),
      hasMore: feed.hasMore(),
      loadedAt: feed.loadedAt(),
      error: feed.error(),
      loading: feed.loading(),
      loadingMore: feed.loadingMore(),
    }).toEqual(before);
    expect(errors).toEqual([]);
  }
});
