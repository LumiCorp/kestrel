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
  assert.equal(await first.lease.verify(), true);

  const secondPromise = acquireDevShellBootstrapAuthority({
    authorityPath,
    ownerToken: createDevShellBootstrapAuthorityToken(),
    timeoutMs: 500,
    pollIntervalMs: 2,
  });
  await first.lease.release();
  assert.equal(await first.lease.verify(), false);
  const second = await secondPromise;
  assert.equal(second.status, "acquired");
  if (second.status === "acquired") {
    await second.lease.release();
  }
});

test("concurrent publication with identical owner evidence uses private staging paths", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-same-evidence-"),
  );
  const authorityPath = path.join(root, "bootstrap-authority");
  const attempts = await Promise.all([
    acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "shared-owner",
      timeoutMs: 30,
      pollIntervalMs: 2,
    }),
    acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "shared-owner",
      timeoutMs: 30,
      pollIntervalMs: 2,
    }),
  ]);

  assert.equal(attempts.filter((result) => result.status === "acquired").length, 1);
  assert.deepEqual(
    attempts.find((result) => result.status === "unavailable"),
    { status: "unavailable", reason: "wait_timeout", ownerPid: process.pid },
  );
  const acquired = attempts.find((result) => result.status === "acquired");
  if (acquired?.status === "acquired") await acquired.lease.release();
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
    `kestrel-dev-shell-bootstrap-v2:${process.pid}:replacement-owner`,
    ownerEvidencePath,
  );
  assert.equal(await acquired.lease.verify(), false);
  await acquired.lease.release();

  assert.equal(
    await readlink(ownerEvidencePath),
    `kestrel-dev-shell-bootstrap-v2:${process.pid}:replacement-owner`,
  );
});

test("bootstrap authority lease verification follows a successful transfer", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dev-shell-authority-verify-transfer-"),
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

  assert.equal(await acquired.lease.verify(), true);
  assert.equal(await acquired.lease.transferTo({
    ownerPid: process.pid,
    ownerToken: "transferred-owner",
  }), true);
  assert.equal(acquired.lease.ownerToken, "transferred-owner");
  assert.equal(await acquired.lease.verify(), true);
  assert.equal(await acquired.lease.release(), true);
  assert.equal(await acquired.lease.verify(), false);
});

test("authority publication and cleanup recover after process death", async () => {
  for (const phase of ["publication_prepared", "cleanup_claimed", "cleanup_quarantined"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `dev-shell-authority-${phase}-`));
    const authorityPath = path.join(root, "bootstrap-authority");
    const moduleUrl = pathToFileURL(path.resolve("src/devshell/bootstrapAuthority.ts")).href;
    const tsxImport = createRequire(import.meta.url).resolve("tsx");
    const childScript = `
      import { acquireDevShellBootstrapAuthority } from ${JSON.stringify(moduleUrl)};
      const result = await acquireDevShellBootstrapAuthority({
        authorityPath: ${JSON.stringify(authorityPath)}, ownerToken: "fault-owner",
        timeoutMs: 1000, pollIntervalMs: 2,
        faultHook(phase) { if (phase === ${JSON.stringify(phase)}) process.kill(process.pid, "SIGKILL"); },
      });
      if (result.status !== "acquired") process.exit(2);
      if (${JSON.stringify(phase)} !== "publication_prepared") await result.lease.release({
        faultHook(observed) { if (observed === ${JSON.stringify(phase)}) process.kill(process.pid, "SIGKILL"); },
      });
    `;
    const child = spawn(process.execPath, ["--import", tsxImport, "--input-type=module", "-e", childScript], { stdio: "ignore" });
    await waitForExit(child);
    const recovered = await acquireDevShellBootstrapAuthority({
      authorityPath, ownerToken: "recovery-owner", timeoutMs: 500, pollIntervalMs: 2,
    });
    assert.equal(recovered.status, "acquired", phase);
    if (recovered.status === "acquired") await recovered.lease.release();
  }
});

