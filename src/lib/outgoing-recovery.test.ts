import { describe, expect, test } from "bun:test";
import type { DMMessage, MediaAttachment } from "@takosjp/yurucommu-api";
import type {
  JournalScope,
  JournalStorage,
  JournalTarget,
  OutgoingJournalRecord,
} from "./outgoing-journal.ts";
import {
  createOutgoingRecovery,
  matchesOutgoingAcknowledgement,
  type RecoveryMessage,
} from "./outgoing-recovery.ts";

const SCOPE_A: JournalScope = {
  serverOrigin: "https://meet.example",
  principalApId: "https://meet.example/ap/users/alice",
};
const SCOPE_B: JournalScope = {
  serverOrigin: "https://meet.example",
  principalApId: "https://meet.example/ap/users/bob",
};
const SCOPE_OTHER_ORIGIN: JournalScope = {
  serverOrigin: "https://other.example",
  principalApId: "https://meet.example/ap/users/alice",
};
const USER: JournalTarget = {
  type: "user",
  ap_id: "https://meet.example/ap/users/recipient",
};
const COMMUNITY: JournalTarget = {
  type: "community",
  ap_id: USER.ap_id,
};
const SENDER: DMMessage["sender"] = {
  ap_id: SCOPE_A.principalApId,
  username: "alice@meet.example",
  preferred_username: "alice",
  name: "Alice",
  icon_url: null,
};
const ATTACHMENTS: MediaAttachment[] = [
  {
    url: "/media/photo.png",
    r2_key: "uploads/photo.png",
    content_type: "image/png",
    name: "photo.png",
  },
];

