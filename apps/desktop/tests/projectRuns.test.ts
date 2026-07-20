import assert from "node:assert/strict";
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DesktopProjectRunRegistry,
  readProjectLauncherDescriptor,
} from "../src/projectRuns.js";

async function createProjectFixture(input: {
  packageJson?: string | undefined;
} = {}): Promise<string> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "kestrel-desktop-project-"));
  await mkdir(projectPath, { recursive: true });
  if (input.packageJson !== undefined) {
    await writeFile(path.join(projectPath, "package.json"), input.packageJson, "utf8");
  }
  return projectPath;
}

test("readProjectLauncherDescriptor returns undefined when package.json is missing", async () => {
  const projectPath = await createProjectFixture();
  const descriptor = await readProjectLauncherDescriptor({ projectPath });
  assert.equal(descriptor, undefined);
});

test("readProjectLauncherDescriptor returns undefined when package.json has no scripts", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({ name: "fixture" }),
  });
  const descriptor = await readProjectLauncherDescriptor({ projectPath });
  assert.equal(descriptor, undefined);
});

test("readProjectLauncherDescriptor rejects invalid package.json", async () => {
  const projectPath = await createProjectFixture({
    packageJson: "{invalid json",
  });
  await assert.rejects(
    () => readProjectLauncherDescriptor({ projectPath }),
    /could not be parsed/i,
  );
});

test("readProjectLauncherDescriptor reads scripts and supported packageManager", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "next dev",
        test: "vitest",
      },
    }),
  });
  const descriptor = await readProjectLauncherDescriptor({ projectPath });

  assert.equal(descriptor?.projectPath, projectPath);
  assert.equal(descriptor?.packageManager, "pnpm");
  assert.equal(descriptor?.packageManagerSelectionRequired, false);
  assert.deepEqual(descriptor?.scripts.map((entry) => entry.name), ["dev", "test"]);
});

test("readProjectLauncherDescriptor requires selection when packageManager is missing", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      scripts: {
        dev: "next dev",
      },
    }),
  });
  const descriptor = await readProjectLauncherDescriptor({ projectPath });

  assert.equal(descriptor?.packageManager, undefined);
  assert.equal(descriptor?.packageManagerSelectionRequired, true);
});

test("readProjectLauncherDescriptor accepts a packageManager override when packageManager is missing", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      scripts: {
        dev: "next dev",
      },
    }),
  });
  const descriptor = await readProjectLauncherDescriptor({
    projectPath,
    packageManagerOverride: "npm",
  });

  assert.equal(descriptor?.packageManager, "npm");
  assert.equal(descriptor?.packageManagerSelectionRequired, false);
});

test("readProjectLauncherDescriptor preserves unsupported packageManager values", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "yarn@1.22.22",
      scripts: {
        dev: "next dev",
      },
    }),
  });
  const descriptor = await readProjectLauncherDescriptor({ projectPath });

  assert.equal(descriptor?.packageManager, undefined);
  assert.equal(descriptor?.unsupportedPackageManager, "yarn@1.22.22");
});

