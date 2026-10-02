import { describe, expect, test } from "bun:test";
import {
  createScopedDraftIdentity,
  createOutgoingJournal,
  newOutgoingIntentId,
  type JournalScope,
  type JournalStorage,
  type JournalTarget,
  type OutgoingJournalRecord,
  type DeletedJournalRecord,
} from "./outgoing-journal.ts";

const SCOPE_A: JournalScope = {
  serverOrigin: "https://meet.example",
  principalApId: "https://meet.example/ap/users/alice",
};
const SCOPE_B: JournalScope = {
  serverOrigin: "https://meet.example",
  principalApId: "https://meet.example/ap/users/bob",
};
const OTHER_ORIGIN: JournalScope = {
  serverOrigin: "https://other.example",
  principalApId: "https://meet.example/ap/users/alice",
};
const USER: JournalTarget = {
  type: "user",
  ap_id: "https://meet.example/ap/users/recipient",
};
const COMMUNITY: JournalTarget = {
  type: "community",
  ap_id: "https://meet.example/ap/communities/room",
};

function memoryStore(): JournalStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function record(
  overrides: Partial<OutgoingJournalRecord> = {},
): OutgoingJournalRecord {
  return {
    version: 1,
    id: "temp-123e4567-e89b-42d3-a456-426614174000",
    target: USER,
    content: "送信する本文",
    attachments: [
      {
        url: "/media/photo.png",
        r2_key: "uploads/photo.png",
        content_type: "image/png",
        name: "photo.png",
      },
    ],
    created_at: "2026-10-02T10:00:00.000Z",
    state: "pending",
    ...overrides,
  };
}

