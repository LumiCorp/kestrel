import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_SHELL_TIMEOUT_MS_MODEL_WARNING } from "../../src/devshell/contracts.js";
import { BUILD_MODE_DELIBERATOR_PROMPT } from "../../src/runtime/agent-context/systemPrompts.js";
import { execCommandTool } from "../../tools/devshell/execCommand.js";
import { devShellRunTool } from "../../tools/devshell/run.js";
import {
  copyDesktopRuntimeResourceDirectories,
} from "../../scripts/prepare-desktop-resources.js";

test("canonical and packaged exec_command contracts carry the exact hard timeout warning", async () => {
  const schema = execCommandTool.definition.inputSchema as {
    oneOf: Array<{ properties: Record<string, { description?: string }> }>;
    properties: Record<string, { description?: string }>;
  };
  assert.equal(
    schema.oneOf[0]?.properties.timeoutMs?.description,
    DEV_SHELL_TIMEOUT_MS_MODEL_WARNING,
  );
  assert.equal(
    schema.properties.timeoutMs?.description,
    DEV_SHELL_TIMEOUT_MS_MODEL_WARNING,
  );
  assert.match(execCommandTool.definition.description, /yieldTimeMs controls only the initial observation window/u);
  assert.equal(
    execCommandTool.definition.description.includes(DEV_SHELL_TIMEOUT_MS_MODEL_WARNING),
    true,
  );

  assert.equal(BUILD_MODE_DELIBERATOR_PROMPT.includes(DEV_SHELL_TIMEOUT_MS_MODEL_WARNING), true);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "kestrel-desktop-payload-contract-"));
  try {
    copyDesktopRuntimeResourceDirectories(repoRoot, fixture);
    for (const relativePath of [
      "src/devshell/contracts.ts",
      "src/runtime/agent-context/systemPrompts.ts",
      "tools/devshell/execCommand.ts",
    ]) {
      assert.equal(
        await readFile(path.join(fixture, relativePath), "utf8"),
        await readFile(path.join(repoRoot, relativePath), "utf8"),
      );
    }
    assert.equal(
      (await readFile(path.join(fixture, "src/devshell/contracts.ts"), "utf8"))
        .includes(DEV_SHELL_TIMEOUT_MS_MODEL_WARNING),
      true,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("bounded dev.shell.run no longer recommends persistent development servers", () => {
  assert.doesNotMatch(devShellRunTool.definition.description, /dev servers/u);
});