test("DesktopProjectRunRegistry starts, tracks, restarts, and stops managed runs", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "next dev",
        lint: "eslint .",
      },
    }),
  });

  const spawned: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    detached: boolean | undefined;
    stdout: PassThrough;
    stderr: PassThrough;
    emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  }> = [];
  const runsChanged: string[][] = [];

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 100;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      queueMicrotask(() => {
        child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
      });
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({
      command,
      args,
      cwd: options.cwd as string | undefined,
      detached: options.detached as boolean | undefined,
      stdout,
      stderr,
      emitExit(code, signal) {
        queueMicrotask(() => {
          child.emit("exit", code, signal ?? null);
        });
      },
    });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
    onRunsChanged(runs) {
      runsChanged.push(runs.map((run) => `${run.scriptName}:${run.status}:${run.pendingAction ?? "none"}`));
    },
  });

  const firstRun = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  const secondRun = await registry.startRun({
    projectPath,
    scriptName: "lint",
  });

  assert.equal(spawned[0]?.command, "pnpm.cmd");
  assert.deepEqual(spawned[0]?.args, ["run", "dev"]);
  assert.equal(spawned[0]?.cwd, projectPath);
  assert.equal(spawned[0]?.detached, undefined);
  assert.equal(spawned[1]?.command, "pnpm.cmd");
  assert.deepEqual(spawned[1]?.args, ["run", "lint"]);

  const duplicateDevRun = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  assert.equal(duplicateDevRun.runId, firstRun.runId);
  assert.equal(spawned.length, 2);

  spawned[0]?.stdout.write("ready on 43100\n");
  spawned[1]?.stderr.write("lint warning\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const runningSnapshot = registry.listRuns();
  assert.equal(runningSnapshot.length, 2);
  assert.equal(runningSnapshot.find((run) => run.runId === firstRun.runId)?.stdoutTail[0], "ready on 43100");
  assert.equal(runningSnapshot.find((run) => run.runId === secondRun.runId)?.stderrTail[0], "lint warning");

  const restartedRun = await registry.restartRun(firstRun.runId);
  assert.notEqual(restartedRun.runId, firstRun.runId);
  assert.equal(restartedRun.scriptName, "dev");
  assert.equal(spawned[2]?.command, "pnpm.cmd");
  assert.deepEqual(spawned[2]?.args, ["run", "dev"]);

  spawned[2]?.emitExit(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const completedSnapshot = registry.listRuns().find((run) => run.runId === restartedRun.runId);
  assert.equal(completedSnapshot?.status, "completed");
  assert.equal(completedSnapshot?.exitCode, 0);

  const stoppedRun = await registry.stopRun(secondRun.runId);
  assert.equal(stoppedRun?.status, "stopped");
  assert.equal(registry.listRuns().find((run) => run.runId === secondRun.runId)?.status, "stopped");
  assert.ok(runsChanged.some((snapshot) => snapshot.includes("dev:completed:none")));
  assert.ok(runsChanged.some((snapshot) => snapshot.includes("dev:stopping:restart")));
  assert.ok(runsChanged.some((snapshot) => snapshot.includes("lint:stopping:stop")));
  assert.ok(runsChanged.some((snapshot) => snapshot.includes("lint:stopped:none")));
});

test("DesktopProjectRunRegistry records emitted HTTP preview URLs deterministically", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "vite --host 0.0.0.0",
      },
    }),
  });

  const spawned: Array<{
    stdout: PassThrough;
    stderr: PassThrough;
  }> = [];
  const timestamps = [
    "2026-05-12T12:00:00.000Z",
    "2026-05-12T12:00:01.000Z",
    "2026-05-12T12:00:02.000Z",
    "2026-05-12T12:00:03.000Z",
  ];

  const spawnImpl = (() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 500;
    child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({ stdout, stderr });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
    now: () => new Date(timestamps.shift() ?? "2026-05-12T12:00:04.000Z"),
  });

  const run = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  spawned[0]?.stdout.write("Local: http://localhost:5173/\n");
  spawned[0]?.stderr.write("Network: https://preview.example.test/app\n");
  spawned[0]?.stdout.write("Local again: http://localhost:5173/\n");
  spawned[0]?.stdout.write("Ignore file:///tmp/index.html and javascript:alert(1)\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const snapshot = registry.listRuns().find((entry) => entry.runId === run.runId);

  assert.equal(snapshot?.primaryPreviewUrl, "http://localhost:5173/");
  assert.deepEqual(
    snapshot?.previewUrls?.map((entry) => ({
      url: entry.url,
      source: entry.source,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      line: entry.line,
      count: entry.count,
    })),
    [
      {
        url: "http://localhost:5173/",
        source: "stdout",
        firstSeenAt: "2026-05-12T12:00:01.000Z",
        lastSeenAt: "2026-05-12T12:00:03.000Z",
        line: "Local again: http://localhost:5173/",
        count: 2,
      },
      {
        url: "https://preview.example.test/app",
        source: "stderr",
        firstSeenAt: "2026-05-12T12:00:02.000Z",
        lastSeenAt: "2026-05-12T12:00:02.000Z",
        line: "Network: https://preview.example.test/app",
        count: 1,
      },
    ],
  );
});