function memoryStorage(): JournalStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function controlledStorage() {
  const base = memoryStorage();
  let denyWrites = false;
  let denyRemovals = false;
  const storage: JournalStorage = {
    get length() {
      return base.length;
    },
    key: (index) => base.key(index),
    getItem: (key) => base.getItem(key),
    setItem: (key, value) => {
      if (denyWrites) throw new Error("write denied");
      base.setItem(key, value);
    },
    removeItem: (key) => {
      if (denyRemovals) throw new Error("remove denied");
      base.removeItem(key);
    },
  };
  return {
    storage,
    base,
    denyWrites: (value: boolean) => {
      denyWrites = value;
    },
    denyRemovals: (value: boolean) => {
      denyRemovals = value;
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
    attachments: ATTACHMENTS,
    created_at: "2026-10-02T10:00:00.000Z",
    state: "pending",
    ...overrides,
  };
}

function ack(id = "https://meet.example/ap/objects/note-1"): DMMessage {
  return {
    id,
    sender: SENDER,
    content: "送信する本文",
    attachments: ATTACHMENTS,
    created_at: "2026-10-02T10:00:01.000Z",
  };
}

const tempId = "temp-123e4567-e89b-42d3-a456-426614174000";
const tempId2 = "temp-123e4567-e89b-42d3-a456-426614174001";

function confirmedCommunityMessage(storage: JournalStorage = memoryStorage()) {
  const recovery = createOutgoingRecovery(SCOPE_A, storage);
  const intent = record({ target: COMMUNITY });
  const message = ack();
  expect(recovery.queue(intent)).toBe(true);
  expect(recovery.confirm(intent.id, message)).toBe(true);
  return { recovery, intent, message, storage };
}

function queueConfirmedSecondMessage(
  recovery: ReturnType<typeof createOutgoingRecovery>,
) {
  const intent = record({
    id: tempId2,
    target: COMMUNITY,
    content: "2つ目の本文",
  });
  const message: DMMessage = {
    ...ack("https://meet.example/ap/objects/note-2"),
    content: intent.content,
    created_at: "2026-10-02T10:00:02.000Z",
  };
  expect(recovery.queue(intent)).toBe(true);
  expect(recovery.confirm(intent.id, message)).toBe(true);
  return { intent, message };
}

describe("outgoing-recovery", () => {
  test("restores a pending record as unconfirmed and waits for explicit retry", () => {
    const storage = memoryStorage();
    expect(createOutgoingRecovery(SCOPE_A, storage).queue(record())).toBe(true);

    const recovered = createOutgoingRecovery(SCOPE_A, storage);
    const rows = recovered.merge(USER, [], SENDER);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: tempId,
      pending: false,
      failed: true,
      deliveryFailure: "unconfirmed",
      content: "送信する本文",
      attachments: ATTACHMENTS,
    });
    expect(recovered.retry(USER, tempId)).toMatchObject({ state: "pending" });
  });

  test("isolates recovered rows by target type, AP id, principal, and origin", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, storage);
    expect(recovery.queue(record())).toBe(true);
    expect(
      recovery.queue(
        record({
          id: "temp-123e4567-e89b-42d3-a456-426614174001",
          target: COMMUNITY,
          content: "community intent",
        }),
      ),
    ).toBe(true);

    const restoredA = createOutgoingRecovery(SCOPE_A, storage);
    expect(restoredA.merge(USER, [], SENDER).map((row) => row.id)).toEqual([
      tempId,
    ]);
    expect(restoredA.merge(COMMUNITY, [], SENDER).map((row) => row.id)).toEqual(
      ["temp-123e4567-e89b-42d3-a456-426614174001"],
    );
    expect(
      restoredA.merge(
        { type: "user", ap_id: "https://meet.example/ap/users/another" },
        [],
        SENDER,
      ),
    ).toEqual([]);
    expect(
      createOutgoingRecovery(SCOPE_B, storage).merge(USER, [], SENDER),
    ).toEqual([]);
    expect(
      createOutgoingRecovery(SCOPE_OTHER_ORIGIN, storage).merge(
        USER,
        [],
        SENDER,
      ),
    ).toEqual([]);
  });

  test("keeps a failed intent and uploaded attachment refs under its original talk", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    expect(recovery.queue(record())).toBe(true);
    expect(recovery.fail(tempId, "unconfirmed")).toBe(true);

    expect(recovery.merge(COMMUNITY, [], SENDER)).toEqual([]);
    expect(recovery.merge(USER, [], SENDER)).toMatchObject([
      {
        id: tempId,
        failed: true,
        deliveryFailure: "unconfirmed",
        attachments: ATTACHMENTS,
      },
    ]);
  });

  test("deduplicates a canonical ACK and protects it from a stale history revision", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    expect(recovery.queue(record())).toBe(true);
    const beforeAck = recovery.revision();
    const sent = ack();
    expect(recovery.confirm(tempId, sent)).toBe(true);
    const afterAck = recovery.revision();

    const staleFetchWithAck: RecoveryMessage[] = [sent];
    expect(
      recovery
        .merge(USER, staleFetchWithAck, SENDER, beforeAck)
        .map((row) => row.id),
    ).toEqual([sent.id]);
    expect(
      recovery.merge(USER, [], SENDER, beforeAck).map((row) => row.id),
    ).toEqual([sent.id]);

    const freshFetchWithAck: RecoveryMessage[] = [sent];
    expect(
      recovery
        .merge(USER, freshFetchWithAck, SENDER, afterAck)
        .map((row) => row.id),
    ).toEqual([sent.id]);
    expect(recovery.merge(USER, [], SENDER, afterAck)).toEqual([]);
  });

  test("retires the ACK bridge only after a fresh page itself observed the canonical ID", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    expect(recovery.queue(record())).toBe(true);
    const sent = ack();
    expect(recovery.confirm(tempId, sent)).toBe(true);
    const afterAck = recovery.revision();

    // The poll-reconciled base contains the ACK, but the fetched page did not.
    expect(
      recovery
        .merge(USER, [sent], SENDER, afterAck, new Set())
        .map((row) => row.id),
    ).toEqual([sent.id]);
    // A subsequent page that still lacks the row must keep the local bridge.
    expect(
      recovery
        .merge(USER, [], SENDER, afterAck, new Set())
        .map((row) => row.id),
    ).toEqual([sent.id]);

    // Only an actual observation from this fresh thread page can retire it.
    expect(
      recovery
        .merge(USER, [sent], SENDER, afterAck, new Set([sent.id]))
        .map((row) => row.id),
    ).toEqual([sent.id]);
    expect(
      recovery
        .merge(USER, [], SENDER, afterAck, new Set())
        .map((row) => row.id),
    ).toEqual([]);
  });

  test("suppresses a confirmed ACK during delete while a second send merges", () => {
    const { recovery, message } = confirmedCommunityMessage();
    const deletion = recovery.beginDelete(COMMUNITY, message.id);

    // A poll page that still contains M1 must not undo the optimistic delete.
    expect(
      recovery.merge(COMMUNITY, [message], SENDER).map((row) => row.id),
    ).toEqual([]);

    const second = queueConfirmedSecondMessage(recovery);
    expect(recovery.merge(COMMUNITY, [], SENDER).map((row) => row.id)).toEqual([
      second.message.id,
    ]);
    expect(deletion.commit()).toBe(true);
  });

  test("rollback restores a pending ACK bridge without dropping a second send", () => {
    const { recovery, message } = confirmedCommunityMessage();
    const deletion = recovery.beginDelete(COMMUNITY, message.id);
    const second = queueConfirmedSecondMessage(recovery);

    expect(deletion.rollback()).toEqual({ mayRestore: true });
    expect(recovery.merge(COMMUNITY, [], SENDER).map((row) => row.id)).toEqual([
      message.id,
      second.message.id,
    ]);
  });

  test("committed delete suppresses a stale fetched ACK and keeps another message", () => {
    const { recovery, message } = confirmedCommunityMessage();
    const deletion = recovery.beginDelete(COMMUNITY, message.id);
    const second = queueConfirmedSecondMessage(recovery);
    expect(deletion.commit()).toBe(true);

    expect(
      recovery.merge(COMMUNITY, [message], SENDER).map((row) => row.id),
    ).toEqual([second.message.id]);
  });

  test("delete suppression is scoped to the exact target and principal", () => {
    const storage = memoryStorage();
    const { recovery, message } = confirmedCommunityMessage(storage);
    const deletion = recovery.beginDelete(COMMUNITY, message.id);
    const otherCommunity: JournalTarget = {
      type: "community",
      ap_id: "https://meet.example/ap/groups/other",
    };

    expect(
      recovery.merge(USER, [message], SENDER).map((row) => row.id),
    ).toEqual([message.id]);
    expect(
      recovery.merge(otherCommunity, [message], SENDER).map((row) => row.id),
    ).toEqual([message.id]);
    expect(
      createOutgoingRecovery(SCOPE_B, storage)
        .merge(COMMUNITY, [message], SENDER)
        .map((row) => row.id),
    ).toEqual([message.id]);
    expect(deletion.rollback()).toEqual({ mayRestore: true });
  });

  test("delete handle snapshots its target identity before later cleanup", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    const intent = record({ target: COMMUNITY });
    const message = ack();
    expect(recovery.queue(intent)).toBe(true);
    expect(recovery.confirm(intent.id, message)).toBe(true);
    const mutableTarget: JournalTarget = { ...COMMUNITY };
    const deletion = recovery.beginDelete(mutableTarget, message.id);
    mutableTarget.ap_id = "https://meet.example/ap/groups/changed";
    controlled.denyRemovals(true);

    expect(deletion.commit()).toBe(false);
    expect(recovery.merge(COMMUNITY, [message], SENDER)).toEqual([]);
    controlled.denyRemovals(false);
    expect(recovery.merge(COMMUNITY, [message], SENDER)).toEqual([]);
  });

  test("overlapping delete handles cannot undo another handle's commit", () => {
    const { recovery, message } = confirmedCommunityMessage();
    const first = recovery.beginDelete(COMMUNITY, message.id);
    const second = recovery.beginDelete(COMMUNITY, message.id);

    expect(first.commit()).toBe(true);
    expect(second.rollback()).toEqual({ mayRestore: false });
    expect(first.rollback()).toEqual({ mayRestore: false });
    expect(recovery.merge(COMMUNITY, [], SENDER)).toEqual([]);
  });

  test("only the last pending rollback may restore the bridge", () => {
    const { recovery, message } = confirmedCommunityMessage();
    const first = recovery.beginDelete(COMMUNITY, message.id);
    const second = recovery.beginDelete(COMMUNITY, message.id);

    expect(first.rollback()).toEqual({ mayRestore: false });
    expect(recovery.merge(COMMUNITY, [], SENDER)).toEqual([]);
    expect(second.rollback()).toEqual({ mayRestore: true });
    expect(recovery.merge(COMMUNITY, [], SENDER).map((row) => row.id)).toEqual([
      message.id,
    ]);
  });

  test("committed delete masks same-session rows and retries failed journal cleanup", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    const intent = record({ target: COMMUNITY });
    const message = ack();
    expect(recovery.queue(intent)).toBe(true);
    controlled.denyRemovals(true);
    expect(recovery.confirm(intent.id, message)).toBe(false);

    const deletion = recovery.beginDelete(COMMUNITY, message.id);
    expect(deletion.commit()).toBe(false);
    expect(
      recovery.merge(COMMUNITY, [message], SENDER).map((row) => row.id),
    ).toEqual([]);
    expect(controlled.base.values.size).toBe(1);

    controlled.denyRemovals(false);
    expect(recovery.merge(COMMUNITY, [message], SENDER)).toEqual([]);
    expect(controlled.base.values.size).toBe(0);
  });

  test("retains cautious reload state when saving a confirmed ACK fails", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(recovery.queue(record())).toBe(true);
    controlled.denyWrites(true);

    expect(recovery.confirm(tempId, ack())).toBe(false);
    const reloaded = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(reloaded.merge(USER, [], SENDER)).toMatchObject([
      { id: tempId, failed: true, deliveryFailure: "unconfirmed" },
    ]);
  });

  test("retains the persisted confirmed ACK when removing it from storage fails", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(recovery.queue(record())).toBe(true);
    controlled.denyRemovals(true);

    const sent = ack();
    expect(recovery.confirm(tempId, sent)).toBe(false);
    const reloaded = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(reloaded.merge(USER, [], SENDER).map((row) => row.id)).toEqual([
      sent.id,
    ]);
    expect(reloaded.revision()).toBe(1);
  });

  test("does not queue or expose a row when the initial journal write is denied", () => {
    const controlled = controlledStorage();
    controlled.denyWrites(true);
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);

    expect(recovery.queue(record())).toBe(false);
    expect(recovery.merge(USER, [], SENDER)).toEqual([]);
    expect(controlled.base.values.size).toBe(0);
    expect(recovery.revision()).toBe(0);
  });

  test("rejects a partial journal write before queueing an intent", () => {
    const base = memoryStorage();
    const partialStorage: JournalStorage = {
      get length() {
        return base.length;
      },
      key: (index) => base.key(index),
      getItem: (key) => base.getItem(key),
      setItem: (key, value) => {
        base.setItem(key, value.slice(0, -1));
      },
      removeItem: (key) => base.removeItem(key),
    };
    const recovery = createOutgoingRecovery(SCOPE_A, partialStorage);

    expect(recovery.queue(record())).toBe(false);
    expect(recovery.merge(USER, [], SENDER)).toEqual([]);
    expect(recovery.revision()).toBe(0);
    expect(base.values.size).toBe(1);
  });

  test("keeps a failed row when discarding it cannot remove its journal record", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(recovery.queue(record())).toBe(true);
    expect(recovery.fail(tempId, "rejected")).toBe(true);
    controlled.denyRemovals(true);

    expect(recovery.discard(USER, tempId)).toBe(false);
    expect(recovery.merge(USER, [], SENDER)).toMatchObject([
      { id: tempId, failed: true, deliveryFailure: "rejected" },
    ]);
  });

  test("preserves two identical intentional messages as distinct intents", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    const first = record();
    const second = record({ id: "temp-123e4567-e89b-42d3-a456-426614174001" });
    expect(recovery.queue(first)).toBe(true);
    expect(recovery.queue(second)).toBe(true);

    expect(
      recovery.merge(USER, [], SENDER).map((row) => [row.id, row.content]),
    ).toEqual([
      [first.id, first.content],
      [second.id, second.content],
    ]);
  });

  test("retry reuses the original intent id and exact uploaded media refs", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    expect(recovery.queue(record())).toBe(true);
    expect(recovery.fail(tempId, "rejected")).toBe(true);

    const retry = recovery.retry(USER, tempId);
    expect(retry).toEqual({ ...record(), state: "pending" });
    expect(retry?.attachments).toEqual(ATTACHMENTS);
    expect(recovery.merge(USER, [], SENDER)).toMatchObject([
      { id: tempId, pending: true, failed: false, attachments: ATTACHMENTS },
    ]);
  });

  test("accepts only an ACK matching principal, body, media, ID, and timestamp", () => {
    const intent = record();
    const sent = ack();

    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, sent),
    ).toBe(true);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_B.principalApId, sent),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        sender: { ...sent.sender, ap_id: SCOPE_B.principalApId },
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        content: "different body",
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        attachments: [{ ...ATTACHMENTS[0], r2_key: "uploads/different.png" }],
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        id: "not-an-absolute-url",
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        created_at: "not-a-date",
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        created_at: 123 as unknown as string,
      }),
    ).toBe(false);
    expect(
      matchesOutgoingAcknowledgement(intent, SCOPE_A.principalApId, {
        ...sent,
        created_at: "2026-10-02T10:00:01Z",
      }),
    ).toBe(false);
  });

  test("does not retire the pending disk intent from history if ACK storage failed", () => {
    const controlled = controlledStorage();
    const recovery = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(recovery.queue(record())).toBe(true);
    controlled.denyWrites(true);

    const sent = ack();
    expect(recovery.confirm(tempId, sent)).toBe(false);
    const fetchedAtRevision = recovery.revision();
    expect(
      recovery
        .merge(USER, [sent], SENDER, fetchedAtRevision)
        .map((row) => row.id),
    ).toEqual([sent.id]);

    const reloaded = createOutgoingRecovery(SCOPE_A, controlled.storage);
    expect(reloaded.merge(USER, [], SENDER)).toMatchObject([
      { id: tempId, failed: true, deliveryFailure: "unconfirmed" },
    ]);
  });

  test("leaves an invalid ACK pending so the caller can mark its outcome unconfirmed", () => {
    const recovery = createOutgoingRecovery(SCOPE_A, memoryStorage());
    expect(recovery.queue(record())).toBe(true);
    const invalidAck = {
      ...ack(),
      sender: { ...SENDER, ap_id: SCOPE_B.principalApId },
    };

    expect(() => recovery.confirm(tempId, invalidAck)).toThrow(
      "Invalid message acknowledgement",
    );
    expect(recovery.merge(USER, [], SENDER)).toMatchObject([
      { id: tempId, pending: true, failed: false },
    ]);
    expect(recovery.fail(tempId, "unconfirmed")).toBe(true);
    expect(recovery.merge(USER, [], SENDER)).toMatchObject([
      {
        id: tempId,
        pending: false,
        failed: true,
        deliveryFailure: "unconfirmed",
      },
    ]);
  });

  test("returns no restored rows and marks corrupt journal contents as failed", () => {
    const storage = memoryStorage();
    expect(createOutgoingRecovery(SCOPE_A, storage).queue(record())).toBe(true);
    const key = [...storage.values.keys()][0]!;
    storage.values.set(key, "invalid json");

    const restored = createOutgoingRecovery(SCOPE_A, storage);
    expect(restored.restorationFailed).toBe(true);
    expect(restored.merge(USER, [], SENDER)).toEqual([]);
  });
});
