import assert from "node:assert/strict";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { RunnerProcess, resolveRunnerCommandForTests } from "../../cli/client/RunnerProcess.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.process", "resolveRunnerCommandForTests prefers source runner for ts module path", () => {
  const modulePath = "/repo/cli/client/RunnerProcess.ts";
  const sourceRunnerPath = "/repo/cli/runner/main.ts";
  const distRunnerPath = "/repo/cli/runner/main.js";
  const tsxImportPath = "tsx";

  const resolved = resolveRunnerCommandForTests({
    modulePath,
    fileExists: (candidate) => candidate === sourceRunnerPath || candidate === distRunnerPath,
    tsxImportPath,
  });

  assert.deepEqual(resolved.args, ["--import", tsxImportPath, sourceRunnerPath]);
});

contractTest("runtime.process", "resolveRunnerCommandForTests prefers dist runner for js module path", () => {
  const modulePath = "/repo/dist/cli/client/RunnerProcess.js";
  const sourceRunnerPath = "/repo/dist/cli/runner/main.ts";
  const distRunnerPath = "/repo/dist/cli/runner/main.js";

  const resolved = resolveRunnerCommandForTests({
    modulePath,
    fileExists: (candidate) => candidate === sourceRunnerPath || candidate === distRunnerPath,
  });

  assert.deepEqual(resolved.args, [distRunnerPath]);
});

contractTest("runtime.process", "resolveRunnerCommandForTests is independent of process cwd", () => {
  const originalCwd = process.cwd();
  const modulePath = "/repo/cli/client/RunnerProcess.ts";
  const sourceRunnerPath = "/repo/cli/runner/main.ts";
  const tsxImportPath = "tsx";

  try {
    process.chdir(path.dirname(originalCwd));
    const resolved = resolveRunnerCommandForTests({
      modulePath,
      fileExists: (candidate) => candidate === sourceRunnerPath,
      tsxImportPath,
    });
    assert.deepEqual(resolved.args, ["--import", tsxImportPath, sourceRunnerPath]);
  } finally {
    process.chdir(originalCwd);
  }
});

