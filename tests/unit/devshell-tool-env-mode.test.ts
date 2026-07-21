import assert from "node:assert/strict";

import type {
  DevProcessStartInput,
  DevProcessStartResult,
  DevShellRunInput,
  DevShellRunResult,
  DevProcessReadInput,
  DevProcessReadResult,
  DevShellServicePort,
  DevProcessStopInput,
  DevProcessStopResult,
  DevProcessWriteAndReadInput,
  DevProcessWriteAndReadResult,
  DevProcessWriteInput,
  DevProcessWriteResult,
} from "../../src/devshell/contracts.js";
import { devProcessStartTool } from "../../tools/devshell/processStart.js";
import { execCommandTool } from "../../tools/devshell/execCommand.js";
import { devShellRunTool } from "../../tools/devshell/run.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "dev.shell.run allows per-call envMode down-scope from inherited profiles", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      envMode: "inherit" as const,
      allowedEnvNames: ["SAFE_TOKEN"],
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "echo ok",
    envMode: "allowlist",
    envNames: ["SAFE_TOKEN", "UNLISTED_TOKEN"],
  });

  assert.equal(service.execInputs[0]?.envMode, "allowlist");
  assert.deepEqual(service.execInputs[0]?.allowedEnvNames, ["SAFE_TOKEN"]);
});

contractTest("runtime.hermetic", "dev.shell.run does not let per-call envMode broaden allowlist profiles", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      envMode: "allowlist" as const,
      allowedEnvNames: ["SAFE_TOKEN"],
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "echo ok",
    envMode: "inherit",
    envNames: ["SAFE_TOKEN"],
  });

  assert.equal(service.execInputs[0]?.envMode, "allowlist");
});

contractTest("runtime.hermetic", "dev.shell.run rejects invalid envMode values", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      envMode: "inherit" as const,
      allowedEnvNames: ["SAFE_TOKEN"],
    },
    devShellService: service,
  };

  await assert.rejects(
    () =>
      devShellRunTool.createHandler(context)({
        command: "echo ok",
        envMode: "everything",
      }),
    /Invalid envMode/u,
  );
});

contractTest("runtime.hermetic", "dev.shell.run derives source-write guard from profile context, not model input", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      sourceWriteGuard: {
        sourceRoots: ["."],
        allowedWriteRoots: [".cache"],
        approvalGrants: [{
          grantId: "grant-1",
          command: "pnpm add zod",
          cwd: ".",
          writablePaths: ["package.json", "pnpm-lock.yaml"],
          expiresAt: "2026-01-01T00:05:00.000Z",
        }],
      },
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "pnpm add zod",
    sourceWriteGuard: {
      enabled: false,
      allowedWriteRoots: ["app"],
    },
  });

  assert.deepEqual(service.execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    sourceRoots: ["."],
    allowedWriteRoots: [".cache"],
    approvalGrants: [{
      grantId: "grant-1",
      command: "pnpm add zod",
      cwd: ".",
      writablePaths: ["package.json", "pnpm-lock.yaml"],
      expiresAt: "2026-01-01T00:05:00.000Z",
    }],
  });
});

contractTest("runtime.hermetic", "dev.shell.run source-write guard is on by default for enabled dev-shell profiles", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "echo ok",
  });

  assert.deepEqual(service.execInputs[0]?.sourceWriteGuard, {
    enabled: true,
  });
});

contractTest("runtime.hermetic", "dev.shell.run carries managed worktree guard mode from runtime context", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      sourceWriteGuard: {
        managedWorktree: true,
      },
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "pnpm add zod",
  });

  assert.deepEqual(service.execInputs[0]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
  });
});

contractTest("runtime.hermetic", "exec_command preserves direct checkpoint guard mode in managed worktrees", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      sourceWriteAuthority: "source_write" as const,
      sourceWriteGuard: {
        managedWorktree: true,
      },
    },
    devShellService: service,
  };

  await execCommandTool.createHandler(context)({
    command: "pnpm run dev",
  });

  assert.equal(service.startInputs[0]?.sourceWriteAuthority, "source_write");
  assert.deepEqual(service.startInputs[0]?.sourceWriteGuard, {
    enabled: true,
    managedWorktree: true,
    mutationPolicy: "direct",
  });
});

