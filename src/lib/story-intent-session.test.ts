import { expect, test } from "bun:test";
import {
  createStoryIntentSession,
  type StoryIntentSessionSnapshot,
} from "./story-intent-session.ts";
import type {
  StoryCreatePayload,
  StoryIntentScope,
  StoryIntentStorage,
} from "./story-intent.ts";

const scopeA: StoryIntentScope = {
  origin: "https://meet.example",
  principal: "https://meet.example/ap/users/alice",
};
const scopeB: StoryIntentScope = {
  origin: "https://meet.example",
  principal: "https://meet.example/ap/users/bob",
};
const payload: StoryCreatePayload = {
  attachment: {
    url: "/media/session.webp",
    r2_key: "uploads/session.webp",
    content_type: "image/webp",
  },
  caption: "Session story",
  displayDuration: "PT5S",
};

class MemoryStorage implements StoryIntentStorage {
  readonly values = new Map<string, string>();
  denyWrite = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.denyWrite) throw new Error("write denied");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function validAck(
  owner: StoryIntentScope = scopeA,
  sent: StoryCreatePayload = payload,
) {
  return {
    ap_id: `${owner.origin}/ap/objects/session-story`,
    author: { ap_id: owner.principal },
    attachment: {
      type: "Document",
      mediaType: sent.attachment.content_type,
      url: `/media/${sent.attachment.r2_key.replace(/^uploads\//, "")}`,
      r2_key: sent.attachment.r2_key,
    },
    caption: sent.caption,
    displayDuration: sent.displayDuration,
    overlays: sent.overlays ?? [],
    published: "2026-10-03T00:00:00.000Z",
    end_time: "2026-10-04T00:00:00.000Z",
  };
}

test("A to B to A re-entry keeps the same coordinator and fences duplicate in-flight POST", async () => {
  const storage = new MemoryStorage();
  const session = createStoryIntentSession(storage);
  const entryA = session.get(scopeA);
  const entryB = session.get(scopeB);
  expect(session.get(scopeA)).toBe(entryA);
  expect(entryA).not.toBe(entryB);
  entryA.coordinator.stage(payload);

  const started = deferred<void>();
  const response = deferred<unknown>();
  let posts = 0;
  const first = entryA.run((coordinator) =>
    coordinator.submit(() => {
      posts += 1;
      started.resolve();
      return response.promise;
    }),
  );
  await started.promise;
  expect(entryB.read().busy).toBe(false);
  expect(entryA.read().busy).toBe(true);

  // Model leaving Alice's view and re-entering it while the POST is pending.
  const resumedA = session.get(scopeA);
  expect(resumedA).toBe(entryA);
  expect(resumedA.coordinator).toBe(entryA.coordinator);
  expect(resumedA.read().record?.status).toBe("pending");
  expect(
    await resumedA.run((coordinator) =>
      coordinator.retry(async () => validAck()),
    ),
  ).toBe(undefined);
  expect(posts).toBe(1);

  response.resolve(validAck());
  const outcome = await first;
  expect(outcome?.kind).toBe("confirmed");
  expect(entryA.read().busy).toBe(false);
  expect(posts).toBe(1);
});

test("confirmed ACK with a failed confirmation write stays locked across scope away and back", async () => {
  const storage = new MemoryStorage();
  const session = createStoryIntentSession(storage);
  const entryA = session.get(scopeA);
  const other = session.get(scopeB);
  entryA.coordinator.stage(payload);
  let posts = 0;
  const outcome = await entryA.run((coordinator) =>
    coordinator.submit(async (sent) => {
      posts += 1;
      storage.denyWrite = true;
      return validAck(scopeA, sent);
    }),
  );

  expect(outcome?.kind).toBe("confirmed");
  expect(outcome?.record?.status).toBe("confirmed");
  expect(entryA.read().record?.status).toBe("confirmed");
  expect(session.get(scopeB)).toBe(other);
  const reentered = session.get(scopeA);
  expect(reentered).toBe(entryA);
  expect(reentered.coordinator).toBe(entryA.coordinator);
  expect(
    (
      await reentered.run((coordinator) =>
        coordinator.retry(async () => validAck()),
      )
    )?.kind,
  ).toBe("blocked");
  expect(posts).toBe(1);
});

