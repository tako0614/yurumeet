import { expect, test } from "bun:test";
import type { Story } from "@takosjp/yurucommu-api";
import {
  createStoryIntentCoordinator,
  type StoryCreatePayload,
  type StoryIntentScope,
  type StoryIntentStorage,
} from "./story-intent.ts";

const scope: StoryIntentScope = {
  origin: "https://meet.example",
  principal: "https://meet.example/ap/users/alice",
};

const payload: StoryCreatePayload = {
  attachment: {
    url: "/media/intent.webp",
    r2_key: "uploads/intent.webp",
    content_type: "image/webp",
  },
  caption: "A saved caption",
  displayDuration: "PT5S",
  overlays: [
    {
      type: "Note",
      name: "Overlay",
      position: { x: 0.5, y: 0.5, width: 0.4, height: 0.2 },
    },
  ],
};

class MemoryStorage implements StoryIntentStorage {
  readonly values = new Map<string, string>();
  denyRead = false;
  denyWrite = false;
  denyRemove = false;
  corruptWrite = false;
  ignoreRemove = false;

  getItem(key: string): string | null {
    if (this.denyRead) throw new Error("storage read denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.denyWrite) throw new Error("storage write denied");
    this.values.set(key, this.corruptWrite ? `${value.slice(0, -1)}!` : value);
  }

  removeItem(key: string): void {
    if (this.denyRemove) throw new Error("storage remove denied");
    if (!this.ignoreRemove) this.values.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function validAck(
  ofScope: StoryIntentScope = scope,
  ofPayload: StoryCreatePayload = payload,
): Story {
  const published = "2026-10-02T00:00:00.000Z";
  const mediaUrl = ofPayload.attachment.url ?? "/media/intent.webp";
  return {
    ap_id: `${ofScope.origin}/ap/objects/story-1`,
    author: {
      ap_id: ofScope.principal,
      username: "alice@meet.example",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    attachment: {
      type: ofPayload.attachment.content_type.startsWith("video/")
        ? "Video"
        : "Document",
      mediaType: ofPayload.attachment.content_type,
      url: mediaUrl,
      r2_key: ofPayload.attachment.r2_key,
    },
    caption: ofPayload.caption?.trim() || undefined,
    displayDuration: ofPayload.displayDuration,
    overlays: structuredClone(ofPayload.overlays ?? []),
    published,
    end_time: new Date(
      Date.parse(published) + 24 * 60 * 60 * 1000,
    ).toISOString(),
    viewed: false,
  };
}

test("pending intent reloads as unconfirmed and does not send automatically", async () => {
  const storage = new MemoryStorage();
  const original = createStoryIntentCoordinator(scope, storage);
  original.stage(payload);
  const createStarted = deferred<void>();
  const createResult = deferred<unknown>();
  let calls = 0;
  const inFlight = original.submit(() => {
    calls += 1;
    createStarted.resolve();
    return createResult.promise;
  });
  await createStarted.promise;

  const reloaded = createStoryIntentCoordinator(scope, storage);
  expect(reloaded.read().record?.status).toBe("unconfirmed");
  expect(calls).toBe(1);
  createResult.reject(new Error("ACK lost"));
  expect((await inFlight).kind).toBe("unconfirmed");
  expect(
    createStoryIntentCoordinator(scope, storage).read().record?.status,
  ).toBe("unconfirmed");
});

test("origin, principal, and exact Story endpoint isolate records", async () => {
  const storage = new MemoryStorage();
  const primary = createStoryIntentCoordinator(scope, storage);
  const otherPrincipal = createStoryIntentCoordinator(
    { ...scope, principal: "https://meet.example/ap/users/bob" },
    storage,
  );
  const sameEndpointExplicit = createStoryIntentCoordinator(
    { ...scope, endpoint: "https://meet.example/api/stories" },
    storage,
  );
  const otherOrigin = createStoryIntentCoordinator(
    {
      origin: "https://other.example",
      principal: "https://other.example/ap/users/alice",
    },
    storage,
  );

  primary.stage(payload);
  expect(otherPrincipal.read().record).toBeNull();
  expect(sameEndpointExplicit.read().record).toBeNull();
  expect(otherOrigin.read().record).toBeNull();
  let sends = 0;
  expect(
    (await sameEndpointExplicit.submit(async () => (sends++, validAck()))).kind,
  ).toBe("blocked");
  expect(sends).toBe(0);
  expect(primary.key).toBe(sameEndpointExplicit.key);
  expect(() =>
    createStoryIntentCoordinator(
      { ...scope, endpoint: "https://meet.example/api/stories/v2" },
      storage,
    ),
  ).toThrow();
  expect(() =>
    createStoryIntentCoordinator(
      { ...scope, endpoint: `${scope.origin}/api/stories?tenant=other` },
      storage,
    ),
  ).toThrow();
});

test("stored records cannot change the exact endpoint represented by their key", () => {
  const storage = new MemoryStorage();
  const original = createStoryIntentCoordinator(scope, storage);
  original.stage(payload);
  const raw = storage.values.get(original.key)!;
  const forged = JSON.parse(raw) as { endpoint: string };
  forged.endpoint = `${scope.origin}/api/other-stories`;
  const foreign = JSON.stringify(forged);
  storage.values.set(original.key, foreign);

  const resumed = createStoryIntentCoordinator(scope, storage);
  expect(resumed.read()).toEqual({ record: null, failed: true });
  expect(resumed.stage(payload).record).toBeNull();
  expect(storage.values.get(original.key)).toBe(foreign);
});

test("a hydrated ready intent keeps the same ID and exact endpoint", () => {
  const storage = new MemoryStorage();
  const first = createStoryIntentCoordinator(scope, storage);
  const staged = first.stage(payload).record!;
  const resumed = createStoryIntentCoordinator(scope, storage);
  expect(resumed.read().record?.status).toBe("ready");
  expect(resumed.stage(payload).record?.intentId).toBe(staged.intentId);
  expect(resumed.read().record?.endpoint).toBe(
    "https://meet.example/api/stories",
  );
});

test("a failed first ready write can be retried only with the same payload", async () => {
  const storage = new MemoryStorage();
  storage.denyWrite = true;
  const intent = createStoryIntentCoordinator(scope, storage);
  const failedStage = intent.stage(payload);
  const retainedId = failedStage.record?.intentId;
  expect(failedStage.failed).toBe(true);

  let sends = 0;
  expect((await intent.submit(async () => (sends++, validAck()))).kind).toBe(
    "blocked",
  );
  storage.denyWrite = false;
  const recovered = intent.stage(payload);
  expect(recovered.failed).toBe(false);
  expect(recovered.record?.intentId).toBe(retainedId);
  expect(
    intent.stage({ ...payload, caption: "different draft" }).record?.payload,
  ).toEqual(payload);
  expect((await intent.submit(async () => (sends++, validAck()))).kind).toBe(
    "confirmed",
  );
  expect(sends).toBe(1);
});

test("a temporary storage getter failure retains uploaded refs for same-payload recovery", () => {
  const storage = new MemoryStorage();
  storage.denyRead = true;
  const intent = createStoryIntentCoordinator(scope, storage);
  const unavailable = intent.stage(payload);
  expect(unavailable.failed).toBe(true);
  expect(unavailable.record?.payload.attachment.r2_key).toBe(
    "uploads/intent.webp",
  );
  expect(storage.values.size).toBe(0);

  storage.denyRead = false;
  const recovered = intent.stage(payload);
  expect(recovered.failed).toBe(false);
  expect(recovered.record?.payload).toEqual(payload);
  expect(
    intent.stage({ ...payload, caption: "different" }).record?.payload,
  ).toEqual(payload);
});

test("unreadable storage blocks POST before the exact pending write can be verified", async () => {
  const storage = new MemoryStorage();
  const intent = createStoryIntentCoordinator(scope, storage);
  intent.stage(payload);
  storage.denyRead = true;
  let sends = 0;
  expect((await intent.submit(async () => (sends++, validAck()))).kind).toBe(
    "blocked",
  );
  expect(sends).toBe(0);
});

test("a ready record must read back byte-for-byte before the first Story POST", async () => {
  const storage = new MemoryStorage();
  storage.corruptWrite = true;
  const intent = createStoryIntentCoordinator(scope, storage);
  const staged = intent.stage(payload);
  expect(staged.failed).toBe(true);
  expect(staged.record?.status).toBe("ready");
  let sends = 0;
  expect((await intent.submit(async () => (sends++, validAck()))).kind).toBe(
    "blocked",
  );
  expect(sends).toBe(0);
  expect(storage.values.get(intent.key)).not.toBe(
    JSON.stringify(staged.record),
  );
});

test("foreign or corrupt bytes are never overwritten or dismissed", () => {
  const storage = new MemoryStorage();
  const seed = createStoryIntentCoordinator(scope, storage);
  storage.values.set(seed.key, "{not-json");
  const intent = createStoryIntentCoordinator(scope, storage);
  expect(intent.read()).toEqual({ record: null, failed: true });
  expect(intent.stage(payload).record).toBeNull();
  expect(intent.dismiss()).toEqual({ record: null, failed: true });
  expect(storage.values.get(seed.key)).toBe("{not-json");
});

test("a storage conflict after staging cannot be replaced or cleared", () => {
  const storage = new MemoryStorage();
  const intent = createStoryIntentCoordinator(scope, storage);
  intent.stage(payload);
  const foreign = JSON.stringify({ unrelated: "another writer" });
  storage.values.set(intent.key, foreign);

  expect(intent.read().failed).toBe(true);
  expect(intent.stage(payload).failed).toBe(true);
  expect(intent.dismiss().failed).toBe(true);
  expect(storage.values.get(intent.key)).toBe(foreign);
});

test("a rejected create promise remains unconfirmed regardless of attached HTTP status", async () => {
  const intent = createStoryIntentCoordinator(scope, new MemoryStorage());
  intent.stage(payload);
  const apparentBadRequest = Object.assign(new Error("proxy response"), {
    status: 400,
  });
  const result = await intent.submit(async () => {
    throw apparentBadRequest;
  });
  expect(result.kind).toBe("unconfirmed");
  expect(result.record?.status).toBe("unconfirmed");
});

test("explicit retry reuses the exact uploaded payload without another upload stage", async () => {
  const storage = new MemoryStorage();
  const intent = createStoryIntentCoordinator(scope, storage);
  const staged = intent.stage(payload).record!;
  const sent: StoryCreatePayload[] = [];
  let firstAttemptWasPersisted = false;
  expect(
    (
      await intent.submit(async (body) => {
        sent.push(body);
        const saved = JSON.parse(storage.values.get(intent.key)!) as {
          status: string;
          payload: StoryCreatePayload;
        };
        firstAttemptWasPersisted =
          saved.status === "pending" &&
          JSON.stringify(saved.payload) === JSON.stringify(body);
        throw new Error("response was lost");
      })
    ).kind,
  ).toBe("unconfirmed");
  expect(firstAttemptWasPersisted).toBe(true);

  const result = await intent.retry(async (body) => {
    sent.push(body);
    return validAck(scope, body);
  });
  expect(result.kind).toBe("confirmed");
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEqual(staged.payload);
  expect(sent[1]).toEqual(staged.payload);
  expect(sent[1].attachment.r2_key).toBe("uploads/intent.webp");
});

test("only one create attempt can be in flight for a coordinator", async () => {
  const intent = createStoryIntentCoordinator(scope, new MemoryStorage());
  intent.stage(payload);
  const createResult = deferred<unknown>();
  const createStarted = deferred<void>();
  let calls = 0;
  const attempt = intent.submit(() => {
    calls += 1;
    createStarted.resolve();
    return createResult.promise;
  });
  await createStarted.promise;
  expect((await intent.retry(async () => (calls++, validAck()))).kind).toBe(
    "blocked",
  );
  expect(calls).toBe(1);
  createResult.resolve(validAck());
  expect((await attempt).kind).toBe("confirmed");
  expect(calls).toBe(1);
});

test("invalid SDK ACK stays unconfirmed and does not erase the exact payload", async () => {
  const storage = new MemoryStorage();
  const intent = createStoryIntentCoordinator(scope, storage);
  intent.stage(payload);
  const result = await intent.submit(async () => ({
    ...validAck(),
    attachment: { ...validAck().attachment, r2_key: "uploads/other.webp" },
  }));
  expect(result.kind).toBe("unconfirmed");
  expect(
    createStoryIntentCoordinator(scope, storage).read().record,
  ).toMatchObject({
    status: "unconfirmed",
    payload,
  });
});

test("strict ACK requires matching local ID, author, media, metadata, and coherent times", async () => {
  const invalid: Array<Partial<Story>> = [
    { ap_id: "https://remote.example/ap/objects/story-1" },
    {
      author: {
        ...validAck().author,
        ap_id: "https://meet.example/ap/users/bob",
      },
    },
    { attachment: { ...validAck().attachment, url: "/media/other.webp" } },
    {
      attachment: {
        ...validAck().attachment,
        r2_key: "uploads/other.webp",
      },
    },
    { attachment: { ...validAck().attachment, mediaType: "image/png" } },
    { attachment: { ...validAck().attachment, type: "Video" } },
    { caption: "other caption" },
    { displayDuration: "PT10S" },
    { overlays: [] },
    { published: "not a timestamp" },
    { end_time: "2026-10-01T23:59:59.000Z" },
  ];
  for (const patch of invalid) {
    const intent = createStoryIntentCoordinator(scope, new MemoryStorage());
    intent.stage(payload);
    const result = await intent.submit(async () => ({
      ...validAck(),
      ...patch,
    }));
    expect(result.kind).toBe("unconfirmed");
  }
});

test("supported media types are bounded and unsupported references cannot be staged", () => {
  for (const contentType of [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/mp4",
    "video/webm",
  ]) {
    const intent = createStoryIntentCoordinator(scope, new MemoryStorage());
    const extension = contentType.split("/")[1];
    const body = {
      ...payload,
      attachment: {
        url: `/media/story.${extension}`,
        r2_key: `uploads/story.${extension}`,
        content_type: contentType,
      },
    };
    expect(intent.stage(body).record?.payload.attachment.content_type).toBe(
      contentType,
    );
  }
  const invalid = createStoryIntentCoordinator(scope, new MemoryStorage());
  expect(
    invalid.stage({
      ...payload,
      attachment: { ...payload.attachment, content_type: "image/svg+xml" },
    }).record,
  ).toBeNull();
  const extraField = createStoryIntentCoordinator(scope, new MemoryStorage());
  expect(
    extraField.stage({
      ...payload,
      secret: "never persist",
    } as StoryCreatePayload).record,
  ).toBeNull();
});

test("confirmed ACK is saved before cleanup and cleanup failure keeps retry locked", async () => {
  const storage = new MemoryStorage();
  storage.denyRemove = true;
  const intent = createStoryIntentCoordinator(scope, storage);
  intent.stage(payload);
  const result = await intent.submit(async () => validAck());
  expect(result.kind).toBe("confirmed");
  expect(result.failed).toBe(true);
  expect(result.record?.status).toBe("confirmed");
  expect(storage.values.get(intent.key)).toContain('"status":"confirmed"');
  expect((await intent.retry(async () => validAck())).kind).toBe("blocked");
  expect(
    createStoryIntentCoordinator(scope, storage).read().record?.status,
  ).toBe("confirmed");
});

test("confirmed ACK stays locked in memory if persisting confirmation fails", async () => {
  const storage = new MemoryStorage();
  const intent = createStoryIntentCoordinator(scope, storage);
  intent.stage(payload);
  const result = await intent.submit(async () => {
    storage.denyWrite = true;
    return validAck();
  });
  expect(result.kind).toBe("confirmed");
  expect(result.failed).toBe(true);
  expect(result.record?.status).toBe("confirmed");
  expect((await intent.retry(async () => validAck())).kind).toBe("blocked");
  expect(
    createStoryIntentCoordinator(scope, storage).read().record?.status,
  ).toBe("unconfirmed");
});
