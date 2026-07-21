import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ManagedRunnerTransport,
  resolveDesktopRunnerCommand,
  resolveDesktopRunnerEnvironment,
} from "../src/runnerTransport.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.process", "resolveDesktopRunnerCommand targets the runner entrypoint", () => {
  const command = resolveDesktopRunnerCommand("/repo");
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, ["--import", "tsx", "/repo/cli/runner/main.ts"]);
});

contractTest("desktop.process", "resolveDesktopRunnerEnvironment enables node mode under Electron", () => {
  const env = resolveDesktopRunnerEnvironment(
    { PATH: "/usr/bin" },
    {
      ...process.versions,
      electron: "37.2.6",
    },
  );

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.KESTREL_DESKTOP_APP, "1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
});

contractTest("desktop.process", "resolveDesktopRunnerEnvironment does not force node mode outside Electron", () => {
  const env = resolveDesktopRunnerEnvironment({ PATH: "/usr/bin" }, process.versions);

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.KESTREL_DESKTOP_APP, "1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

contractTest("desktop.process", "ManagedRunnerTransport applies updated environment on restart", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const seenKeys: string[] = [];
  let exitHandler: ((code: number | null) => void) | undefined;

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ["--import", "tsx", "/repo/cli/runner/main.ts"]);
    seenKeys.push((options.env as NodeJS.ProcessEnv).OPENROUTER_API_KEY ?? "");

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = stdin as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = 4242;
    child.kill = () => {
      queueMicrotask(() => {
        exitHandler?.(0);
        child.emit("exit", 0);
      });
      return true;
    };
    const baseOn = child.on.bind(child);
    child.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitHandler = listener as (code: number | null) => void;
      }
      return baseOn(event, listener);
    }) as ChildProcessWithoutNullStreams["on"];
    child.once = child.once.bind(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const transport = new ManagedRunnerTransport({
    repoRoot: "/repo",
    logPath: "/tmp/kestrel-runner.log",
    env: { PATH: "/usr/bin" },
    spawnImpl,
  });

  transport.start({
    onLine() {},
    onExit() {},
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  transport.setEnvironment({ PATH: "/usr/bin", OPENROUTER_API_KEY: "test-key" });
  await transport.restart();

  assert.deepEqual(seenKeys, ["", "test-key"]);
});

contractTest("desktop.process", "ManagedRunnerTransport starts, forwards lines, and restarts cleanly", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exitHandler: ((code: number | null) => void) | undefined;
  let spawnCount = 0;
  let stdinContents = "";
  stdin.on("data", (chunk) => {
    stdinContents += chunk.toString("utf8");
  });

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    spawnCount += 1;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ["--import", "tsx", "/repo/cli/runner/main.ts"]);
    assert.equal(options.cwd, "/repo");
    assert.equal((options.env as NodeJS.ProcessEnv).KESTREL_DESKTOP_APP, "1");

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = stdin as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = 4242;
    child.kill = () => {
      queueMicrotask(() => {
        exitHandler?.(0);
        child.emit("exit", 0);
      });
      return true;
    };
    const baseOn = child.on.bind(child);
    child.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitHandler = listener as (code: number | null) => void;
      }
      return baseOn(event, listener);
    }) as ChildProcessWithoutNullStreams["on"];
    child.once = child.once.bind(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const transport = new ManagedRunnerTransport({
    repoRoot: "/repo",
    logPath: "/tmp/kestrel-runner.log",
    spawnImpl,
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCodes: Array<number | null> = [];
  const observedStdout: string[] = [];
  const observedStderr: string[] = [];
  const observedExitCodes: Array<number | null> = [];

  const releaseObserver = transport.observe({
    onLine(line) {
      observedStdout.push(line);
    },
    onErrorOutput(line) {
      observedStderr.push(line);
    },
    onExit(code) {
      observedExitCodes.push(code);
    },
  });

  transport.start({
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

  stdout.write("runner ready\n");
  stderr.write("warning\n");
  transport.send("ping");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(spawnCount, 1);
  assert.deepEqual(stdoutLines, ["runner ready"]);
  assert.deepEqual(stderrLines, ["warning"]);
  assert.deepEqual(observedStdout, ["runner ready"]);
  assert.deepEqual(observedStderr, ["warning"]);
  assert.equal(stdinContents, "ping\n");
  assert.equal(transport.getStatus().running, true);

  const restartedStatus = await transport.restart();
  assert.equal(spawnCount, 2);
  assert.equal(restartedStatus.running, true);
  assert.equal(restartedStatus.pid, 4242);
  assert.deepEqual(exitCodes, [0]);

  await transport.stop();
  assert.deepEqual(exitCodes, [0, 0]);
  assert.deepEqual(observedExitCodes, [0, 0]);
  assert.equal(transport.getStatus().running, false);
  releaseObserver();
});

contractTest("desktop.process", "ManagedRunnerTransport treats broken stdin pipes as not-started", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let exitHandler: ((code: number | null) => void) | undefined;

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ["--import", "tsx", "/repo/cli/runner/main.ts"]);
    assert.equal(options.cwd, "/repo");

    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = stdin as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = 4242;
    child.kill = () => {
      queueMicrotask(() => {
        exitHandler?.(0);
        child.emit("exit", 0);
      });
      return true;
    };
    const baseOn = child.on.bind(child);
    child.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitHandler = listener as (code: number | null) => void;
      }
      return baseOn(event, listener);
    }) as ChildProcessWithoutNullStreams["on"];
    child.once = child.once.bind(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  const transport = new ManagedRunnerTransport({
    repoRoot: "/repo",
    logPath: "/tmp/kestrel-runner.log",
    spawnImpl,
  });

  transport.start({
    onLine() {},
    onExit() {},
  });

  stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.throws(
    () => transport.send("ping"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "desktop.runner_not_started",
  );
});
