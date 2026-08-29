import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquireDevShellBootstrapAuthority,
  createDevShellBootstrapAuthorityToken,
} from "../../src/devshell/bootstrapAuthority.js";

test("developer-shell bootstrap authority excludes another process and recovers exact dead ownership", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-process-"),
  );
  const authorityPath = path.join(root, "bootstrap-authority");
  const moduleUrl = pathToFileURL(
    path.resolve("src/devshell/bootstrapAuthority.ts"),
  ).href;
  const tsxImport = createRequire(import.meta.url).resolve("tsx");
  const childScript = `
    import { acquireDevShellBootstrapAuthority } from ${JSON.stringify(moduleUrl)};
    const result = await acquireDevShellBootstrapAuthority({
      authorityPath: ${JSON.stringify(authorityPath)},
      ownerToken: "child-owner",
      timeoutMs: 1000,
      pollIntervalMs: 5,
    });
    if (result.status !== "acquired") process.exit(2);
    process.stdout.write("acquired\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--import", tsxImport, "--input-type=module", "-e", childScript],
    { stdio: ["ignore", "pipe", "inherit"] },
  );

  try {
    await waitForOutput(child, "acquired\n");
    const refused = await acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "parent-waiter",
      timeoutMs: 30,
      pollIntervalMs: 2,
    });
    assert.deepEqual(refused, {
      status: "unavailable",
      reason: "wait_timeout",
      ownerPid: child.pid,
    });

    child.kill("SIGKILL");
    await waitForExit(child);

    const recovered = await acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "parent-recovery",
      timeoutMs: 100,
      pollIntervalMs: 2,
    });
    assert.equal(recovered.status, "acquired");
    if (recovered.status === "acquired") {
      await recovered.lease.release();
    }
  } finally {
    if (isChildRunning(child)) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  }
});

test("developer-shell bootstrap authority distinguishes same-process instances by token", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-token-"),
  );
  const authorityPath = path.join(root, "bootstrap-authority");
  const first = await acquireDevShellBootstrapAuthority({
    authorityPath,
    ownerToken: createDevShellBootstrapAuthorityToken(),
    timeoutMs: 100,
    pollIntervalMs: 2,
  });
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;

  const secondPromise = acquireDevShellBootstrapAuthority({
    authorityPath,
    ownerToken: createDevShellBootstrapAuthorityToken(),
    timeoutMs: 500,
    pollIntervalMs: 2,
  });
  await first.lease.release();
  const second = await secondPromise;
  assert.equal(second.status, "acquired");
  if (second.status === "acquired") {
    await second.lease.release();
  }
});

test("bootstrap authority release preserves an exact replacement target", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-replace-"),
  );
  const authorityPath = path.join(root, "bootstrap-authority");
  const acquired = await acquireDevShellBootstrapAuthority({
    authorityPath,
    ownerToken: "original-owner",
    timeoutMs: 100,
    pollIntervalMs: 2,
  });
  assert.equal(acquired.status, "acquired");
  if (acquired.status !== "acquired") return;

  const ownerEvidencePath = path.join(authorityPath, "owner");
  await rm(ownerEvidencePath);
  await symlink(
    `kestrel-dev-shell-bootstrap-v1:${process.pid}:replacement-owner`,
    ownerEvidencePath,
  );
  await acquired.lease.release();

  assert.equal(
    await readlink(ownerEvidencePath),
    `kestrel-dev-shell-bootstrap-v1:${process.pid}:replacement-owner`,
  );
});

test("dead authority with an unowned cleanup marker fails within the caller deadline", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-stuck-cleanup-"),
  );
  const authorityPath = path.join(root, "bootstrap-authority");
  await mkdir(authorityPath);
  await symlink(
    "kestrel-dev-shell-bootstrap-v1:2147483647:dead-owner",
    path.join(authorityPath, "owner"),
  );
  await writeFile(path.join(authorityPath, "cleanup"), "", "utf8");

  const startedAt = Date.now();
  const result = await acquireDevShellBootstrapAuthority({
    authorityPath,
    ownerToken: "waiting-owner",
    timeoutMs: 30,
    pollIntervalMs: 2,
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "invalid_owner_evidence",
    ownerPid: 2147483647,
  });
  assert.ok(Date.now() - startedAt < 1_000);
});

async function waitForOutput(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("child output timed out")),
      5_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`child exited before acquiring authority: ${code}`));
    });
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function isChildRunning(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
