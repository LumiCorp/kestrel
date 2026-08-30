import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { InMemoryDevShellStore } from "../../src/devshell/InMemoryDevShellStore.js";
import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import {
  DEFAULT_DEV_SHELL_DISABLED_CONFIG,
  type DevShellOutputChunk,
  type DevShellProcessRecord,
  type DevShellProcessStatus,
  type DevShellProcessStore,
} from "../../src/devshell/contracts.js";


const TEST_COMMAND_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function readProcessUntilTerminal(input: {
  supervisor: DevShellSupervisor;
  processId: string;
  timeoutMs: number;
  pollWaitMs?: number | undefined;
  cursor?: number | undefined;
}) {
  const deadline = Date.now() + input.timeoutMs;
  let result = await input.supervisor.readProcess({
    processId: input.processId,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    waitMs: input.pollWaitMs ?? 200,
    maxBytes: 4096,
  });
  while (result.status === "RUNNING" && Date.now() < deadline) {
    result = await input.supervisor.readProcess({
      processId: input.processId,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      waitMs: input.pollWaitMs ?? 200,
      maxBytes: 4096,
    });
  }
  return result;
}

async function readProcessUntilText(input: {
  supervisor: DevShellSupervisor;
  processId: string;
  expectedText: string;
  timeoutMs: number;
  cursor: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  let result = await input.supervisor.readProcess({
    processId: input.processId,
    cursor: input.cursor,
    waitMs: 200,
    maxBytes: 4096,
  });
  while (!result.text.includes(input.expectedText) && Date.now() < deadline) {
    result = await input.supervisor.readProcess({
      processId: input.processId,
      cursor: input.cursor,
      waitMs: 200,
      maxBytes: 4096,
    });
  }
  return result;
}

test("dev shell default maxReadBytes is generous enough for medium file reads", () => {
  assert.equal(DEFAULT_DEV_SHELL_DISABLED_CONFIG.maxReadBytes, 131_072);
});

test("DevShellSupervisor defaults its state directory under ~/ KESTREL_HOME", () => {
  const previous = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = "~/kestrel-dev-shell-supervisor-home";
  try {
    const supervisor = new DevShellSupervisor(new InMemoryDevShellStore());
    assert.equal(
      (supervisor as unknown as { baseDir: string }).baseDir,
      path.join(os.homedir(), "kestrel-dev-shell-supervisor-home", "dev-shell"),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previous;
    }
  }
});

test("DevShellSupervisor rejects missing workspace roots during exec preflight", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-supervisor-"));
  const supervisor = new DevShellSupervisor(new InMemoryDevShellStore(), path.join(baseDir, "state"));
  await supervisor.initialize();
  try {
    await assert.rejects(
      () => supervisor.runCommand({
        workspaceRoot: path.join(baseDir, "does-not-exist"),
        command: "echo nope",
        allowedEnvNames: [],
      }),
      /active workspace is unavailable/u,
    );
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor returns completed command output without a processId", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'first-line\\nsecond-line\\n'",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /first-line/);
    assert.match(result.text, /second-line/);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor rejects requested cwd outside the workspace root", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    await assert.rejects(
      () => supervisor.runCommand({
        workspaceRoot,
        cwd: "../outside-workspace",
        command: "pwd",
        timeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 4096,
      }),
      /resolves outside the active workspace/u,
    );
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor points an invalid sessionId to the active command and cwd", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 30",
      yieldTimeMs: 10,
    });
    assert.equal(started.status, "RUNNING");
    await assert.rejects(
      () => supervisor.readProcess({ processId: "mistyped-session", waitMs: 0 }),
      (error: unknown) => {
        assert.match(String(error), new RegExp(started.processId!));
        assert.match(String(error), /sleep 30/u);
        assert.match(String(error), /cwd '\.'/u);
        assert.match(String(error), /Reuse the matching sessionId/u);
        return true;
      },
    );
    await supervisor.stopProcess({ processId: started.processId!, waitMs: 100 });
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor observes stdout and stderr chunks without changing command output", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const chunks: DevShellOutputChunk[] = [];
  try {
    const result = await supervisor.runCommand(
      {
        workspaceRoot,
        command: "printf 'out-line\\n'; printf 'err-line\\n' >&2",
        timeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxOutputBytes: 4096,
      },
      {
        outputObserver: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    assert.equal(result.status, "COMPLETED");
    assert.match(result.text, /out-line/u);
    assert.match(result.text, /err-line/u);
    assert.equal(chunks.some((chunk) => chunk.channel === "stdout" && /out-line/u.test(chunk.text)), true);
    assert.equal(chunks.some((chunk) => chunk.channel === "stderr" && /err-line/u.test(chunk.text)), true);
    assert.equal(chunks.every((chunk) => chunk.processId !== undefined), true);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor does not block command completion on console observers", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  let releaseObserver: (() => void) | undefined;
  let observerResolved = false;
  let observerStartedResolve: (() => void) | undefined;
  const observerStarted = new Promise<void>((resolve) => {
    observerStartedResolve = resolve;
  });
  const observerGate = new Promise<void>((resolve) => {
    releaseObserver = () => {
      observerResolved = true;
      resolve();
    };
  });
  const runPromise = supervisor.runCommand(
    {
      workspaceRoot,
      command: "printf 'done\\n'",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    },
    {
      outputObserver: async () => {
        observerStartedResolve?.();
        await observerGate;
      },
    },
  );
  try {
    await resolveWithin(observerStarted, 1000, "outputObserver was not invoked");
    const result = await resolveWithin(runPromise, 1000, "runCommand awaited the output observer");

    assert.equal(result.status, "COMPLETED");
    assert.match(result.text, /done/u);
    assert.equal(observerResolved, false);
  } finally {
    releaseObserver?.();
    await runPromise.catch(() => {});
    await supervisor.close();
  }
});

test("DevShellSupervisor returns nonzero command exits as failed process results", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'bad input\\n'; exit 7",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 7);
    assert.match(result.text, /bad input/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor observes through the initial window after early output", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'starting\\n'; sleep 0.02; printf 'done\\n'",
      yieldTimeMs: 500,
      maxOutputBytes: 4096,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.processId, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.text, "starting\ndone\n");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor fails fast for multiline run commands", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'before\\n'\nfalse\nprintf 'after\\n'",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 1);
    assert.equal(result.commandKind, "multi_line");
    assert.equal(result.strictModeApplied, true);
    assert.equal(result.strictModeReason, "multi_line_fail_fast");
    assert.equal(result.failurePhase, "command");
    assert.match(result.failureReason ?? "", /Strict multi-line shell command failed fast/u);
    assert.match(result.text, /before/u);
    assert.doesNotMatch(result.text, /after/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor does not let a later passing command hide multiline setup failure", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'setup failed\\n'\nfalse\nprintf 'pytest passed\\n'",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 1);
    assert.equal(result.strictModeApplied, true);
    assert.match(result.text, /setup failed/u);
    assert.doesNotMatch(result.text, /pytest passed/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor starts pnpm dev without hidden package-manager commands", async () => {
  const { supervisor, workspaceRoot, baseDir } = await createSupervisor();
  const fake = await createFakePnpm(baseDir);
  const restore = installFakePnpmEnv(fake);
  try {
    const result = await supervisor.startProcess({
      workspaceRoot,
      command: "pnpm dev",
      yieldTimeMs: 200,
      maxOutputBytes: 4096,
      envMode: "inherit",
    });

    assert.equal(result.status, "RUNNING");
    assert.equal(typeof result.processId, "string");
    if (result.processId !== undefined) {
      const observed = await readProcessUntilText({
        supervisor,
        processId: result.processId,
        expectedText: "requested:dev",
        timeoutMs: TEST_COMMAND_TIMEOUT_MS,
        cursor: 0,
      });
      assert.match(observed.text, /requested:dev/u);
      assert.deepEqual(await readFakePnpmLog(fake.logPath), ["dev"]);
      await supervisor.stopProcess({ processId: result.processId, waitMs: 1000 });
    }
  } finally {
    restore();
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard fails and restores unauthorized shell writes", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'changed' > app/page.tsx",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 126);
    assert.match(result.failureReason ?? "", /unauthorized source writes/u);
    assert.deepEqual(result.unauthorizedSourceWrites?.map((item) => item.path), ["app/page.tsx"]);
    assert.equal(result.unauthorizedSourceWrites?.[0]?.kind, "modified");
    assert.equal(result.unauthorizedSourceWrites?.[0]?.restored, true);
    assert.equal(await readFile(pagePath, "utf8"), "original");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard ignores its own state under the workspace", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-nested-state-"));
  const workspaceRootPath = path.join(baseDir, "workspace");
  const stateDir = path.join(workspaceRootPath, ".local", "share", "kestrel", "dev-shell");
  await mkdir(workspaceRootPath, { recursive: true });
  const workspaceRoot = await realpath(workspaceRootPath);
  const supervisor = new DevShellSupervisor(new InMemoryDevShellStore(), stateDir);
  await supervisor.initialize();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf nested-state-ok",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
        mutationPolicy: "reject",
      },
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.exitCode, 0);
    assert.equal(result.text, "nested-state-ok");
    assert.deepEqual(result.unauthorizedSourceWrites, undefined);
    assert.deepEqual(result.sourceWriteGuard?.allowedWriteRoots, []);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard excludes Kestrel internal state but still rejects adjacent source writes", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const pagePath = path.join(workspaceRoot, "app", "page.tsx");
  await mkdir(path.dirname(pagePath), { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const internalOnly = await supervisor.startProcess({
      workspaceRoot,
      command: "mkdir -p .kestrel/runtime .local/share/kestrel/state/0.6; printf 'db' > .kestrel/runtime/runtime.db; printf 'log' > .kestrel/runtime/runner.log; printf 'legacy' > .local/share/kestrel/state/0.6/runtime.db; sleep 5",
      yieldTimeMs: 300,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });

    assert.equal(internalOnly.status, "RUNNING");
    assert.notEqual(internalOnly.processId, undefined);
    if (internalOnly.processId !== undefined) {
      await supervisor.stopProcess({ processId: internalOnly.processId });
    }

    const sourceWrite = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'changed' > app/page.tsx; sleep 5",
      yieldTimeMs: 300,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });
    const sourceResult = sourceWrite.status === "RUNNING" && sourceWrite.processId !== undefined
      ? await readProcessUntilTerminal({
          supervisor,
          processId: sourceWrite.processId,
          timeoutMs: TEST_COMMAND_TIMEOUT_MS,
        })
      : sourceWrite;

    assert.equal(sourceResult.status, "FAILED");
    assert.equal(sourceResult.exitCode, 126);
    assert.deepEqual(sourceResult.unauthorizedSourceWrites?.map((item) => item.path), ["app/page.tsx"]);
    assert.equal(await readFile(pagePath, "utf8"), "original");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard removes created directories after restoring files", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const generatedDir = path.join(workspaceRoot, "generated");
  const generatedFile = path.join(generatedDir, "nested", "file.txt");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "mkdir -p generated/nested && printf 'new' > generated/nested/file.txt",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 126);
    const restoredWrites = result.unauthorizedSourceWrites ?? [];
    assert.ok(restoredWrites.some((item) => item.path === "generated/nested/file.txt" && item.restored === true));
    await assert.rejects(() => readFile(generatedFile, "utf8"));
    await assert.rejects(() => readdir(generatedDir));
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor rejects source-write authority before spawning source-readonly commands", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  try {
    await assert.rejects(
      () =>
        supervisor.runCommand({
          workspaceRoot,
          command: "printf 'changed' > app/page.tsx",
          timeoutMs: TEST_COMMAND_TIMEOUT_MS,
          maxOutputBytes: 4096,
          sourceWriteAuthority: "source_write",
          sourceWriteGuard: {
            enabled: true,
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "DEV_SHELL_SOURCE_WRITE_AUTHORITY_DENIED");
        assert.match((error as Error).message, /source_readonly/u);
        return true;
      },
    );
    await assert.rejects(() => readFile(pagePath, "utf8"));
    await assert.rejects(
      () =>
        supervisor.runCommand({
          workspaceRoot,
          command: "printf 'changed' > app/page.tsx",
          timeoutMs: TEST_COMMAND_TIMEOUT_MS,
          maxOutputBytes: 4096,
          sourceWriteAuthority: "source_write",
          sourceWriteGuard: {
            enabled: false,
          },
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "DEV_SHELL_SOURCE_WRITE_AUTHORITY_DENIED");
        assert.match((error as Error).message, /disabled/u);
        return true;
      },
    );
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard stops and restores unauthorized managed process writes", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'changed' > app/page.tsx; sleep 5",
      yieldTimeMs: 300,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });

    let result = started;
    if (started.status === "RUNNING" && started.processId !== undefined) {
      result = await readProcessUntilTerminal({
        supervisor,
        processId: started.processId,
        timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      });
    }

    assert.equal(result.status, "FAILED");
    assert.match(result.failureReason ?? "", /unauthorized source writes/u);
    assert.deepEqual(result.unauthorizedSourceWrites?.map((item) => item.path), ["app/page.tsx"]);
    assert.equal(await readFile(pagePath, "utf8"), "original");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard allows a matching per-command approved path", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  const command = "printf 'changed' > app/page.tsx";
  const sourceWriteGuard = {
    enabled: true,
    approvalGrants: [{
      grantId: "grant-1",
      command,
      writablePaths: ["app/page.tsx"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }],
  };
  await mkdir(appDir, { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command,
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.sourceWriteGuard?.mode, "approved_source_write");
    assert.equal(result.sourceWriteGuard?.approvedGrantId, "grant-1");
    assert.deepEqual(result.unauthorizedSourceWrites, undefined);
    assert.equal(await readFile(pagePath, "utf8"), "changed");

    await writeFile(pagePath, "original", "utf8");
    const repeated = await supervisor.runCommand({
      workspaceRoot,
      command,
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard,
    });
    assert.equal(repeated.status, "FAILED");
    assert.match(repeated.failureReason ?? "", /unauthorized source writes/u);
    assert.equal(await readFile(pagePath, "utf8"), "original");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor allows source workspace writes when the workspace root is explicitly writable", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'changed' > app/page.tsx",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteAuthority: "source_write",
      sourceWriteGuard: {
        enabled: true,
        allowedWriteRoots: [workspaceRoot],
      },
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.sourceWriteGuard?.mode, "approved_source_write");
    assert.deepEqual(result.unauthorizedSourceWrites, undefined);
    assert.equal(await readFile(pagePath, "utf8"), "changed");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor source-write guard protects managed worktree gitfile", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const gitFilePath = path.join(workspaceRoot, ".git");
  await writeFile(gitFilePath, "gitdir: /tmp/kestrel-worktree-gitdir\n", "utf8");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "find . -mindepth 1 -maxdepth 1 ! -name .kestrel -exec rm -rf {} +",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
      },
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 126);
    assert.match(result.failureReason ?? "", /unauthorized source writes/u);
    assert.deepEqual(result.unauthorizedSourceWrites?.map((item) => item.path), [".git"]);
    assert.equal(result.unauthorizedSourceWrites?.[0]?.kind, "deleted");
    assert.equal(result.unauthorizedSourceWrites?.[0]?.restored, true);
    assert.equal(await readFile(gitFilePath, "utf8"), "gitdir: /tmp/kestrel-worktree-gitdir\n");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor allows source writes in managed checkpoint worktree mode", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  await writeFile(pagePath, "original", "utf8");
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'changed' > app/page.tsx",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
        managedWorktree: true,
      },
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.sourceWriteGuard?.mode, "checkpoint_worktree");
    assert.deepEqual(result.unauthorizedSourceWrites, undefined);
    assert.equal(await readFile(pagePath, "utf8"), "changed");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor capture mode restores source and returns an exact patch", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const appDir = path.join(workspaceRoot, "app");
  const pagePath = path.join(appDir, "page.tsx");
  await mkdir(appDir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: workspaceRoot });
  await writeFile(pagePath, "original\n", "utf8");
  await execFileAsync("git", ["add", "app/page.tsx"], { cwd: workspaceRoot });
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'changed\\n' > app/page.tsx",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
      sourceWriteGuard: {
        enabled: true,
        managedWorktree: true,
        mutationPolicy: "capture",
      },
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.sourceWriteGuard?.mode, "captured_source_write");
    assert.equal(await readFile(pagePath, "utf8"), "original\n");
    assert.match(result.sourceWriteGuard?.capturedPatch ?? "", /a\/app\/page\.tsx/u);
    assert.match(result.sourceWriteGuard?.capturedPatch ?? "", /\+changed/u);
    assert.match(result.sourceWriteGuard?.capturedBaseRevisions?.["app/page.tsx"] ?? "", /^sha256:/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor marks lost guarded processes as not finally source-write checked", async () => {
  const { supervisor, workspaceRoot, baseDir, store } = await createSupervisor();
  let restarted: DevShellSupervisor | undefined;
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 5",
      yieldTimeMs: 10,
      maxOutputBytes: 4096,
      sourceWriteGuard: { enabled: true },
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(started.sourceWriteGuard?.finalCheckCompleted, false);
    const processId = started.processId!;

    restarted = new DevShellSupervisor(store, path.join(baseDir, "state"));
    await restarted.initialize();
    const lost = await restarted.readProcess({ processId, waitMs: 0, maxBytes: 4096 });
    assert.equal(lost.status, "LOST");
    assert.match(lost.failureReason ?? "", /source-write guard final check did not run/u);
    assert.equal(lost.sourceWriteGuard?.finalCheckCompleted, false);
    assert.deepEqual(lost.sourceWriteGuard?.unauthorizedSourceWrites, []);
  } finally {
    await restarted?.close();
    await supervisor.close();
  }
});

