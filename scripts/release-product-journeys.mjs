import { createHash } from "node:crypto";
import { FormData } from "miniflare";
import { qualifyPostAttachments } from "./release-post-journey.mjs";
import {
  loginProductSession,
  logoutProductSession,
} from "./release-auth-journey.mjs";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mMQCDjxHwADxAIopPp9tgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(
      `${label} returned HTTP ${response.status}; expected ${expected}`,
    );
  }
}

async function requirePrivateDenialBody(response, readJson, label) {
  const denied = await readJson(response, label);
  if (
    denied === null ||
    Object.keys(denied).length !== 1 ||
    ![
      "Authentication required",
      "Not authorized",
      "Not authorized to access this media",
    ].includes(denied.error)
  ) {
    throw new Error(`${label} included non-error content`);
  }
}

async function first(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .first();
}

async function run(db, sql, ...values) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}

async function seedActor(db, origin, username, role = "member") {
  const actorApId = `${origin}/ap/users/${username}`;
  await run(
    db,
    `INSERT INTO actors (
      ap_id, preferred_username, name, inbox, outbox, followers_url,
      following_url, public_key_pem, private_key_pem, role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'journey-test-only', 'journey-test-only', ?)`,
    actorApId,
    username,
    `Release smoke ${username}`,
    `${actorApId}/inbox`,
    `${actorApId}/outbox`,
    `${actorApId}/followers`,
    `${actorApId}/following`,
    role,
  );
  return actorApId;
}

async function seedSession(db, actorApId, sessionSalt, rawSessionId) {
  const id = `sha256:${sha256(`${sessionSalt}:${rawSessionId}`)}`;
  await run(
    db,
    `INSERT INTO sessions (id, member_id, access_token, expires_at)
     VALUES (?, ?, ?, ?)`,
    id,
    actorApId,
    id,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  );
  return rawSessionId;
}

function sessionHeaders(origin, sessionId) {
  return {
    origin,
    cookie: `session=${sessionId}`,
  };
}

function dmPath(otherActorApId) {
  return `/api/dm/user/${encodeURIComponent(otherActorApId)}/messages`;
}

