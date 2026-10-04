import { afterEach, describe, expect, test } from "bun:test";
import {
  ApiError,
  clearYurucommuApiTransport,
  getYurucommuApiTransport,
  sendUserDMMessage,
  setYurucommuApiTransport,
  type DMMessage,
  type Actor,
  type MediaAttachment,
} from "@takosjp/yurucommu-api";
import type {
  JournalScope,
  JournalStorage,
  JournalTarget,
  OutgoingJournalRecord,
} from "./outgoing-journal.ts";
import { createOutgoingJournal } from "./outgoing-journal.ts";
import { createOutgoingRecovery } from "./outgoing-recovery.ts";
import { createAuthSessionController } from "./auth-session.ts";
import {
  classifyMessageDeliveryFailure,
  isExpiredMessageMedia,
} from "./message-delivery.ts";
import { uploadProductMedia } from "./media-upload.ts";
import {
  captureTalkMediaGuard,
  talkMediaExpired,
  type TalkMediaScope,
} from "./talk-media.ts";

const nativeFetch = globalThis.fetch;
const SCOPE: JournalScope = {
  serverOrigin: "https://meet.example",
  principalApId: "https://meet.example/ap/users/alice",
};
const USER: JournalTarget = {
  type: "user",
  ap_id: "https://meet.example/ap/users/bob",
};
const SENDER: DMMessage["sender"] = {
  ap_id: SCOPE.principalApId,
  username: "alice@meet.example",
  preferred_username: "alice",
  name: "Alice",
  icon_url: null,
};
const ATTACHMENT: MediaAttachment = {
  url: "/media/photo.png",
  r2_key: "uploads/photo.png",
  content_type: "image/png",
  name: "photo.png",
};
const ID = "temp-123e4567-e89b-42d3-a456-426614174000";
const FRESH_ID = "temp-123e4567-e89b-42d3-a456-426614174001";

function memoryStorage(): JournalStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function record(
  overrides: Partial<OutgoingJournalRecord> = {},
): OutgoingJournalRecord {
  return {
    version: 1,
    id: ID,
    target: USER,
    content: "送信する本文",
    attachments: [{ ...ATTACHMENT }],
    created_at: "2026-10-04T10:00:00.000Z",
    state: "pending",
    ...overrides,
  };
}

