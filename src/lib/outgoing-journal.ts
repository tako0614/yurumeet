import type { MediaAttachment } from "@takosjp/yurucommu-api";

export type JournalScope = {
  serverOrigin: string;
  principalApId: string;
};

export type JournalTarget = {
  type: "user" | "community";
  ap_id: string;
};

export type OutgoingJournalRecord = {
  version: 1;
  id: string;
  target: JournalTarget;
  content: string;
  attachments?: MediaAttachment[];
  created_at: string;
  state: "pending" | "unconfirmed" | "rejected" | "confirmed";
  serverId?: string;
  /** Exact server expiry rejection only; never attached to an unknown outcome. */
  failureCode?: "MEDIA_EXPIRED";
  /** Advertised deadlines aligned with exact immutable attachment references. */
  mediaDeadlines?: (string | null)[];
  /** A later retry rejection cannot settle an earlier unknown acceptance. */
  hadUnconfirmedAttempt?: true;
};

/** A successful server delete, stored at the former confirmed intent's key. */
export type DeletedJournalRecord = {
  version: 2;
  id: string;
  target: JournalTarget;
  state: "deleted";
  serverId: string;
};

export type JournalStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type OutgoingJournalRead = {
  records: OutgoingJournalRecord[];
  deletedRecords: DeletedJournalRecord[];
  failed: boolean;
};

const PREFIX = "yurume:outgoing:v1:";
const MAX_CONTENT_LENGTH = 100_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_FIELD_LENGTH = 4_096;
const ID_PATTERN =
  /^temp-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserSessionStorage(): JournalStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_ATTACHMENT_FIELD_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (isHttpUrl(value)) return true;
  // Core returns same-product upload paths such as `/media/photo.png`.
  // Keep this to one plain filename segment; encoded or literal path traversal
  // and query/fragment suffixes are not valid attachment references.
  return /^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value);
}

function isServerOrigin(value: unknown): value is string {
  if (!isHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === value && url.pathname === "/" && !url.search && !url.hash
    );
  } catch {
    return false;
  }
}

function validScope(value: unknown): value is JournalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (
    Object.keys(scope).length === 2 &&
    isServerOrigin(scope.serverOrigin) &&
    isHttpUrl(scope.principalApId)
  );
}

function validTarget(value: unknown): value is JournalTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    Object.keys(target).length === 2 &&
    (target.type === "user" || target.type === "community") &&
    isHttpUrl(target.ap_id)
  );
}

function validAttachment(value: unknown): value is MediaAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  const keys = Object.keys(attachment);
  if (
    keys.some(
      (key) => !["url", "r2_key", "content_type", "name"].includes(key),
    ) ||
    typeof attachment.r2_key !== "string" ||
    attachment.r2_key.length === 0 ||
    attachment.r2_key.length > MAX_ATTACHMENT_FIELD_LENGTH ||
    typeof attachment.content_type !== "string" ||
    !/^(image|video)\/[a-z0-9.+-]+$/i.test(attachment.content_type) ||
    attachment.content_type.length > 255 ||
    (attachment.name !== undefined &&
      (typeof attachment.name !== "string" ||
        attachment.name.length > MAX_ATTACHMENT_FIELD_LENGTH)) ||
    (attachment.url !== undefined && !isMediaUrl(attachment.url))
  ) {
    return false;
  }
  return true;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validRecord(value: unknown): value is OutgoingJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = [
    "version",
    "id",
    "target",
    "content",
    "attachments",
    "created_at",
    "state",
    "serverId",
    "failureCode",
    "mediaDeadlines",
    "hadUnconfirmedAttempt",
  ];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !ID_PATTERN.test(record.id) ||
    !validTarget(record.target) ||
    typeof record.content !== "string" ||
    record.content.length > MAX_CONTENT_LENGTH ||
    (record.content.length === 0 &&
      (!Array.isArray(record.attachments) ||
        record.attachments.length === 0)) ||
    !validTimestamp(record.created_at) ||
    typeof record.state !== "string" ||
    !["pending", "unconfirmed", "rejected", "confirmed"].includes(
      record.state,
    ) ||
    (record.attachments !== undefined &&
      (!Array.isArray(record.attachments) ||
        record.attachments.length > MAX_ATTACHMENTS ||
        !Array.from(record.attachments).every(validAttachment)))
  ) {
    return false;
  }
  if (record.state === "confirmed") {
    if (!isHttpUrl(record.serverId)) return false;
  } else if (record.serverId !== undefined) {
    return false;
  }
  if (
    record.failureCode !== undefined &&
    (record.failureCode !== "MEDIA_EXPIRED" ||
      record.state !== "rejected" ||
      !Array.isArray(record.attachments) ||
      record.attachments.length === 0)
  )
    return false;
  if (
    record.mediaDeadlines !== undefined &&
    (!Array.isArray(record.attachments) ||
      !Array.isArray(record.mediaDeadlines) ||
      record.mediaDeadlines.length !== record.attachments.length ||
      !Array.from(record.mediaDeadlines).every(
        (deadline) =>
          deadline === null ||
          (typeof deadline === "string" &&
            deadline.length <= 256 &&
            Number.isFinite(Date.parse(deadline))),
      ))
  )
    return false;
  if (
    record.hadUnconfirmedAttempt !== undefined &&
    (record.hadUnconfirmedAttempt !== true || record.state === "rejected")
  )
    return false;
  return true;
}

