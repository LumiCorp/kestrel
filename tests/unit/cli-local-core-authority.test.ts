import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contractTest } from "../helpers/contract-test.js";


const ROOT = process.cwd();

contractTest("runtime.hermetic", "CLI production entrypoints do not construct an embedded execution authority", async () => {
  const entrypoints = [
    "cli/app/App.ts",
    "cli/commandMode.ts",
    "cli/webCommand.ts",
    "cli/webRunnerProxy.ts",
    "scripts/kchat-smoke.ts",
  ];

  for (const relativePath of entrypoints) {
    const source = await readFile(path.join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:InProcessRunnerTransport|RunnerProcess|createRunnerServiceServer|new RunnerHost)\b/u,
      `${relativePath} must remain a client of Local Core`,
    );
  }
});

contractTest("runtime.hermetic", "CLI evidence commands do not open or reconstruct a runtime store", async () => {
  const evidenceClients = [
    "cli/app/OperatorController.ts",
    "cli/commandMode.ts",
    "cli/runtime.ts",
  ];

  for (const relativePath of evidenceClients) {
    const source = await readFile(path.join(ROOT, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /\bcreateSessionStoreFromEnv\b/u,
      `${relativePath} must read evidence through Local Core`,
    );
  }
});
