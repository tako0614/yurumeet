import { describe, expect, test } from "bun:test";
import {
  createDraftSession,
  type DraftStorage,
  draftKey,
} from "./draft-store.ts";
import { createScopedDraftIdentity } from "./outgoing-journal.ts";

function memoryStore(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const ID_A =
  '[1,"https://one.example","https://one.example/users/alice","user","https://one.example/users/bob"]';
const ID_B =
  '[1,"https://one.example","https://one.example/users/alice","user","https://one.example/users/carol"]';

describe("draft-store", () => {
  test("loads and saves text while preserving surrounding whitespace", () => {
    const store = memoryStore();
    const session = createDraftSession(store);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "saved" });
    expect(session.hasUnstoredChanges()).toBe(false);
    expect(session.edit(ID_A, " hello ")).toEqual({
      text: " hello ",
      status: "unsaved",
    });
    expect(session.save(ID_A)).toEqual({ text: " hello ", status: "saved" });
    expect(session.hasUnstoredChanges()).toBe(false);
    expect(store.map.get(draftKey(ID_A))).toBe(" hello ");
  });

  test("whitespace-only text removes only the v2 key and keeps empty memory", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "previous");
    store.map.set(draftKey(ID_B), "other");
    const session = createDraftSession(store);
    expect(session.enter(ID_A)).toEqual({ text: "previous", status: "saved" });
    store.map.set(draftKey(ID_A), "refreshed");
    expect(session.enter(ID_A)).toEqual({ text: "refreshed", status: "saved" });
    expect(session.clear(ID_A)).toEqual({ text: "", status: "saved" });
    expect(store.map.has(draftKey(ID_A))).toBe(false);
    expect(store.map.get(draftKey(ID_B))).toBe("other");

    session.edit(ID_A, "   ");
    expect(session.save(ID_A)).toEqual({ text: "   ", status: "saved" });
    expect(store.map.has(draftKey(ID_A))).toBe(false);
  });

  test("failed write A to B to A retains the in-memory draft through switches", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "A");
    const session = createDraftSession({
      ...store,
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(session.enter(ID_A)).toEqual({ text: "A", status: "saved" });
    session.edit(ID_A, "B");
    expect(session.save(ID_A)).toEqual({ text: "B", status: "write-error" });
    session.enter(ID_B);
    expect(session.enter(ID_A)).toEqual({ text: "B", status: "write-error" });
    expect(store.map.get(draftKey(ID_A))).toBe("A");

    expect(session.edit(ID_A, "A")).toEqual({ text: "A", status: "unsaved" });
    expect(session.save(ID_A)).toEqual({ text: "A", status: "saved" });
    expect(store.map.get(draftKey(ID_A))).toBe("A");
  });

  test("read-denied entry followed by switches never deletes stored bytes", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "protected");
    let denied = true;
    let removes = 0;
    const guarded: DraftStorage = {
      getItem: (key) => {
        if (denied) throw new Error("denied");
        return store.getItem(key);
      },
      setItem: (key, value) => store.setItem(key, value),
      removeItem: (key) => {
        removes++;
        store.removeItem(key);
      },
    };
    const session = createDraftSession(guarded);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "read-error" });
    session.edit(ID_A, "typed while denied");
    expect(session.save(ID_A)).toEqual({
      text: "typed while denied",
      status: "read-error",
    });
    expect(store.map.get(draftKey(ID_A))).toBe("protected");
    expect(removes).toBe(0);
    session.edit(ID_A, "");
    denied = false;
    session.enter(ID_B);
    expect(session.save(ID_A)).toEqual({ text: "", status: "conflict" });
    expect(store.map.get(draftKey(ID_A))).toBe("protected");
    expect(removes).toBe(0);
  });

  test("read failure preserves known storage value and prevents resurrecting deletion", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "old draft");
    let denyA = false;
    const guarded: DraftStorage = {
      getItem: (key) => {
        if (denyA && key === draftKey(ID_A))
          throw new Error("transient denial");
        return store.getItem(key);
      },
      setItem: (key, value) => store.setItem(key, value),
      removeItem: (key) => store.removeItem(key),
    };
    const session = createDraftSession(guarded);
    expect(session.enter(ID_A)).toEqual({ text: "old draft", status: "saved" });
    session.enter(ID_B);
    store.map.delete(draftKey(ID_A));
    denyA = true;
    expect(session.enter(ID_A)).toEqual({
      text: "old draft",
      status: "read-error",
    });

    denyA = false;
    expect(session.save(ID_A)).toEqual({
      text: "old draft",
      status: "conflict",
    });
    expect(store.map.has(draftKey(ID_A))).toBe(false);
  });

  test("initial read failure permits only absent or already exact desired bytes", () => {
    const store = memoryStore();
    let denied = true;
    const guarded: DraftStorage = {
      getItem: (key) => {
        if (denied) throw new Error("denied");
        return store.getItem(key);
      },
      setItem: (key, value) => store.setItem(key, value),
      removeItem: (key) => store.removeItem(key),
    };
    const session = createDraftSession(guarded);
    session.enter(ID_A);
    session.edit(ID_A, "typed");
    denied = false;
    store.map.set(draftKey(ID_A), "newer");
    expect(session.save(ID_A)).toEqual({ text: "typed", status: "conflict" });
    expect(store.map.get(draftKey(ID_A))).toBe("newer");

    store.map.set(draftKey(ID_A), "typed");
    expect(session.save(ID_A)).toEqual({ text: "typed", status: "saved" });
    expect(store.map.get(draftKey(ID_A))).toBe("typed");
  });

  test("a fresh read conflict preserves newer storage until explicit reload", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "original");
    const session = createDraftSession(store);
    session.enter(ID_A);
    session.edit(ID_A, "local");
    store.map.set(draftKey(ID_A), "newer");
    expect(session.save(ID_A)).toEqual({ text: "local", status: "conflict" });
    expect(store.map.get(draftKey(ID_A))).toBe("newer");
    expect(session.peek(ID_A)).toEqual({ text: "local", status: "conflict" });
    expect(session.reload(ID_A)).toEqual({ text: "newer", status: "saved" });
  });

  test("scoped identities separate origin, principal, contact type, and contact", () => {
    const scope = {
      serverOrigin: "https://one.example",
      principalApId: "https://one.example/users/alice",
    };
    const target = {
      type: "user" as const,
      ap_id: "https://one.example/users/bob",
    };
    const identities = [
      createScopedDraftIdentity(scope, target),
      createScopedDraftIdentity(
        { ...scope, serverOrigin: "https://two.example" },
        target,
      ),
      createScopedDraftIdentity(
        { ...scope, principalApId: "https://one.example/users/other" },
        target,
      ),
      createScopedDraftIdentity(scope, {
        type: "community",
        ap_id: target.ap_id,
      }),
      createScopedDraftIdentity(scope, {
        type: "user",
        ap_id: "https://one.example/users/carol",
      }),
    ];
    expect(new Set(identities).size).toBe(identities.length);

    const session = createDraftSession(memoryStore());
    identities.forEach((identity, index) => session.edit(identity, `${index}`));
    identities.forEach((identity, index) => {
      expect(session.peek(identity)).toEqual({
        text: `${index}`,
        status: "unsaved",
      });
    });
  });

  test("mutation throw is reconciled when readback proves the write completed", () => {
    const store = memoryStore();
    const session = createDraftSession({
      ...store,
      setItem: (key, value) => {
        store.setItem(key, value);
        throw new Error("reported failure after write");
      },
    });
    session.enter(ID_A);
    session.edit(ID_A, "complete");
    expect(session.save(ID_A)).toEqual({ text: "complete", status: "saved" });
  });

  test("wrong, partial, no-op, and unreadable readbacks report write-error", () => {
    const wrong = memoryStore();
    const wrongSession = createDraftSession({
      ...wrong,
      setItem: (key) => wrong.setItem(key, "wrong"),
    });
    wrongSession.enter(ID_A);
    wrongSession.edit(ID_A, "desired");
    expect(wrongSession.save(ID_A).status).toBe("write-error");

    const partial = memoryStore();
    const partialSession = createDraftSession({
      ...partial,
      setItem: (key, value) => partial.setItem(key, value.slice(0, 2)),
    });
    partialSession.enter(ID_A);
    partialSession.edit(ID_A, "desired");
    expect(partialSession.save(ID_A)).toEqual({
      text: "desired",
      status: "write-error",
    });

    const noop = memoryStore();
    const noopSession = createDraftSession({
      ...noop,
      setItem: () => undefined,
    });
    noopSession.enter(ID_A);
    noopSession.edit(ID_A, "desired");
    expect(noopSession.save(ID_A).status).toBe("write-error");

    const unreadable = memoryStore();
    let reads = 0;
    const unreadableSession = createDraftSession({
      getItem: (key) => {
        reads++;
        if (reads === 3) throw new Error("readback denied");
        return unreadable.getItem(key);
      },
      setItem: (key, value) => unreadable.setItem(key, value),
      removeItem: (key) => unreadable.removeItem(key),
    });
    unreadableSession.enter(ID_A);
    unreadableSession.edit(ID_A, "desired");
    expect(unreadableSession.save(ID_A)).toEqual({
      text: "desired",
      status: "write-error",
    });
  });

  test("failed remove keeps empty memory and never restores sent text", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "sent text");
    const session = createDraftSession({
      ...store,
      removeItem: () => {
        throw new Error("denied");
      },
    });
    session.enter(ID_A);
    expect(session.clear(ID_A)).toEqual({ text: "", status: "write-error" });
    expect(session.hasUnstoredChanges()).toBe(true);
    session.enter(ID_B);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "write-error" });
    expect(store.map.get(draftKey(ID_A))).toBe("sent text");
  });

  test("send clear conflict keeps empty memory and preserves newer storage", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "submitted text");
    const session = createDraftSession(store);
    expect(session.enter(ID_A)).toEqual({
      text: "submitted text",
      status: "saved",
    });
    store.map.set(draftKey(ID_A), "newer text");

    expect(session.clear(ID_A)).toEqual({ text: "", status: "conflict" });
    expect(session.hasUnstoredChanges()).toBe(true);
    expect(store.map.get(draftKey(ID_A))).toBe("newer text");
    session.enter(ID_B);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "conflict" });
    expect(session.reload(ID_A)).toEqual({
      text: "newer text",
      status: "saved",
    });
  });

  test("legacy contact-only entries are neither imported nor deleted", () => {
    const store = memoryStore();
    const legacy = "yurume:draft:contact-only";
    store.map.set(legacy, "unknown author");
    const session = createDraftSession(store);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "saved" });
    expect(session.clear(ID_A)).toEqual({ text: "", status: "saved" });
    expect(store.map.get(legacy)).toBe("unknown author");
  });

  test("null storage reports unavailable state without throwing", () => {
    const session = createDraftSession(null);
    expect(session.enter(ID_A)).toEqual({ text: "", status: "read-error" });
    expect(session.edit(ID_A, "kept in memory")).toEqual({
      text: "kept in memory",
      status: "unsaved",
    });
    expect(session.hasUnstoredChanges()).toBe(true);
    expect(session.save(ID_A)).toEqual({
      text: "kept in memory",
      status: "write-error",
    });
    expect(session.peek(ID_A).text).toBe("kept in memory");
    expect(session.hasUnstoredChanges()).toBe(true);
  });

  test("an initially unavailable storage provider can recover on reload and save", () => {
    const store = memoryStore();
    store.map.set(draftKey(ID_A), "stored draft");
    let activeStorage: DraftStorage | null = null;
    const session = createDraftSession(() => activeStorage);

    expect(session.enter(ID_A)).toEqual({ text: "", status: "read-error" });
    activeStorage = store;
    expect(session.reload(ID_A)).toEqual({
      text: "stored draft",
      status: "saved",
    });
    session.edit(ID_A, "recovered update");
    expect(session.save(ID_A)).toEqual({
      text: "recovered update",
      status: "saved",
    });
    expect(store.map.get(draftKey(ID_A))).toBe("recovered update");
  });

  test("default browser storage is reacquired after its getter recovers", () => {
    const store = memoryStore();
    let denied = true;
    const testWindow = {};
    Object.defineProperty(testWindow, "localStorage", {
      configurable: true,
      get() {
        if (denied) throw new Error("storage getter denied");
        return store;
      },
    });

    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      enumerable: priorWindow?.enumerable ?? false,
      writable: true,
      value: testWindow,
    });
    try {
      const session = createDraftSession();
      expect(session.enter(ID_A)).toEqual({ text: "", status: "read-error" });
      session.edit(ID_A, "kept through denial");
      expect(session.save(ID_A)).toEqual({
        text: "kept through denial",
        status: "write-error",
      });

      denied = false;
      expect(session.save(ID_A)).toEqual({
        text: "kept through denial",
        status: "saved",
      });
      expect(store.map.get(draftKey(ID_A))).toBe("kept through denial");

      store.map.set(draftKey(ID_A), "read after recovery");
      expect(session.reload(ID_A)).toEqual({
        text: "read after recovery",
        status: "saved",
      });
    } finally {
      if (priorWindow) {
        Object.defineProperty(globalThis, "window", priorWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
