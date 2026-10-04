import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runSupervisedCommand } from "./native-smoke-supervisor.mjs";

const repo = resolve(import.meta.dir, "..");
type SupervisedOptions = NonNullable<
  Parameters<typeof runSupervisedCommand>[1]
>;

function capture() {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    stream,
    bytes: () => Buffer.concat(chunks),
    close: () => stream.destroy(),
  };
}

async function expectProcessNotLive(pid: number) {
  let exists = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") exists = false;
    else throw error;
  }
  if (!exists) return;

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(
      stat.lastIndexOf(")") + 2,
      stat.lastIndexOf(")") + 3,
    );
    if (state === "Z" || state === "X") return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      if (result.status !== 0 || !result.stdout.trim()) return;
      const state = result.stdout.trim()[0];
      if (state === "Z" || state === "X") return;
    } else {
      throw error;
    }
  }
  expect(exists, `process ${pid} is still live`).toBe(false);
}

async function runFixture(source: string, options: SupervisedOptions = {}) {
  const stdout = capture();
  const stderr = capture();
  const startedAt = performance.now();
  let error: unknown;
  try {
    await runSupervisedCommand([process.execPath, "-e", source], {
      cwd: repo,
      timeoutMs: 400,
      termGraceMs: 50,
      killWaitMs: 200,
      stdoutTarget: stdout.stream,
      stderrTarget: stderr.stream,
      ...options,
    });
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    stdout: stdout.bytes(),
    stderr: stderr.bytes(),
    elapsedMs: performance.now() - startedAt,
    close() {
      stdout.close();
      stderr.close();
    },
  };
}

describe("native smoke process supervision", () => {
  test("the public package command invokes the fixed Node wrapper without timeout overrides", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repo, "package.json"), "utf8"),
    );
    const wrapper = await readFile(
      resolve(repo, "scripts/smoke-release-worker.mjs"),
      "utf8",
    );
    expect(packageJson.scripts["smoke:release-artifact"]).toBe(
      "node scripts/smoke-release-worker.mjs",
    );
    expect(wrapper).toContain(
      "[process.execPath, child, ...process.argv.slice(2)]",
    );
    expect(wrapper).toContain("const timeoutMs = 120_000");
    expect(wrapper).not.toMatch(/process\.env|timeoutMs\s*:\s*process\./);
  });

  test("releases exact success stdout after a normal child and process-group exit", async () => {
    const success = Buffer.from('{"status":"PASSED"}\n');
    const source = `process.stdout.write(Buffer.from(${JSON.stringify(success.toString())}));`;
    const result = await runFixture(source);
    try {
      expect(result.error).toBeUndefined();
      expect(result.stdout).toEqual(success);
      expect(result.stderr).toEqual(Buffer.alloc(0));
    } finally {
      result.close();
    }
  });

  test("withholds PASSED and terminates the child group when a child and descendant hang", async () => {
    let childPid: number | undefined;
    const result = await runFixture(
      'const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"] }); process.stderr.write(`owned-descendant-pid=${descendant.pid}\\n`); process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n"); setInterval(() => {}, 1000);',
      {
        timeoutMs: 500,
        termGraceMs: 40,
        killWaitMs: 160,
        spawn: ((command: string, args: string[], options: object) => {
          const child = spawn(command, args, options);
          childPid = child.pid;
          return child;
        }) as typeof spawn,
      },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.elapsedMs).toBeLessThan(1500);
      const match = result.stderr
        .toString()
        .match(/owned-descendant-pid=(\d+)/);
      expect(match).not.toBeNull();
      if (!childPid || !match) throw new Error("synthetic process IDs missing");
      await expectProcessNotLive(childPid);
      await expectProcessNotLive(Number(match[1]));
    } finally {
      result.close();
    }
  });

  test("withholds success and terminates a descendant left after exit-zero with closed pipes", async () => {
    let childPid: number | undefined;
    const result = await runFixture(
      'const { spawn } = require("node:child_process"); const descendant = spawn(process.execPath, ["-e", "process.stdout.end(); process.stderr.end(); setInterval(() => {}, 1000);"], { stdio: ["ignore", "ignore", "ignore"] }); process.stderr.write(`owned-descendant-pid=${descendant.pid}\\n`, () => process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n", () => process.exit(0)));',
      {
        timeoutMs: 500,
        termGraceMs: 40,
        killWaitMs: 160,
        spawn: ((command: string, args: string[], options: object) => {
          const child = spawn(command, args, options);
          childPid = child.pid;
          return child;
        }) as typeof spawn,
      },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "exceeded its deadline",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.elapsedMs).toBeLessThan(1500);
      const match = result.stderr
        .toString()
        .match(/owned-descendant-pid=(\d+)/);
      expect(match).not.toBeNull();
      if (!childPid || !match) throw new Error("synthetic process IDs missing");
      await expectProcessNotLive(childPid);
      await expectProcessNotLive(Number(match[1]));
    } finally {
      result.close();
    }
  });

  test("bounds excessive child stdout and never releases a partial success record", async () => {
    const result = await runFixture(
      "process.stdout.write(Buffer.alloc(4096, 0x61)); setInterval(() => {}, 1000);",
      { stdoutLimitBytes: 64 },
    );
    try {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain(
        "stdout exceeded its limit",
      );
      expect(result.stdout).toEqual(Buffer.alloc(0));
    } finally {
      result.close();
    }
  });

  test("a closed stderr destination stops the child and withholds success", async () => {
    const stdout = capture();
    const stderr = new PassThrough();
    const pending = runSupervisedCommand(
      [
        process.execPath,
        "-e",
        'process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n"); process.stderr.write("diagnostic\\n"); setInterval(() => {}, 1000);',
      ],
      {
        cwd: repo,
        timeoutMs: 500,
        termGraceMs: 40,
        killWaitMs: 160,
        stdoutTarget: stdout.stream,
        stderrTarget: stderr,
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    stderr.destroy();
    try {
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("stderr destination closed");
      expect(stdout.bytes()).toEqual(Buffer.alloc(0));
    } finally {
      stdout.close();
    }
  });

  test("a stalled stderr sink is cut off at the deadline and the child is gone", async () => {
    let childPid: number | undefined;
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    const stdout = capture();
    const stderr = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const startedAt = performance.now();
    try {
      const error = await runSupervisedCommand(
        [
          process.execPath,
          "-e",
          'process.stdout.write("{\\"status\\":\\"PASSED\\"}\\n"); process.stderr.write(Buffer.alloc(1024 * 1024, 0x61)); setInterval(() => {}, 1000);',
        ],
        {
          cwd: repo,
          timeoutMs: 500,
          termGraceMs: 40,
          killWaitMs: 160,
          stdoutTarget: stdout.stream,
          stderrTarget: stderr,
          spawn: ((command: string, args: string[], options: object) => {
            const child = spawn(command, args, options);
            childPid = child.pid;
            return child;
          }) as typeof spawn,
        },
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("exceeded its deadline");
      expect(stdout.bytes()).toEqual(Buffer.alloc(0));
      expect(performance.now() - startedAt).toBeLessThan(1500);
      if (!childPid) throw new Error("synthetic child PID missing");
      await expectProcessNotLive(childPid);
    } finally {
      releaseWrite?.();
      stdout.close();
      stderr.destroy();
    }
  });
});