test("an exact claimant can release its own incomplete authority transfer", async () => {
  for (const phase of ["transfer_claimed", "transfer_prepared"] as const) {
    const root = await mkdtemp(
      path.join(os.tmpdir(), `dev-shell-authority-release-${phase}-`),
    );
    const authorityPath = path.join(root, "bootstrap-authority");
    const acquired = await acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "transfer-owner",
      timeoutMs: 100,
      pollIntervalMs: 2,
    });
    assert.equal(acquired.status, "acquired");
    if (acquired.status !== "acquired") continue;

    await assert.rejects(
      acquired.lease.transferTo({
        ownerPid: 2_147_483_647,
        ownerToken: "blocked-child",
        faultHook(observed) {
          if (observed === phase) throw new Error(`injected ${phase}`);
        },
      }),
      new RegExp(`injected ${phase}`, "u"),
    );
    assert.equal(await acquired.lease.release(), true, phase);

    const recovered = await acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "recovery-owner",
      timeoutMs: 100,
      pollIntervalMs: 2,
    });
    assert.equal(recovered.status, "acquired", phase);
    if (recovered.status === "acquired") await recovered.lease.release();
  }
});

test("authority transfer claims recover after claimant process death", async () => {
  for (const phase of ["transfer_claimed", "transfer_prepared"] as const) {
    const root = await mkdtemp(
      path.join(os.tmpdir(), `dev-shell-authority-crash-${phase}-`),
    );
    const authorityPath = path.join(root, "bootstrap-authority");
    const moduleUrl = pathToFileURL(
      path.resolve("src/devshell/bootstrapAuthority.ts"),
    ).href;
    const tsxImport = createRequire(import.meta.url).resolve("tsx");
    const childScript = `
      import { acquireDevShellBootstrapAuthority } from ${JSON.stringify(moduleUrl)};
      const result = await acquireDevShellBootstrapAuthority({
        authorityPath: ${JSON.stringify(authorityPath)}, ownerToken: "crashing-owner",
        timeoutMs: 1000, pollIntervalMs: 2,
      });
      if (result.status !== "acquired") process.exit(2);
      await result.lease.transferTo({
        ownerPid: 2147483647, ownerToken: "blocked-child",
        faultHook(observed) { if (observed === ${JSON.stringify(phase)}) process.kill(process.pid, "SIGKILL"); },
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, "--input-type=module", "-e", childScript],
      { stdio: "ignore" },
    );
    await waitForExit(child);

    const recovered = await acquireDevShellBootstrapAuthority({
      authorityPath,
      ownerToken: "recovery-owner",
      timeoutMs: 500,
      pollIntervalMs: 2,
    });
    assert.equal(recovered.status, "acquired", phase);
    if (recovered.status === "acquired") await recovered.lease.release();
  }
});

test("malformed authority evidence is rejected canonically and preserved", async () => {
  const malformed = [
    "kestrel-dev-shell-bootstrap-v2:2147483647junk:token",
    "kestrel-dev-shell-bootstrap-v2:+2147483647:token",
    "kestrel-dev-shell-bootstrap-v2: 2147483647:token",
    "kestrel-dev-shell-bootstrap-v2:2147483647 :token",
    "kestrel-dev-shell-bootstrap-v2:1.5:token",
    "kestrel-dev-shell-bootstrap-v2:1e3:token",
    "kestrel-dev-shell-bootstrap-v2::token",
    "kestrel-dev-shell-bootstrap-v2:123:",
    "kestrel-dev-shell-bootstrap-v2:123:token:extra",
    "kestrel-dev-shell-bootstrap-v2:0123:token",
  ];
  for (const evidence of malformed) {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-shell-authority-malformed-"));
    const authorityPath = path.join(root, "bootstrap-authority");
    await mkdir(authorityPath);
    await symlink(evidence, path.join(authorityPath, "owner"));
    const result = await acquireDevShellBootstrapAuthority({
      authorityPath, ownerToken: "waiting-owner", timeoutMs: 20, pollIntervalMs: 2,
    });
    assert.deepEqual(result, { status: "unavailable", reason: "invalid_owner_evidence" });
    assert.equal(await readlink(path.join(authorityPath, "owner")), evidence);
  }
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
