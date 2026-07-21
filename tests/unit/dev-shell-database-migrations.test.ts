import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import {
  resolveDevShellMigrationEnvironment,
  runDevShellDatabaseMigrations,
} from "../../src/devshell/DevShellDatabaseMigrations.js";
import { formatDevShellBootstrapFailureMessage } from "../../src/devshell/bootstrapFailure.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.process", "runDevShellDatabaseMigrations runs root migration script with dev shell database url", async () => {
  const spawned: Array<{
    command: string;
    args: string[];
    cwd: string;
    databaseUrl: string | undefined;
    disableDotEnv: string | undefined;
  }> = [];
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    const env = options.env as NodeJS.ProcessEnv;
    spawned.push({
      command,
      args,
      cwd: String(options.cwd),
      databaseUrl: env.DATABASE_URL,
      disableDotEnv: env.KESTREL_DISABLE_DOTENV,
    });
    return createChildProcess(0);
  }) as unknown as typeof import("node:child_process").spawn;

  await runDevShellDatabaseMigrations({
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
      disableDotEnv: "1",
    },
  ]);
});

contractTest("runtime.process", "runDevShellDatabaseMigrations surfaces migration failures", async () => {
  const spawnImpl = (() =>
    createChildProcess(1, {
      stderr: "column already exists",
    })) as unknown as typeof import("node:child_process").spawn;

  await assert.rejects(
    () =>
      runDevShellDatabaseMigrations({
        repoRoot: "/repo",
        databaseUrl: "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
        spawnImpl,
      }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "DEV_SHELL_MIGRATION_FAILED");
      assert.match(
        String((error as { details?: Record<string, unknown> }).details?.migrationOutput),
        /column already exists/u,
      );
      assert.match(formatDevShellBootstrapFailureMessage(error), /column already exists/u);
      return true;
    },
  );
});

contractTest("runtime.process", "resolveDevShellMigrationEnvironment enables node mode under Electron", () => {
  const env = resolveDevShellMigrationEnvironment(
    { PATH: "/usr/bin" },
    "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel",
    {
      ...process.versions,
      electron: "37.2.6",
    },
  );

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.DATABASE_URL, "postgres://kestrel:kestrel@127.0.0.1:61234/kestrel");
  assert.equal(env.KESTREL_DISABLE_DOTENV, "1");
  assert.equal(env.KESTREL_DEV_SHELL_SERVICE, "1");
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