function validDeletedRecord(value: unknown): value is DeletedJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 5 &&
    Object.keys(record).every((key) =>
      ["version", "id", "target", "state", "serverId"].includes(key),
    ) &&
    record.version === 2 &&
    typeof record.id === "string" &&
    ID_PATTERN.test(record.id) &&
    validTarget(record.target) &&
    record.state === "deleted" &&
    isHttpUrl(record.serverId)
  );
}

type JournalRecord = OutgoingJournalRecord | DeletedJournalRecord;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function scopePrefix(scope: JournalScope): string {
  return `${PREFIX}${enc(scope.serverOrigin)}:${enc(scope.principalApId)}:`;
}

function recordKey(scope: JournalScope, record: JournalRecord): string {
  return `${scopePrefix(scope)}${record.target.type}:${enc(record.target.ap_id)}:${record.id}`;
}

function sameTarget(a: JournalTarget, b: JournalTarget): boolean {
  return a.type === b.type && a.ap_id === b.ap_id;
}

function sameIntentPayload(
  current: OutgoingJournalRecord,
  snapshot: OutgoingJournalRecord,
): boolean {
  return (
    current.id === snapshot.id &&
    sameTarget(current.target, snapshot.target) &&
    current.content === snapshot.content &&
    current.created_at === snapshot.created_at &&
    JSON.stringify(current.mediaDeadlines) ===
      JSON.stringify(snapshot.mediaDeadlines) &&
    JSON.stringify(current.attachments) === JSON.stringify(snapshot.attachments)
  );
}

function validEnvelope(
  value: unknown,
  scope: JournalScope,
  key: string,
): value is { scope: JournalScope; record: JournalRecord } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 2 ||
    !("scope" in envelope) ||
    !("record" in envelope)
  ) {
    return false;
  }
  const storedScope = envelope.scope;
  const record = envelope.record;
  return (
    !!storedScope &&
    typeof storedScope === "object" &&
    !Array.isArray(storedScope) &&
    Object.keys(storedScope).length === 2 &&
    (storedScope as JournalScope).serverOrigin === scope.serverOrigin &&
    (storedScope as JournalScope).principalApId === scope.principalApId &&
    (validRecord(record) || validDeletedRecord(record)) &&
    recordKey(scope, record) === key
  );
}

/** Stable identity for an unsent text draft under one server, account, and talk. */
export function createScopedDraftIdentity(
  scope: JournalScope,
  target: JournalTarget,
): string {
  if (!validScope(scope) || !validTarget(target)) {
    throw new TypeError("Invalid scoped draft identity");
  }
  return JSON.stringify([
    1,
    scope.serverOrigin,
    scope.principalApId,
    target.type,
    target.ap_id,
  ]);
}

