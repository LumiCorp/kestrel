import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readDevShellSocketObservation,
  removeDevShellSocketIfUnchanged,
} from "../../src/devshell/socketOwnership.js";

test("socket cleanup does not unlink a replacement path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "old owner", "utf8");
  const oldObservation = await readDevShellSocketObservation(socketPath);
  assert.ok(oldObservation !== undefined);

  await rm(socketPath);
  await writeFile(socketPath, "replacement owner", "utf8");

  assert.equal(
    await removeDevShellSocketIfUnchanged(socketPath, oldObservation),
    "changed",
  );
  assert.equal(await readFile(socketPath, "utf8"), "replacement owner");
});

test("socket cleanup removes an unchanged observed path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "current owner", "utf8");
  const observation = await readDevShellSocketObservation(socketPath);
  assert.ok(observation !== undefined);

  assert.equal(
    await removeDevShellSocketIfUnchanged(socketPath, observation),
    "removed",
  );
  assert.equal(await readDevShellSocketObservation(socketPath), undefined);
});

test("socket cleanup reports a missing observed path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "current owner", "utf8");
  const observation = await readDevShellSocketObservation(socketPath);
  assert.ok(observation !== undefined);
  await rm(socketPath);

  assert.equal(
    await removeDevShellSocketIfUnchanged(socketPath, observation),
    "missing",
  );
});

test("socket cleanup preserves a path whose metadata changed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "current owner", "utf8");
  const observation = await readDevShellSocketObservation(socketPath);
  assert.ok(observation !== undefined);
  await chmod(socketPath, 0o600);

  assert.equal(
    await removeDevShellSocketIfUnchanged(socketPath, observation),
    "changed",
  );
  assert.equal(await readFile(socketPath, "utf8"), "current owner");
});

test("socket observation propagates non-missing filesystem errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const parentFile = path.join(directory, "not-a-directory");
  await writeFile(parentFile, "file", "utf8");

  await assert.rejects(
    readDevShellSocketObservation(path.join(parentFile, "supervisor.sock")),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
  );
});
