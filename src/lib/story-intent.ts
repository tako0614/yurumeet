import type { Story, StoryOverlay } from "@takosjp/yurucommu-api";

export interface StoryCreatePayload {
  attachment: { url?: string; r2_key: string; content_type: string };
  displayDuration: string;
  caption?: string;
  overlays?: StoryOverlay[];
  community_ap_id?: string;
}

export type StoryIntentPayload = StoryCreatePayload;

export interface StoryIntentScope {
  origin: string;
  principal: string;
  endpoint?: string;
}

export interface StoryIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StoryIntentStatus =
  "ready" | "pending" | "unconfirmed" | "confirmed";

export interface StoryIntentRecord {
  version: 1;
  intentId: string;
  origin: string;
  principal: string;
  endpoint: string;
  status: StoryIntentStatus;
  payload: StoryIntentPayload;
  storyId?: string;
}

export interface StoryIntentSnapshot {
  record: StoryIntentRecord | null;
  failed: boolean;
}

export interface StoryIntentOutcome extends StoryIntentSnapshot {
  kind: "confirmed" | "unconfirmed" | "blocked";
  error?: unknown;
}

const MAX_RECORD_BYTES = 150_000;
const MAX_PAYLOAD_BYTES = 130_000;
const MAX_TEXT_LENGTH = 10_000;
const CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function canonicalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function sameOriginUrl(value: unknown, origin: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function localPrincipal(value: unknown, origin: string): value is string {
  return (
    sameOriginUrl(value, origin) &&
    /^\/ap\/users\/[A-Za-z0-9._~-]+$/.test(new URL(value).pathname)
  );
}

function localStoryId(value: unknown, origin: string): value is string {
  return (
    sameOriginUrl(value, origin) &&
    /^\/ap\/objects\/[A-Za-z0-9._~-]+$/.test(new URL(value).pathname)
  );
}

function localCommunity(value: unknown, origin: string): value is string {
  return (
    sameOriginUrl(value, origin) &&
    /^\/ap\/(?:groups|communities)\/[A-Za-z0-9._~-]+$/.test(
      new URL(value).pathname,
    )
  );
}

function mediaPath(key: string): string {
  return `/media/${key.startsWith("uploads/") ? key.slice(8) : key}`;
}

function validOverlay(value: unknown): value is StoryOverlay {
  if (!value || typeof value !== "object") return false;
  const overlay = value as Partial<StoryOverlay>;
  if (
    !hasOnlyKeys(value, ["type", "position", "name", "oneOf", "href"]) ||
    !["Question", "Note", "Link"].includes(overlay.type ?? "") ||
    !overlay.position ||
    typeof overlay.position !== "object" ||
    !hasOnlyKeys(overlay.position, ["x", "y", "width", "height"])
  )
    return false;
  const position = overlay.position;
  return (
    [position.x, position.y, position.width, position.height].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
    ) &&
    (overlay.name === undefined ||
      (typeof overlay.name === "string" &&
        overlay.name.length <= MAX_TEXT_LENGTH)) &&
    (overlay.href === undefined ||
      (typeof overlay.href === "string" && overlay.href.length <= 2048)) &&
    (overlay.oneOf === undefined ||
      (Array.isArray(overlay.oneOf) &&
        overlay.oneOf.length <= 4 &&
        overlay.oneOf.every(
          (item) =>
            item &&
            typeof item === "object" &&
            hasOnlyKeys(item, ["type", "name"]) &&
            item.type === "Note" &&
            typeof item.name === "string" &&
            item.name.length <= MAX_TEXT_LENGTH,
        )))
  );
}

function validPayload(
  value: unknown,
  origin: string,
): value is StoryIntentPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<StoryIntentPayload>;
  const attachment = payload.attachment;
  if (
    !hasOnlyKeys(value, [
      "attachment",
      "displayDuration",
      "caption",
      "overlays",
      "community_ap_id",
    ]) ||
    !attachment ||
    typeof attachment !== "object" ||
    !hasOnlyKeys(attachment, ["url", "r2_key", "content_type"])
  )
    return false;
  const key = attachment.r2_key;
  if (
    typeof key !== "string" ||
    !/^(?:uploads\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(key) ||
    typeof attachment.content_type !== "string" ||
    !CONTENT_TYPES.has(attachment.content_type) ||
    (attachment.url !== undefined &&
      attachment.url !== mediaPath(key) &&
      attachment.url !== `${origin}${mediaPath(key)}`) ||
    typeof payload.displayDuration !== "string" ||
    !/^PT(?:\d+(?:\.\d+)?S)$/.test(payload.displayDuration) ||
    payload.displayDuration.length > 32 ||
    (payload.caption !== undefined &&
      (typeof payload.caption !== "string" ||
        payload.caption.length > MAX_TEXT_LENGTH)) ||
    (payload.community_ap_id !== undefined &&
      !localCommunity(payload.community_ap_id, origin)) ||
    (payload.overlays !== undefined &&
      (!Array.isArray(payload.overlays) ||
        payload.overlays.length > 20 ||
        !payload.overlays.every(validOverlay)))
  )
    return false;
  return true;
}