contractTest("runtime.process", "RunnerProcess resolves tsx to an absolute import path for child startup", () => {
  const child = createMockChild();
  const spawnArgs: Array<[string, string[], { cwd?: string } | undefined]> = [];
  const runner = new RunnerProcess({
    spawnImpl: ((command: string, args: string[], options?: { cwd?: string }) => {
      spawnArgs.push([command, args, options]);
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  runner.start({
    onLine() {},
    onExit() {},
    onErrorOutput() {},
  });

  const [, args] = spawnArgs[0] ?? [];
  assert.equal(args?.[0], "--import");
  assert.match(args?.[1] ?? "", /^file:\/\//u);
  assert.match(args?.[2] ?? "", /\/cli\/runner\/main\.ts$/u);
});

contractTest("runtime.process", "RunnerProcess resolves tsx absolutely when loaded through createRequire", () => {
  const child = createMockChild();
  const spawnArgs: Array<[string, string[], { cwd?: string } | undefined]> = [];
  const requireFromProtocolClient = createRequire(
    new URL("../../cli/client/ProtocolClient.ts", import.meta.url),
  );
  const { RunnerProcess: RequiredRunnerProcess } = requireFromProtocolClient(
    "./RunnerProcess.js",
  ) as typeof import("../../cli/client/RunnerProcess.js");
  const runner = new RequiredRunnerProcess({
    spawnImpl: ((command: string, args: string[], options?: { cwd?: string }) => {
      spawnArgs.push([command, args, options]);
      return child;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  runner.start({
    onLine() {},
    onExit() {},
    onErrorOutput() {},
  });

  const [, args] = spawnArgs[0] ?? [];
  assert.equal(args?.[0], "--import");
  assert.match(args?.[1] ?? "", /^file:\/\//u);
  assert.notEqual(args?.[1], "tsx");
  assert.match(args?.[2] ?? "", /\/cli\/runner\/main\.ts$/u);
});

contractTest("runtime.process", "RunnerProcess wires stdout and stderr through the transport handlers", async () => {
  const child = createMockChild();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCodes: Array<number | null> = [];
  const runner = new RunnerProcess({
    spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
  });

  runner.start({
    onLine(line) {
      stdoutLines.push(line);
    },
    onExit(code) {
      exitCodes.push(code);
    },
    onErrorOutput(line) {
      stderrLines.push(line);
    },
  });

  (child.stdout as unknown as PassThrough).write("ready\n");
  (child.stderr as unknown as PassThrough).write("warning\n");
  await tick();

  assert.deepEqual(stdoutLines, ["ready"]);
  assert.deepEqual(stderrLines, ["warning"]);
  assert.deepEqual(exitCodes, []);
});

contractTest("runtime.process", "RunnerProcess clears listeners and allows restart after unexpected exit", async () => {
  const firstChild = createMockChild();
  const secondChild = createMockChild();
  let spawnCount = 0;
  const stdoutLines: string[] = [];
  const exitCodes: Array<number | null> = [];
  const runner = new RunnerProcess({
    spawnImpl: (() => {
      spawnCount += 1;
      return spawnCount === 1 ? firstChild : secondChild;
    }) as unknown as typeof import("node:child_process").spawn,
  });

  const handlers = {
    onLine(line: string) {
      stdoutLines.push(line);
    },
    onExit(code: number | null) {
      exitCodes.push(code);
    },
    onErrorOutput() {},
  };

  runner.start(handlers);
  (firstChild.stdout as unknown as PassThrough).write("first\n");
  await tick();
  firstChild.emit("close", 1, null);
  await tick();

  assert.deepEqual(stdoutLines, ["first"]);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(readPrivate<ChildProcessWithoutNullStreams | undefined>(runner, "child"), undefined);
  assert.equal(readPrivate(runner, "stdoutReader"), undefined);
  assert.equal(readPrivate(runner, "stderrReader"), undefined);
  assert.equal(readPrivate(runner, "handlers"), undefined);
  assert.equal(firstChild.listenerCount("close"), 0);
  assert.equal(firstChild.listenerCount("error"), 0);

  runner.start(handlers);
  (secondChild.stdout as unknown as PassThrough).write("second\n");
  await tick();
  secondChild.emit("close", 0, null);
  await tick();

  assert.deepEqual(stdoutLines, ["first", "second"]);
  assert.deepEqual(exitCodes, [1, 0]);
});

contractTest("runtime.process", "RunnerProcess surfaces child error diagnostics and finalizes once", async () => {
  const child = createMockChild();
  const diagnostics: string[] = [];
  const exitCodes: Array<number | null> = [];
  const runner = new RunnerProcess({
    spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
  });

  runner.start({
    onLine() {},
    onExit(code) {
      exitCodes.push(code);
    },
    onErrorOutput(line) {
      diagnostics.push(line);
    },
  });

  child.emit("error", new Error("spawn ENOENT"));
  child.emit("close", null, null);
  await tick();

  assert.equal(diagnostics.some((line) => line.includes("spawn ENOENT")), true);
  assert.deepEqual(exitCodes, [null]);
  assert.equal(readPrivate(runner, "child"), undefined);
});

contractTest("runtime.process", "RunnerProcess stop escalates to SIGKILL after timeout", async () => {
  const diagnostics: string[] = [];
  const exitCodes: Array<number | null> = [];
  const child = createMockChild({
    onKill(signal) {
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          child.emit("close", null, "SIGKILL");
        });
      }
    },
  });
  const runner = new RunnerProcess({
    spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
    stopTimeoutMs: 5,
  });

  runner.start({
    onLine() {},
    onExit(code) {
      exitCodes.push(code);
    },
    onErrorOutput(line) {
      diagnostics.push(line);
    },
  });

  await runner.stop();

  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(
    diagnostics.some((line) => line.includes("sending SIGKILL")),
    true,
  );
  assert.deepEqual(exitCodes, [null]);
  assert.equal(readPrivate(runner, "child"), undefined);
});

contractTest("runtime.process", "RunnerProcess stop is idempotent and resolves through a single exit path", async () => {
  const child = createMockChild({
    onKill(signal) {
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          child.emit("close", 0, null);
        });
      }
    },
  });
  const exitCodes: Array<number | null> = [];
  const runner = new RunnerProcess({
    spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
  });

  runner.start({
    onLine() {},
    onExit(code) {
      exitCodes.push(code);
    },
    onErrorOutput() {},
  });

  const firstStop = runner.stop();
  const secondStop = runner.stop();
  assert.equal(firstStop, secondStop);

  await Promise.all([firstStop, secondStop]);

  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.deepEqual(exitCodes, [0]);
  assert.equal(readPrivate(runner, "child"), undefined);
  assert.equal(firstStop, secondStop);
});

function createMockChild(input: {
  onKill?: ((signal: NodeJS.Signals) => void) | undefined;
} = {}): ChildProcessWithoutNullStreams & {
  killCalls: NodeJS.Signals[];
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    killCalls: NodeJS.Signals[];
  };
  child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
  child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
  child.killCalls = [];
  child.kill = ((signal?: number | NodeJS.Signals) => {
    const resolved = (typeof signal === "string" ? signal : "SIGTERM") as NodeJS.Signals;
    child.killCalls.push(resolved);
    input.onKill?.(resolved);
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];
  Object.defineProperty(child, "pid", {
    configurable: true,
    enumerable: true,
    value: 4242,
  });
  return child;
}

function readPrivate<TValue>(value: unknown, key: string): TValue | undefined {
  return (value as Record<string, TValue>)[key];
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
