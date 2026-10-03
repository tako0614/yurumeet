import { describe, expect, test } from "bun:test";
import { createHistoryReadCoordinator } from "./history-read-coordinator.ts";
import { createOlderHistoryScroll } from "./older-history-scroll.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness() {
  const reads = createHistoryReadCoordinator();
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  const scroll = createOlderHistoryScroll(
    (callback) => {
      callbacks.set(++id, callback);
      return id;
    },
    (key) => {
      callbacks.delete(key);
    },
  );
  const element = { scrollHeight: 1000, scrollTop: 300, isConnected: true };
  let scope = "a";
  let elementCurrent = true;
  let loads = 0;
  let failures = 0;
  const request = deferred<boolean>();
  const load = () => {
    loads++;
    const requestedScope = scope;
    return reads.runOlder(() => request.promise, {
      isScopeCurrent: () => scope === requestedScope,
      onSuccess: (prepended) => prepended,
      onFailure: () => failures++,
    });
  };
  return {
    reads,
    scroll,
    element,
    request,
    callbacks,
    start: () => scroll.run(element, load, () => elementCurrent),
    switchScope: () => {
      scope = scope === "a" ? "b" : "a";
      reads.invalidate();
    },
    replaceElement: () => {
      elementCurrent = false;
    },
    counts: () => ({ loads, failures }),
    frame: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach((callback) => callback(0));
    },
  };
}

async function resolvePrepend(h: ReturnType<typeof harness>) {
  h.request.resolve(true);
  // Coordinator, caller, and scroll ownership each resume at a microtask.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(h.callbacks.size).toBe(1);
}

describe("older history scroll ownership", () => {
  test("a current prepend preserves the reader and blocks another load through its frame", async () => {
    const h = harness();
    const run = h.start();
    await resolvePrepend(h);
    h.element.scrollHeight = 1300;
    await h.start();
    expect(h.counts().loads).toBe(1);
    h.frame();
    await run;
    expect(h.element.scrollTop).toBe(600);
    const second = h.start();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.frame();
    await second;
    expect(h.counts().loads).toBe(2);
  });

  test("a stale successful older response cannot move the destination conversation", async () => {
    const h = harness();
    const run = h.start();
    h.switchScope();
    h.element.scrollHeight = 9000;
    h.element.scrollTop = 430;
    h.request.resolve(true);
    await run;
    h.frame();
    expect(h.callbacks.size).toBe(0);
    expect(h.element.scrollTop).toBe(430);
  });

  test("a same-conversation reload after apply invalidates the queued correction", async () => {
    const h = harness();
    const run = h.start();
    await resolvePrepend(h);
    h.reads.invalidate();
    h.element.scrollHeight = 9000;
    h.element.scrollTop = 430;
    h.frame();
    await run;
    expect(h.element.scrollTop).toBe(430);
  });

  test("switching away and back cannot revive a queued correction", async () => {
    const h = harness();
    const run = h.start();
    await resolvePrepend(h);
    h.switchScope();
    h.switchScope();
    h.element.scrollHeight = 9000;
    h.frame();
    await run;
    expect(h.element.scrollTop).toBe(300);
  });

  test.each(["disconnect", "replace", "dispose"] as const)(
    "%s prevents a queued frame from writing the old element",
    async (reason) => {
      const h = harness();
      const run = h.start();
      await resolvePrepend(h);
      h.element.scrollHeight = 9000;
      if (reason === "disconnect") h.element.isConnected = false;
      if (reason === "replace") h.replaceElement();
      if (reason === "dispose") h.scroll.invalidate();
      h.frame();
      await run;
      expect(h.element.scrollTop).toBe(300);
    },
  );

  test("failed and no-prepend responses never compensate unrelated height growth", async () => {
    for (const failed of [true, false]) {
      const h = harness();
      const run = h.start();
      h.element.scrollHeight = 9000;
      if (failed) h.request.reject(new Error("older GET failed"));
      else h.request.resolve(false);
      await run;
      expect(h.callbacks.size).toBe(0);
      expect(h.element.scrollTop).toBe(300);
      expect(h.counts().failures).toBe(failed ? 1 : 0);
    }
  });

  test("an invalidated old read cannot release a new conversation's latch", async () => {
    const h = harness();
    const old = h.start();
    h.switchScope();
    h.scroll.invalidate();
    const current = h.start();
    await resolvePrepend(h);
    await old;
    await h.start();
    expect(h.counts().loads).toBe(2);
    h.frame();
    await current;
  });
});
