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

// The home-screen icons are rendered from the logo, not copies of it, so the
// copy check above cannot see them go stale. Record the logo bytes they were
// rendered from and the bytes that rendering produced: a new logo, or an icon
// edited by hand, fails here until the icons are regenerated and this record
// is updated in the same change.
//
// Regenerate from the repository root (ImageMagick 7.1.2 reproduces the
// recorded bytes exactly; another version may differ, which is fine as long as
// the record below is updated with the new hashes):
//
//   L=public/yurumeet-logo.png
//   P="-strip -define png:exclude-chunks=date,time"
//   magick $L -filter Lanczos -resize 192x192 $P PNG32:public/icons/yurumeet-192.png
//   magick $L -filter Lanczos -resize 512x512 $P PNG32:public/icons/yurumeet-512.png
//   magick -size 1024x1024 xc:'#ff3b3b' \( $L -filter Lanczos -resize 85% \) \
//     -gravity center -compose over -composite -alpha off \
//     -filter Lanczos -resize 512x512 $P PNG24:public/icons/yurumeet-maskable-512.png
//   magick -size 1024x1024 xc:'#ff3b3b' $L -compose over -composite -alpha off \
//     -filter Lanczos -resize 180x180 $P PNG24:public/apple-touch-icon.png
//
// The maskable icon keeps the bubble within 0.32 of the size from the centre
// (the maskable safe zone is 0.40); the maskable and apple-touch icons are
// opaque because launchers and iOS fill transparent pixels themselves.
const derivedIcons = {
  source: {
    path: "public/yurumeet-logo.png",
    sha256: "43c30ddcd20378ba595e75434444edbb3540b4182a0e068036276320b1302d72",
  },
  icons: {
    "public/apple-touch-icon.png":
      "d01dae2d7fbb2e759d3901fb5215cd7597ab253ad38f1929875857ed48ec690d",
    "public/icons/yurumeet-192.png":
      "e30e2698c9e8588285bbb4bdd21a54fc23a27b2848de88eadbbfe07624231b2a",
    "public/icons/yurumeet-512.png":
      "29b0d47212657fad7d17585986d223a1dfd870e378f8a0585390be8c83390404",
    "public/icons/yurumeet-maskable-512.png":
      "b1e259ea080f23ae1090895756c672260917cb6b8eb7ab8e1dab119857a254d7",
  },
};

async function sha256Of(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const derivedFailures = [];
const sourceHash = await sha256Of(derivedIcons.source.path);
if (sourceHash !== derivedIcons.source.sha256) {
  derivedFailures.push(
    `${derivedIcons.source.path} is sha256:${sourceHash}, but the home-screen icons were rendered from sha256:${derivedIcons.source.sha256}`,
  );
}
for (const [path, recorded] of Object.entries(derivedIcons.icons)) {
  const actual = await sha256Of(path);
  if (actual !== recorded) {
    derivedFailures.push(
      `${path} is sha256:${actual}, recorded sha256:${recorded}`,
    );
  }
}
// Every PNG the manifest or index.html points a phone at must be one of the
// recorded derived icons, so a new icon cannot bypass this record.
const manifest = JSON.parse(
  await readFile("public/manifest.webmanifest", "utf8"),
);
const indexHtml = await readFile("index.html", "utf8");
const referencedIcons = [
  ...manifest.icons.map((icon) => icon.src),
  ...[
    ...indexHtml.matchAll(/<link rel="apple-touch-icon" href="([^"]+)"/g),
  ].map((match) => match[1]),
].map((src) => `public${src}`);
for (const path of referencedIcons) {
  if (!(path in derivedIcons.icons)) {
    derivedFailures.push(
      `${path} is referenced but not a recorded derived icon`,
    );
  }
}
if (derivedFailures.length > 0) {
  throw new Error(
    `Yurumeet home-screen icons drifted from their recorded logo source. Regenerate them from ${derivedIcons.source.path} and update derivedIcons in scripts/check-brand-assets.mjs:\n${derivedFailures.join("\n")}`,
  );
}

console.log(
  `Verified ${logoPaths.length} matching Yurumeet brand logo copies and ${Object.keys(derivedIcons.icons).length} home-screen icons derived from ${derivedIcons.source.path}.`,
);
