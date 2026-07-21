import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readRuntimeSettings, writeRuntimeSettings } from "../../cli/config/RuntimeSettings.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "readRuntimeSettings returns empty defaults when file is missing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-settings-empty-"));
  const settings = await readRuntimeSettings(home);
  assert.deepEqual(settings, {
    version: 1,
    defaults: {},
  });
});

contractTest("runtime.hermetic", "writeRuntimeSettings persists setup defaults", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-settings-write-"));
  await writeRuntimeSettings(home, {
    version: 1,
    defaults: {
      profileId: "reference",
      storeDriver: "sqlite",
      sqlitePath: "~/.kestrel/runtime.db",
      approvalPolicyPackId: "ci_bot",
      minimalMode: true,
    },
  });
  const settings = await readRuntimeSettings(home);
  assert.deepEqual(settings, {
    version: 1,
    defaults: {
      profileId: "reference",
      storeDriver: "sqlite",
      sqlitePath: "~/.kestrel/runtime.db",
      approvalPolicyPackId: "ci_bot",
      minimalMode: true,
    },
  });
});

contractTest("runtime.hermetic", "readRuntimeSettings ignores invalid defaults instead of widening behavior", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-settings-invalid-"));
  await writeFile(
    path.join(home, "settings.json"),
    JSON.stringify({
      version: 1,
      defaults: {
        profileId: "reference",
        storeDriver: "memory",
        approvalPolicyPackId: "god_mode",
        minimalMode: "yes",
      },
    }),
    "utf8",
  );
  const settings = await readRuntimeSettings(home);
  assert.deepEqual(settings, {
    version: 1,
    defaults: {
      profileId: "reference",
    },
  });
});