function validEndpoint(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value &&
      url.pathname === "/api/stories"
    );
  } catch {
    return false;
  }
}

function validRecord(
  value: unknown,
  scope: Required<StoryIntentScope>,
): value is StoryIntentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoryIntentRecord>;
  return (
    hasOnlyKeys(value, [
      "version",
      "intentId",
      "origin",
      "principal",
      "endpoint",
      "status",
      "payload",
      "storyId",
    ]) &&
    record.version === 1 &&
    typeof record.intentId === "string" &&
    /^[0-9a-f-]{36}$/.test(record.intentId) &&
    record.origin === scope.origin &&
    record.principal === scope.principal &&
    record.endpoint === scope.endpoint &&
    ["ready", "pending", "unconfirmed", "confirmed"].includes(
      record.status ?? "",
    ) &&
    validPayload(record.payload, scope.origin) &&
    (record.status === "confirmed"
      ? localStoryId(record.storyId, scope.origin)
      : record.storyId === undefined)
  );
}

function canonicalTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

/** Validate the SDK Story object against the exact local intent. */
export function acknowledgesStory(
  response: unknown,
  scope: Required<StoryIntentScope>,
  payload: StoryIntentPayload,
): response is Story {
  if (!response || typeof response !== "object") return false;
  try {
    const story = response as Partial<Story>;
    const published = canonicalTime(story.published);
    const endTime = canonicalTime(story.end_time);
    const attachment = story.attachment;
    const expectedUrl = mediaPath(payload.attachment.r2_key);
    return (
      localStoryId(story.ap_id, scope.origin) &&
      story.author?.ap_id === scope.principal &&
      !!attachment &&
      attachment.r2_key === payload.attachment.r2_key &&
      attachment.url === expectedUrl &&
      attachment.mediaType === payload.attachment.content_type &&
      attachment.type ===
        (payload.attachment.content_type.startsWith("video/")
          ? "Video"
          : "Document") &&
      (story.caption?.trim() || undefined) ===
        (payload.caption?.trim() || undefined) &&
      story.displayDuration === payload.displayDuration &&
      canonical(story.overlays ?? []) === canonical(payload.overlays ?? []) &&
      published !== null &&
      endTime !== null &&
      endTime > published
    );
  } catch {
    return false;
  }
}

