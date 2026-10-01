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
export async function uploadProductMedia(file: File) {
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
  return uploadMedia(transportFile);
}
