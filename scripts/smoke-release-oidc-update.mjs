#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HistoricalUpdateFailure,
  qualifyHistoricalOidcUpdate,
} from "./release-historical-update.mjs";
import { runSupervisedCommand } from "./native-smoke-supervisor.mjs";

const childMode = process.argv[2] === "--child";
const args = process.argv.slice(childMode ? 3 : 2);
const usage =
  "usage: node scripts/smoke-release-oidc-update.mjs <candidate-worker.js> <sha256:candidate-digest> <published-v0.1.2-worker.js> <core-3.2.0-19-sql-dir> <public-core-3.2.0.tgz> <published-v0.1.2-takosumi-artifact.json>";

if (args.length !== 6) {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
} else if (!childMode) {
  try {
    await runSupervisedCommand(
      [
        process.execPath,
        fileURLToPath(import.meta.url),
        "--child",
        ...args.map((value, index) => (index === 1 ? value : resolve(value))),
      ],
      {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        timeoutMs: 720_000,
      },
    );
  } catch {
    process.stderr.write(
      '{"kind":"yurumeet.native-historical-oidc-update@v1","status":"FAILED","check":"native-smoke-supervisor"}\n',
    );
    process.exitCode = 1;
  }
} else {
  try {
    const result = await qualifyHistoricalOidcUpdate({
      candidateWorkerPath: resolve(args[0]),
      candidateSha256: args[1],
      oldWorkerPath: resolve(args[2]),
      oldSqlDir: resolve(args[3]),
      oldCoreTarballPath: resolve(args[4]),
      oldReleaseManifestPath: resolve(args[5]),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        kind: "yurumeet.native-historical-oidc-update@v1",
        status: "FAILED",
        check:
          error instanceof HistoricalUpdateFailure
            ? error.message
            : "native-runtime-failure",
      })}\n`,
    );
    process.exitCode = 1;
  }
}
