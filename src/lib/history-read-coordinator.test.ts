import { describe, expect, test } from "bun:test";
import { createHistoryReadCoordinator } from "./history-read-coordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function historyReads() {
  const reads = createHistoryReadCoordinator();
  let scope = "conversation-a:alice";
  const events: string[] = [];
  const full = (request: ReturnType<typeof deferred<string>>) => {
    const requestedScope = scope;
    return reads.runFull(() => request.promise, {
      isScopeCurrent: () => scope === requestedScope,
      onStart: () => events.push("full:start"),
      onSuccess: (page) => events.push(`full:success:${page}`),
      onFailure: () => events.push("full:failure"),
      onFinally: () => events.push("full:finally"),
    });
  };
  const poll = (request: ReturnType<typeof deferred<string>>) => {
    const requestedScope = scope;
    return reads.runPoll(() => request.promise, {
      isScopeCurrent: () => scope === requestedScope,
      onSuccess: (page) => events.push(`poll:success:${page}`),
      onFailure: () => events.push("poll:failure"),
    });
  };
  return {
    reads,
    events,
    full,
    poll,
    changeScope: (next: string) => {
      scope = next;
      reads.invalidate();
    },
  };
}

describe("history read coordination", () => {
  test("an older apply that reenters a full read cannot authorize a later frame", async () => {
    const reads = createHistoryReadCoordinator();
    const full = deferred<string>();
    const ticket = await reads.runOlder(async () => "older", {
      isScopeCurrent: () => true,
      onSuccess: () => {
        void reads.runFull(() => full.promise, {
          isScopeCurrent: () => true,
          onStart: () => {},
          onSuccess: () => {},
          onFailure: () => {},
          onFinally: () => {},
        });
        return true;
      },
      onFailure: () => {},
    });
    expect(ticket).toBeNull();
    full.resolve("refreshed");
  });

  test("a successful poll takes over a pending full read and suppresses its late failure", async () => {
    const history = historyReads();
    const initial = deferred<string>();
    const newest = deferred<string>();
    const loading = history.full(initial);
    const polling = history.poll(newest);

    newest.resolve("newest-page");
    expect(await polling).toBe(history.reads.generation());
    initial.reject(new Error("old read failed"));
    await loading;
    expect(history.events).toEqual(["full:start", "poll:success:newest-page"]);
  });

  test("a successful poll also suppresses a late stale full success", async () => {
    const history = historyReads();
    const initial = deferred<string>();
    const newest = deferred<string>();
    const loading = history.full(initial);
    const polling = history.poll(newest);

    newest.resolve("newest-page");
    await polling;
    initial.resolve("stale-page");
    await loading;
    expect(history.events).toEqual(["full:start", "poll:success:newest-page"]);
  });

  test("a poll started before a full retry cannot affect the new read", async () => {
    const history = historyReads();
    const oldPoll = deferred<string>();
    const retried = deferred<string>();
    const polling = history.poll(oldPoll);
    const loading = history.full(retried);

    oldPoll.resolve("old-page");
    expect(await polling).toBeNull();
    retried.resolve("retry-page");
    await loading;
    expect(history.events).toEqual([
      "full:start",
      "full:success:retry-page",
      "full:finally",
    ]);
  });

  test("a failed poll from before a full retry cannot report a new failure", async () => {
    const history = historyReads();
    const oldPoll = deferred<string>();
    const retried = deferred<string>();
    const polling = history.poll(oldPoll);
    const loading = history.full(retried);

    oldPoll.reject(new Error("old poll failed"));
    expect(await polling).toBeNull();
    retried.resolve("retry-page");
    await loading;
    expect(history.events).toEqual([
      "full:start",
      "full:success:retry-page",
      "full:finally",
    ]);
  });

  test("full history may finish first and a later poll still applies", async () => {
    const history = historyReads();
    const initial = deferred<string>();
    const newest = deferred<string>();
    const loading = history.full(initial);
    const polling = history.poll(newest);

    initial.resolve("initial-page");
    await loading;
    newest.resolve("newest-page");
    expect(await polling).toBe(history.reads.generation());
    expect(history.events).toEqual([
      "full:start",
      "full:success:initial-page",
      "full:finally",
      "poll:success:newest-page",
    ]);
  });

  test("a poll callback that starts a new full read cannot claim the new generation", async () => {
    const reads = createHistoryReadCoordinator();
    const oldPoll = deferred<string>();
    const refreshed = deferred<string>();
    const events: string[] = [];
    let refresh!: Promise<void>;

    const polling = reads.runPoll(() => oldPoll.promise, {
      isScopeCurrent: () => true,
      onSuccess: () => {
        events.push("poll:success");
        refresh = reads.runFull(() => refreshed.promise, {
          isScopeCurrent: () => true,
          onStart: () => events.push("full:start"),
          onSuccess: () => events.push("full:success"),
          onFailure: () => events.push("full:failure"),
          onFinally: () => events.push("full:finally"),
        });
      },
      onFailure: () => events.push("poll:failure"),
    });
    oldPoll.resolve("old-page");
    expect(await polling).toBeNull();
    refreshed.resolve("refreshed-page");
    await refresh;

    expect(events).toEqual([
      "poll:success",
      "full:start",
      "full:success",
      "full:finally",
    ]);
  });

  test("a conversation or principal change invalidates pending polls and typing tokens", async () => {
    const history = historyReads();
    const oldPoll = deferred<string>();
    const polling = history.poll(oldPoll);
    const oldTypingToken = history.reads.generation();
    history.changeScope("conversation-b:bob");

    oldPoll.reject(new Error("old poll failed"));
    expect(await polling).toBeNull();
    expect(history.reads.isCurrent(oldTypingToken)).toBe(false);
    expect(history.events).toEqual([]);
  });
});
