import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readDevShellSocketIdentity,
  removeDevShellSocketIfOwned,
} from "../../src/devshell/socketOwnership.js";

test("socket ownership cleanup does not unlink a replacement path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "old owner", "utf8");
  const oldIdentity = await readDevShellSocketIdentity(socketPath);
  assert.ok(oldIdentity !== undefined);

  await rm(socketPath);
  await writeFile(socketPath, "replacement owner", "utf8");

  assert.equal(
    await removeDevShellSocketIfOwned(socketPath, oldIdentity),
    "different_owner",
  );
  assert.equal(await readFile(socketPath, "utf8"), "replacement owner");
});

test("socket ownership cleanup removes the path owned by the caller", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dev-shell-socket-owner-"));
  const socketPath = path.join(directory, "supervisor.sock");
  await writeFile(socketPath, "current owner", "utf8");
  const identity = await readDevShellSocketIdentity(socketPath);
  assert.ok(identity !== undefined);

  assert.equal(
    await removeDevShellSocketIfOwned(socketPath, identity),
    "removed",
  );
  assert.equal(await readDevShellSocketIdentity(socketPath), undefined);
});
