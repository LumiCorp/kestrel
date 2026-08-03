import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  DockerSandboxCancellationError,
  DockerSandboxExecutor,
} from "../../src/code/DockerSandboxExecutor.js";
import type {
  AppliedCodeExecutionPolicy,
  CodeExecutionRequest,
  SandboxExecutionOutput,
} from "../../src/code/contracts.js";

const execFileAsync = promisify(execFile);
let dockerReady: Promise<void> | undefined;

test(
  "Docker sandbox bounds fork attempts with the configured PID limit",
  async () => {
    await requireDocker();
    const containerName = testContainerName("pids");
    const executor = fixedNameExecutor(containerName);
    const execution = executor.execute({
      request: {
        language: "javascript",
        code: `
          const { spawn } = require("node:child_process");
          let errors = 0;
          for (let index = 0; index < 200; index += 1) {
            const child = spawn("sh", ["-c", "sleep 30"]);
            child.on("error", () => { errors += 1; });
          }
          setTimeout(() => {
            console.log(JSON.stringify({ errors }));
            process.exit(errors > 0 ? 0 : 3);
          }, 750);
        `,
      },
      policy: policy({ pidsLimit: 32, timeoutMs: 5_000 }),
    });

    await waitForContainer(containerName, true);
    const hostConfig = await inspectHostConfig(containerName);
    assert.equal(hostConfig.PidsLimit, 32);

    const result = await execution;
    assert.equal(result.status, "ok", result.stderr);
    const evidence = JSON.parse(result.stdout.trim()) as { errors?: number };
    assert.equal((evidence.errors ?? 0) > 0, true);
    await waitForContainer(containerName, false);
  },
);

test(
  "Docker sandbox memory pressure terminates inside the configured limit",
  async () => {
    await requireDocker();
    const result = await executeWithName("memory", {
      language: "javascript",
      code: `
        const chunks = [];
        while (true) {
          chunks.push(Buffer.alloc(8 * 1024 * 1024, 0xff));
        }
      `,
    }, policy({ memoryMb: 64, timeoutMs: 5_000 }));

    assert.equal(result.status, "error", result.stderr);
    assert.equal(result.exitCode, 137);
    assert.equal(result.durationMs < 5_000, true);
  },
);

test(
  "Docker sandbox does not inherit parent environment secrets",
  async () => {
    await requireDocker();
    const variableName = `KESTREL_SANDBOX_SECRET_${randomUUID().replaceAll("-", "")}`;
    const secret = `secret-${randomUUID()}`;
    process.env[variableName] = secret;
    try {
      const result = await executeWithName("secret", {
        language: "javascript",
        code: `
          const name = ${JSON.stringify(variableName)};
          console.log(process.env[name] === undefined ? "missing" : process.env[name]);
        `,
      });

      assert.equal(result.status, "ok", result.stderr);
      assert.equal(result.stdout.trim(), "missing");
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
    } finally {
      delete process.env[variableName];
    }
  },
);

test(
  "Docker sandbox blocks outbound traffic in network-off mode",
  async () => {
    await requireDocker();
    const result = await executeWithName("network", {
      language: "javascript",
      code: `
        fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1_000) })
          .then(() => {
            console.error("network unexpectedly available");
            process.exit(2);
          })
          .catch(() => console.log("blocked"));
      `,
    });

    assert.equal(result.status, "ok", result.stderr);
    assert.equal(result.stdout.trim(), "blocked");
  },
);