/** A tab-local, per-intent journal. It never sends requests or removes unknown entries. */
export function createOutgoingJournal(
  scope: JournalScope,
  storage: JournalStorage | null = browserSessionStorage(),
) {
  const canUse = validScope(scope);
  const journalScope = canUse ? { ...scope } : scope;

  function write(record: OutgoingJournalRecord): boolean {
    if (!canUse || !storage) return false;
    try {
      if (!validRecord(record)) return false;
      const key = recordKey(journalScope, record);
      const serialized = JSON.stringify({ scope: journalScope, record });
      if (
        typeof serialized !== "string" ||
        !validEnvelope(JSON.parse(serialized) as unknown, journalScope, key)
      ) {
        return false;
      }
      const current = storage.getItem(key);
      if (current !== null) {
        const stored: unknown = JSON.parse(current);
        if (!validEnvelope(stored, journalScope, key)) return false;
        if (stored.record.version === 2) return false;
      }
      storage.setItem(key, serialized);
      return storage.getItem(key) === serialized;
    } catch {
      return false;
    }
  }

  function remove(record: OutgoingJournalRecord): boolean {
    if (!canUse || !storage) return false;
    try {
      if (!validRecord(record)) return false;
      const key = recordKey(journalScope, record);
      const current = storage.getItem(key);
      if (current === null) return true;
      const stored: unknown = JSON.parse(current);
      if (!validEnvelope(stored, journalScope, key)) return false;
      if (stored.record.version === 2) return false;
      if (!sameIntentPayload(stored.record, record)) return false;
      if (
        stored.record.state === "confirmed" &&
        stored.record.serverId !== record.serverId
      )
        return false;
      storage.removeItem(key);
      return storage.getItem(key) === null;
    } catch {
      return false;
    }
  }

  /** Rewrite only the exact persisted confirmed ACK after a successful DELETE. */
  function markDeleted(record: OutgoingJournalRecord): boolean {
    if (
      !canUse ||
      !storage ||
      !validRecord(record) ||
      record.state !== "confirmed"
    )
      return false;
    try {
      const key = recordKey(journalScope, record);
      const current = storage.getItem(key);
      if (current === null) return true; // The confirmed journal was already removed.
      const envelope: unknown = JSON.parse(current);
      if (!validEnvelope(envelope, journalScope, key)) return false;
      if (envelope.record.version === 2) {
        return envelope.record.serverId === record.serverId;
      }
      if (envelope.record.state === "rejected") return false;
      // A persisted pending/unconfirmed copy can survive a failed ACK write.
      // The caller's canonical confirmed ACK supplies the server ID; immutable
      // intent identity and payload must still match before replacing it.
      if (!sameIntentPayload(envelope.record, record)) return false;
      if (
        envelope.record.state === "confirmed" &&
        envelope.record.serverId !== record.serverId
      )
        return false;
      const marker: DeletedJournalRecord = {
        version: 2,
        id: record.id,
        target: { type: record.target.type, ap_id: record.target.ap_id },
        state: "deleted",
        serverId: record.serverId!,
      };
      const serialized = JSON.stringify({
        scope: journalScope,
        record: marker,
      });
      try {
        storage.setItem(key, serialized);
      } catch {
        // Some adapters commit bytes before throwing. The readback below is
        // the only evidence that this exact marker survived.
      }
      return storage.getItem(key) === serialized;
    } catch {
      return false;
    }
  }

  function read(target?: JournalTarget): OutgoingJournalRead {
    if (!canUse || !storage || (target !== undefined && !validTarget(target))) {
      return { records: [], deletedRecords: [], failed: true };
    }
    const records: OutgoingJournalRecord[] = [];
    const deletedRecords: DeletedJournalRecord[] = [];
    let failed = false;
    try {
      const prefix = scopePrefix(journalScope);
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) {
        try {
          const raw = storage.getItem(key);
          if (raw === null) continue;
          const envelope: unknown = JSON.parse(raw);
          if (!validEnvelope(envelope, journalScope, key)) {
            failed = true;
            continue;
          }
          if (!target || sameTarget(envelope.record.target, target)) {
            if (envelope.record.version === 2)
              deletedRecords.push(envelope.record);
            else records.push(envelope.record);
          }
        } catch {
          failed = true;
        }
      }
    } catch {
      failed = true;
    }
    records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    deletedRecords.sort(
      (a, b) =>
        a.serverId.localeCompare(b.serverId) || a.id.localeCompare(b.id),
    );
    return { records, deletedRecords, failed };
  }

  return { write, remove, markDeleted, read };
}

/** Creates a fresh UI-only intent identifier; it is not a server idempotency key. */
export function newOutgoingIntentId(): string {
  return `temp-${crypto.randomUUID()}`;
}