test("default and explicitly equivalent endpoint use one stable entry", () => {
  const session = createStoryIntentSession(new MemoryStorage());
  const implicit = session.get(scopeA);
  const explicit = session.get({
    ...scopeA,
    endpoint: "https://meet.example/api/stories",
  });
  expect(explicit).toBe(implicit);
  expect(explicit.scope).toEqual({
    origin: scopeA.origin,
    principal: scopeA.principal,
    endpoint: "https://meet.example/api/stories",
  });
  expect(Object.isFrozen(explicit.scope)).toBe(true);
});

test("scope and entry remain stable when the caller mutates its input object", () => {
  const session = createStoryIntentSession(new MemoryStorage());
  const mutable = { ...scopeA };
  const entry = session.get(mutable);
  mutable.principal = scopeB.principal;
  mutable.endpoint = "https://meet.example/api/other-stories";

  expect(session.get(scopeA)).toBe(entry);
  expect(entry.scope.principal).toBe(scopeA.principal);
  expect(entry.scope.endpoint).toBe("https://meet.example/api/stories");
});

test("different scope records and coordinators do not leak", () => {
  const session = createStoryIntentSession(new MemoryStorage());
  const alice = session.get(scopeA);
  const bob = session.get(scopeB);
  alice.coordinator.stage(payload);
  expect(bob.read().record).toBeNull();
  expect(alice.coordinator).not.toBe(bob.coordinator);
  expect(
    session.get({
      origin: "https://other.example",
      principal: "https://other.example/ap/users/alice",
    }),
  ).not.toBe(alice);
});

test("throwing subscribers cannot reject or unlock the protected operation", async () => {
  const session = createStoryIntentSession(new MemoryStorage());
  const entry = session.get(scopeA);
  entry.coordinator.stage(payload);
  const observed: StoryIntentSessionSnapshot[] = [];
  entry.subscribe((snapshot) => {
    observed.push(snapshot);
    throw new Error("render failed");
  });
  const started = deferred<void>();
  const result = deferred<string>();
  let callbackCalls = 0;
  const running = entry.run(async () => {
    callbackCalls += 1;
    started.resolve();
    return result.promise;
  });
  await started.promise;

  expect(entry.read().busy).toBe(true);
  expect(callbackCalls).toBe(1);
  expect(await entry.run(async () => (callbackCalls++, "duplicate"))).toBe(
    undefined,
  );
  expect(callbackCalls).toBe(1);
  expect(observed.map(({ busy }) => busy)).toEqual([false, true]);

  result.resolve("done");
  await expect(running).resolves.toBe("done");
  expect(entry.read().busy).toBe(false);
  expect(observed.map(({ busy }) => busy)).toEqual([false, true, false]);
});

test("a fresh session reloads pending as unknown but does not share in-memory coordinator state", async () => {
  const storage = new MemoryStorage();
  const firstSession = createStoryIntentSession(storage);
  const first = firstSession.get(scopeA);
  first.coordinator.stage(payload);
  const started = deferred<void>();
  const response = deferred<unknown>();
  const running = first.run((coordinator) =>
    coordinator.submit(() => {
      started.resolve();
      return response.promise;
    }),
  );
  await started.promise;

  const reloadSession = createStoryIntentSession(storage);
  const afterReload = reloadSession.get(scopeA);
  expect(afterReload).not.toBe(first);
  expect(afterReload.coordinator).not.toBe(first.coordinator);
  expect(afterReload.read().record?.status).toBe("unconfirmed");
  expect(afterReload.read().busy).toBe(false);

  response.resolve(validAck());
  expect((await running)?.kind).toBe("confirmed");
});