export function createStoryIntentCoordinator(
  scope: StoryIntentScope,
  storage?: StoryIntentStorage,
) {
  if (
    !canonicalOrigin(scope.origin) ||
    !localPrincipal(scope.principal, scope.origin)
  ) {
    throw new Error(
      "Story intent requires a canonical origin and local principal",
    );
  }
  const endpoint = scope.endpoint ?? `${scope.origin}/api/stories`;
  if (!validEndpoint(endpoint, scope.origin)) {
    throw new Error("Story intent requires a canonical same-origin endpoint");
  }
  const resolvedScope: Required<StoryIntentScope> = { ...scope, endpoint };
  const key = `yurumeet:story-intent:v1:${encodeURIComponent(scope.origin)}:${encodeURIComponent(scope.principal)}:${encodeURIComponent(endpoint)}`;
  let backing = storage;
  let failed = false;
  if (!backing) {
    try {
      backing = globalThis.sessionStorage;
    } catch {
      failed = true;
    }
  }
  if (!backing) failed = true;

  let record: StoryIntentRecord | null = null;
  let raw: string | null = null;
  let corrupted = false;
  let conflict = false;
  let stageRecoverable = false;
  let busy = false;

  const snapshot = (): StoryIntentSnapshot => ({
    record: record ? structuredClone(record) : null,
    failed,
  });
  const current = (): string | null | undefined => {
    try {
      return backing?.getItem(key);
    } catch {
      failed = true;
      return undefined;
    }
  };
  const unchanged = (): boolean => {
    const currentRaw = current();
    if (currentRaw === undefined || currentRaw !== raw) {
      failed = true;
      if (currentRaw !== undefined && currentRaw !== raw) conflict = true;
      return false;
    }
    return true;
  };
  const save = (next: StoryIntentRecord): boolean => {
    if (failed || !backing || !unchanged()) return false;
    const nextRaw = JSON.stringify(next);
    if (nextRaw.length > MAX_RECORD_BYTES) {
      failed = true;
      return false;
    }
    try {
      backing.setItem(key, nextRaw);
    } catch {
      failed = true;
      return false;
    }
    if (current() !== nextRaw) {
      failed = true;
      return false;
    }
    raw = nextRaw;
    record = structuredClone(next);
    return true;
  };
  const remove = (): boolean => {
    if (failed || !backing || !unchanged()) return false;
    try {
      backing.removeItem(key);
    } catch {
      failed = true;
      return false;
    }
    if (current() !== null) {
      failed = true;
      return false;
    }
    raw = null;
    record = null;
    return true;
  };

  const initial = current();
  if (initial === undefined) failed = true;
  else if (initial !== null) {
    raw = initial;
    try {
      if (initial.length > MAX_RECORD_BYTES)
        throw new Error("Record too large");
      const parsed: unknown = JSON.parse(initial);
      if (!validRecord(parsed, resolvedScope))
        throw new Error("Invalid record");
      record =
        parsed.status === "pending"
          ? { ...parsed, status: "unconfirmed" }
          : parsed;
    } catch {
      failed = true;
      corrupted = true;
    }
  }

  const read = (): StoryIntentSnapshot => {
    if (!failed) unchanged();
    return snapshot();
  };

  const stage = (payload: StoryIntentPayload): StoryIntentSnapshot => {
    if (busy) return snapshot();
    let captured: StoryIntentPayload;
    try {
      captured = JSON.parse(JSON.stringify(payload)) as StoryIntentPayload;
      if (
        !validPayload(captured, scope.origin) ||
        JSON.stringify(captured).length > MAX_PAYLOAD_BYTES
      )
        throw new Error("Invalid Story payload");
    } catch {
      return snapshot();
    }
    if (record) {
      if (
        record.status !== "ready" ||
        canonical(record.payload) !== canonical(captured)
      )
        return snapshot();
      if (!failed) {
        if (!unchanged()) {
          if (!conflict && !corrupted) stageRecoverable = true;
        }
        return snapshot();
      }
      if (conflict || !stageRecoverable) return snapshot();
      const saved = current();
      const intended = JSON.stringify(record);
      if (saved === intended) {
        raw = saved;
        failed = false;
        stageRecoverable = false;
        return snapshot();
      }
      if (saved === undefined || saved !== raw) {
        if (saved !== undefined) conflict = true;
        failed = true;
        return snapshot();
      }
      failed = false;
      if (!save(record)) stageRecoverable = !conflict;
      else stageRecoverable = false;
      return snapshot();
    }
    const next: StoryIntentRecord = {
      version: 1,
      intentId: crypto.randomUUID(),
      origin: scope.origin,
      principal: scope.principal,
      endpoint,
      status: "ready",
      payload: captured,
    };
    if (failed || corrupted || conflict) {
      // Keep uploaded references in this tab when storage is inaccessible, but
      // never POST until a later explicit stage proves the slot is still empty
      // or already contains these exact intended bytes.
      if (!corrupted && !conflict && raw === null) {
        record = next;
        stageRecoverable = true;
      }
      return snapshot();
    }
    if (!unchanged()) {
      if (!corrupted && !conflict && raw === null) {
        record = next;
        stageRecoverable = true;
      }
      return snapshot();
    }
    if (!save(next)) {
      record = next;
      stageRecoverable = !conflict;
    }
    return snapshot();
  };

  const blocked = (): StoryIntentOutcome => ({
    ...snapshot(),
    kind: "blocked",
  });
  const attempt = async (
    create: (payload: StoryIntentPayload) => Promise<unknown>,
    explicitRetry: boolean,
  ): Promise<StoryIntentOutcome> => {
    if (busy || failed || !record || !unchanged()) return blocked();
    if (
      explicitRetry
        ? record.status !== "unconfirmed"
        : record.status !== "ready"
    )
      return blocked();

    busy = true;
    const pending: StoryIntentRecord = { ...record, status: "pending" };
    try {
      if (!save(pending)) {
        record = { ...pending, status: "unconfirmed" };
        return blocked();
      }
      let response: unknown;
      try {
        response = await create(structuredClone(pending.payload));
      } catch (error) {
        const unconfirmed: StoryIntentRecord = {
          ...pending,
          status: "unconfirmed",
        };
        if (!save(unconfirmed)) record = unconfirmed;
        return { ...snapshot(), kind: "unconfirmed", error };
      }

      if (!acknowledgesStory(response, resolvedScope, pending.payload)) {
        const unconfirmed: StoryIntentRecord = {
          ...pending,
          status: "unconfirmed",
        };
        if (!save(unconfirmed)) record = unconfirmed;
        return { ...snapshot(), kind: "unconfirmed" };
      }

      const confirmed: StoryIntentRecord = {
        ...pending,
        status: "confirmed",
        storyId: response.ap_id,
      };
      if (!save(confirmed)) {
        // The received strict ACK is conclusive for this coordinator instance.
        record = confirmed;
        return {
          ...snapshot(),
          kind: "confirmed",
          record: structuredClone(confirmed),
        };
      }
      remove();
      return {
        ...snapshot(),
        kind: "confirmed",
        record: structuredClone(confirmed),
      };
    } finally {
      busy = false;
    }
  };

  const dismiss = (): StoryIntentSnapshot => {
    if (!busy && record && record.status !== "confirmed") remove();
    return snapshot();
  };
  const clearConfirmed = (): StoryIntentSnapshot => {
    if (!busy && record?.status === "confirmed") remove();
    return snapshot();
  };

  return {
    key,
    read,
    stage,
    submit: (create: (payload: StoryIntentPayload) => Promise<unknown>) =>
      attempt(create, false),
    retry: (create: (payload: StoryIntentPayload) => Promise<unknown>) =>
      attempt(create, true),
    dismiss,
    clearConfirmed,
  };
}