test("DevShellSupervisor releases managed worktree process leases during lost-process recovery", async () => {
  const { supervisor, workspaceRoot, baseDir, store } = await createSupervisor();
  let restarted: DevShellSupervisor | undefined;
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 5",
      yieldTimeMs: 10,
      maxOutputBytes: 4096,
    });
    const processId = started.processId!;
    await writeManagedWorktreeSidecar(workspaceRoot, processId);

    restarted = new DevShellSupervisor(store, path.join(baseDir, "state"));
    await restarted.initialize();

    const metadata = JSON.parse(await readFile(`${workspaceRoot}.binding.json`, "utf8")) as Record<string, unknown>;
    assert.deepEqual(metadata.activeProcesses, []);
    assert.equal(metadata.currentLease, undefined);
  } finally {
    await restarted?.close();
    await supervisor.close();
  }
});

test("DevShellSupervisor returns timed-out one-shot runs as failed process results", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "printf 'controller started\\n'; sleep 5",
      timeoutMs: 500,
      maxOutputBytes: 4096,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.exitCode, 124);
    assert.match(result.text, /controller started/u);
    assert.match(result.failureReason ?? "", /timed out after 500 ms/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor keeps an explicit timeout active after startProcess returns", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'ready\\n'; sleep 5",
      yieldTimeMs: 20,
      timeoutMs: 100,
      maxOutputBytes: 4096,
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(typeof started.processId, "string");

    const settled = await readProcessUntilTerminal({
      supervisor,
      processId: started.processId!,
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
    });
    assert.equal(settled.status, "FAILED");
    assert.equal(settled.exitCode, 124);
    assert.match(settled.failureReason ?? "", /timed out after 100 ms/u);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor does not let a stale running read overwrite a terminal process record", async () => {
  const { supervisor, workspaceRoot, store } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'ready\\n'; sleep 5",
      yieldTimeMs: 20,
      timeoutMs: 100,
      maxOutputBytes: 4096,
    });
    const processId = started.processId!;
    const staleRunningRecord = await store.getProcess(processId);
    assert.equal(staleRunningRecord?.status, "RUNNING");

    const settled = await readProcessUntilTerminal({
      supervisor,
      processId,
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
    });
    assert.equal(settled.status, "FAILED");

    const updated = await (supervisor as unknown as {
      updateStoredProcessRecord(
        record: DevShellProcessRecord,
        transcriptSize: number,
      ): Promise<DevShellProcessRecord>;
    }).updateStoredProcessRecord(staleRunningRecord!, settled.nextCursor);
    assert.equal(updated.status, "FAILED");
    assert.equal(updated.exitCode, 124);
    assert.match(updated.failureReason ?? "", /timed out after 100 ms/u);
    assert.equal((await store.getProcess(processId))?.status, "FAILED");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor clears the original wall timeout when provisional preview retention is acquired", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 30",
      yieldTimeMs: 10,
      timeoutMs: 100,
    });
    const processId = started.processId!;
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview-publish:publication-1",
      kind: "workspace_preview_provisional",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const stillRunning = await supervisor.readProcess({ processId, waitMs: 0 });
    assert.equal(stillRunning.status, "RUNNING");

    const released = await supervisor.releaseProcessRetention({
      leaseId: "workspace-preview-publish:publication-1",
    });
    assert.equal(released.status, "missing");
    const stopped = await supervisor.readProcess({ processId, waitMs: 0 });
    assert.equal(stopped.status, "STOPPED");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor atomically promotes one provisional lease and preserves unrelated authorities", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const processId = started.processId!;
    const provisionalExpiry = new Date(Date.now() + 600_000).toISOString();
    const finalExpiry = new Date(Date.now() + 300_000).toISOString();
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview-publish:publication-1",
      kind: "workspace_preview_provisional",
      expiresAt: provisionalExpiry,
    });
    await supervisor.retainProcess({
      processId,
      leaseId: "finalize:run-1:process-1",
      kind: "standalone",
      expiresAt: provisionalExpiry,
    });

    const promoted = await supervisor.promoteProcessRetention({
      processId,
      fromLeaseId: "workspace-preview-publish:publication-1",
      leaseId: "workspace-preview:preview-1",
      kind: "workspace_preview",
      expiresAt: finalExpiry,
    });

    assert.deepEqual(promoted.leases, [
      {
        leaseId: "finalize:run-1:process-1",
        kind: "standalone",
        expiresAt: provisionalExpiry,
      },
      {
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview",
        expiresAt: finalExpiry,
      },
    ]);
    assert.equal(
      promoted.leases.some((lease) => lease.leaseId === "workspace-preview-publish:publication-1"),
      false,
    );
    await supervisor.releaseProcessRetention({ leaseId: "workspace-preview:preview-1" });
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "RUNNING");
    await supervisor.releaseProcessRetention({ leaseId: "finalize:run-1:process-1" });
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor rejects missing, expired, and mismatched promotion sources without mutation", async () => {
  let now = new Date("2026-08-13T12:00:00.000Z");
  const { supervisor, workspaceRoot, store } = await createSupervisor(() => now);
  try {
    const first = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const second = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const firstProcessId = first.processId!;
    const secondProcessId = second.processId!;
    await supervisor.retainProcess({
      processId: firstProcessId,
      leaseId: "workspace-preview-publish:publication-1",
      kind: "workspace_preview_provisional",
      expiresAt: "2026-08-13T12:10:00.000Z",
    });
    const beforeFirst = await store.getProcess(firstProcessId);
    const beforeSecond = await store.getProcess(secondProcessId);

    for (const input of [
      {
        processId: firstProcessId,
        fromLeaseId: "workspace-preview-publish:missing",
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview" as const,
        expiresAt: "2026-08-13T12:05:00.000Z",
      },
      {
        processId: secondProcessId,
        fromLeaseId: "workspace-preview-publish:publication-1",
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview" as const,
        expiresAt: "2026-08-13T12:05:00.000Z",
      },
    ]) {
      await assert.rejects(
        supervisor.promoteProcessRetention(input),
        (error: unknown) => {
          assert.equal(
            (error as { code?: string }).code,
            "DEV_SHELL_RETENTION_PROMOTION_SOURCE_MISSING",
          );
          return true;
        },
      );
    }
    assert.deepEqual(await store.getProcess(firstProcessId), beforeFirst);
    assert.deepEqual(await store.getProcess(secondProcessId), beforeSecond);

    now = new Date("2026-08-13T12:10:00.000Z");
    await assert.rejects(
      supervisor.promoteProcessRetention({
        processId: firstProcessId,
        fromLeaseId: "workspace-preview-publish:publication-1",
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview",
        expiresAt: "2026-08-13T12:20:00.000Z",
      }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "DEV_SHELL_RETENTION_PROMOTION_SOURCE_MISSING",
        );
        return true;
      },
    );
    assert.deepEqual(await store.getProcess(firstProcessId), beforeFirst);

    await assert.rejects(
      supervisor.promoteProcessRetention({
        processId: "missing-process",
        fromLeaseId: "workspace-preview-publish:publication-1",
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview",
        expiresAt: "2026-08-13T12:20:00.000Z",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "DEV_SHELL_PROCESS_NOT_FOUND");
        return true;
      },
    );
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor rejects promotion after the process has settled", async () => {
  const { supervisor, workspaceRoot, store } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 0.05",
      yieldTimeMs: 5,
    });
    const processId = started.processId!;
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview-publish:publication-1",
      kind: "workspace_preview_provisional",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await readProcessUntilTerminal({
      supervisor,
      processId,
      timeoutMs: 5000,
      pollWaitMs: 25,
    });
    const before = await store.getProcess(processId);
    assert.notEqual(before?.status, "RUNNING");

    await assert.rejects(
      supervisor.promoteProcessRetention({
        processId,
        fromLeaseId: "workspace-preview-publish:publication-1",
        leaseId: "workspace-preview:preview-1",
        kind: "workspace_preview",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "DEV_SHELL_PROCESS_NOT_RUNNING");
        return true;
      },
    );
    assert.deepEqual(await store.getProcess(processId), before);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor restores provisional retention and keeps persistence usable after promotion storage failure", async () => {
  for (const mode of ["before", "after"] as const) {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), `kestrel-promotion-${mode}-`));
    const workspaceRootPath = path.join(baseDir, "workspace");
    await mkdir(workspaceRootPath, { recursive: true });
    const workspaceRoot = await realpath(workspaceRootPath);
    const store = new FaultInjectingDevShellStore();
    const supervisor = new DevShellSupervisor(store, path.join(baseDir, "state"));
    await supervisor.initialize();
    try {
      const started = await supervisor.startProcess({
        workspaceRoot,
        command: "sleep 30",
        yieldTimeMs: 10,
      });
      const processId = started.processId!;
      const provisionalLease = {
        processId,
        leaseId: `workspace-preview-publish:${mode}`,
        kind: "workspace_preview_provisional" as const,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      await supervisor.retainProcess(provisionalLease);
      store.failNextUpsert(mode);

      await assert.rejects(
        supervisor.promoteProcessRetention({
          processId,
          fromLeaseId: provisionalLease.leaseId,
          leaseId: `workspace-preview:${mode}`,
          kind: "workspace_preview",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        /injected promotion persistence failure/u,
      );

      const retained = await supervisor.inspectProcessRetention({ processId });
      assert.deepEqual(
        retained.leases.map((lease) => [lease.leaseId, lease.kind]),
        [[provisionalLease.leaseId, "workspace_preview_provisional"]],
      );
      assert.deepEqual(
        (await store.getProcess(processId))?.retentionLeases.map((lease) => [lease.leaseId, lease.kind]),
        [[provisionalLease.leaseId, "workspace_preview_provisional"]],
      );

      const retried = await supervisor.promoteProcessRetention({
        processId,
        fromLeaseId: provisionalLease.leaseId,
        leaseId: `workspace-preview:${mode}`,
        kind: "workspace_preview",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      assert.deepEqual(
        retried.leases.map((lease) => lease.leaseId),
        [`workspace-preview:${mode}`],
      );
      await supervisor.releaseProcessRetention({ leaseId: `workspace-preview:${mode}` });
    } finally {
      await supervisor.close();
    }
  }
});

test("DevShellSupervisor orders process exit behind a failing promotion without resurrecting retention", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-promotion-exit-"));
  const workspaceRootPath = path.join(baseDir, "workspace");
  await mkdir(workspaceRootPath, { recursive: true });
  const workspaceRoot = await realpath(workspaceRootPath);
  const store = new FaultInjectingDevShellStore();
  const supervisor = new DevShellSupervisor(store, path.join(baseDir, "state"));
  await supervisor.initialize();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 0.08",
      yieldTimeMs: 10,
    });
    const processId = started.processId!;
    const provisionalLeaseId = "workspace-preview-publish:exit";
    await supervisor.retainProcess({
      processId,
      leaseId: provisionalLeaseId,
      kind: "workspace_preview_provisional",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    store.delayAndFailNextUpsert(125);

    await assert.rejects(
      supervisor.promoteProcessRetention({
        processId,
        fromLeaseId: provisionalLeaseId,
        leaseId: "workspace-preview:exit",
        kind: "workspace_preview",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      }),
      /injected delayed promotion persistence failure/u,
    );
    const terminalDeadline = Date.now() + 2_000;
    let record = await store.getProcess(processId);
    while (record?.status === "RUNNING" && Date.now() < terminalDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      record = await store.getProcess(processId);
    }
    assert.notEqual(record?.status, "RUNNING");
    assert.deepEqual(record?.retentionLeases, []);
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor renews an exact lease and retains until the final lease is released", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const processId = started.processId!;
    const firstExpiry = new Date(Date.now() + 5_000).toISOString();
    const renewedExpiry = new Date(Date.now() + 10_000).toISOString();
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview:preview-1",
      kind: "workspace_preview",
      expiresAt: firstExpiry,
    });
    await supervisor.retainProcess({
      processId,
      leaseId: "finalize:run-1:process-1",
      kind: "standalone",
      expiresAt: firstExpiry,
    });
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview:preview-1",
      kind: "workspace_preview",
      expiresAt: renewedExpiry,
    });

    const inspected = await supervisor.inspectProcessRetention({ processId });
    assert.equal(inspected.leases.length, 2);
    assert.equal(
      inspected.leases.find((lease) => lease.leaseId === "workspace-preview:preview-1")?.expiresAt,
      renewedExpiry,
    );
    const afterFirstRelease = await supervisor.releaseProcessRetention({
      leaseId: "workspace-preview:preview-1",
    });
    assert.equal(afterFirstRelease.status, "active");
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "RUNNING");
    await supervisor.releaseProcessRetention({ leaseId: "finalize:run-1:process-1" });
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "STOPPED");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor stops a retained process when its final lease expires", async () => {
  let now = new Date("2026-08-12T12:00:00.000Z");
  const { supervisor, workspaceRoot } = await createSupervisor(() => now);
  try {
    const started = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const processId = started.processId!;
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview:preview-1",
      kind: "workspace_preview",
      expiresAt: "2026-08-12T12:01:00.000Z",
    });
    now = new Date("2026-08-12T12:01:00.000Z");
    await (supervisor as unknown as { expireIdleProcesses(): Promise<void> }).expireIdleProcesses();
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "STOPPED");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor expires an orphaned provisional preview lease after ten minutes", async () => {
  let now = new Date("2026-08-13T12:00:00.000Z");
  const { supervisor, workspaceRoot } = await createSupervisor(() => now);
  try {
    const started = await supervisor.startProcess({ workspaceRoot, command: "sleep 30", yieldTimeMs: 10 });
    const processId = started.processId!;
    await supervisor.retainProcess({
      processId,
      leaseId: "workspace-preview-publish:publication-1",
      kind: "workspace_preview_provisional",
      expiresAt: "2026-08-13T12:10:00.000Z",
    });

    now = new Date("2026-08-13T12:09:59.999Z");
    await (supervisor as unknown as { expireIdleProcesses(): Promise<void> }).expireIdleProcesses();
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "RUNNING");

    now = new Date("2026-08-13T12:10:00.000Z");
    await (supervisor as unknown as { expireIdleProcesses(): Promise<void> }).expireIdleProcesses();
    assert.equal((await supervisor.readProcess({ processId, waitMs: 0 })).status, "STOPPED");
  } finally {
    await supervisor.close();
  }
});

