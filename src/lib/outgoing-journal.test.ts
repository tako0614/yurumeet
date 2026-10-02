import { describe, expect, test } from "bun:test";
import {
  createScopedDraftIdentity,
  createOutgoingJournal,
  newOutgoingIntentId,
  type JournalScope,
  type JournalStorage,
  type JournalTarget,
  type OutgoingJournalRecord,
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
    expect(journal.read()).toEqual({ records: [first, second], failed: false });
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
    expect(scopedB.read()).toEqual({ records: [], failed: false });
    expect(otherOrigin.read()).toEqual({ records: [], failed: false });
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

    expect(journal.read()).toEqual({ records: [], failed: true });
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

    expect(journal.read()).toEqual({ records: [], failed: true });
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

    expect(journal.read()).toEqual({ records: [], failed: true });
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
