#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runSupervisedCommand } from "./native-smoke-supervisor.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const child = resolve(repo, "scripts/release-worker-smoke-child.mjs");
const timeoutMs = 120_000;

try {
  await runSupervisedCommand(
    [process.execPath, child, ...process.argv.slice(2)],
    { cwd: repo, timeoutMs },
  );
} catch (error) {
  process.stderr.write(`[native-smoke-supervisor] ${error}\n`);
  process.exitCode = 1;
}