test("InMemoryDevShellStore deep clones source-write guard results", async () => {
  const store = new InMemoryDevShellStore();
  const now = new Date().toISOString();
  await store.upsertProcess({
    processId: "proc-1",
    command: "true",
    status: "FAILED",
    workspaceRoot: "/workspace",
    cwd: "/workspace",
    shellPath: "/bin/sh",
    idleTimeoutMs: 1000,
    maxReadBytes: 4096,
    readiness: {
      workspaceRootExists: true,
      cwdExists: true,
      cwdWithinWorkspace: true,
      shellResolved: true,
      tools: [],
      env: [],
    },
    requestedTools: [],
    envNames: [],
    transcriptPath: "/tmp/transcript.log",
    outputCursor: 0,
    submittedAt: now,
    startedAt: now,
    updatedAt: now,
    expiresAt: now,
    lifecycle: "interactive",
    retentionLeases: [],
    sourceWriteGuard: {
      enabled: true,
      mode: "source_readonly",
      sourceRoots: ["."],
      allowedWriteRoots: [],
      unauthorizedSourceWrites: [{ path: "app/page.tsx", kind: "modified", restored: true }],
      restored: true,
      finalCheckCompleted: true,
    },
  });

  const first = await store.getProcess("proc-1");
  first!.sourceWriteGuard!.unauthorizedSourceWrites[0]!.path = "mutated";
  const second = await store.getProcess("proc-1");
  assert.equal(second!.sourceWriteGuard!.unauthorizedSourceWrites[0]!.path, "app/page.tsx");
});