function authActor(name = "Alice"): Actor {
  return {
    ap_id: "https://meet.example/ap/users/alice",
    username: "alice",
    preferred_username: "alice",
    name,
    summary: null,
    icon_url: null,
    header_url: null,
    follower_count: 0,
    following_count: 0,
    post_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function expiredDeadline(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function mockFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): typeof fetch {
  const fetcher = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => handler(input, init);
  return Object.assign(fetcher, { preconnect: nativeFetch.preconnect });
}

function configureTestTransport(
  resolveUrl: (path: string) => string = (path) =>
    `https://meet.example${path}`,
) {
  const transport = {
    resolveUrl,
    getAuthHeaders: () => ({}),
    credentials: "omit" as RequestCredentials,
  };
  setYurucommuApiTransport(transport);
  return transport;
}

function keyFor(target = USER, id = ID) {
  return `yurume:outgoing:v1:${encodeURIComponent(SCOPE.serverOrigin)}:${encodeURIComponent(SCOPE.principalApId)}:${target.type}:${encodeURIComponent(target.ap_id)}:${id}`;
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  clearYurucommuApiTransport();
});

describe("talk media expiry recovery", () => {
  test("keeps an expired old intent immutable when a fresh intent is queued", () => {
    const recovery = createOutgoingRecovery(SCOPE, memoryStorage());
    const old = record();
    expect(recovery.queue(old)).toBe(true);
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);
    const draft = recovery.expiredDraft(USER, ID)!;

    const fresh = record({
      id: FRESH_ID,
      content: "新しい本文",
      attachments: [],
    });
    expect(recovery.queue(fresh)).toBe(true);
    old.content = "caller mutation";
    old.attachments![0]!.name = "caller mutation.png";
    draft.record.content = "draft mutation";

    expect(recovery.expiredDraft(USER, ID)?.record).toMatchObject({
      id: ID,
      content: "送信する本文",
      attachments: [{ ...ATTACHMENT, name: "photo.png" }],
      state: "rejected",
      failureCode: "MEDIA_EXPIRED",
    });
    expect(draft.isCurrent()).toBe(true);
    expect(
      recovery.merge(USER, [], SENDER).find((row) => row.id === ID),
    ).toMatchObject({
      id: ID,
      mediaExpired: true,
    });
    expect(recovery.retry(USER, ID)).toBeNull();
  });

  test("keeps source Files in memory across fail and retry, but never restores them from storage", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    const source = new File(["original bytes"], "旅行.png", {
      type: "image/png",
    });
    expect(recovery.queue(record(), [source])).toBe(true);
    expect(recovery.fail(ID, "rejected")).toBe(true);
    expect(recovery.retry(USER, ID)).toMatchObject({ state: "pending" });
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);
    expect(recovery.expiredDraft(USER, ID)?.sourceFiles).toEqual([source]);

    const restored = createOutgoingRecovery(SCOPE, storage);
    expect(restored.expiredDraft(USER, ID)).toMatchObject({
      record: { state: "rejected", failureCode: "MEDIA_EXPIRED" },
    });
    expect(restored.expiredDraft(USER, ID)?.sourceFiles).toBeUndefined();
    expect(
      [...storage.values.values()].some((value) =>
        value.includes("original bytes"),
      ),
    ).toBe(false);
  });

  test("persists only the exact expiry discriminator and exposes it on the merged row", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    expect(recovery.queue(record())).toBe(true);
    const legacy = record({ id: FRESH_ID, content: "older journal record" });
    expect(recovery.queue(legacy)).toBe(true);
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);

    const restored = createOutgoingRecovery(SCOPE, storage);
    expect(
      restored.merge(USER, [], SENDER).find((row) => row.id === ID),
    ).toMatchObject({
      id: ID,
      failed: true,
      deliveryFailure: "rejected",
      mediaExpired: true,
    });
    expect(restored.retry(USER, ID)).toBeNull();
    expect(restored.expiredDraft(USER, FRESH_ID)).toBeNull();
    const legacyRow = restored
      .merge(USER, [], SENDER)
      .find((row) => row.id === FRESH_ID);
    expect(legacyRow).toMatchObject({
      content: "older journal record",
    });
    expect(legacyRow?.mediaExpired).toBeUndefined();
  });

  test("rejects malformed failureCode records without deleting their bytes", () => {
    const storage = memoryStorage();
    const malformed = [
      record({ failureCode: "OTHER" as never }),
      record({ state: "unconfirmed", failureCode: "MEDIA_EXPIRED" }),
      record({ attachments: [], failureCode: "MEDIA_EXPIRED" }),
    ];
    const raw = malformed.map((saved, index) => {
      const id = `temp-123e4567-e89b-42d3-a456-42661417400${index + 2}`;
      const value = JSON.stringify({
        scope: SCOPE,
        record: { ...saved, id },
      });
      storage.setItem(keyFor(USER, id), value);
      return value;
    });

    const restored = createOutgoingRecovery(SCOPE, storage);
    expect(restored.restorationFailed).toBe(true);
    expect(restored.expiredDraft(USER, ID)).toBeNull();
    expect([...storage.values.values()]).toEqual(raw);
  });

  test("rejects invalid unconfirmed-attempt markers", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    const malformed = [
      record({ hadUnconfirmedAttempt: false as never }),
      record({ hadUnconfirmedAttempt: "yes" as never }),
      record({ state: "rejected", hadUnconfirmedAttempt: true }),
    ];

    for (const intent of malformed) expect(recovery.queue(intent)).toBe(false);
    expect(storage.length).toBe(0);
  });

  test("rejects sparse, invalid, and misaligned media deadline arrays", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    const sparse = new Array<string | null>(1);
    const malformed = [
      record({ mediaDeadlines: sparse }),
      record({ mediaDeadlines: ["not-a-date"] }),
      record({ mediaDeadlines: [null, null] }),
    ];

    for (const intent of malformed) expect(recovery.queue(intent)).toBe(false);
    expect(storage.length).toBe(0);
  });

  test("keeps expired deadline rows unconfirmed without an expiry affordance or draft", () => {
    const recovery = createOutgoingRecovery(SCOPE, memoryStorage());
    const deadline = expiredDeadline();
    const pending = record({ mediaDeadlines: [deadline] });
    expect(recovery.queue(pending)).toBe(true);
    expect(recovery.fail(ID, "unconfirmed")).toBe(true);

    expect(recovery.retry(USER, ID)).toBeNull();
    const row = recovery.merge(USER, [], SENDER).find((item) => item.id === ID);
    expect(row).toMatchObject({
      failed: true,
      deliveryFailure: "unconfirmed",
      mediaDeadlines: [deadline],
    });
    expect(row?.mediaExpired).toBeUndefined();
    expect(recovery.expiredDraft(USER, ID)).toBeNull();
  });

  test("keeps an expiry response unconfirmed after a previous retry had an unknown outcome", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    expect(recovery.queue(record())).toBe(true);
    expect(recovery.fail(ID, "unconfirmed")).toBe(true);
    expect(recovery.retry(USER, ID)).toMatchObject({
      state: "pending",
      hadUnconfirmedAttempt: true,
    });
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);

    const row = recovery
      .merge(USER, [], SENDER)
      .find((candidate) => candidate.id === ID);
    expect(row).toMatchObject({
      failed: true,
      deliveryFailure: "unconfirmed",
    });
    expect(row?.mediaExpired).toBeUndefined();
    expect(recovery.expiredDraft(USER, ID)).toBeNull();
    const restored = createOutgoingRecovery(SCOPE, storage);
    expect(restored.expiredDraft(USER, ID)).toBeNull();
    const restoredRow = restored
      .merge(USER, [], SENDER)
      .find((candidate) => candidate.id === ID);
    expect(restoredRow).toMatchObject({
      deliveryFailure: "unconfirmed",
    });
    expect(restoredRow?.mediaExpired).toBeUndefined();
  });

  test("offers an explicitly rejected expired deadline as a fresh-media draft", () => {
    const recovery = createOutgoingRecovery(SCOPE, memoryStorage());
    const deadline = expiredDeadline();
    const pending = record({ mediaDeadlines: [deadline] });
    expect(recovery.queue(pending)).toBe(true);
    expect(recovery.fail(ID, "rejected")).toBe(true);

    expect(
      recovery.merge(USER, [], SENDER).find((row) => row.id === ID),
    ).toMatchObject({
      failed: true,
      deliveryFailure: "rejected",
      mediaExpired: true,
    });
    expect(recovery.expiredDraft(USER, ID)?.record.mediaDeadlines).toEqual([
      deadline,
    ]);
    expect(recovery.retry(USER, ID)).toBeNull();
    expect(
      recovery.merge(USER, [], SENDER).find((row) => row.id === ID),
    ).toMatchObject({
      deliveryFailure: "rejected",
      mediaExpired: true,
    });
  });

  test("does not remove an original journal entry through a changed deadline snapshot", () => {
    const storage = memoryStorage();
    const journal = createOutgoingJournal(SCOPE, storage);
    const original = record({ mediaDeadlines: ["2026-10-05T10:00:00.000Z"] });
    expect(journal.write(original)).toBe(true);
    const key = [...storage.values.keys()][0]!;
    const raw = storage.getItem(key);
    const changed = {
      ...original,
      mediaDeadlines: ["2026-10-06T10:00:00.000Z"],
    };

    expect(journal.remove(changed)).toBe(false);
    expect(storage.getItem(key)).toBe(raw);
    expect(journal.remove(original)).toBe(true);
  });

  test("releases in-memory Files without changing the journal row or its capture revision", () => {
    const storage = memoryStorage();
    const recovery = createOutgoingRecovery(SCOPE, storage);
    const source = new File(["original bytes"], "photo.png", {
      type: "image/png",
    });
    expect(recovery.queue(record(), [source])).toBe(true);
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);
    const captured = recovery.expiredDraft(USER, ID)!;
    expect(captured.sourceFiles).toEqual([source]);

    recovery.releaseSourceFiles();
    expect(captured.isCurrent()).toBe(true);
    expect(recovery.expiredDraft(USER, ID)?.sourceFiles).toBeUndefined();
    expect(
      [...storage.values.values()].some((value) =>
        value.includes("original bytes"),
      ),
    ).toBe(false);
    expect(
      createOutgoingRecovery(SCOPE, storage).expiredDraft(USER, ID)?.record,
    ).toMatchObject({
      state: "rejected",
      failureCode: "MEDIA_EXPIRED",
    });
  });
});

