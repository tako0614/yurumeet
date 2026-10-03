/**
 * Per-mounted-app session for unsent text drafts. The caller supplies a
 * validated, fully scoped identity; it is used unchanged for in-memory
 * separation and under the versioned storage prefix.
 */

export type DraftStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type DraftState = {
  text: string;
  status: "saved" | "unsaved" | "read-error" | "write-error" | "conflict";
};

const DRAFT_PREFIX = "yurume:draft:v2:";

export function draftKey(identity: string): string {
  return `${DRAFT_PREFIX}${identity}`;
}

function browserStorage(): DraftStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

type Entry = DraftState & {
  /** Storage value last observed or verified; null means known absent. */
  expected: string | null | undefined;
  dirty: boolean;
  attemptedRead: boolean;
};

function state(entry: Entry): DraftState {
  return { text: entry.text, status: entry.status };
}

/**
 * Keep each identity's current text in memory for the lifetime of the app
 * mount. Reads and writes are guarded because browser storage can fail at any
 * operation, including after a mutation has already taken effect.
 */
export function createDraftSession(
  storage?: DraftStorage | null | (() => DraftStorage | null),
) {
  const entries = new Map<string, Entry>();
  const getStorage = (): DraftStorage | null => {
    try {
      if (storage === undefined) return browserStorage();
      return typeof storage === "function" ? storage() : storage;
    } catch {
      return null;
    }
  };

  const get = (identity: string): Entry => {
    let entry = entries.get(identity);
    if (!entry) {
      entry = {
        text: "",
        status: "read-error",
        expected: undefined,
        dirty: false,
        attemptedRead: false,
      };
      entries.set(identity, entry);
    }
    return entry;
  };

  const readRaw = (
    identity: string,
    activeStorage: DraftStorage | null = getStorage(),
  ): string | null | undefined => {
    if (!activeStorage) return undefined;
    try {
      return activeStorage.getItem(draftKey(identity));
    } catch {
      return undefined;
    }
  };

  function enter(identity: string): DraftState {
    if (!identity) return { text: "", status: "read-error" };
    const entry = get(identity);
    // Failed/edited contents remain authoritative in this mounted session.
    if (
      entry.dirty ||
      (entry.attemptedRead &&
        (entry.status === "read-error" ||
          entry.status === "write-error" ||
          entry.status === "conflict"))
    ) {
      return state(entry);
    }

    const raw = readRaw(identity);
    entry.attemptedRead = true;
    if (raw === undefined) {
      entry.status = "read-error";
      return state(entry);
    }
    entry.expected = raw;
    entry.text = raw ?? "";
    entry.status = "saved";
    return state(entry);
  }

  function edit(identity: string, text: string): DraftState {
    if (!identity) return { text, status: "unsaved" };
    const entry = get(identity);
    entry.text = text;
    entry.dirty = true;
    entry.status = "unsaved";
    return state(entry);
  }

  function save(identity: string): DraftState {
    if (!identity) return { text: "", status: "write-error" };
    const entry = get(identity);
    const desired = entry.text.trim().length === 0 ? null : entry.text;
    const activeStorage = getStorage();
    if (!activeStorage) {
      entry.status = "write-error";
      entry.dirty = true;
      return state(entry);
    }

    const key = draftKey(identity);
    const current = readRaw(identity, activeStorage);
    if (current === undefined) {
      entry.status = "read-error";
      entry.dirty = true;
      return state(entry);
    }

    // A previous write may have succeeded even though its call/readback threw.
    if (current === desired) {
      entry.expected = current;
      entry.status = "saved";
      entry.dirty = false;
      return state(entry);
    }

    // A known prior value changed outside this session; preserve both versions.
    if (entry.expected !== undefined && current !== entry.expected) {
      entry.status = "conflict";
      entry.dirty = true;
      return state(entry);
    }
    // After an initial read failure, only a proven-absent value may be replaced.
    if (entry.expected === undefined && current !== null) {
      entry.status = "conflict";
      entry.dirty = true;
      return state(entry);
    }

    try {
      if (desired === null) activeStorage.removeItem(key);
      else activeStorage.setItem(key, desired);
    } catch {
      // Readback below distinguishes a completed mutation from a failed one.
    }

    const verified = readRaw(identity, activeStorage);
    if (verified === desired) {
      entry.expected = verified;
      entry.status = "saved";
      entry.dirty = false;
      return state(entry);
    }
    if (verified === undefined) {
      entry.status = "write-error";
      entry.dirty = true;
      return state(entry);
    }
    entry.status = "write-error";
    entry.dirty = true;
    return state(entry);
  }

  function clear(identity: string): DraftState {
    if (!identity) return { text: "", status: "write-error" };
    edit(identity, "");
    return save(identity);
  }

  function reload(identity: string): DraftState {
    if (!identity) return { text: "", status: "read-error" };
    const entry = get(identity);
    const raw = readRaw(identity);
    entry.attemptedRead = true;
    if (raw === undefined) {
      entry.status = "read-error";
      return state(entry);
    }
    entry.text = raw ?? "";
    entry.expected = raw;
    entry.dirty = false;
    entry.status = "saved";
    return state(entry);
  }

  function peek(identity: string): DraftState {
    if (!identity) return { text: "", status: "read-error" };
    return state(get(identity));
  }

  function hasUnstoredChanges(): boolean {
    return [...entries.values()].some(
      (entry) => entry.dirty && entry.status !== "saved",
    );
  }

  return { enter, edit, save, clear, reload, peek, hasUnstoredChanges };
}