test("DesktopProjectRunRegistry batches noisy output notifications and flushes on exit", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "vite",
      },
    }),
  });

  const spawned: Array<{
    stdout: PassThrough;
    emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  }> = [];
  const runSnapshots: string[][] = [];
  const ledgerWrites: string[][] = [];

  const spawnImpl = (() => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 700;
    child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({
      stdout,
      emitExit(code, signal) {
        queueMicrotask(() => {
          child.emit("exit", code, signal ?? null);
        });
      },
    });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
    flushIntervalMs: 25,
    onRunsChanged(runs) {
      runSnapshots.push(runs.map((run) => `${run.status}:${run.stdoutTail.length}`));
    },
    ledger: {
      async readRuns() {
        return [];
      },
      async writeRuns(runs) {
        ledgerWrites.push(runs.map((run) => `${run.status}:${run.stdoutTail.length}`));
      },
    },
  });

  const run = await registry.startRun({ projectPath, scriptName: "dev" });
  spawned[0]?.stdout.write("one\n");
  spawned[0]?.stdout.write("two\n");
  spawned[0]?.stdout.write("three\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(registry.listRuns().find((entry) => entry.runId === run.runId)?.stdoutTail.length, 3);
  assert.deepEqual(runSnapshots, [["running:0"]]);
  assert.deepEqual(ledgerWrites, [["running:0"]]);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(runSnapshots.at(-1), ["running:3"]);
  assert.deepEqual(ledgerWrites.at(-1), ["running:3"]);

  spawned[0]?.stdout.write("four\n");
  spawned[0]?.emitExit(0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(runSnapshots.at(-1), ["completed:4"]);
  assert.deepEqual(ledgerWrites.at(-1), ["completed:4"]);
});

test("DesktopProjectRunRegistry stopAll waits for the terminal ledger flush", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "vite",
      },
    }),
  });
  const spawned: Array<{
    emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  }> = [];
  let releaseFinalWrite: (() => void) | undefined;
  let terminalWriteStarted = false;
  let stopAllResolved = false;

  const spawnImpl = (() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 800;
    child.kill = (() => {
      queueMicrotask(() => {
        child.emit("exit", 0, "SIGTERM");
      });
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({
      emitExit(code, signal) {
        child.emit("exit", code, signal ?? null);
      },
    });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
    ledger: {
      async readRuns() {
        return [];
      },
      async writeRuns(runs) {
        if (runs.some((run) => run.status === "stopped")) {
          terminalWriteStarted = true;
          await new Promise<void>((resolve) => {
            releaseFinalWrite = resolve;
          });
        }
      },
    },
  });

  await registry.startRun({ projectPath, scriptName: "dev" });
  const stopAllPromise = registry.stopAll().then(() => {
    stopAllResolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(terminalWriteStarted, true);
  assert.equal(stopAllResolved, false);

  releaseFinalWrite?.();
  await stopAllPromise;
  assert.equal(stopAllResolved, true);
});

test("DesktopProjectRunRegistry resolves previews only for recorded credential-free HTTP URLs", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "next dev",
      },
    }),
  });

  const spawned: Array<{ stdout: PassThrough }> = [];
  const spawnImpl = (() => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 600;
    child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({ stdout });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
  });

  const run = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  spawned[0]?.stdout.write("Ready: http://localhost:3000\n");
  spawned[0]?.stdout.write("Ignored: http://user:secret@localhost:3001\n");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    registry.listRuns().find((entry) => entry.runId === run.runId)?.previewUrls?.map((entry) => entry.url),
    ["http://localhost:3000/"],
  );
  assert.equal(registry.resolvePreviewUrl({ runId: run.runId }).url, "http://localhost:3000/");
  await assert.rejects(
    async () => registry.resolvePreviewUrl({
      runId: run.runId,
      url: "https://not-recorded.example.test/",
    }),
    /only open URLs emitted/u,
  );
});