contractTest("runtime.hermetic", "dev.shell.run carries runtime-derived source-write authority", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      sourceWriteAuthority: "source_write" as const,
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "pnpm test",
    sourceWriteAuthority: "source_readonly",
  });

  assert.equal(service.execInputs[0]?.sourceWriteAuthority, "source_write");
});

contractTest("runtime.hermetic", "dev.process.start carries runtime-derived source-write authority", async () => {
  const service = new CapturingDevShellService();
  const context = {
    devShell: {
      enabled: true,
      sourceWriteAuthority: "source_write" as const,
    },
    devShellService: service,
  };

  await devProcessStartTool.createHandler(context)({
    command: "pnpm dev",
  });

  assert.equal(service.startInputs[0]?.sourceWriteAuthority, "source_write");
});

contractTest("runtime.hermetic", "dev.shell.run defaults cwd to the workspace app root", async () => {
  const service = new CapturingDevShellService();
  const context = {
    fileSystem: {
      workspaceRoot: "/repo",
      tempRoots: [],
    },
    workspace: {
      appRoot: "app",
    },
    devShell: {
      enabled: true,
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "pnpm test",
  });

  assert.equal(service.execInputs[0]?.workspaceRoot, "/repo");
  assert.equal(service.execInputs[0]?.cwd, "/repo/app");
});

contractTest("runtime.hermetic", "dev.shell.run ignores app roots that escape the workspace", async () => {
  const service = new CapturingDevShellService();
  const context = {
    fileSystem: {
      workspaceRoot: "/repo",
      tempRoots: [],
    },
    workspace: {
      appRoot: "../outside",
    },
    devShell: {
      enabled: true,
    },
    devShellService: service,
  };

  await devShellRunTool.createHandler(context)({
    command: "pnpm test",
  });

  assert.equal(service.execInputs[0]?.workspaceRoot, "/repo");
  assert.equal(service.execInputs[0]?.cwd, "/repo");
});

contractTest("runtime.hermetic", "dev.process.start ignores app roots that escape the workspace", async () => {
  const service = new CapturingDevShellService();
  const context = {
    fileSystem: {
      workspaceRoot: "/repo",
      tempRoots: [],
    },
    workspace: {
      appRoot: "/outside",
    },
    devShell: {
      enabled: true,
    },
    devShellService: service,
  };

  await devProcessStartTool.createHandler(context)({
    command: "pnpm dev",
  });

  assert.equal(service.startInputs[0]?.workspaceRoot, "/repo");
  assert.equal(service.startInputs[0]?.cwd, "/repo");
});

class CapturingDevShellService implements DevShellServicePort {
  readonly execInputs: DevShellRunInput[] = [];
  readonly startInputs: DevProcessStartInput[] = [];

  async runCommand(input: DevShellRunInput): Promise<DevShellRunResult> {
    this.execInputs.push(input);
    return {
      submittedAt: "2026-01-01T00:00:00.000Z",
      status: "COMPLETED",
      stdout: "",
      text: "",
      truncated: false,
    };
  }

  async startProcess(input: DevProcessStartInput): Promise<DevProcessStartResult> {
    this.startInputs.push(input);
    return {
      processId: "process-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "RUNNING",
      text: "",
      cursor: 0,
      nextCursor: 0,
      truncated: false,
    };
  }

  async writeProcess(_input: DevProcessWriteInput): Promise<DevProcessWriteResult> {
    throw new Error("not implemented");
  }

  async writeAndReadProcess(_input: DevProcessWriteAndReadInput): Promise<DevProcessWriteAndReadResult> {
    throw new Error("not implemented");
  }

  async readProcess(_input: DevProcessReadInput): Promise<DevProcessReadResult> {
    throw new Error("not implemented");
  }

  async stopProcess(_input: DevProcessStopInput): Promise<DevProcessStopResult> {
    throw new Error("not implemented");
  }
}