describe("outgoing-journal", () => {
  test("scopes draft identity by origin, principal, target type, and AP ID", () => {
    const identity = createScopedDraftIdentity(SCOPE_A, USER);

    expect(identity).toBe(
      JSON.stringify([
        1,
        SCOPE_A.serverOrigin,
        SCOPE_A.principalApId,
        USER.type,
        USER.ap_id,
      ]),
    );
    expect(createScopedDraftIdentity(SCOPE_B, USER)).not.toBe(identity);
    expect(createScopedDraftIdentity(OTHER_ORIGIN, USER)).not.toBe(identity);
    expect(
      createScopedDraftIdentity(SCOPE_A, { ...USER, type: "community" }),
    ).not.toBe(identity);
    expect(
      createScopedDraftIdentity(SCOPE_A, {
        ...USER,
        ap_id: "https://meet.example/ap/users/another",
      }),
    ).not.toBe(identity);
  });

  test("stores separate intents and round-trips exact uploaded media references", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const first = record();
    const second = record({
      id: "temp-123e4567-e89b-42d3-a456-426614174001",
      content: "同じ内容の別intent",
    });
    delete second.attachments;

    expect(journal.write(first)).toBe(true);
    expect(journal.write(second)).toBe(true);
    expect(storage.map.size).toBe(2);
    expect(journal.read()).toEqual({
      records: [first, second],
      deletedRecords: [],
      failed: false,
    });
    expect(journal.read(USER).records).toEqual([first, second]);
  });

  test("isolates targets, principals, and server origins", () => {
    const storage = memoryStore();
    const scopedA = createOutgoingJournal(SCOPE_A, storage);
    const scopedB = createOutgoingJournal(SCOPE_B, storage);
    const otherOrigin = createOutgoingJournal(OTHER_ORIGIN, storage);
    const userRecord = record();
    const communityRecord = record({
      id: "temp-123e4567-e89b-42d3-a456-426614174001",
      target: COMMUNITY,
    });

    expect(scopedA.write(userRecord)).toBe(true);
    expect(scopedA.write(communityRecord)).toBe(true);
    expect(scopedA.read(USER).records).toEqual([userRecord]);
    expect(scopedA.read(COMMUNITY).records).toEqual([communityRecord]);
    expect(scopedB.read()).toEqual({
      records: [],
      deletedRecords: [],
      failed: false,
    });
    expect(otherOrigin.read()).toEqual({
      records: [],
      deletedRecords: [],
      failed: false,
    });
    expect(scopedB.remove(userRecord)).toBe(true);
    expect(scopedA.read(USER).records).toEqual([userRecord]);
  });

  test("requires a successful write and complete-value readback", () => {
    const denied: JournalStorage = {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    };
    const quota: JournalStorage = {
      ...denied,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const mismatch: JournalStorage = {
      length: 0,
      key: () => null,
      getItem: () => "different bytes",
      setItem: () => {},
      removeItem: () => {},
    };

    expect(createOutgoingJournal(SCOPE_A, null).write(record())).toBe(false);
    expect(createOutgoingJournal(SCOPE_A, denied).write(record())).toBe(false);
    expect(createOutgoingJournal(SCOPE_A, quota).write(record())).toBe(false);
    expect(createOutgoingJournal(SCOPE_A, mismatch).write(record())).toBe(
      false,
    );
  });

  test("reports malformed scoped records and leaves them untouched", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const good = record();
    expect(journal.write(good)).toBe(true);
    const key = [...storage.map.keys()][0]!;
    storage.map.set(key, "not-json");

    expect(journal.read()).toEqual({
      records: [],
      deletedRecords: [],
      failed: true,
    });
    expect(storage.map.get(key)).toBe("not-json");
  });

  test("rejects array states and targets while reading and writing", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const arrayState = record({ state: ["pending"] as unknown as "pending" });
    const arrayTarget = record({
      target: ["user", USER.ap_id] as unknown as JournalTarget,
    });

    expect(journal.write(arrayState)).toBe(false);
    expect(journal.write(arrayTarget)).toBe(false);
    expect(storage.map.size).toBe(0);

    const good = record();
    expect(journal.write(good)).toBe(true);
    const key = [...storage.map.keys()][0]!;
    const envelope = JSON.parse(storage.map.get(key)!);
    envelope.record.state = ["pending"];
    storage.map.set(key, JSON.stringify(envelope));

    expect(journal.read()).toEqual({
      records: [],
      deletedRecords: [],
      failed: true,
    });
    expect(storage.map.has(key)).toBe(true);
  });

  test("validates the serialized record before writing it", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const deceptive = record();
    Object.defineProperty(deceptive, "toJSON", {
      enumerable: true,
      value: () => ({ ...record(), state: ["pending"] }),
    });

    expect(journal.write(deceptive)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  test("rejects a payload whose serialized principal does not match its key", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    expect(journal.write(record())).toBe(true);
    const key = [...storage.map.keys()][0]!;
    const envelope = JSON.parse(storage.map.get(key)!);
    envelope.scope.principalApId = SCOPE_B.principalApId;
    storage.map.set(key, JSON.stringify(envelope));

    expect(journal.read()).toEqual({
      records: [],
      deletedRecords: [],
      failed: true,
    });
    expect(storage.map.has(key)).toBe(true);
  });

  test("rejects malformed, oversized, and credential-bearing payloads before writing", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const valid = record();
    const withPreview = {
      ...valid,
      attachments: [
        { ...valid.attachments![0], preview: "blob:https://meet.example/x" },
      ],
    } as unknown as OutgoingJournalRecord;
    const withCredentials = record({
      attachments: [
        {
          url: "https://user:password@media.example/photo.png",
          r2_key: "uploads/photo.png",
          content_type: "image/png",
        },
      ],
    });
    const oversized = record({ content: "x".repeat(100_001) });
    const wrongId = record({ id: "local-outgoing-1" });
    const sparseAttachments = record({ attachments: new Array(1) });
    const invalidMediaPaths = [
      "/media/../secret.png",
      "/media/%2e%2e%2fsecret.png",
      "/media/photo.png?download=1",
      "/media/photo.png#fragment",
      "//other.example/media/photo.png",
      "/media\\..\\secret.png",
    ].map((url, index) =>
      record({
        id: `temp-123e4567-e89b-42d3-a456-42661417401${index}`,
        attachments: [
          {
            url,
            r2_key: "uploads/photo.png",
            content_type: "image/png",
          },
        ],
      }),
    );

    expect(journal.write(withPreview)).toBe(false);
    expect(journal.write(withCredentials)).toBe(false);
    expect(journal.write(oversized)).toBe(false);
    expect(journal.write(wrongId)).toBe(false);
    expect(journal.write(sparseAttachments)).toBe(false);
    for (const invalidPath of invalidMediaPaths) {
      expect(journal.write(invalidPath)).toBe(false);
    }
    expect(storage.map.size).toBe(0);
  });

  test("requires a valid confirmed server id and forbids it on other states", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);

    expect(
      journal.write(record({ state: "confirmed", serverId: "not-a-url" })),
    ).toBe(false);
    expect(
      journal.write(
        record({
          state: "rejected",
          serverId: "https://meet.example/ap/notes/1",
        }),
      ),
    ).toBe(false);
    const confirmed = record({
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/1",
    });
    expect(journal.write(confirmed)).toBe(true);
    expect(journal.read().records).toEqual([confirmed]);
  });

  test("replaces only a confirmed ACK with a minimal v2 marker at its exact key", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const confirmed = record({
      target: COMMUNITY,
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/deleted",
    });
    expect(journal.write(confirmed)).toBe(true);
    const key = [...storage.map.keys()][0]!;
    expect(journal.markDeleted(confirmed)).toBe(true);
    expect([...storage.map.keys()]).toEqual([key]);
    const marker: DeletedJournalRecord = {
      version: 2,
      id: confirmed.id,
      target: confirmed.target,
      state: "deleted",
      serverId: confirmed.serverId!,
    };
    expect(JSON.parse(storage.map.get(key)!)).toEqual({
      scope: SCOPE_A,
      record: marker,
    });
    expect(createOutgoingJournal(SCOPE_A, storage).read()).toEqual({
      records: [],
      deletedRecords: [marker],
      failed: false,
    });
    expect(journal.markDeleted(confirmed)).toBe(true);
    expect(journal.write(confirmed)).toBe(false);
    expect(journal.remove(confirmed)).toBe(false);
    expect(storage.map.get(key)).toBe(
      JSON.stringify({ scope: SCOPE_A, record: marker }),
    );
    expect(
      createOutgoingJournal(SCOPE_B, storage).read().deletedRecords,
    ).toEqual([]);
    expect(
      createOutgoingJournal(OTHER_ORIGIN, storage).read().deletedRecords,
    ).toEqual([]);
    expect(
      createOutgoingJournal(SCOPE_A, storage).read(USER).deletedRecords,
    ).toEqual([]);
  });

  test("markDeleted refuses a stale, different, malformed, or unreadable current intent", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const confirmed = record({
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/1",
    });
    expect(journal.markDeleted(record())).toBe(false);
    expect(journal.write(confirmed)).toBe(true);
    const key = [...storage.map.keys()][0]!;
    const original = storage.map.get(key)!;
    expect(journal.markDeleted({ ...confirmed, content: "different" })).toBe(
      false,
    );
    expect(storage.map.get(key)).toBe(original);
    expect(journal.remove({ ...confirmed, content: "different" })).toBe(false);
    expect(storage.map.get(key)).toBe(original);
    const alternate = {
      ...confirmed,
      serverId: "https://meet.example/ap/notes/other",
    };
    expect(journal.markDeleted(alternate)).toBe(false);
    expect(journal.remove(alternate)).toBe(false);
    expect(storage.map.get(key)).toBe(original);
    storage.map.set(key, "malformed");
    expect(journal.markDeleted(confirmed)).toBe(false);
    expect(storage.map.get(key)).toBe("malformed");
    storage.map.set(key, original);
    expect(journal.remove(confirmed)).toBe(true);
    expect(journal.markDeleted(confirmed)).toBe(true);
    expect(storage.map.has(key)).toBe(false);
  });

  test("a canonical confirmed ACK may replace its matching pending disk intent", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const pending = record({ target: COMMUNITY });
    const confirmed = {
      ...pending,
      state: "confirmed" as const,
      serverId: "https://meet.example/ap/notes/1",
    };
    expect(journal.write(pending)).toBe(true);
    expect(journal.markDeleted(confirmed)).toBe(true);
    expect(journal.read().deletedRecords).toMatchObject([
      { serverId: confirmed.serverId },
    ]);
    expect(journal.remove(pending)).toBe(false);
    expect(journal.read().deletedRecords).toHaveLength(1);
  });

  test("rejects malformed v2 markers without deleting or restoring their bytes", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const confirmed = record({
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/1",
    });
    expect(journal.write(confirmed)).toBe(true);
    expect(journal.markDeleted(confirmed)).toBe(true);
    const key = [...storage.map.keys()][0]!;
    const good = JSON.parse(storage.map.get(key)!);
    const invalid = [
      { ...good, scope: SCOPE_B },
      {
        ...good,
        record: {
          ...good.record,
          id: "temp-123e4567-e89b-42d3-a456-426614174001",
        },
      },
      { ...good, record: { ...good.record, version: 3 } },
      { ...good, record: { ...good.record, state: "confirmed" } },
      {
        ...good,
        record: {
          ...good.record,
          serverId: "https://user:secret@meet.example/ap/notes/1",
        },
      },
      { ...good, record: { ...good.record, content: "must be absent" } },
      { ...good, record: { ...good.record, target: ["user", USER.ap_id] } },
    ];
    for (const envelope of invalid) {
      const bytes = JSON.stringify(envelope);
      storage.map.set(key, bytes);
      expect(journal.read()).toEqual({
        records: [],
        deletedRecords: [],
        failed: true,
      });
      expect(journal.markDeleted(confirmed)).toBe(false);
      expect(storage.map.get(key)).toBe(bytes);
    }
  });

  test("markDeleted reports denied write or readback without claiming persistence", () => {
    const base = memoryStore();
    let denyWrite = false;
    let denyReadback = false;
    let reads = 0;
    const storage: JournalStorage = {
      get length() {
        return base.length;
      },
      key: (index) => base.key(index),
      getItem: (key) => {
        reads++;
        if (denyReadback && reads > 1) throw new Error("read denied");
        return base.getItem(key);
      },
      setItem: (key, value) => {
        if (denyWrite) throw new Error("write denied");
        base.setItem(key, value);
      },
      removeItem: (key) => base.removeItem(key),
    };
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const confirmed = record({
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/1",
    });
    expect(journal.write(confirmed)).toBe(true);
    denyWrite = true;
    expect(journal.markDeleted(confirmed)).toBe(false);
    expect(base.map.size).toBe(1);
    expect(journal.read().records).toEqual([confirmed]);
    denyWrite = false;
    denyReadback = true;
    reads = 0;
    expect(journal.markDeleted(confirmed)).toBe(false);
    denyReadback = false;
    expect(journal.read().deletedRecords).toMatchObject([
      { state: "deleted", serverId: confirmed.serverId },
    ]);
  });

  test("markDeleted accepts exact marker readback when setItem mutates then throws", () => {
    const base = memoryStore();
    let throwAfterWrite = false;
    const storage: JournalStorage = {
      get length() {
        return base.length;
      },
      key: (index) => base.key(index),
      getItem: (key) => base.getItem(key),
      setItem: (key, value) => {
        base.setItem(key, value);
        if (throwAfterWrite) throw new Error("committed before adapter error");
      },
      removeItem: (key) => base.removeItem(key),
    };
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const confirmed = record({
      state: "confirmed",
      serverId: "https://meet.example/ap/notes/1",
    });
    expect(journal.write(confirmed)).toBe(true);
    throwAfterWrite = true;
    expect(journal.markDeleted(confirmed)).toBe(true);
    expect(journal.read()).toMatchObject({
      records: [],
      deletedRecords: [{ state: "deleted", serverId: confirmed.serverId }],
      failed: false,
    });
  });

  test("removes only a valid target intent and verifies removal", () => {
    const storage = memoryStore();
    const journal = createOutgoingJournal(SCOPE_A, storage);
    const a = record();
    const b = record({ id: "temp-123e4567-e89b-42d3-a456-426614174001" });
    expect(journal.write(a)).toBe(true);
    expect(journal.write(b)).toBe(true);
    expect(journal.remove(a)).toBe(true);
    expect(journal.read().records).toEqual([b]);
    expect(journal.remove({ ...a, target: COMMUNITY })).toBe(true);
    expect(journal.read().records).toEqual([b]);
  });

  test("uses temp UUIDs distinct from server identifiers", () => {
    expect(newOutgoingIntentId()).toMatch(
      /^temp-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
