import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalDevShellService } from "../../../dist/src/devshell/LocalDevShellService.js";

const baseDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-packaged-dev-shell-"));
const previousStoreDriver = process.env.KESTREL_STORE_DRIVER;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousKestrelHome = process.env.KESTREL_HOME;
const service = new LocalDevShellService(path.join(baseDir, "supervisor"), {
  startupTimeoutMs: 30_000,
  pollIntervalMs: 25,
});

try {
  process.env.KESTREL_STORE_DRIVER = "sqlite";
  delete process.env.DATABASE_URL;
  process.env.KESTREL_HOME = path.join(baseDir, "runtime-home");
  const result = await service.runCommand({
    workspaceRoot: baseDir,
    command: "printf packaged-ok",
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.text, "packaged-ok");
  process.stdout.write("packaged-ok\n");
} finally {
  await service.close();
  await rm(baseDir, { recursive: true, force: true });
  if (previousStoreDriver === undefined) delete process.env.KESTREL_STORE_DRIVER;
  else process.env.KESTREL_STORE_DRIVER = previousStoreDriver;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousKestrelHome === undefined) delete process.env.KESTREL_HOME;
  else process.env.KESTREL_HOME = previousKestrelHome;
}
