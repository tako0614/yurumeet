import { afterEach, describe, expect, test } from "bun:test";
import {
  clearYurucommuApiTransport,
  setYurucommuApiTransport,
  uploadMedia,
} from "@takosjp/yurucommu-api";
import { uploadProductMedia } from "./media-upload.ts";

const originalFetch = globalThis.fetch;
const uploadedFiles: File[] = [];
let fetchCalls = 0;

function interceptUpload() {
  uploadedFiles.length = 0;
  fetchCalls = 0;
  setYurucommuApiTransport({
    resolveUrl: (path) => `https://upload.invalid${path}`,
    getAuthHeaders: () => ({}),
    credentials: "omit",
  });
  globalThis.fetch = (async (_input, init) => {
    fetchCalls += 1;
    const form = init?.body;
    const file = form instanceof FormData ? form.get("file") : null;
    if (file instanceof File) uploadedFiles.push(file);
    return Response.json({
      url: "https://media.invalid/fixture",
      r2_key: "fixture",
      content_type: "image/png",
    });
  }) as typeof fetch;
}

function failIfRead(file: File) {
  let readCount = 0;
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => {
      readCount += 1;
      throw new Error("original bytes must not be read before SDK validation");
    },
  });
  return () => readCount;
}

function countFileConstruction() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "File");
  if (!descriptor || !("value" in descriptor)) {
    throw new Error("File constructor is not a replaceable data property");
  }
  const nativeFile = globalThis.File;
  let constructionCount = 0;
  Object.defineProperty(globalThis, "File", {
    ...descriptor,
    value: new Proxy(nativeFile, {
      construct(target, argumentsList, newTarget) {
        constructionCount += 1;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    }),
  });
  return {
    count: () => constructionCount,
    restore: () => Object.defineProperty(globalThis, "File", descriptor),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearYurucommuApiTransport();
  uploadedFiles.length = 0;
  fetchCalls = 0;
});

describe("uploadProductMedia", () => {
  test("uploads Unicode filenames through the published SDK without changing the source File", async () => {
    interceptUpload();
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const original = new File([bytes], "旅行の写真.png", {
      type: "image/png",
      lastModified: 1_700_000_000_123,
    });

    await expect(uploadProductMedia(original)).resolves.toMatchObject({
      r2_key: "fixture",
    });

    expect(uploadedFiles).toHaveLength(1);
    expect(fetchCalls).toBe(1);
    const sent = uploadedFiles[0];
    expect(sent.name).toBe("media.png");
    expect(sent.type).toBe(original.type);
    expect(sent.size).toBe(original.size);
    expect(sent.lastModified).toBe(original.lastModified);
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(bytes);
    expect(original.name).toBe("旅行の写真.png");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
  });

  test("accepts an ASCII source name through the same SDK path", async () => {
    interceptUpload();
    const original = new File(["ascii bytes"], "photo.png", {
      type: "image/png",
      lastModified: 1234,
    });

    await uploadProductMedia(original);

    expect(uploadedFiles).toHaveLength(1);
    expect(fetchCalls).toBe(1);
    expect(uploadedFiles[0].name).toBe("media.png");
    expect(uploadedFiles[0].lastModified).toBe(1234);
    expect(await uploadedFiles[0].text()).toBe("ascii bytes");
    expect(original.name).toBe("photo.png");
  });

  test("still lets SDK MIME and size validation reject before fetch", async () => {
    interceptUpload();
    const unsupported = new File(["invalid"], "不明.bin", {
      type: "application/octet-stream",
    });
    const oversized = new File(
      [new Uint8Array(20 * 1024 * 1024 + 1)],
      "大きな画像.png",
      { type: "image/png" },
    );
    const unsupportedReads = failIfRead(unsupported);
    const oversizedReads = failIfRead(oversized);
    const fileConstruction = countFileConstruction();

    try {
      await expect(uploadProductMedia(unsupported)).rejects.toMatchObject({
        name: "FileValidationError",
        code: "INVALID_TYPE",
      });
      await expect(uploadProductMedia(oversized)).rejects.toMatchObject({
        name: "FileValidationError",
        code: "FILE_TOO_LARGE",
      });
      expect(unsupportedReads()).toBe(0);
      expect(oversizedReads()).toBe(0);
      expect(unsupported.name).toBe("不明.bin");
      expect(oversized.name).toBe("大きな画像.png");
      expect(fileConstruction.count()).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(uploadedFiles).toHaveLength(0);
    } finally {
      fileConstruction.restore();
    }
  });

  test("captures the old unchanged-File forwarding failure against SDK validation", async () => {
    interceptUpload();
    const original = new File(["bytes"], "旅行の写真.png", {
      type: "image/png",
    });

    await expect(uploadMedia(original)).rejects.toMatchObject({
      name: "FileValidationError",
      code: "INVALID_FILENAME",
    });
    expect(fetchCalls).toBe(0);
    expect(uploadedFiles).toHaveLength(0);
  });
});