test("DevShellSupervisor writes arbitrary stdin to a running process and read polls with empty input", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; test \"$line\" = done && break; done",
      yieldTimeMs: 50,
      maxOutputBytes: 4096,
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(typeof started.processId, "string");
    const processId = started.processId!;

    const written = await supervisor.writeProcess({
      processId,
      data: "move N\nmove E\ndone\n",
    });
    assert.equal(written.status, "ACCEPTED");

    const read = await supervisor.readProcess({
      processId,
      waitMs: 500,
      maxBytes: 4096,
    });
    assert.match(read.text, /got:move N/);
    const reread = await supervisor.readProcess({
      processId,
      cursor: read.cursor,
      waitMs: 0,
      maxBytes: 4096,
    });
    assert.equal(reread.text.startsWith(read.text), true);
    let combined = read.text;
    let cursor = read.nextCursor;
    for (let attempt = 0; attempt < 5 && /got:move E/.test(combined) === false; attempt += 1) {
      const next = await supervisor.readProcess({
        processId,
        cursor,
        waitMs: 200,
        maxBytes: 4096,
      });
      combined += next.text;
      cursor = next.nextCursor;
    }
    assert.match(combined, /got:move E/);
    await supervisor.stopProcess({
      processId,
      cursor,
      waitMs: 100,
      maxBytes: 4096,
    });
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor writes stdin and reads resulting output in one process call", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'ready\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; test \"$line\" = done && break; done",
      yieldTimeMs: 5000,
      maxOutputBytes: 4096,
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(typeof started.processId, "string");
    assert.match(started.text, /ready/u);
    const processId = started.processId!;

    const result = await supervisor.writeAndReadProcess({
      processId,
      data: "move N\n",
      waitMs: 5000,
      maxBytes: 4096,
    });

    assert.equal(result.bytesWritten, Buffer.byteLength("move N\n", "utf8"));
    assert.equal(result.status, "RUNNING");
    assert.equal(result.processId, processId);
    assert.match(result.text, /got:move N/u);
    assert.equal(result.cursor, started.nextCursor);
    assert.ok(result.nextCursor > result.cursor);

    await supervisor.writeAndReadProcess({
      processId,
      data: "done\n",
      cursor: result.nextCursor,
      waitMs: 500,
      maxBytes: 4096,
    });
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor delivers a terminal result once and rejects reuse of the settled session", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "printf 'first\\n'; IFS= read -r line; printf 'second\\n'; IFS= read -r line",
      yieldTimeMs: 75,
      maxOutputBytes: 4096,
    });
    assert.equal(started.status, "RUNNING");
    const processId = started.processId!;
    const first = started.text.length > 0
      ? started
      : await readProcessUntilText({
          supervisor,
          processId,
          cursor: started.nextCursor,
          expectedText: "first\n",
          timeoutMs: 5000,
        });
    assert.equal(first.status, "RUNNING");
    assert.equal(first.text, "first\n");

    const continued = await supervisor.writeProcess({ processId, data: "continue\n" });
    assert.equal(continued.status, "ACCEPTED");
    const second = await readProcessUntilText({
      supervisor,
      processId,
      cursor: first.nextCursor,
      expectedText: "second\n",
      timeoutMs: 5000,
    });
    assert.equal(second.status, "RUNNING");
    assert.equal(second.text, "second\n");

    const finished = await supervisor.writeProcess({ processId, data: "done\n" });
    assert.equal(finished.status, "ACCEPTED");
    const terminal = await readProcessUntilTerminal({
      supervisor,
      processId,
      cursor: second.nextCursor,
      timeoutMs: 5000,
      pollWaitMs: 200,
    });
    assert.equal(terminal.status, "COMPLETED");

    await assert.rejects(
      () => supervisor.readProcess({ processId, waitMs: 0, maxBytes: 4096 }),
      (error: unknown) => {
        assert.match(String(error), /terminal result was already delivered/u);
        assert.match(String(error), /Start a new exec_command with command/u);
        assert.match(String(error), /Do not reuse the settled sessionId/u);
        return true;
      },
    );

    const replay = await supervisor.readProcess({ processId, cursor: 0, waitMs: 0, maxBytes: 4096 });
    assert.equal(replay.status, "COMPLETED");
    assert.equal(replay.text, "first\nsecond\n");
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor never regresses a fast terminal process back to running", async () => {
  const { supervisor, workspaceRoot, store } = await createSupervisor();
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = await supervisor.startProcess({
        workspaceRoot,
        command: "printf 'missing runner\\n' >&2; sleep 0.01; exit 1",
        yieldTimeMs: 1,
        maxOutputBytes: 4096,
        sourceWriteGuard: { enabled: true },
      });
      const processId = started.processId;
      const terminal = processId !== undefined
        ? await readProcessUntilTerminal({
            supervisor,
            processId,
            timeoutMs: 5000,
            pollWaitMs: 25,
          })
        : started;
      assert.equal(terminal.status, "FAILED");
      if (processId !== undefined) {
        const stored = await store.getProcess(processId);
        assert.notEqual(stored?.status, "RUNNING");
      }
    }
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor reads transcript chunks on UTF-8 character boundaries", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "node -e \"process.stdout.write('a\\\\u{1F642}b'); setTimeout(() => {}, 5000)\"",
      yieldTimeMs: 5000,
      maxOutputBytes: 4096,
    });
    assert.equal(started.status, "RUNNING");
    assert.equal(typeof started.processId, "string");
    assert.equal(started.text, "a\u{1F642}b");
    const processId = started.processId!;

    const splitRead = await supervisor.readProcess({
      processId,
      cursor: 0,
      maxBytes: 3,
      waitMs: 0,
    });
    assert.equal(splitRead.text, "a\u{1F642}");
    assert.equal(splitRead.text.includes("\uFFFD"), false);
    assert.equal(splitRead.cursor, 0);
    assert.equal(splitRead.nextCursor, Buffer.byteLength("a\u{1F642}", "utf8"));
    assert.equal(splitRead.truncated, true);

    const tinyRead = await supervisor.readProcess({
      processId,
      cursor: Buffer.byteLength("a", "utf8"),
      maxBytes: 1,
      waitMs: 0,
    });
    assert.equal(tinyRead.text, "\u{1F642}");
    assert.equal(tinyRead.text.includes("\uFFFD"), false);
    assert.equal(tinyRead.cursor, Buffer.byteLength("a", "utf8"));
    assert.equal(tinyRead.nextCursor, Buffer.byteLength("a\u{1F642}", "utf8"));

    const continuationCursor = Buffer.byteLength("a", "utf8") + 1;
    const continuationRead = await supervisor.readProcess({
      processId,
      cursor: continuationCursor,
      maxBytes: 4096,
      waitMs: 0,
    });
    assert.equal(continuationRead.text, "b");
    assert.equal(continuationRead.text.includes("\uFFFD"), false);
    assert.equal(continuationRead.cursor, Buffer.byteLength("a\u{1F642}", "utf8"));
    assert.equal(continuationRead.nextCursor, Buffer.byteLength("a\u{1F642}b", "utf8"));

    await supervisor.stopProcess({ processId, waitMs: 100 });
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor exposes the core in-shell client without leaking service control env", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const originalSocketPath = process.env.KESTREL_DEV_SHELL_SOCKET_PATH;
  const originalSecret = process.env.KESTREL_DEV_SHELL_TEST_SECRET;
  const originalCorepackHome = process.env.COREPACK_HOME;
  process.env.KESTREL_DEV_SHELL_SOCKET_PATH = "/tmp/kestrel-dev-shell-test.sock";
  process.env.KESTREL_DEV_SHELL_TEST_SECRET = "do-not-leak";
  process.env.COREPACK_HOME = "/opt/kestrel-corepack";
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: (
        "python3 -c \"import os, kestrel_devshell; " +
        "print(kestrel_devshell.__name__); " +
        "print(os.environ.get('KESTREL_DEV_SHELL_SOCKET_PATH', 'missing')); " +
        "print(os.environ.get('COREPACK_HOME', 'missing')); " +
        "print(os.environ.get('KESTREL_DEV_SHELL_TEST_SECRET', 'missing'))\""
      ),
      envMode: "allowlist",
      timeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxOutputBytes: 4096,
    });
    const finalResult = result;

    assert.equal(finalResult.status, "COMPLETED");
    assert.match(`${result.text}${finalResult.text}`, /kestrel_devshell/u);
    assert.match(`${result.text}${finalResult.text}`, /\/opt\/kestrel-corepack/u);
    assert.match(`${result.text}${finalResult.text}`, /missing/u);
    assert.doesNotMatch(`${result.text}${finalResult.text}`, /\/tmp\/kestrel-dev-shell-test\.sock/u);
    assert.doesNotMatch(`${result.text}${finalResult.text}`, /do-not-leak/u);
  } finally {
    if (originalSocketPath !== undefined) {
      process.env.KESTREL_DEV_SHELL_SOCKET_PATH = originalSocketPath;
    } else {
      delete process.env.KESTREL_DEV_SHELL_SOCKET_PATH;
    }
    if (originalSecret !== undefined) {
      process.env.KESTREL_DEV_SHELL_TEST_SECRET = originalSecret;
    } else {
      delete process.env.KESTREL_DEV_SHELL_TEST_SECRET;
    }
    if (originalCorepackHome !== undefined) {
      process.env.COREPACK_HOME = originalCorepackHome;
    } else {
      delete process.env.COREPACK_HOME;
    }
    await supervisor.close();
  }
});

