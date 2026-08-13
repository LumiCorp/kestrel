import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SHARED_PROCESS_ISOLATION = "shared-process";

export function partitionTestFiles(files, workerCount) {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(
      `test group worker count must be a positive integer; received ${String(workerCount)}`,
    );
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("test group must contain at least one file");
  }
  if (files.some((file) => typeof file !== "string" || file.length === 0)) {
    throw new Error("test group contains an invalid file entry");
  }

  const sorted = [...files].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("test group assigns a file more than once");
  }

  const shards = Array.from(
    { length: Math.min(workerCount, sorted.length) },
    () => [],
  );
  for (const [index, file] of sorted.entries()) {
    shards[index % shards.length].push(file);
  }
  return shards;
}

export async function runFailFastShards(shards, { run, abort }) {
  const active = new Set();
  let firstFailure;
  const executions = shards.map(async (shard, index) => {
    active.add(index);
    try {
      await run(shard, index);
    } catch (error) {
      if (firstFailure === undefined) {
        firstFailure = error;
        for (const activeIndex of active) {
          if (activeIndex !== index) abort(activeIndex);
        }
      }
      throw error;
    } finally {
      active.delete(index);
    }
  });

  await Promise.allSettled(executions);
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
}

export async function runNodeTestGroup({
  files,
  workers,
  isolation,
  prefix = [],
}) {
  if (isolation !== SHARED_PROCESS_ISOLATION) {
    throw new Error(
      `unknown test group isolation '${String(isolation)}'; expected ${SHARED_PROCESS_ISOLATION}`,
    );
  }
  const shards = partitionTestFiles(files, workers);
  const children = new Map();
  const startedAt = Date.now();
  let receivedSignal;

  const terminateShard = (index, signal = "SIGTERM") => {
    const child = children.get(index);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } else if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    } catch {}
  };
  const handleSignal = (signal) => {
    receivedSignal = signal;
    for (const index of children.keys()) terminateShard(index, signal);
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await runFailFastShards(shards, {
      run: (shard, index) =>
        runNodeTestShard({
          files: shard,
          index,
          count: shards.length,
          isolation,
          prefix,
          children,
        }),
      abort: (index) => terminateShard(index),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  if (receivedSignal !== undefined) {
    throw new Error(`test group terminated by ${receivedSignal}`);
  }
  process.stdout.write(
    `[test-group] ${shards.length} shard(s) completed in ${formatMs(Date.now() - startedAt)}\n`,
  );
}

function runNodeTestShard({
  files,
  index,
  count,
  isolation,
  prefix,
  children,
}) {
  const shardNumber = index + 1;
  const startedAt = Date.now();
  process.stdout.write(
    `[test-group] shard ${shardNumber}/${count}: ${files.length} file(s)\n`,
  );
  const child = spawn(
    process.execPath,
    [
      ...(isolation === SHARED_PROCESS_ISOLATION
        ? ["--experimental-test-isolation=none"]
        : []),
      ...prefix,
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...files,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    },
  );
  children.set(index, child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      children.delete(index);
      reject(error);
    };
    child.once("error", (error) => {
      fail(
        new Error(`test group shard ${shardNumber}/${count} failed to start`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      children.delete(index);
      process.stdout.write(
        `[test-group] shard ${shardNumber}/${count} completed in ${formatMs(Date.now() - startedAt)}\n`,
      );
      if (code === 0) resolve();
      else if (signal) {
        reject(
          new Error(
            `test group shard ${shardNumber}/${count} ended from ${signal}`,
          ),
        );
      } else {
        reject(
          new Error(
            `test group shard ${shardNumber}/${count} failed with exit ${code ?? 1}`,
          ),
        );
      }
    });
  });
}

function parseArguments(args) {
  let workers;
  let isolation;
  let section = "options";
  const prefix = [];
  const files = [];

  for (const argument of args) {
    if (argument === "--prefix") {
      section = "prefix";
      continue;
    }
    if (argument === "--files") {
      section = "files";
      continue;
    }
    if (section === "prefix") {
      prefix.push(argument);
      continue;
    }
    if (section === "files") {
      files.push(argument);
      continue;
    }
    if (argument.startsWith("--workers=")) {
      workers = Number(argument.slice("--workers=".length));
      continue;
    }
    if (argument.startsWith("--isolation=")) {
      isolation = argument.slice("--isolation=".length);
      continue;
    }
    throw new Error(`unknown test group argument '${argument}'`);
  }

  return { files, workers, isolation, prefix };
}

function formatMs(value) {
  return `${(value / 1000).toFixed(1)}s`;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    await runNodeTestGroup(parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `[test-group] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