async function tableCounts(db) {
  const counts = {};
  for (const table of [
    "objects",
    "object_recipients",
    "activities",
    "inbox",
    "media_uploads",
    "delivery_fanouts",
  ]) {
    const result = await first(db, `SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = result?.count;
  }
  return counts;
}

async function uploadKeys(media) {
  const result = await media.list({ prefix: "uploads/", limit: 1000 });
  return result.objects.map((object) => object.key).sort();
}

export async function qualifyProductJourneys(
  worker,
  { origin, password, sessionSalt, readJson },
) {
  const db = await worker.getD1Database("DB");
  const media = await worker.getR2Bucket("MEDIA");
  const senderApId = await seedActor(
    db,
    origin,
    "release-smoke-sender",
    "owner",
  );
  const recipientApId = await seedActor(db, origin, "release-smoke-recipient");
  const unrelatedApId = await seedActor(db, origin, "release-smoke-unrelated");
  const oldSenderSession = await seedSession(
    db,
    senderApId,
    sessionSalt,
    "release-smoke-session-sender-7f6d1192",
  );
  const recipientSession = await seedSession(
    db,
    recipientApId,
    sessionSalt,
    "release-smoke-session-recipient-a108328f",
  );
  const unrelatedSession = await seedSession(
    db,
    unrelatedApId,
    sessionSalt,
    "release-smoke-session-unrelated-ecf49f83",
  );

  const authSession = await loginProductSession(worker, {
    origin,
    password,
    sessionSalt,
    readJson,
    actorApId: senderApId,
    oldSession: oldSenderSession,
  });
  const senderSession = authSession.sessionId;

  const content = "release smoke direct message";
  const postResponse = await worker.dispatchFetch(
    `${origin}${dmPath(recipientApId)}`,
    {
      method: "POST",
      headers: {
        ...sessionHeaders(origin, senderSession),
        "content-type": "application/json",
      },
      body: JSON.stringify({ content }),
    },
  );
  requireStatus(postResponse, 201, "authenticated DM POST");
  const posted = await readJson(postResponse, "authenticated DM POST");
  const messageId = posted.message?.id;
  const conversationId = posted.conversation_id;
  if (
    typeof messageId !== "string" ||
    posted.message?.content !== content ||
    typeof conversationId !== "string" ||
    conversationId.length === 0
  ) {
    throw new Error(
      "authenticated DM POST returned an incomplete message response",
    );
  }

  const object = await first(
    db,
    `SELECT ap_id, type, attributed_to, content, visibility, to_json,
            conversation
       FROM objects
      WHERE ap_id = ?`,
    messageId,
  );
  if (!object) throw new Error("DM object was not persisted");
  if (
    object.type !== "Note" ||
    object.attributed_to !== senderApId ||
    object.content !== content ||
    object.visibility !== "direct" ||
    object.conversation !== conversationId ||
    JSON.stringify(JSON.parse(object.to_json)) !==
      JSON.stringify([recipientApId])
  ) {
    throw new Error(
      "persisted DM object does not match its direct recipient response",
    );
  }

  const recipientProjection = await first(
    db,
    `SELECT object_ap_id, recipient_ap_id, type
       FROM object_recipients
      WHERE object_ap_id = ? AND recipient_ap_id = ?`,
    messageId,
    recipientApId,
  );
  const activity = await first(
    db,
    `SELECT ap_id, type, actor_ap_id, object_ap_id
       FROM activities
      WHERE object_ap_id = ? AND type = 'Create'`,
    messageId,
  );
  const inbox = activity
    ? await first(
        db,
        `SELECT actor_ap_id, activity_ap_id
           FROM inbox
          WHERE actor_ap_id = ? AND activity_ap_id = ?`,
        recipientApId,
        activity.ap_id,
      )
    : null;
  if (
    recipientProjection?.type !== "to" ||
    !activity ||
    activity.actor_ap_id !== senderApId ||
    activity.object_ap_id !== messageId ||
    !inbox
  ) {
    throw new Error(
      "DM recipient, Create activity, and inbox rows were not persisted together",
    );
  }

  const recipientResponse = await worker.dispatchFetch(
    `${origin}${dmPath(senderApId)}`,
    { headers: sessionHeaders(origin, recipientSession) },
  );
  requireStatus(recipientResponse, 200, "recipient DM GET");
  const recipientThread = await readJson(recipientResponse, "recipient DM GET");
  if (
    recipientThread.conversation_id !== conversationId ||
    recipientThread.messages?.length !== 1 ||
    recipientThread.messages[0]?.id !== messageId ||
    recipientThread.messages[0]?.content !== content
  ) {
    throw new Error(
      "recipient DM GET did not return exactly the persisted message",
    );
  }

  const unrelatedResponse = await worker.dispatchFetch(
    `${origin}${dmPath(senderApId)}`,
    { headers: sessionHeaders(origin, unrelatedSession) },
  );
  requireStatus(unrelatedResponse, 200, "unrelated actor DM GET");
  const unrelatedThread = await readJson(
    unrelatedResponse,
    "unrelated actor DM GET",
  );
  if (
    !Array.isArray(unrelatedThread.messages) ||
    unrelatedThread.messages.length !== 0
  ) {
    throw new Error("DM isolation exposed a message to an unrelated actor");
  }

  const uploadForm = new FormData();
  uploadForm.set(
    "file",
    new File([PNG_BYTES], "release-smoke.png", { type: "image/png" }),
  );
  const uploadResponse = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: sessionHeaders(origin, senderSession),
      body: uploadForm,
    },
  );
  requireStatus(uploadResponse, 200, "authenticated media upload");
  const uploaded = await readJson(uploadResponse, "authenticated media upload");
  const mediaId = uploaded.id;
  const r2Key = uploaded.r2_key;
  const mediaUrl = uploaded.url;
  if (
    typeof mediaId !== "string" ||
    r2Key !== `uploads/${mediaId}.png` ||
    mediaUrl !== `/media/${mediaId}.png` ||
    uploaded.content_type !== "image/png"
  ) {
    throw new Error("media upload returned an incomplete storage identity");
  }
  const upload = await first(
    db,
    `SELECT id, r2_key, uploader_ap_id, content_type, size
       FROM media_uploads
      WHERE id = ?`,
    mediaId,
  );
  if (
    !upload ||
    upload.r2_key !== r2Key ||
    upload.uploader_ap_id !== senderApId ||
    upload.content_type !== "image/png" ||
    upload.size !== PNG_BYTES.byteLength
  ) {
    throw new Error(
      "media upload was not persisted with the authenticated owner and bytes",
    );
  }
  const storedObject = await media.get(r2Key);
  if (!storedObject)
    throw new Error("media upload R2 object was not persisted");
  const storedBytes = new Uint8Array(await storedObject.arrayBuffer());
  if (
    !storedBytes.every((byte, index) => byte === PNG_BYTES[index]) ||
    storedBytes.length !== PNG_BYTES.length
  ) {
    throw new Error("media upload R2 bytes do not match the uploaded PNG");
  }

  const mediaReadResponse = await worker.dispatchFetch(`${origin}${mediaUrl}`, {
    headers: sessionHeaders(origin, senderSession),
  });
  requireStatus(mediaReadResponse, 200, "authenticated media GET");
  if (
    mediaReadResponse.headers.get("content-type") !== "image/png" ||
    !mediaReadResponse.headers.get("cache-control")?.startsWith("private,")
  ) {
    throw new Error("media-readback did not preserve private uploader headers");
  }
  const servedBytes = new Uint8Array(await mediaReadResponse.arrayBuffer());
  if (
    !servedBytes.every((byte, index) => byte === PNG_BYTES[index]) ||
    servedBytes.length !== PNG_BYTES.length
  ) {
    throw new Error(
      "authenticated media GET did not return the exact uploaded bytes",
    );
  }

  for (const deniedHeaders of [{}, sessionHeaders(origin, unrelatedSession)]) {
    const denied = await worker.dispatchFetch(`${origin}${mediaUrl}`, {
      headers: deniedHeaders,
    });
    requireStatus(denied, 403, "private-media-read-refusal");
    if (denied.headers.get("cache-control") !== "no-store") {
      throw new Error("private-media-read-refusal was cacheable");
    }
    await requirePrivateDenialBody(denied, readJson, "private-media-refusal");
  }

  const postChecks = await qualifyPostAttachments(worker, {
    origin,
    ownerApId: senderApId,
    ownerSession: senderSession,
    unrelatedSession,
    png: PNG_BYTES,
    readJson,
  });

  const beforeUnauthenticated = await tableCounts(db);
  const mediaKeysBefore = await uploadKeys(media);
  const unauthenticatedDm = await worker.dispatchFetch(
    `${origin}${dmPath(recipientApId)}`,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ content: "unauthenticated release smoke write" }),
    },
  );
  requireStatus(unauthenticatedDm, 401, "unauthenticated DM POST");
  await readJson(unauthenticatedDm, "unauthenticated DM POST");
  const unauthenticatedUploadForm = new FormData();
  unauthenticatedUploadForm.set(
    "file",
    new File([PNG_BYTES], "unauthenticated.png", { type: "image/png" }),
  );
  const unauthenticatedMedia = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: { origin },
      body: unauthenticatedUploadForm,
    },
  );
  requireStatus(unauthenticatedMedia, 401, "unauthenticated media upload");
  await readJson(unauthenticatedMedia, "unauthenticated media upload");
  const invalidForm = new FormData();
  invalidForm.set(
    "file",
    new File(["not-a-png"], "invalid.png", { type: "image/png" }),
  );
  const invalidUpload = await worker.dispatchFetch(
    `${origin}/api/media/upload`,
    {
      method: "POST",
      headers: sessionHeaders(origin, senderSession),
      body: invalidForm,
    },
  );
  requireStatus(invalidUpload, 400, "invalid-media-refusal");
  await readJson(invalidUpload, "invalid-media-refusal");
  const afterUnauthenticated = await tableCounts(db);
  const mediaKeysAfter = await uploadKeys(media);
  if (
    JSON.stringify(afterUnauthenticated) !==
    JSON.stringify(beforeUnauthenticated)
  ) {
    throw new Error("unauthenticated API requests created database rows");
  }
  if (JSON.stringify(mediaKeysAfter) !== JSON.stringify(mediaKeysBefore)) {
    throw new Error("unauthenticated API requests created R2 objects");
  }

  await logoutProductSession(worker, { origin, readJson }, authSession);
  const revokedDm = await worker.dispatchFetch(origin + dmPath(recipientApId), {
    method: "POST",
    headers: {
      ...sessionHeaders(origin, senderSession),
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "revoked-session-write" }),
  });
  requireStatus(revokedDm, 401, "logout-revocation DM write");
  await readJson(revokedDm, "logout-revocation");
  const revokedPost = await worker.dispatchFetch(origin + "/api/posts", {
    method: "POST",
    headers: {
      ...sessionHeaders(origin, senderSession),
      "content-type": "application/json",
    },
    body: JSON.stringify({ content: "revoked-post-write", attachments: [] }),
  });
  if (revokedPost.status !== 401)
    throw new Error("logout-revocation accepted a post write");
  await readJson(revokedPost, "logout-revocation");
  const revokedForm = new FormData();
  revokedForm.set(
    "file",
    new File([PNG_BYTES], "revoked.png", { type: "image/png" }),
  );
  const revokedUpload = await worker.dispatchFetch(
    origin + "/api/media/upload",
    {
      method: "POST",
      headers: sessionHeaders(origin, senderSession),
      body: revokedForm,
    },
  );
  requireStatus(revokedUpload, 401, "logout-revocation media write");
  await readJson(revokedUpload, "logout-revocation");
  const revokedRead = await worker.dispatchFetch(origin + mediaUrl, {
    headers: sessionHeaders(origin, senderSession),
  });
  requireStatus(revokedRead, 403, "logout-revocation private media");
  if (revokedRead.headers.get("cache-control") !== "no-store") {
    throw new Error("logout-revocation cached private media");
  }
  await requirePrivateDenialBody(revokedRead, readJson, "logout-revocation");
  if (
    JSON.stringify(await tableCounts(db)) !==
      JSON.stringify(beforeUnauthenticated) ||
    JSON.stringify(await uploadKeys(media)) !== JSON.stringify(mediaKeysBefore)
  ) {
    throw new Error("logout-revocation left durable write effects");
  }
  return {
    checks: [
      "password-login",
      "session-rotation",
      "invalid-password-refusal",
      "authenticated-dm",
      "dm-isolation",
      "media-upload",
      "media-readback",
      "private-media-read-refusal",
      "invalid-media-refusal",
      "unauthenticated-api-refusal",
      ...postChecks,
      "logout-revocation",
    ],
  };
}