test("DevShellSupervisor rebinds pnpm workspace env to the resolved workspace root", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "dev-shell-pnpm-workspace-root-"));
  const store = new InMemoryDevShellStore();
  const supervisor = new DevShellSupervisor(store, workspaceRoot);
  const originalWorkspaceDir = process.env.NPM_CONFIG_WORKSPACE_DIR;
  process.env.NPM_CONFIG_WORKSPACE_DIR = "/tmp/source-workspace";
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "node -p 'process.env.NPM_CONFIG_WORKSPACE_DIR'",
      envMode: "inherit",
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.stdout.trim(), workspaceRoot);
  } finally {
    if (originalWorkspaceDir === undefined) {
      delete process.env.NPM_CONFIG_WORKSPACE_DIR;
    } else {
      process.env.NPM_CONFIG_WORKSPACE_DIR = originalWorkspaceDir;
    }
    await supervisor.close();
  }
});

test("DevShellSupervisor strips trusted runner credentials from inherited shell env", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const originalWorkspaceToken = process.env.KESTREL_WORKSPACE_SERVICE_TOKEN;
  const originalRunnerToken = process.env.KESTREL_RUNNER_SERVICE_TOKEN;
  process.env.KESTREL_WORKSPACE_SERVICE_TOKEN = "workspace-secret";
  process.env.KESTREL_RUNNER_SERVICE_TOKEN = "runner-secret";
  try {
    const result = await supervisor.runCommand({
      workspaceRoot,
      command: "node -e \"console.log(process.env.KESTREL_WORKSPACE_SERVICE_TOKEN ?? 'missing'); console.log(process.env.KESTREL_RUNNER_SERVICE_TOKEN ?? 'missing')\"",
      envMode: "inherit",
      envNames: ["KESTREL_WORKSPACE_SERVICE_TOKEN", "KESTREL_RUNNER_SERVICE_TOKEN"],
      timeoutMs: 10_000,
    });

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.stdout.trim(), "missing\nmissing");
  } finally {
    if (originalWorkspaceToken === undefined) delete process.env.KESTREL_WORKSPACE_SERVICE_TOKEN;
    else process.env.KESTREL_WORKSPACE_SERVICE_TOKEN = originalWorkspaceToken;
    if (originalRunnerToken === undefined) delete process.env.KESTREL_RUNNER_SERVICE_TOKEN;
    else process.env.KESTREL_RUNNER_SERVICE_TOKEN = originalRunnerToken;
    await supervisor.close();
  }
});

