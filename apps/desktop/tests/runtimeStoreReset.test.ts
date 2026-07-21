import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { archiveRuntimeStore } from "../src/runtimeStoreReset.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("desktop.hermetic", "archiveRuntimeStore renames runtime.db to a timestamped archive path", async () => {
  const runtimeHomePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-runtime-home-"));
  const storePath = path.join(runtimeHomePath, "runtime.db");
  await mkdir(storePath);
  await writeFile(path.join(storePath, "PG_VERSION"), "17\n", "utf8");

  const reset = await archiveRuntimeStore(runtimeHomePath, {
    now: new Date("2026-04-21T10:11:12.345Z"),
  });

  assert.equal(reset.storePath, storePath);
  assert.match(reset.archivedStorePath ?? "", /runtime\.db\.archived-2026-04-21T10-11-12-345Z$/u);
  assert.equal((await stat(reset.archivedStorePath ?? "")).isDirectory(), true);
  await assert.rejects(() => stat(storePath));
});

contractTest("desktop.hermetic", "archiveRuntimeStore succeeds when runtime.db does not exist", async () => {
  const runtimeHomePath = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-runtime-home-empty-"));

  const reset = await archiveRuntimeStore(runtimeHomePath, {
    now: new Date("2026-04-21T10:11:12.345Z"),
  });

  assert.equal(reset.storePath, path.join(runtimeHomePath, "runtime.db"));
  assert.equal(reset.archivedStorePath, undefined);
  assert.equal(reset.resetAt, "2026-04-21T10:11:12.345Z");
});
