import type {
  CommunityMessage,
  DMMessage,
  MediaAttachment,
} from "@takosjp/yurucommu-api";
import {
  createOutgoingJournal,
  type JournalScope,
  type JournalStorage,
  type JournalTarget,
  type OutgoingJournalRecord,
} from "./outgoing-journal.ts";
import type { MessageDeliveryFailure } from "./message-delivery.ts";

export type RecoveryMessage = (DMMessage | CommunityMessage) & {
  pending?: boolean;
  failed?: boolean;
  deliveryFailure?: MessageDeliveryFailure;
};

type Entry = {
  record: OutgoingJournalRecord;
  revision: number;
  acknowledged?: RecoveryMessage;
  observedInHistory?: boolean;
  acknowledgementSaved?: boolean;
};

/** Correlate a real acknowledgement; never infer success from history text. */
export function matchesOutgoingAcknowledgement(
  record: OutgoingJournalRecord,
  principalApId: string,
  message: RecoveryMessage,
): boolean {
  try {
    const url = new URL(message.id);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      message.sender?.ap_id !== principalApId ||
      message.content !== record.content ||
      typeof message.created_at !== "string" ||
      new Date(message.created_at).toISOString() !== message.created_at
    )
      return false;
    const expected = record.attachments ?? [];
    const actual = message.attachments ?? [];
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((attachment, index) => {
        const received = actual[index];
        return (
          received &&
          attachment.url === received.url &&
          attachment.r2_key === received.r2_key &&
          attachment.content_type === received.content_type &&
          attachment.name === received.name
        );
      })
    );
  } catch {
    return false;
  }
}

const sameTarget = (a: JournalTarget, b: JournalTarget) =>
  a.type === b.type && a.ap_id === b.ap_id;

/** One principal's tab-local intents. This store never sends or replays requests. */
export function createOutgoingRecovery(
  scope: JournalScope,
  storage?: JournalStorage | null,
) {
  const journal = createOutgoingJournal(scope, storage);
  const entries = new Map<string, Entry>();
  let revision = 0;
  const restored = journal.read();
  for (const saved of restored.records) {
    // The previous page's pending request has an unknown outcome after reload.
    const record: OutgoingJournalRecord =
      saved.state === "pending" ? { ...saved, state: "unconfirmed" } : saved;
    entries.set(record.id, {
      record,
      revision: ++revision,
      acknowledgementSaved: record.state === "confirmed",
    });
  }

  const queue = (record: OutgoingJournalRecord): boolean => {
    if (
      entries.has(record.id) ||
      record.state !== "pending" ||
      !journal.write(record)
    )
      return false;
    // The caller's mutable arrays must not change an already journaled intent.
    const snapshot = JSON.parse(
      JSON.stringify(record),
    ) as OutgoingJournalRecord;
    entries.set(snapshot.id, { record: snapshot, revision: ++revision });
    return true;
  };

  const retry = (
    target: JournalTarget,
    id: string,
  ): OutgoingJournalRecord | null => {
    const entry = entries.get(id);
    if (
      !entry ||
      !sameTarget(entry.record.target, target) ||
      (entry.record.state !== "unconfirmed" &&
        entry.record.state !== "rejected")
    )
      return null;
    const record: OutgoingJournalRecord = { ...entry.record, state: "pending" };
    if (!journal.write(record)) return null;
    entries.set(id, { record, revision: ++revision });
    return record;
  };

  const fail = (id: string, state: MessageDeliveryFailure): boolean => {
    const entry = entries.get(id);
    if (!entry || entry.record.state !== "pending") return false;
    const record: OutgoingJournalRecord = { ...entry.record, state };
    entries.set(id, { record, revision: ++revision });
    return journal.write(record);
  };

  const confirm = (id: string, message: RecoveryMessage): boolean => {
    const entry = entries.get(id);
    if (!entry || entry.record.state !== "pending") return false;
    if (
      !matchesOutgoingAcknowledgement(
        entry.record,
        scope.principalApId,
        message,
      )
    ) {
      throw new Error("Invalid message acknowledgement");
    }
    const record: OutgoingJournalRecord = {
      ...entry.record,
      state: "confirmed",
      serverId: message.id,
    };
    // Keep the real ACK in memory even when storing it fails. The old disk
    // intent remains cautious on reload; never remove it without a saved ACK.
    const entryWithAck: Entry = {
      record,
      revision: ++revision,
      acknowledged: message,
    };
    entries.set(id, entryWithAck);
    entryWithAck.acknowledgementSaved = journal.write(record);
    return entryWithAck.acknowledgementSaved && journal.remove(record);
  };

  const discard = (target: JournalTarget, id: string): boolean => {
    const entry = entries.get(id);
    if (
      !entry ||
      !sameTarget(entry.record.target, target) ||
      (entry.record.state !== "unconfirmed" &&
        entry.record.state !== "rejected") ||
      !journal.remove(entry.record)
    )
      return false;
    entries.delete(id);
    revision++;
    return true;
  };

  const merge = (
    target: JournalTarget,
    fetched: RecoveryMessage[],
    sender: DMMessage["sender"],
    fetchedAtRevision?: number,
    observedIds?: ReadonlySet<string>,
  ): RecoveryMessage[] => {
    // Local rows are always rebuilt from the latest keyed entries, never a
    // selected-thread snapshot captured before an asynchronous fetch/send.
    const rows = new Map(
      fetched.filter((m) => !m.id.startsWith("temp-")).map((m) => [m.id, m]),
    );
    for (const [id, entry] of entries) {
      const record = entry.record;
      if (!sameTarget(record.target, target)) continue;
      if (record.state === "confirmed") {
        const serverId = record.serverId!;
        if (rows.has(serverId)) {
          // Retire the bridge only after history fetched AFTER this ACK
          // contains its actual ID. Older in-flight snapshots cannot erase it.
          if (
            fetchedAtRevision !== undefined &&
            fetchedAtRevision >= entry.revision &&
            (!observedIds || observedIds.has(serverId))
          ) {
            if (!entry.acknowledgementSaved)
              entry.acknowledgementSaved = journal.write(record);
            if (entry.acknowledgementSaved && journal.remove(record))
              entry.observedInHistory = true;
          }
          continue;
        }
        if (
          entry.observedInHistory &&
          (fetchedAtRevision === undefined ||
            fetchedAtRevision >= entry.revision)
        )
          continue;
        rows.set(
          serverId,
          entry.acknowledged ?? {
            id: serverId,
            sender,
            content: record.content,
            attachments: record.attachments,
            created_at: record.created_at,
          },
        );
      } else {
        rows.set(id, {
          id,
          sender,
          content: record.content,
          attachments: record.attachments as MediaAttachment[] | undefined,
          created_at: record.created_at,
          pending: record.state === "pending",
          failed: record.state !== "pending",
          ...(record.state !== "pending"
            ? { deliveryFailure: record.state }
            : {}),
        });
      }
    }
    return [...rows.values()].sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
  };

  return {
    queue,
    retry,
    fail,
    confirm,
    discard,
    merge,
    revision: () => revision,
    restorationFailed: restored.failed,
  };
}