test("DevShellSupervisor stops a live process and rejects writes after completion", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 30",
      yieldTimeMs: 10,
    });
    assert.equal(started.status, "RUNNING");
    const processId = started.processId!;

    const stopped = await supervisor.stopProcess({ processId, waitMs: 100 });
    assert.equal(stopped.status, "STOPPED");
    assert.equal(stopped.processId, undefined);

    await assert.rejects(
      () => supervisor.writeProcess({ processId, data: "hello\n" }),
      /not running/u,
    );
  } finally {
    await supervisor.close();
  }
});

test("DevShellSupervisor stops descendant processes when stopping a live process", async () => {
  const { supervisor, workspaceRoot } = await createSupervisor();
  const childPidPath = path.join(workspaceRoot, "child.pid");
  let childPid: number | undefined;
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command:
        "node -e 'setInterval(() => {}, 1000)' & echo $! > child.pid; while kill -0 $(cat child.pid) 2>/dev/null; do sleep 1; done",
      yieldTimeMs: 100,
    });
    assert.equal(started.status, "RUNNING");
    await waitForFile(childPidPath, 1000);
    const rawPid = await readFile(childPidPath, "utf8");
    childPid = Number.parseInt(rawPid.trim(), 10);
    assert.equal(Number.isInteger(childPid) && childPid > 0, true);
    assert.equal(isPidRunning(childPid), true);

    const stopped = await supervisor.stopProcess({ processId: started.processId!, waitMs: 1000 });
    assert.equal(stopped.status, "STOPPED");
    await waitForPidExit(childPid, 1000);
    assert.equal(isPidRunning(childPid), false);
  } finally {
    if (childPid !== undefined && isPidRunning(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    await supervisor.close();
  }
});

