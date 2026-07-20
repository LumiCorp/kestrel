import assert from "node:assert/strict";
import test from "node:test";

import {
  expandCapabilityPacks,
  resolveRuntimeProfileSelection,
} from "../../src/profile/runtimeProfile.js";
import { DEFAULT_BALANCED_TOOL_ALLOWLIST, FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";

test("CLI defaults resolve to the local developer preset", () => {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "cli",
  });

  assert.equal(resolved.presetId, "cli_dev_local");
  assert.deepEqual(resolved.capabilityPacks, ["balanced", "filesystem", "dev_shell"]);
  assert.equal(resolved.toolAllowlist.includes("fs.write_text"), false);
  assert.equal(resolved.toolAllowlist.includes("fs.create_text"), true);
  assert.equal(resolved.toolAllowlist.includes("fs.edit_text"), true);
  assert.equal(resolved.toolAllowlist.includes("fs.apply_patch"), true);
  assert.equal(resolved.toolAllowlist.includes("artifact.read"), true);
  assert.equal(resolved.toolAllowlist.includes("repo.trace"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.shell.run"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.write"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.read"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.stop"), true);
  assert.equal(resolved.toolAllowlist.includes("code.execute"), false);
});

test("desktop defaults add the host-open capability without exposing it to CLI", () => {
  const cli = resolveRuntimeProfileSelection({ shellKind: "cli" });
  const desktop = resolveRuntimeProfileSelection({ shellKind: "desktop" });

  assert.equal(desktop.presetId, "desktop_dev_local");
  assert.deepEqual(desktop.capabilityPacks, ["balanced", "filesystem", "dev_shell", "desktop_host"]);
  assert.equal(desktop.toolAllowlist.includes("desktop.host.open"), true);
  assert.equal(cli.toolAllowlist.includes("desktop.host.open"), false);
});

test("web defaults stay narrow and do not expose local mutation tools", () => {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "web",
  });

  assert.equal(resolved.presetId, "web_balanced");
  assert.deepEqual(resolved.capabilityPacks, ["balanced"]);
  assert.equal(resolved.toolAllowlist.includes("fs.write_text"), false);
  assert.equal(resolved.toolAllowlist.includes("repo.trace"), false);
  assert.equal(resolved.toolAllowlist.includes("dev.shell.run"), false);
  assert.equal(resolved.toolAllowlist.includes("dev.process.write"), false);
  assert.equal(resolved.toolAllowlist.includes("desktop.host.open"), false);
  assert.equal(resolved.toolAllowlist.includes("code.execute"), false);
});

test("runtime shape stays preset-first even when legacy codeMode input is present", () => {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "web",
    codeMode: {
      enabled: true,
      languages: ["javascript", "python", "bash"],
      sandbox: {
        executor: "docker",
        timeoutMs: 20_000,
        memoryMb: 256,
        cpuShares: 256,
        networkDefault: "off",
        allowDependencyInstall: false,
        maxOutputBytes: 32_000,
        maxArtifacts: 20,
        maxArtifactBytes: 64_000,
      },
      retention: {
        persistSummary: true,
        persistArtifacts: true,
      },
      approvalMode: "auto",
    },
  });

  assert.deepEqual(resolved.capabilityPacks, ["balanced"]);
  assert.equal(resolved.toolAllowlist.includes("code.execute"), false);
  assert.equal(resolved.codeMode.enabled, false);
});

test("explicit capability packs expand deterministically", () => {
  assert.deepEqual(
    expandCapabilityPacks(["balanced", "filesystem", "dev_shell", "sandbox_code"]).includes("code.execute"),
    true,
  );
});

test("explicit capability packs restore required tool families even when starting from a narrow allowlist", () => {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "desktop",
    presetId: "desktop_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    toolAllowlist: [...DEFAULT_BALANCED_TOOL_ALLOWLIST],
  });

  for (const toolName of FILESYSTEM_TOOL_NAMES) {
    assert.equal(
      resolved.toolAllowlist.includes(toolName),
      toolName !== "fs.write_text" && toolName !== "fs.replace_text",
    );
  }
  assert.equal(resolved.toolAllowlist.includes("artifact.read"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.shell.run"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.write"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.read"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.stop"), true);
  assert.equal(resolved.toolAllowlist.includes("code.execute"), true);
});

test("explicit capability packs restore balanced planning tools from stale allowlists", () => {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: "cli",
    presetId: "cli_dev_local",
    capabilityPacks: ["balanced", "filesystem", "dev_shell", "sandbox_code"],
    toolAllowlist: ["FinalizeAnswer", "fs.read_text", "dev.shell.run", "code.execute"],
  });

  assert.equal(resolved.toolAllowlist.includes("FinalizeAnswer"), true);
  assert.equal(resolved.toolAllowlist.includes("task.propose"), true);
  assert.equal(resolved.toolAllowlist.includes("fs.verify_json"), true);
  assert.equal(resolved.toolAllowlist.includes("dev.process.write"), true);
});