describe("talk media failure classification", () => {
  test("shows expiry affordance only for the actual SDK 409 MEDIA_EXPIRED error", () => {
    const exact = new ApiError(409, "expired", { code: "MEDIA_EXPIRED" });
    expect(isExpiredMessageMedia(exact)).toBe(true);
    expect(classifyMessageDeliveryFailure(exact)).toBe("rejected");

    const others: unknown[] = [
      new TypeError("network unavailable"),
      new ApiError(408, "timeout", { code: "MEDIA_EXPIRED" }),
      new ApiError(500, "server error", { code: "MEDIA_EXPIRED" }),
      new ApiError(409, "conflict", { code: "OTHER" }),
      { name: "ApiError", status: 409, code: "MEDIA_EXPIRED" },
      { status: 409, code: "MEDIA_EXPIRED" },
    ];
    const expectedFailures = [
      "unconfirmed",
      "unconfirmed",
      "unconfirmed",
      "rejected",
      "unconfirmed",
      "unconfirmed",
    ] as const;
    others.forEach((error, index) => {
      expect(isExpiredMessageMedia(error)).toBe(false);
      expect(classifyMessageDeliveryFailure(error)).toBe(
        expectedFailures[index],
      );
    });
  });

  test("recognizes the MEDIA_EXPIRED code parsed from an actual published SDK response", async () => {
    configureTestTransport();
    globalThis.fetch = mockFetch(async () =>
      Response.json(
        { error: "expired", code: "MEDIA_EXPIRED" },
        { status: 409 },
      ),
    );

    let error: unknown;
    try {
      await sendUserDMMessage(USER.ap_id, "hello", [ATTACHMENT]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect(isExpiredMessageMedia(error)).toBe(true);
  });

  test("auth epoch stays stable for a same-principal profile refresh and advances on scope change", async () => {
    let reads = 0;
    const session = createAuthSessionController(
      {
        async readCurrentActor() {
          reads += 1;
          return reads === 1 ? authActor() : authActor("Updated profile");
        },
        async postLogout() {
          return new Response(null, { status: 503 });
        },
        async clearPush() {},
        suppressOidc() {},
      },
      {
        origin: SCOPE.serverOrigin,
        actor: authActor(),
        logoutErrorText: "logout failed",
        observationErrorText: "auth unavailable",
      },
    );

    await session.logout();
    const afterLogout = session.epoch();
    await session.refresh();
    expect(session.read().actor?.name).toBe("Updated profile");
    expect(session.epoch()).toBe(afterLogout);

    session.configure(SCOPE.serverOrigin, authActor());
    expect(session.epoch()).toBeGreaterThan(afterLogout);
  });
});

describe("talk media scope guard", () => {
  test("invalidates a capture after its own row is discarded but permits an unrelated new row", () => {
    configureTestTransport();
    const recovery = createOutgoingRecovery(SCOPE, memoryStorage());
    const other = record({
      id: FRESH_ID,
      state: "rejected",
      target: {
        type: "user",
        ap_id: "https://meet.example/ap/users/carol",
      },
    });
    expect(recovery.queue(record())).toBe(true);
    expect(recovery.fail(ID, "rejected", "MEDIA_EXPIRED")).toBe(true);
    expect(recovery.queue({ ...other, state: "pending" })).toBe(true);
    expect(recovery.fail(FRESH_ID, "rejected", "MEDIA_EXPIRED")).toBe(true);
    const currentEntry = recovery.expiredDraft(USER, ID);
    const otherEntry = recovery.expiredDraft(other.target, FRESH_ID);
    const makeGuard = (target: JournalTarget, isCurrent: () => boolean) =>
      captureTalkMediaGuard(
        () => ({
          origin: SCOPE.serverOrigin,
          principal: SCOPE.principalApId,
          authEpoch: 1,
          target,
        }),
        isCurrent,
      );
    const firstGuard = makeGuard(
      USER,
      () => currentEntry?.isCurrent() ?? false,
    );
    const unrelatedGuard = makeGuard(
      other.target,
      () => otherEntry?.isCurrent() ?? false,
    );
    expect(firstGuard()).toBe(true);
    expect(unrelatedGuard()).toBe(true);
    expect(recovery.discard(USER, ID)).toBe(true);
    expect(firstGuard()).toBe(false);
    expect(unrelatedGuard()).toBe(true);
  });

  test("invalidates captures when auth epoch, origin, principal, target, or view changes", () => {
    const cases: Array<
      [string, (scope: TalkMediaScope) => TalkMediaScope, () => boolean]
    > = [
      [
        "auth epoch",
        (scope) => ({ ...scope, authEpoch: scope.authEpoch + 1 }),
        () => true,
      ],
      [
        "origin",
        (scope) => ({ ...scope, origin: "https://other.example" }),
        () => true,
      ],
      [
        "principal",
        (scope) => ({
          ...scope,
          principal: "https://meet.example/ap/users/carol",
        }),
        () => true,
      ],
      [
        "target",
        (scope) => ({
          ...scope,
          target: {
            ...scope.target,
            ap_id: "https://meet.example/ap/users/carol",
          },
        }),
        () => true,
      ],
    ];
    for (const [label, mutate, viewCurrent] of cases) {
      const initial: TalkMediaScope = {
        origin: SCOPE.serverOrigin,
        principal: SCOPE.principalApId,
        authEpoch: 4,
        target: USER,
      };
      let current = initial;
      const guard = captureTalkMediaGuard(() => current, viewCurrent);
      current = mutate(current);
      expect(guard(), label).toBe(false);
    }
  });

  test("invalidates a capture when its view lifetime ends", () => {
    configureTestTransport();
    const scope: TalkMediaScope = {
      origin: SCOPE.serverOrigin,
      principal: SCOPE.principalApId,
      authEpoch: 1,
      target: USER,
    };
    let viewCurrent = true;
    const guard = captureTalkMediaGuard(
      () => scope,
      () => viewCurrent,
    );
    expect(guard()).toBe(true);
    viewCurrent = false;
    expect(guard()).toBe(false);
  });

  test("invalidates captures when transport identity or either resolved URL changes", () => {
    let uploadHost = "https://meet.example";
    let sendHost = "https://meet.example";
    const mutableTransport = configureTestTransport(
      (path) =>
        `${path === "/api/media/upload" ? uploadHost : sendHost}${path}`,
    );
    const scope: TalkMediaScope = {
      origin: SCOPE.serverOrigin,
      principal: SCOPE.principalApId,
      authEpoch: 1,
      target: USER,
    };
    const transportCapture = captureTalkMediaGuard(
      () => scope,
      () => true,
    );
    setYurucommuApiTransport({ ...mutableTransport });
    expect(transportCapture()).toBe(false);

    for (const changedPath of [
      "/api/media/upload",
      "/api/dm/user/https%3A%2F%2Fmeet.example%2Fap%2Fusers%2Fbob/messages",
    ]) {
      uploadHost = "https://meet.example";
      sendHost = "https://meet.example";
      const base = configureTestTransport(
        (path) =>
          `${path === "/api/media/upload" ? uploadHost : sendHost}${path}`,
      );
      const guard = captureTalkMediaGuard(
        () => scope,
        () => true,
      );
      if (changedPath === "/api/media/upload")
        uploadHost = "https://other.example";
      else sendHost = "https://other.example";
      expect(getYurucommuApiTransport()).toBe(base);
      expect(guard(), changedPath).toBe(false);
    }
  });

  test("checks the capture after awaiting source bytes and before the SDK sends", async () => {
    configureTestTransport();
    let fetchCalls = 0;
    globalThis.fetch = mockFetch(async () => {
      fetchCalls += 1;
      return Response.json({
        url: "/media/uploaded.png",
        r2_key: "uploaded",
        content_type: "image/png",
      });
    });
    const scope: TalkMediaScope = {
      origin: SCOPE.serverOrigin,
      principal: SCOPE.principalApId,
      authEpoch: 1,
      target: USER,
    };
    let current = scope;
    const guard = captureTalkMediaGuard(
      () => current,
      () => true,
    );
    const source = new File(["image bytes"], "photo.png", {
      type: "image/png",
    });
    let resolveBytes!: (bytes: ArrayBuffer) => void;
    Object.defineProperty(source, "arrayBuffer", {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          resolveBytes = resolve;
        }),
    });
    const uploading = uploadProductMedia(source, () => {
      if (!guard()) throw new Error("talk media scope changed");
    });
    current = { ...scope, authEpoch: 2 };
    resolveBytes(new Uint8Array([1, 2, 3]).buffer);
    await expect(uploading).rejects.toThrow("talk media scope changed");
    expect(fetchCalls).toBe(0);
  });
});