test("DevShellSupervisor close waits for terminal process persistence to settle", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-close-settlement-"));
  const workspaceRootPath = path.join(baseDir, "workspace");
  await mkdir(workspaceRootPath, { recursive: true });
  const workspaceRoot = await realpath(workspaceRootPath);
  const store = new BlockingTerminalDevShellStore();
  const supervisor = new DevShellSupervisor(store, path.join(baseDir, "state"));
  await supervisor.initialize();
  let closePromise: Promise<void> | undefined;
  try {
    const started = await supervisor.startProcess({
      workspaceRoot,
      command: "sleep 30",
      yieldTimeMs: 50,
    });
    if (started.processId === undefined) throw new Error("missing supervised process id");

    closePromise = supervisor.close();
    await store.terminalWriteStarted;
    let closeSettled = false;
    void closePromise.then(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);

    store.releaseTerminalWrite();
    await closePromise;
    const record = await store.getProcess(started.processId);
    assert.equal(record?.status, "STOPPED");
  } finally {
    store.releaseTerminalWrite();
    await (closePromise ?? supervisor.close());
  }
});

test("shutdown abort terminates a child while its initial process record is pending", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-start-abort-"));
  const workspaceRootPath = path.join(baseDir, "workspace");
  const childPidPath = path.join(workspaceRootPath, "child.pid");
  await mkdir(workspaceRootPath, { recursive: true });
  const workspaceRoot = await realpath(workspaceRootPath);
  const store = new BlockingInitialDevShellStore();
  const supervisor = new DevShellSupervisor(store, path.join(baseDir, "state"));
  const shutdown = new AbortController();
  await supervisor.initialize();
  let runPromise: Promise<unknown> | undefined;
  try {
    runPromise = supervisor.runCommand({
      workspaceRoot,
      command: `${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(childPidPath)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'`,
      timeoutMs: 60_000,
    }, { shutdownSignal: shutdown.signal });
    await store.initialWriteStarted;
    await waitForFile(childPidPath, 1000);
    const childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10);
    assert.equal(isPidRunning(childPid), true);

    shutdown.abort();
    await waitForPidExit(childPid, 2_000);
    assert.equal(isPidRunning(childPid), false);

    store.releaseInitialWrite();
    const result = await runPromise as { status: string; failureReason?: string | undefined };
    assert.equal(result.status, "FAILED");
    assert.match(result.failureReason ?? "", /service shutdown interrupted/u);
  } finally {
    store.releaseInitialWrite();
    await Promise.allSettled([runPromise, supervisor.close()]);
  }
});