test(
  "Docker sandbox cancellation enforces hardening and removes the named workload",
  async () => {
    await requireDocker();
    const containerName = testContainerName("cancel");
    const controller = new AbortController();
    const execution = fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: "setInterval(() => {}, 1_000);",
      },
      policy: policy({ memoryMb: 64, pidsLimit: 32, timeoutMs: 10_000 }),
      signal: controller.signal,
    });

    await waitForContainer(containerName, true);
    const hostConfig = await inspectHostConfig(containerName);
    assert.equal(hostConfig.PidsLimit, 32);
    assert.equal(hostConfig.Memory, 64 * 1024 * 1024);
    assert.equal(hostConfig.NetworkMode, "none");
    assert.equal(hostConfig.CapDrop?.includes("ALL"), true);
    assert.equal(
      hostConfig.SecurityOpt?.includes("no-new-privileges"),
      true,
    );

    controller.abort();
    await assert.rejects(
      execution,
      (error: unknown) => error instanceof DockerSandboxCancellationError,
    );
    await assertContainerAndProcessesRemoved(containerName);
  },
);

test(
  "Docker sandbox timeout removes the named container and its child process",
  async () => {
    await requireDocker();
    const containerName = testContainerName("timeout");
    const result = await fixedNameExecutor(containerName).execute({
      request: {
        language: "javascript",
        code: `
          const { spawn } = require("node:child_process");
          spawn("sh", ["-c", "sleep 30"]);
          setInterval(() => {}, 1_000);
        `,
      },
      policy: policy({ timeoutMs: 500 }),
    });

    assert.equal(result.status, "timeout");
    await assertContainerAndProcessesRemoved(containerName);
  },
);

function fixedNameExecutor(containerName: string): DockerSandboxExecutor {
  return new DockerSandboxExecutor({
    containerNameFactory: () => containerName,
  });
}

async function executeWithName(
  label: string,
  request: CodeExecutionRequest,
  appliedPolicy = policy(),
): Promise<SandboxExecutionOutput> {
  const containerName = testContainerName(label);
  const result = await fixedNameExecutor(containerName).execute({
    request,
    policy: appliedPolicy,
  });
  await waitForContainer(containerName, false);
  return result;
}

function policy(
  overrides: Partial<AppliedCodeExecutionPolicy> = {},
): AppliedCodeExecutionPolicy {
  return {
    enabled: true,
    approvalMode: "auto",
    executor: "docker",
    language: "javascript",
    timeoutMs: 5_000,
    memoryMb: 128,
    cpuShares: 128,
    pidsLimit: 64,
    network: "off",
    allowDependencyInstall: false,
    maxOutputBytes: 32_000,
    maxArtifacts: 20,
    maxArtifactBytes: 64_000,
    ...overrides,
  };
}

function testContainerName(label: string): string {
  return `kestrel-code-test-${label}-${randomUUID()}`;
}

async function requireDocker(): Promise<void> {
  dockerReady ??= prepareDocker();
  await dockerReady;
}

async function prepareDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
    });
    try {
      await execFileAsync("docker", ["image", "inspect", "node:20-alpine"], {
        timeout: 10_000,
      });
    } catch {
      await execFileAsync("docker", ["pull", "node:20-alpine"], {
        timeout: 120_000,
      });
    }
  } catch (error) {
    assert.fail(
      `Docker-backed sandbox proof requires Docker and node:20-alpine: ${String(error)}`,
    );
  }
}

async function inspectHostConfig(containerName: string): Promise<{
  PidsLimit?: number;
  Memory?: number;
  NetworkMode?: string;
  CapDrop?: string[];
  SecurityOpt?: string[];
}> {
  const { stdout } = await execFileAsync(
    "docker",
    ["inspect", "--format", "{{json .HostConfig}}", containerName],
    { timeout: 10_000 },
  );
  return JSON.parse(stdout.trim());
}

async function waitForContainer(
  containerName: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await containerExists(containerName) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Expected Docker container '${containerName}' existence to become ${expected}.`,
  );
}

async function containerExists(containerName: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", containerName], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function assertContainerAndProcessesRemoved(
  containerName: string,
): Promise<void> {
  await waitForContainer(containerName, false);
  await assert.rejects(
    execFileAsync("docker", ["top", containerName], { timeout: 5_000 }),
  );
}
