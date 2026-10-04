import { uploadMedia, validateFile } from "@takosjp/yurucommu-api";

const TRANSPORT_NAMES: Record<string, string> = {
  "image/jpeg": "media.jpg",
  "image/png": "media.png",
  "image/gif": "media.gif",
  "image/webp": "media.webp",
  "video/mp4": "media.mp4",
  "video/webm": "media.webm",
};

/** Adapt browser filenames to the published SDK's ASCII multipart contract. */
export async function uploadProductMedia(
  file: File,
  beforeUpload?: () => void,
) {
  const transportName = TRANSPORT_NAMES[file.type] ?? "media.bin";
  const validationFile = new Proxy(file, {
    get(target, property) {
      if (property === "name") return transportName;
      return Reflect.get(target, property, target);
    },
  });
  validateFile(validationFile);
  const transportFile = new File([await file.arrayBuffer()], transportName, {
    type: file.type,
    lastModified: file.lastModified,
  });
  // Callers can reject a changed principal/transport after byte reads.
  // No await separates this check from the SDK resolving its destination.
  beforeUpload?.();
  const result = await uploadMedia(transportFile);
  // Public API4.1.11 preserves this JSON field but predates its declaration.
  // Older servers advertise no deadline; never invent a TTL for them.
  const expiresAt = (result as typeof result & { expires_at?: unknown })
    .expires_at;
  return {
    ...result,
    expires_at:
      typeof expiresAt === "string" &&
      expiresAt.length <= 256 &&
      Number.isFinite(Date.parse(expiresAt))
        ? expiresAt
        : undefined,
  };
}