async function createSupervisor(now?: () => Date): Promise<{
  supervisor: DevShellSupervisor;
  workspaceRoot: string;
  baseDir: string;
  store: InMemoryDevShellStore;
}> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-supervisor-"));
  const workspaceRootPath = path.join(baseDir, "workspace");
  await mkdir(workspaceRootPath, { recursive: true });
  const workspaceRoot = await realpath(workspaceRootPath);
  const store = new InMemoryDevShellStore();
  const supervisor = new DevShellSupervisor(store, path.join(baseDir, "state"), now);
  await supervisor.initialize();
  return { supervisor, workspaceRoot, baseDir, store };
}

class BlockingTerminalDevShellStore implements DevShellProcessStore {
  private readonly delegate = new InMemoryDevShellStore();
  readonly terminalWriteStarted: Promise<void>;
  private readonly terminalWriteReleased: Promise<void>;
  private resolveTerminalWriteStarted!: () => void;
  private resolveTerminalWriteReleased!: () => void;

  constructor() {
    this.terminalWriteStarted = new Promise((resolve) => {
      this.resolveTerminalWriteStarted = resolve;
    });
    this.terminalWriteReleased = new Promise((resolve) => {
      this.resolveTerminalWriteReleased = resolve;
    });
  }

  releaseTerminalWrite(): void {
    this.resolveTerminalWriteReleased();
  }

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    if (record.status !== "RUNNING") {
      this.resolveTerminalWriteStarted();
      await this.terminalWriteReleased;
    }
    await this.delegate.upsertProcess(record);
  }

  getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    return this.delegate.getProcess(processId);
  }

  listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    return this.delegate.listProcesses(input);
  }
}

class BlockingInitialDevShellStore implements DevShellProcessStore {
  private readonly delegate = new InMemoryDevShellStore();
  readonly initialWriteStarted: Promise<void>;
  private readonly initialWriteReleased: Promise<void>;
  private resolveInitialWriteStarted!: () => void;
  private resolveInitialWriteReleased!: () => void;
  private blocked = false;

  constructor() {
    this.initialWriteStarted = new Promise((resolve) => {
      this.resolveInitialWriteStarted = resolve;
    });
    this.initialWriteReleased = new Promise((resolve) => {
      this.resolveInitialWriteReleased = resolve;
    });
  }

  releaseInitialWrite(): void {
    this.resolveInitialWriteReleased();
  }

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    if (record.status === "RUNNING" && this.blocked === false) {
      this.blocked = true;
      this.resolveInitialWriteStarted();
      await this.initialWriteReleased;
    }
    await this.delegate.upsertProcess(record);
  }

  getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    return this.delegate.getProcess(processId);
  }

  listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    return this.delegate.listProcesses(input);
  }
}

class FaultInjectingDevShellStore implements DevShellProcessStore {
  private readonly delegate = new InMemoryDevShellStore();
  private failure:
    | { mode: "before" | "after"; delayMs: number; message: string }
    | undefined;

  failNextUpsert(mode: "before" | "after"): void {
    this.failure = {
      mode,
      delayMs: 0,
      message: "injected promotion persistence failure",
    };
  }

  delayAndFailNextUpsert(delayMs: number): void {
    this.failure = {
      mode: "before",
      delayMs,
      message: "injected delayed promotion persistence failure",
    };
  }

  async upsertProcess(record: DevShellProcessRecord): Promise<void> {
    const failure = this.failure;
    this.failure = undefined;
    if (failure !== undefined && failure.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, failure.delayMs));
    }
    if (failure?.mode === "before") throw new Error(failure.message);
    await this.delegate.upsertProcess(record);
    if (failure?.mode === "after") throw new Error(failure.message);
  }

  getProcess(processId: string): Promise<DevShellProcessRecord | null> {
    return this.delegate.getProcess(processId);
  }

  listProcesses(input?: {
    status?: DevShellProcessStatus[] | undefined;
  }): Promise<DevShellProcessRecord[]> {
    return this.delegate.listProcesses(input);
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPidRunning(pid) === false) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await stat(filePath);
}

async function writeManagedWorktreeSidecar(worktreeRoot: string, processId: string): Promise<void> {
  const now = new Date().toISOString();
  await writeFile(
    `${worktreeRoot}.binding.json`,
    `${JSON.stringify({
      version: 2,
      createdBySessionId: "session-1",
      sourceWorkspaceRoot: worktreeRoot,
      sourceRepoRoot: worktreeRoot,
      worktreeRoot,
      baseHead: "HEAD",
      lastObservedSourceHead: "HEAD",
      bindingKey: "binding",
      scope: { kind: "taskKey", value: "task-1" },
      currentLease: {
        leaseId: "lease-1",
        sessionId: "session-1",
        runId: "run-1",
        acquiredAt: now,
        kind: "process",
      },
      activeProcesses: [{
        processId,
        sessionId: "session-1",
        runId: "run-1",
        startedAt: now,
      }],
      bindings: [{
        sessionId: "session-1",
        firstBoundAt: now,
        lastBoundAt: now,
      }],
      dirtyState: {
        dirty: false,
        porcelain: "",
        checkedAt: now,
      },
      createdAt: now,
    }, null, 2)}\n`,
    "utf8",
  );
}

async function createFakePnpm(baseDir: string): Promise<{ binDir: string; logPath: string }> {
  const binDir = path.join(baseDir, "fake-bin");
  const logPath = path.join(baseDir, "fake-pnpm.log");
  const pnpmPath = path.join(binDir, "pnpm");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    pnpmPath,
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$PNPM_FAKE_LOG\"",
      "printf 'requested:%s\\n' \"$*\"",
      "if [ \"$1\" = \"dev\" ]; then",
      "  while :; do sleep 1; done",
      "fi",
    ].join("\n"),
    "utf8",
  );
  await chmod(pnpmPath, 0o755);
  await writeFile(logPath, "", "utf8");
  return { binDir, logPath };
}

function installFakePnpmEnv(
  fake: { binDir: string; logPath: string },
): () => void {
  const previousPath = process.env.PATH;
  const previousLog = process.env.PNPM_FAKE_LOG;
  const previousShell = process.env.SHELL;
  process.env.PATH = `${fake.binDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.PNPM_FAKE_LOG = fake.logPath;
  process.env.SHELL = "/bin/sh";
  return () => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousLog === undefined) {
      delete process.env.PNPM_FAKE_LOG;
    } else {
      process.env.PNPM_FAKE_LOG = previousLog;
    }
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  };
}

async function readFakePnpmLog(logPath: string): Promise<string[]> {
  const raw = await readFile(logPath, "utf8");
  return raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}
