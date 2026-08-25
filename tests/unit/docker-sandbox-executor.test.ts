import assert from "node:assert/strict";
import test from "node:test";

import { buildDockerCreateCommand } from "../../src/code/DockerSandboxExecutor.js";
import type { SandboxExecutionInput } from "../../src/code/contracts.js";

test("Docker create command carries the canonical sandbox hardening contract", () => {
  const command = buildDockerCreateCommand(input(), "kestrel-command-contract");

  assert.equal(argumentAfter(command, "--name"), "kestrel-command-contract");
  assert.equal(argumentAfter(command, "--user"), "65532:65532");
  assert.equal(command.includes("--read-only"), true);
  assert.equal(argumentAfter(command, "--memory"), "128m");
  assert.equal(argumentAfter(command, "--pids-limit"), "64");
  assert.equal(argumentAfter(command, "--cap-drop"), "ALL");
  assert.equal(argumentAfter(command, "--security-opt"), "no-new-privileges");
  assert.equal(argumentAfter(command, "--network"), "none");

  const tmpfs = argumentsAfter(command, "--tmpfs");
  assert.deepEqual(tmpfs, [
    "/workspace:rw,nosuid,nodev,size=32m,nr_inodes=1024,uid=65532,gid=65532,mode=0700",
    "/tmp:rw,nosuid,nodev,size=16m,nr_inodes=512,uid=65532,gid=65532,mode=0700",
  ]);

  for (const prohibited of [
    "--privileged",
    "--device",
    "--mount",
    "--volume",
    "-v",
    "--pid",
    "--userns",
  ]) {
    assert.equal(command.includes(prohibited), false, prohibited);
  }
});

test("Docker capability create command joins only the trusted broker namespace", () => {
  const capabilityInput = input();
  capabilityInput.capability = {
    transport: "docker-shared-loopback-v1",
    lease: "opaque-test-lease",
    operation: "search",
    destination: "api.tavily.com",
    response: { answer: "ok" },
  };
  const command = buildDockerCreateCommand(
    capabilityInput,
    "kestrel-command-contract",
    "kestrel-trusted-broker",
  );

  assert.equal(argumentAfter(command, "--network"), "container:kestrel-trusted-broker");
  assert.equal(command.includes("bridge"), false);
  assert.equal(command.includes("host"), false);
  assert.equal(command.join(" ").includes("opaque-test-lease"), false);
});

function input(): SandboxExecutionInput {
  return {
    request: {
      language: "javascript",
      code: "console.log('bounded')",
    },
    policy: {
      enabled: true,
      approvalMode: "auto",
      executor: "docker",
      language: "javascript",
      timeoutMs: 5_000,
      memoryMb: 128,
      cpuShares: 128,
      pidsLimit: 64,
      workspaceSizeMb: 32,
      workspaceInodes: 1_024,
      tmpSizeMb: 16,
      tmpInodes: 512,
      network: "off",
      allowDependencyInstall: false,
      maxOutputBytes: 32_000,
      maxArtifacts: 20,
      maxArtifactBytes: 64_000,
    },
  };
}

function argumentAfter(command: string[], flag: string): string | undefined {
  const index = command.indexOf(flag);
  return index < 0 ? undefined : command[index + 1];
}

function argumentsAfter(command: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < command.length - 1; index += 1) {
    if (command[index] === flag) {
      values.push(command[index + 1] ?? "");
    }
  }
  return values;
}
