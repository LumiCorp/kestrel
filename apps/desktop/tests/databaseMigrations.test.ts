import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  resolveDesktopMigrationEnvironment,
  runDesktopDatabaseMigrations,
} from "../src/databaseMigrations.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.process", "runDesktopDatabaseMigrations runs root migration script with desktop database url", async () => {
  const spawned: Array<{ command: string; args: string[]; cwd: string; databaseUrl: string | undefined }> = [];
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    const env = options.env as NodeJS.ProcessEnv;
    spawned.push({
      command,
      args,
      cwd: String(options.cwd),
      databaseUrl: env.DATABASE_URL,
    });
    return createChildProcess(0);
  }) as unknown as typeof import("node:child_process").spawn;

  await runDesktopDatabaseMigrations({
    repoRoot: "/repo",
    databaseUrl: "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
    env: { PATH: "/usr/bin" },
    spawnImpl,
  });

  assert.deepEqual(spawned, [
    {
      command: process.execPath,
      args: ["--import", "tsx", "/repo/scripts/migrate.ts"],
      cwd: "/repo",
      databaseUrl: "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
    },
  ]);
});

contractTest("desktop.process", "runDesktopDatabaseMigrations surfaces migration failures", async () => {
  const spawnImpl = (() =>
    createChildProcess(1, {
      stderr: "relation already exists",
    })) as unknown as typeof import("node:child_process").spawn;

  await assert.rejects(
    () =>
      runDesktopDatabaseMigrations({
        repoRoot: "/repo",
        databaseUrl: "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
        spawnImpl,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "desktop.database_migration_failed");
      assert.match(String((error as { details?: string }).details), /relation already exists/u);
      return true;
    },
  );
});

contractTest("desktop.process", "resolveDesktopMigrationEnvironment enables node mode under Electron", () => {
  const env = resolveDesktopMigrationEnvironment(
    { PATH: "/usr/bin" },
    "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
    {
      ...process.versions,
      electron: "37.2.6",
    },
  );

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.DATABASE_URL, "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel");
  assert.equal(env.KESTREL_DESKTOP_APP, "1");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
});

function createChildProcess(
  code: number,
  output: { stdout?: string | undefined; stderr?: string | undefined } = {},
): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  child.stdin = null;
  child.kill = () => true;
  queueMicrotask(() => {
    if (output.stdout !== undefined) {
      child.stdout?.emit("data", output.stdout);
    }
    if (output.stderr !== undefined) {
      child.stderr?.emit("data", output.stderr);
    }
    child.emit("close", code);
  });
  return child;
}
