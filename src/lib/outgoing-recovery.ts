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
import { talkMediaExpired } from "./talk-media.ts";

export type RecoveryMessage = (DMMessage | CommunityMessage) & {
  pending?: boolean;
  failed?: boolean;
  deliveryFailure?: MessageDeliveryFailure;
  mediaExpired?: boolean;
  mediaDeadlines?: (string | null)[];
};

type Entry = {
  record: OutgoingJournalRecord;
  revision: number;
  acknowledged?: RecoveryMessage;
  observedInHistory?: boolean;
  acknowledgementSaved?: boolean;
  /** Browser File objects are retained only in memory, never journaled. */
  sourceFiles?: readonly File[];
};

export type ExpiredOutgoingDraft = {
  record: OutgoingJournalRecord;
  sourceFiles?: readonly File[];
  isCurrent: () => boolean;
};

type DeleteSuppression = {
  pending: Set<symbol>;
  committed: boolean;
};

type DeleteHandle = {
  /** True only when no other same-message delete can still mask restoration. */
  rollback: () => { mayRestore: boolean };
  /** True when matching entries are removed or durably marked deleted; masking remains active either way. */
  commit: () => boolean;
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
  // Session masks have no TTL/LRU: expiring one could resurrect a confirmed
  // message that this client successfully deleted. Memory includes restored
  // deleted markers and IDs deleted during this mounted recovery session.
  const deleteSuppressions = new Map<string, DeleteSuppression>();
  const deleteKey = (target: JournalTarget, serverId: string) =>
    JSON.stringify([target.type, target.ap_id, serverId]);
  let revision = 0;
  const restored = journal.read();
  for (const deleted of restored.deletedRecords) {
    // A verified previous DELETE is not an outgoing intent. Restore the mask
    // before exposing any surviving confirmed sibling with the same server ID.
    deleteSuppressions.set(deleteKey(deleted.target, deleted.serverId), {
      pending: new Set(),
      committed: true,
    });
  }
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

  const queue = (
    record: OutgoingJournalRecord,
    sourceFiles?: readonly File[],
  ): boolean => {
    if (
      entries.has(record.id) ||
      record.state !== "pending" ||
      (sourceFiles !== undefined &&
        (sourceFiles.length !== (record.attachments?.length ?? 0) ||
          !sourceFiles.every((file) => file instanceof File))) ||
      !journal.write(record)
    )
      return false;
    // The caller's mutable arrays must not change an already journaled intent.
    const snapshot = JSON.parse(
      JSON.stringify(record),
    ) as OutgoingJournalRecord;
    entries.set(snapshot.id, {
      record: snapshot,
      revision: ++revision,
      ...(sourceFiles ? { sourceFiles: [...sourceFiles] } : {}),
    });
    return true;
  };

  const retry = (
    target: JournalTarget,
    id: string,
  ): OutgoingJournalRecord | null => {
    const entry = entries.get(id);
    if (
      !entry ||
      entry.record.failureCode === "MEDIA_EXPIRED" ||
      entry.record.mediaDeadlines?.some((deadline) =>
        talkMediaExpired(deadline ?? undefined),
      ) ||
      !sameTarget(entry.record.target, target) ||
      (entry.record.state !== "unconfirmed" &&
        entry.record.state !== "rejected")
    )
      return null;
    const record: OutgoingJournalRecord = {
      ...entry.record,
      state: "pending",
      ...(entry.record.state === "unconfirmed"
        ? { hadUnconfirmedAttempt: true }
        : {}),
    };
    if (!journal.write(record)) return null;
    entries.set(id, { ...entry, record, revision: ++revision });
    return record;
  };

  const fail = (
    id: string,
    state: MessageDeliveryFailure,
    failureCode?: "MEDIA_EXPIRED",
  ): boolean => {
    const entry = entries.get(id);
    if (!entry || entry.record.state !== "pending") return false;
    if (entry.record.hadUnconfirmedAttempt) state = "unconfirmed";
    const record: OutgoingJournalRecord = {
      ...entry.record,
      state,
      ...(state === "rejected" &&
      failureCode === "MEDIA_EXPIRED" &&
      entry.record.attachments?.length
        ? { failureCode }
        : {}),
    };
    entries.set(id, { ...entry, record, revision: ++revision });
    return journal.write(record);
  };

  const expiredDraft = (
    target: JournalTarget,
    id: string,
  ): ExpiredOutgoingDraft | null => {
    const entry = entries.get(id);
    if (
      !entry ||
      !sameTarget(entry.record.target, target) ||
      entry.record.state !== "rejected" ||
      (entry.record.failureCode !== "MEDIA_EXPIRED" &&
        !entry.record.mediaDeadlines?.some((deadline) =>
          talkMediaExpired(deadline ?? undefined),
        ))
    )
      return null;
    const capturedRevision = entry.revision;
    return {
      record: JSON.parse(JSON.stringify(entry.record)) as OutgoingJournalRecord,
      ...(entry.sourceFiles ? { sourceFiles: [...entry.sourceFiles] } : {}),
      isCurrent: () => entries.get(id)?.revision === capturedRevision,
    };
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

  const cleanupDeletedAcknowledgements = (
    target: JournalTarget,
    serverId: string,
  ): boolean => {
    let complete = true;
    for (const [id, entry] of entries) {
      if (
        entry.record.state !== "confirmed" ||
        entry.record.serverId !== serverId ||
        !sameTarget(entry.record.target, target)
      ) {
        continue;
      }
      if (journal.remove(entry.record) || journal.markDeleted(entry.record)) {
        // The same key may now hold a deletion marker; retire its old entry
        // immediately so a later merge cannot remove that marker by old ID.
        entries.delete(id);
        revision++;
      } else {
        complete = false;
      }
    }
    return complete;
  };

  const beginDelete = (
    target: JournalTarget,
    serverId: string,
  ): DeleteHandle => {
    const scopedTarget: JournalTarget = {
      type: target.type,
      ap_id: target.ap_id,
    };
    const key = deleteKey(scopedTarget, serverId);
    let suppression = deleteSuppressions.get(key);
    if (!suppression) {
      suppression = { pending: new Set(), committed: false };
      deleteSuppressions.set(key, suppression);
    }
    const token = Symbol("delete");
    suppression.pending.add(token);
    let tokenState: "pending" | "rolled-back" | "committed" = "pending";

    const commit = (): boolean => {
      if (tokenState === "rolled-back") return false;
      if (tokenState === "pending") {
        suppression!.pending.delete(token);
        suppression!.committed = true;
        tokenState = "committed";
        revision++;
      }
      // Keep the mask when neither removal nor marker persistence can be
      // verified; a later merge may retire those still-renderable entries.
      return cleanupDeletedAcknowledgements(scopedTarget, serverId);
    };

    const rollback = (): { mayRestore: boolean } => {
      if (tokenState !== "pending") return { mayRestore: false };
      suppression!.pending.delete(token);
      tokenState = "rolled-back";
      const mayRestore =
        !suppression!.committed && suppression!.pending.size === 0;
      if (mayRestore) deleteSuppressions.delete(key);
      revision++;
      return { mayRestore };
    };

    return { rollback, commit };
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
    const rows = new Map<string, RecoveryMessage>();
    for (const message of fetched) {
      if (message.id.startsWith("temp-")) continue;
      const suppression = deleteSuppressions.get(deleteKey(target, message.id));
      if (suppression) continue;
      rows.set(message.id, message);
    }
    for (const [id, entry] of entries) {
      const record = entry.record;
      if (!sameTarget(record.target, target)) continue;
      if (record.state === "confirmed") {
        const serverId = record.serverId!;
        const suppression = deleteSuppressions.get(deleteKey(target, serverId));
        if (suppression) {
          if (suppression.committed)
            cleanupDeletedAcknowledgements(target, serverId);
          continue;
        }
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
          ...(record.mediaDeadlines
            ? { mediaDeadlines: [...record.mediaDeadlines] }
            : {}),
          ...(record.state !== "pending"
            ? { deliveryFailure: record.state }
            : {}),
          ...(record.state === "rejected" &&
          (record.failureCode === "MEDIA_EXPIRED" ||
            record.mediaDeadlines?.some((deadline) =>
              talkMediaExpired(deadline ?? undefined),
            ))
            ? { mediaExpired: true }
            : {}),
        });
      }
    }
    // The paging cursor uses the first canonical row. Keep the same tuple
    // order as Core's history query; locale collation can put /a before /B
    // and make a later request repeat an already displayed page.
    return [...rows.values()].sort((a, b) => {
      if (a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? -1 : 1;
      }
      return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    });
  };

  return {
    releaseSourceFiles: () => {
      for (const entry of entries.values()) delete entry.sourceFiles;
    },
    queue,
    retry,
    fail,
    expiredDraft,
    confirm,
    discard,
    beginDelete,
    merge,
    revision: () => revision,
    restorationFailed: restored.failed,
  };
}