test("DesktopProjectRunRegistry restarts the current live attempt when restart is invoked from history", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "next dev",
      },
    }),
  });

  const spawned: Array<{
    command: string;
    args: string[];
    cwd: string | undefined;
    emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void;
  }> = [];

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = stdout as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = stderr as ChildProcessWithoutNullStreams["stderr"];
    child.pid = spawned.length + 300;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      queueMicrotask(() => {
        child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
      });
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    spawned.push({
      command,
      args,
      cwd: options.cwd as string | undefined,
      emitExit(code, signal) {
        queueMicrotask(() => {
          child.emit("exit", code, signal ?? null);
        });
      },
    });
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "win32",
  });

  const firstRun = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  const secondRun = await registry.restartRun(firstRun.runId);

  assert.notEqual(secondRun.runId, firstRun.runId);
  assert.equal(spawned.length, 2);

  const thirdRun = await registry.restartRun(firstRun.runId);

  assert.notEqual(thirdRun.runId, firstRun.runId);
  assert.notEqual(thirdRun.runId, secondRun.runId);
  assert.equal(thirdRun.scriptName, "dev");
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2]?.command, "pnpm.cmd");
  assert.deepEqual(spawned[2]?.args, ["run", "dev"]);

  const runs = registry.listRuns();
  assert.equal(runs.find((run) => run.runId === firstRun.runId)?.status, "stopped");
  assert.equal(runs.find((run) => run.runId === secondRun.runId)?.status, "stopped");
  assert.equal(runs.find((run) => run.runId === thirdRun.runId)?.status, "running");

  spawned[2]?.emitExit(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("DesktopProjectRunRegistry fails runs when spawn emits an error and stop resolves without the force-kill delay", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "npm@10.8.2",
      scripts: {
        dev: "next dev",
        test: "node --test",
      },
    }),
  });

  const children: Array<EventEmitter & ChildProcessWithoutNullStreams> = [];
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];

  const spawnImpl = ((command: string, args: string[]) => {
    assert.equal(command, "npm.cmd");
    assert.equal(args[0], "run");
    const child = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.pid = children.length + 200;
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      queueMicrotask(() => {
        child.emit("exit", null, typeof signal === "string" ? signal : "SIGTERM");
      });
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    children.push(child);
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({ spawnImpl, platform: "win32" });

  const failedRun = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  children[0]?.emit("error", new Error("spawn EPERM"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const failedSnapshot = registry.listRuns().find((run) => run.runId === failedRun.runId);
  assert.equal(failedSnapshot?.status, "failed");
  assert.match(failedSnapshot?.stderrTail.join("\n") ?? "", /spawn EPERM/);

  const runningRun = await registry.startRun({
    projectPath,
    scriptName: "test",
  });
  const stoppedRun = await registry.stopRun(runningRun.runId);

  assert.equal(stoppedRun?.status, "stopped");
  assert.equal(killSignals.at(-1), "SIGTERM");
});

test("DesktopProjectRunRegistry signals the owned process group on POSIX stops", async () => {
  const projectPath = await createProjectFixture({
    packageJson: JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.12.2",
      scripts: {
        dev: "next dev",
      },
    }),
  });

  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let childRef: (EventEmitter & ChildProcessWithoutNullStreams) | undefined;
  let detachedFlag: boolean | undefined;

  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    assert.equal(command, "pnpm");
    assert.deepEqual(args, ["run", "dev"]);
    detachedFlag = options.detached as boolean | undefined;
    const child = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.pid = 4242;
    child.kill = (() => {
      assert.fail("expected POSIX stop path to use process-group signalling before child.kill fallback");
    }) as ChildProcessWithoutNullStreams["kill"];
    child.once = child.once.bind(child);
    child.on = child.on.bind(child);
    childRef = child;
    return child;
  }) as typeof spawn;

  const registry = new DesktopProjectRunRegistry({
    spawnImpl,
    platform: "darwin",
    killProcessImpl(pid, signal) {
      groupSignals.push({ pid, signal });
      if (signal === "SIGTERM") {
        queueMicrotask(() => {
          childRef?.emit("exit", null, "SIGTERM");
        });
      }
    },
  });

  const run = await registry.startRun({
    projectPath,
    scriptName: "dev",
  });
  const stopped = await registry.stopRun(run.runId);

  assert.equal(detachedFlag, true);
  assert.equal(stopped?.status, "stopped");
  assert.deepEqual(groupSignals, [{ pid: -4242, signal: "SIGTERM" }]);
});
