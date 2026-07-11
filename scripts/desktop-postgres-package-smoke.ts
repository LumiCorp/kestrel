import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveDesktopPackagerConfig } from "../apps/desktop/src/packageConfig.js";
import { resolveLocalCorePaths } from "../src/localCore/home.js";
import {
  ensureLocalCoreManagedPostgres,
  resolveLocalCorePostgresInstallation,
} from "../src/localCore/postgres.js";

const repoRoot = resolveRepoRoot(process.cwd());
const packagerConfig = resolveDesktopPackagerConfig({ repoRoot });
const packagedRoot = process.env.KESTREL_DESKTOP_PACKAGE_PATH?.trim()
  || path.join(
    packagerConfig.outDir,
    `${packagerConfig.appName}-${packagerConfig.platform}-${packagerConfig.arch}`,
  );
const bundleRootPath = process.env.KESTREL_DESKTOP_POSTGRES_BUNDLE_PATH?.trim()
  || resolvePackagedBundleRoot(packagedRoot, packagerConfig.platform);
const smokeRoot = mkdtempSync(path.join(resolveSmokeTempParent(), "kdp-db-"));
const paths = resolveLocalCorePaths(smokeRoot);

let smokeFailure: Error | undefined;
let successMessage: string | undefined;
try {
  const ready = await ensureLocalCoreManagedPostgres({ paths, bundleRootPath });
  assert.equal(ready.status.state, "healthy", ready.status.lastError?.message);
  assert.equal(ready.status.managed, true);
  assert.equal(ready.status.running, true);
  assert.equal("databaseUrl" in ready, true);
  successMessage = `[desktop-postgres-package-smoke] passed: ${ready.status.socketPath}:${String(ready.status.port)}`;
} catch (error) {
  if (existsSync(paths.postgresLogPath)) {
    process.stderr.write(
      `[desktop-postgres-package-smoke] postgres log:\n${readFileSync(paths.postgresLogPath, "utf8")}\n`,
    );
  }
  smokeFailure = toError(error);
}
process.stdout.write(`${successMessage}\n`);

let cleanupFailure: Error | undefined;
try {
  await cleanupManagedPostgres(bundleRootPath, smokeRoot);
  rmSync(smokeRoot, { recursive: true, force: true });
} catch (error) {
  cleanupFailure = toError(error);
  process.stderr.write(
    `[desktop-postgres-package-smoke] cleanup failed; retained isolated state at ${smokeRoot}\n`,
  );
}

if (smokeFailure !== undefined && cleanupFailure !== undefined) {
  throw new AggregateError(
    [smokeFailure, cleanupFailure],
    "Packaged Desktop Postgres smoke and cleanup both failed.",
  );
}
if (smokeFailure !== undefined) {
  throw smokeFailure;
}
if (cleanupFailure !== undefined) {
  throw cleanupFailure;
}

async function cleanupManagedPostgres(bundleRoot: string, fixtureRoot: string): Promise<void> {
  const errors: Error[] = [];
  try {
    await stopManagedPostgres(bundleRoot);
  } catch (error) {
    errors.push(toError(error));
  }
  try {
    await stopSmokeProcesses(fixtureRoot);
  } catch (error) {
    errors.push(toError(error));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Packaged Desktop Postgres smoke cleanup failed.");
  }
}

async function stopManagedPostgres(bundleRoot: string): Promise<void> {
  const installation = await resolveLocalCorePostgresInstallation({ bundleRootPath: bundleRoot });
  if (installation === undefined || existsSync(path.join(paths.postgresDataPath, "PG_VERSION")) === false) {
    return;
  }
  execFileSync(installation.pgCtlPath, [
    "stop",
    "-D",
    paths.postgresDataPath,
    "-m",
    "fast",
    "-w",
  ], {
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: installation.libDir,
      PATH: `${installation.binDir}:${process.env.PATH ?? ""}`,
    },
    stdio: "ignore",
  });
}

async function stopSmokeProcesses(fixtureRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pids = listSmokeProcessIds(fixtureRoot);
    if (pids.length === 0) {
      return;
    }
    const signal: NodeJS.Signals = attempt < 8 ? "SIGTERM" : "SIGKILL";
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const remaining = listSmokeProcessIds(fixtureRoot);
  if (remaining.length > 0) {
    throw new Error(`Postgres smoke processes did not exit: ${remaining.join(", ")}.`);
  }
}

function listSmokeProcessIds(fixtureRoot: string): number[] {
  const fixturePaths = new Set([
    path.resolve(fixtureRoot),
    realpathSync(fixtureRoot),
  ]);
  const output = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (
      match?.[1] === undefined
      || match[2] === undefined
      || [...fixturePaths].some((fixturePath) => match[2]?.includes(fixturePath)) === false
    ) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid && Number.isInteger(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

function resolveSmokeTempParent(): string {
  return process.platform === "darwin" ? "/tmp" : tmpdir();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function resolvePackagedBundleRoot(packagedPath: string, platform: string): string {
  if (platform === "darwin") {
    return path.join(packagedPath, "Kestrel.app", "Contents", "Resources", "postgres-bundle");
  }
  return path.join(packagedPath, "resources", "postgres-bundle");
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}
