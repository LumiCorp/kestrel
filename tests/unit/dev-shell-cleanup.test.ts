import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cleanupDevShellServices } from "../../src/devshell/cleanup.js";
import { DEV_SHELL_BOOTSTRAP_STATUS_FILE } from "../../src/devshell/paths.js";

test("cleanupDevShellServices dry-run reports owner-exited services without signalling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-cleanup-"));
  const serviceDir = path.join(root, "service");
  await mkdir(serviceDir, { recursive: true });
  await writeFile(
    path.join(serviceDir, DEV_SHELL_BOOTSTRAP_STATUS_FILE),
    JSON.stringify({
      pid: process.pid,
      ownerPid: 99_999_999,
      ownerKind: "ks",
      socketPath: path.join(serviceDir, "supervisor.sock"),
    }),
    "utf8",
  );

  const result = await cleanupDevShellServices({
    roots: [root],
    apply: false,
    verifyServiceProcess: () => true,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.staleReason, "owner_process_exited");
  assert.equal(result.candidates[0]?.action, "would_signal");
  assert.equal(result.candidates[0]?.pid, process.pid);
});

test("cleanupDevShellServices refuses to signal unverified stale pids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-cleanup-"));
  await writeFile(
    path.join(root, DEV_SHELL_BOOTSTRAP_STATUS_FILE),
    JSON.stringify({
      pid: process.pid,
      ownerPid: 99_999_999,
      ownerKind: "ks",
      socketPath: path.join(root, "supervisor.sock"),
    }),
    "utf8",
  );

  const result = await cleanupDevShellServices({
    roots: [root],
    apply: true,
    verifyServiceProcess: () => false,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.staleReason, "owner_process_exited");
  assert.equal(result.candidates[0]?.action, "none");
  assert.match(result.candidates[0]?.error ?? "", /did not match/u);
});

test("cleanupDevShellServices reports missing owner metadata without signalling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-dev-shell-cleanup-"));
  await writeFile(
    path.join(root, DEV_SHELL_BOOTSTRAP_STATUS_FILE),
    JSON.stringify({
      pid: process.pid,
      socketPath: path.join(root, "supervisor.sock"),
    }),
    "utf8",
  );

  const result = await cleanupDevShellServices({
    roots: [root],
    apply: true,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.staleReason, "missing_owner");
  assert.equal(result.candidates[0]?.action, "none");
});