describe("advertised media expiry", () => {
  test("requires a valid advertised deadline and compares it to the supplied clock", () => {
    const now = Date.parse("2026-10-04T10:00:00.000Z");
    expect(talkMediaExpired(undefined, now)).toBe(false);
    expect(talkMediaExpired("not-a-date", now)).toBe(false);
    expect(talkMediaExpired("2026-10-04T09:59:59.000Z", now)).toBe(true);
    expect(talkMediaExpired("2026-10-04T10:00:01.000Z", now)).toBe(false);
  });

  test("sanitizes missing and invalid expiry fields from SDK uploads and preserves valid deadlines", async () => {
    configureTestTransport();
    const responses = [
      { url: "/media/a.png", r2_key: "a", content_type: "image/png" },
      {
        url: "/media/b.png",
        r2_key: "b",
        content_type: "image/png",
        expires_at: "invalid",
      },
      {
        url: "/media/c.png",
        r2_key: "c",
        content_type: "image/png",
        expires_at: "2026-10-05T10:00:00.000Z",
      },
    ];
    globalThis.fetch = mockFetch(async () => Response.json(responses.shift()));
    const source = new File(["bytes"], "photo.png", { type: "image/png" });

    await expect(uploadProductMedia(source)).resolves.toMatchObject({
      expires_at: undefined,
    });
    await expect(uploadProductMedia(source)).resolves.toMatchObject({
      expires_at: undefined,
    });
    await expect(uploadProductMedia(source)).resolves.toMatchObject({
      expires_at: "2026-10-05T10:00:00.000Z",
    });
  });
});
