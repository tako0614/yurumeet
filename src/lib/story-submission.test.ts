import { expect, test } from "bun:test";
import { submitStoryDraft } from "./story-submission.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Payload = {
  attachment: { url?: string; r2_key: string; content_type: string };
  displayDuration: string;
  caption?: string;
};

const media = {
  url: "https://media.example.test/uploaded",
  r2_key: "stories/uploaded",
  content_type: "video/webm",
};

test("video submission snapshots the selected file and caption before upload awaits", async () => {
  const firstFile = new File(["video"], "first.webm", { type: "video/webm" });
  const laterFile = new File(["image"], "later.png", { type: "image/png" });
  const draft = { file: firstFile, caption: "  first caption  " };
  const upload = deferred<typeof media>();
  const uploadStarted = deferred<void>();
  let uploadedFile: File | undefined;
  let createdPayload: Payload | undefined;

  const submitting = submitStoryDraft(draft, {
    upload: async (file) => {
      uploadedFile = file;
      uploadStarted.resolve();
      return upload.promise;
    },
    create: async (payload) => {
      createdPayload = payload as Payload;
      return "created-story";
    },
  });
  await uploadStarted.promise;

  draft.file = laterFile;
  draft.caption = "changed while uploading";
  upload.resolve(media);

  await expect(submitting).resolves.toBe("created-story");
  expect(uploadedFile).toBe(firstFile);
  expect(createdPayload).toEqual({
    attachment: media,
    displayDuration: "PT10S",
    caption: "first caption",
  });
});

test("image submission uses the image duration and omits a whitespace-only caption", async () => {
  const file = new File(["image"], "photo.png", { type: "image/png" });
  let createdPayload: Payload | undefined;

  await submitStoryDraft(
    { file, caption: "   \n  " },
    {
      upload: async () => ({ ...media, content_type: "image/png" }),
      create: async (payload) => {
        createdPayload = payload as Payload;
        return true;
      },
    },
  );

  expect(createdPayload).toEqual({
    attachment: { ...media, content_type: "image/png" },
    displayDuration: "PT5S",
    caption: undefined,
  });
});

test("an upload rejection propagates and prevents story creation", async () => {
  const uploadError = new Error("upload failed");
  let createCalls = 0;

  await expect(
    submitStoryDraft(
      {
        file: new File(["video"], "clip.mp4", { type: "video/mp4" }),
        caption: "caption",
      },
      {
        upload: async () => {
          throw uploadError;
        },
        create: async () => {
          createCalls += 1;
          return null;
        },
      },
    ),
  ).rejects.toBe(uploadError);
  expect(createCalls).toBe(0);
});

test("a story creation rejection propagates to the caller", async () => {
  const createError = new Error("story creation failed");

  await expect(
    submitStoryDraft(
      {
        file: new File(["image"], "photo.jpg", { type: "image/jpeg" }),
        caption: "caption",
      },
      {
        upload: async () => media,
        create: async () => {
          throw createError;
        },
      },
    ),
  ).rejects.toBe(createError);
});

test("submission remains pending until story creation finishes", async () => {
  const createResult = deferred<string>();
  const createStarted = deferred<void>();
  const submitting = submitStoryDraft(
    {
      file: new File(["video"], "clip.webm", { type: "video/webm" }),
      caption: "caption",
    },
    {
      upload: async () => media,
      create: async () => {
        createStarted.resolve();
        return createResult.promise;
      },
    },
  );
  let settled = false;
  void submitting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await createStarted.promise;
  expect(settled).toBe(false);
  createResult.resolve("story-id");
  await expect(submitting).resolves.toBe("story-id");
  expect(settled).toBe(true);
});
