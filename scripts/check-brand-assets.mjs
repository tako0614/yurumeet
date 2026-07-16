import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const logoPaths = [
  "public/yurumeet-logo.png",
  "src/assets/yurumeet-logo.png",
  "site/assets/yurumeet-logo.png",
];

const hashes = await Promise.all(
  logoPaths.map(async (path) => ({
    path,
    hash: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  })),
);

const expected = hashes[0].hash;
const drifted = hashes.filter(({ hash }) => hash !== expected);
if (drifted.length > 0) {
  throw new Error(
    `Yurumeet brand logo copies differ: ${hashes
      .map(({ path, hash }) => `${path}=${hash}`)
      .join(", ")}`,
  );
}

console.log(
  `Verified ${logoPaths.length} matching Yurumeet brand logo copies.`,
);
