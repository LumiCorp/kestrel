import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createHostedRunnerStore,
  createHostedRunnerStoreRecoveryPath,
} from "../../cli/runner/HostedRunnerStore.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest(
  "runtime.hermetic",
  "hosted runner archives a corrupt PGlite store and retries once with a verified fresh store",
  async () => {
    const storeDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-hosted-runner-store-"));
    const storePath = path.join(storeDir, "pglite");
    await writeFile(storePath, "corrupt pglite path", "utf8");
    const quarantines: Array<{ sqlitePath: string; recoveryPath: string }> = [];

    const store = await createHostedRunnerStore({
      storeDir,
      onStoreQuarantined: (recovery) => {
        quarantines.push(recovery);
      },
    });
    try {
      assert.equal(store.sqlitePath, storePath);
      assert.equal((await stat(storePath)).isDirectory(), true);
      assert.deepEqual(quarantines.map((recovery) => recovery.sqlitePath), [
        storePath,
      ]);
      const recoveryPath = quarantines[0]?.recoveryPath;
      assert.ok(recoveryPath);
      assert.equal(
        await readFile(recoveryPath, "utf8"),
        "corrupt pglite path",
      );
      await store.store.ensureSession("hosted-runner-store-proof");
    } finally {
      await store.close();
    }
  },
);

contractTest(
  "runtime.hermetic",
  "hosted runner recovery paths are stable and adjacent to the failed PGlite store",
  () => {
    assert.equal(
      createHostedRunnerStoreRecoveryPath("/runtime/store/pglite", 1_784_512_345_678, 42),
      "/runtime/store/pglite.recovery-1784512345678-42",
    );
  },
);
