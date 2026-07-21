import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import { resolveKestrelCoreHome } from "../../src/localCore/home.js";
import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "resolveKestrelHomePath expands bare and nested ~ KESTREL_HOME values", () => {
  assert.equal(resolveKestrelHomePath({ KESTREL_HOME: "~" } as NodeJS.ProcessEnv), homedir());
  assert.equal(
    resolveKestrelHomePath({ KESTREL_HOME: "~/kestrel-home-test" } as NodeJS.ProcessEnv),
    path.join(homedir(), "kestrel-home-test"),
  );
});

contractTest("runtime.hermetic", "resolveKestrelHomePath defaults to the shared platform Local Core home when KESTREL_HOME is unset", () => {
  assert.equal(
    resolveKestrelHomePath({} as NodeJS.ProcessEnv),
    resolveKestrelCoreHome({} as NodeJS.ProcessEnv, process.platform).homePath,
  );
});
