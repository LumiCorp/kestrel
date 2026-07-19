import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  DevProcessReadResult,
  DevProcessStartInput,
  DevProcessStartResult,
  DevProcessStopResult,
  DevShellProcessStatus,
  DevShellSourceWriteGuardResult,
  DevShellUnauthorizedSourceWrite,
} from "../../src/devshell/contracts.js";
import {
  findDevShellCommandSafetyIssue,
  normalizeDevShellExecCommand,
} from "../../src/devshell/normalizeCommand.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { createToolInputError, readNumber, readString } from "../helpers.js";
import {
  buildDevShellCommandOptions,
  buildDevShellPackageManagerPreflight,
  buildDevShellSourceWriteAuthority,
  buildDevShellSourceWriteGuardRequest,
  parseStringArrayField,
  parseToolInput,
  readDevShellConfig,
  requireDevShellService,
  requireStringValue,
  resolveDevShellEnvMode,
  resolveWorkspaceAppCwd,
} from "./shared.js";
import { EXEC_COMMAND_OUTPUT_CONTRACT } from "./outputContracts.js";
import { storeTextArtifact } from "../runtime/artifactStore.js";

type ExecCommandStatus = "completed" | "running" | "timeout" | "failed" | "stopped";

const DEFAULT_START_OBSERVATION_MS = 5000;
const DEFAULT_CONTINUATION_OBSERVATION_MS = 1000;

interface ExecCommandOutput {
  status: ExecCommandStatus;
  output: string;
  durationMs: number;
  truncated: boolean;
  sessionId?: string | undefined;
  exitCode?: number | undefined;
  cursor?: number | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  sourceWriteGuard?: DevShellSourceWriteGuardResult | undefined;
  unauthorizedSourceWrites?: DevShellUnauthorizedSourceWrite[] | undefined;
  changedFiles?: string[] | undefined;
  patchRef?: string | undefined;
  baseRevisions?: Record<string, string> | undefined;
  failureReason?: string | undefined;
}

export const execCommandTool: SharedToolModule = {
  definition: {
    name: "exec_command",
    description:
      "Start one shell command and observe it briefly. Command shape: use command and do not include sessionId, stdin, or stop. Source writes are rejected and restored by default. For a formatter, generator, or codemod, set sourceMutation to capture; the command must settle in the initial observation window and returns a patchRef that must be committed with fs.apply_patch. If a command remains alive, the result has status running and a sessionId. Continue/read shape: only use sessionId returned by a running result, with optional stdin as raw input; include the newline a terminal user would press. Stop shape uses sessionId with stop=true. Never invent sessionId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["command"],
          properties: {
            command: {
              type: "string",
              minLength: 1,
              description:
                "Command shape only: start one command and observe it. It returns a terminal result if the process exits, otherwise status running with sessionId. Do not include sessionId, stdin, or stop.",
            },
            cwd: {
              type: "string",
              minLength: 1,
              description:
                "Workspace-relative working directory such as '.' or 'apps/web'. Absolute paths and paths that escape the active workspace are rejected with recovery guidance.",
            },
            requiredTools: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            envNames: {
              type: "array",
              items: { type: "string", minLength: 1 },
            },
            yieldTimeMs: { type: "number", minimum: 0 },
            timeoutMs: { type: "number", minimum: 1 },
            maxOutputBytes: { type: "number", minimum: 1 },
            envMode: {
              type: "string",
              enum: ["inherit", "allowlist"],
            },
            sourceMutation: {
              type: "string",
              enum: ["reject", "capture"],
              description: "Source mutation policy. reject is the default. capture restores source changes and returns an immutable patchRef for later fs.apply_patch.",
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["sessionId"],
          properties: {
            sessionId: {
              type: "string",
              minLength: 1,
              description:
                "Continue/read shape only: an existing running process id from runtime context. Never invent this value.",
            },
            stdin: {
              type: "string",
              description:
                "Raw terminal input for the existing process; include the newline a terminal user would press, for example \"move N\\n\". Omit stdin to read more output.",
            },
            yieldTimeMs: { type: "number", minimum: 0 },
            maxOutputBytes: { type: "number", minimum: 1 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "stop"],
          properties: {
            sessionId: {
              type: "string",
              minLength: 1,
              description:
                "Stop shape only: an existing running process id from runtime context. Never invent this value.",
            },
            stop: {
              type: "boolean",
              enum: [true],
              description: "Stop the existing process and return final observed output.",
            },
            yieldTimeMs: { type: "number", minimum: 0 },
            maxOutputBytes: { type: "number", minimum: 1 },
          },
        },
      ],
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description:
            "Command shape only: start one managed process and observe it briefly. When command is present, omit sessionId, stdin, and stop.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          description:
            "Workspace-relative working directory such as '.' or 'apps/web'. Absolute paths and paths that escape the active workspace are invalid.",
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Continue/read/stop shape only: an existing running process id from runtime context. Never invent this value.",
        },
        stdin: {
          type: "string",
          description:
            "Only with sessionId, never with command. Raw terminal input for the existing process; include the newline a terminal user would press, for example \"move N\\n\".",
        },
        stop: {
          type: "boolean",
          description: "Only with sessionId, never with command or stdin. Stop the existing process and return final observed output.",
        },
        requiredTools: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        envNames: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        yieldTimeMs: { type: "number", minimum: 0 },
        timeoutMs: { type: "number", minimum: 1 },
        maxOutputBytes: { type: "number", minimum: 1 },
        envMode: {
          type: "string",
          enum: ["inherit", "allowlist"],
        },
        sourceMutation: {
          type: "string",
          enum: ["reject", "capture"],
          description: "Command shape only. reject is the default; capture returns source changes as a patch artifact without keeping them in the workspace.",
        },
      },
    },
    outputContract: EXEC_COMMAND_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "dev.process", "host.shell", "terminal.input"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Exec Command",
      aliases: ["exec command", "terminal command", "terminal session"],
      keywords: ["developer", "shell", "terminal", "command", "stdin", "process"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown): Promise<ExecCommandOutput> => {
      const startedAt = Date.now();
      const body = parseToolInput("exec_command", input);
      validateExecCommandInput(body);
      const service = requireDevShellService(context);
      const command = readString(body, "command");
      const sessionId = readString(body, "sessionId")?.trim();
      const maxOutputBytes = readNumber(body, "maxOutputBytes");
      const yieldTimeMs = readNumber(body, "yieldTimeMs");
      const waitMs = typeof yieldTimeMs === "number" ? yieldTimeMs : undefined;
      const maxBytes = typeof maxOutputBytes === "number" ? maxOutputBytes : undefined;

      if (command !== undefined) {
        const sourceMutation = readSourceMutation(body);
        const result = await service.startProcess(
          buildStartProcessInput(context, body, command),
          buildDevShellCommandOptions(context),
        );
        if (sourceMutation === "capture" && result.status === "RUNNING" && result.processId !== undefined) {
          const stopped = await service.stopProcess(
            { processId: result.processId, waitMs: 1000, ...(maxBytes !== undefined ? { maxBytes } : {}) },
            buildDevShellCommandOptions(context),
          );
          const mapped = mapProcessResult(stopped, startedAt, result.processId);
          return {
            ...mapped,
            status: "failed",
            patchRef: undefined,
            baseRevisions: undefined,
            failureReason: "sourceMutation capture commands must settle within the initial observation window; the process was stopped and its changes were restored.",
          };
        }
        return mapProcessResult(result, startedAt);
      }

      const requiredSessionId = sessionId ?? requireStringValue("exec_command", body, "sessionId");
      if (body.stop === true) {
        const result = await service.stopProcess(
          {
            processId: requiredSessionId,
            ...(waitMs !== undefined ? { waitMs } : {}),
            ...(maxBytes !== undefined ? { maxBytes } : {}),
          },
          buildDevShellCommandOptions(context),
        );
        return mapProcessResult(result, startedAt, requiredSessionId);
      }

      const stdin = readString(body, "stdin");
      if (stdin !== undefined) {
        const result = await service.writeAndReadProcess(
          {
            processId: requiredSessionId,
            data: stdin,
            waitMs: resolveContinuationObservationMs(body),
            ...(maxBytes !== undefined ? { maxBytes } : {}),
          },
          buildDevShellCommandOptions(context),
        );
        return mapProcessResult(result, startedAt, requiredSessionId);
      }

      const result = await service.readProcess(
        {
          processId: requiredSessionId,
          ...(waitMs !== undefined ? { waitMs } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        },
        buildDevShellCommandOptions(context),
      );
      return mapProcessResult(result, startedAt, requiredSessionId);
    };
  },
};

function validateExecCommandInput(body: Record<string, unknown>): void {
  const command = readString(body, "command");
  const sessionId = readString(body, "sessionId");
  const hasCommand = command !== undefined && command.trim().length > 0;
  const hasSessionId = sessionId !== undefined && sessionId.trim().length > 0;
  if (hasCommand === hasSessionId) {
    throw createToolInputError(
      "exec_command",
      "Expected exactly one of 'command' or 'sessionId'.",
      { fields: ["command", "sessionId"] },
    );
  }
  if (hasCommand && (Object.hasOwn(body, "stdin") || body.stop === true)) {
    throw createToolInputError(
      "exec_command",
      "'command' cannot be combined with 'stdin' or 'stop'.",
      { fields: ["command", "stdin", "stop"] },
    );
  }
  if (body.stop === true && Object.hasOwn(body, "stdin")) {
    throw createToolInputError(
      "exec_command",
      "'stop' cannot be combined with 'stdin'.",
      { fields: ["stop", "stdin"] },
    );
  }
}

function buildStartProcessInput(
  context: SharedToolContext,
  body: Record<string, unknown>,
  command: string,
): DevProcessStartInput {
  const config = readDevShellConfig(context);
  const envMode = resolveDevShellEnvMode(config, "exec_command", body);
  const requestedMutation = readSourceMutation(body);
  const sourceWriteGuard = buildDevShellSourceWriteGuardRequest(config, requestedMutation);
  const sourceWriteAuthority = buildDevShellSourceWriteAuthority(config);
  const normalizedCommand = normalizeDevShellExecCommand(command);
  if (normalizedCommand === undefined) {
    throw createToolInputError("exec_command", "Missing required string field 'command'.", {
      field: "command",
    });
  }
  const commandSafetyIssue = findDevShellCommandSafetyIssue(normalizedCommand);
  if (commandSafetyIssue !== undefined) {
    throw createToolInputError("exec_command", commandSafetyIssue.message, {
      field: "command",
      code: commandSafetyIssue.code,
      token: commandSafetyIssue.token,
      requiredCorrection: commandSafetyIssue.correction,
    });
  }
  const workspaceRoot = context.fileSystem?.workspaceRoot ?? ".";
  const requestedCwd = readString(body, "cwd")?.trim();
  if (requestedCwd !== undefined) {
    validateWorkspaceRelativeCwd(workspaceRoot, requestedCwd);
  }
  const defaultCwd = resolveWorkspaceAppCwd(workspaceRoot, context.workspace?.appRoot);
  return {
    workspaceRoot,
    command: normalizedCommand,
    cwd: requestedCwd ?? defaultCwd,
    ...(parseStringArrayField("exec_command", body, "requiredTools") !== undefined
      ? { requiredTools: parseStringArrayField("exec_command", body, "requiredTools") }
      : {}),
    ...(parseStringArrayField("exec_command", body, "envNames") !== undefined
      ? { envNames: parseStringArrayField("exec_command", body, "envNames") }
      : {}),
    yieldTimeMs: resolveStartObservationMs(body),
    ...(typeof readNumber(body, "timeoutMs") === "number" ? { timeoutMs: readNumber(body, "timeoutMs") } : {}),
    ...(typeof readNumber(body, "maxOutputBytes") === "number" ? { maxOutputBytes: readNumber(body, "maxOutputBytes") } : {}),
    ...(config.idleTimeoutMs !== undefined ? { idleTimeoutMs: config.idleTimeoutMs } : {}),
    ...(config.maxReadBytes !== undefined ? { maxReadBytes: config.maxReadBytes } : {}),
    ...(config.allowedEnvNames !== undefined ? { allowedEnvNames: config.allowedEnvNames } : {}),
    ...(envMode !== undefined ? { envMode } : {}),
    ...(buildDevShellPackageManagerPreflight(context) !== undefined
      ? { packageManagerPreflight: buildDevShellPackageManagerPreflight(context) }
      : {}),
    ...(sourceWriteAuthority !== undefined ? { sourceWriteAuthority } : {}),
    ...(sourceWriteGuard !== undefined ? { sourceWriteGuard } : {}),
  };
}

function readSourceMutation(body: Record<string, unknown>): "reject" | "capture" {
  const requestedMutation = readString(body, "sourceMutation") ?? "reject";
  if (requestedMutation !== "reject" && requestedMutation !== "capture") {
    throw createToolInputError("exec_command", "sourceMutation must be 'reject' or 'capture'.", { field: "sourceMutation" });
  }
  return requestedMutation;
}

function validateWorkspaceRelativeCwd(workspaceRoot: string, cwd: string): void {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const resolvedCwd = resolve(resolvedWorkspaceRoot, cwd);
  const relativeCwd = relative(resolvedWorkspaceRoot, resolvedCwd);
  if (
    isAbsolute(cwd) === false &&
    relativeCwd !== ".." &&
    relativeCwd.startsWith(`..${sep}`) === false
  ) {
    return;
  }
  throw createToolInputError(
    "exec_command",
    `Invalid cwd '${cwd}'. cwd must be relative to the active workspace and must not escape it.`,
    {
      field: "cwd",
      code: "EXEC_COMMAND_CWD_NOT_WORKSPACE_RELATIVE",
      requestedCwd: cwd,
      requiredCorrection: "Use '.' for the workspace root or a relative directory such as 'apps/web'.",
    },
  );
}

function resolveStartObservationMs(body: Record<string, unknown>): number {
  const requestedYieldTimeMs = readNumber(body, "yieldTimeMs");
  if (typeof requestedYieldTimeMs === "number") {
    return requestedYieldTimeMs;
  }
  return DEFAULT_START_OBSERVATION_MS;
}

function resolveContinuationObservationMs(body: Record<string, unknown>): number {
  const requestedYieldTimeMs = readNumber(body, "yieldTimeMs");
  if (typeof requestedYieldTimeMs === "number") {
    return requestedYieldTimeMs;
  }
  return DEFAULT_CONTINUATION_OBSERVATION_MS;
}

function mapProcessResult(
  result: DevProcessStartResult | DevProcessReadResult | DevProcessStopResult,
  startedAt: number,
  fallbackSessionId?: string | undefined,
): ExecCommandOutput {
  const status = mapStatus(result.status, result.exitCode, result.failureReason);
  const sessionId = status === "running" || result.truncated
    ? result.processId ?? fallbackSessionId
    : undefined;
  const capturedPatch = result.sourceWriteGuard?.capturedPatch;
  const patchArtifact = capturedPatch !== undefined && capturedPatch.length > 0
    ? storeTextArtifact({ content: capturedPatch, contentType: "text/x-diff; charset=utf-8", namespace: "patch" })
    : undefined;
  const visibleSourceWriteGuard = result.sourceWriteGuard === undefined
    ? undefined
    : {
      ...result.sourceWriteGuard,
      capturedPatch: undefined,
    };
  return {
    status,
    ...(sessionId !== undefined ? { sessionId } : {}),
    output: result.text,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    durationMs: Math.max(0, Date.now() - startedAt),
    truncated: result.truncated,
    ...(result.nextCursor !== undefined ? { cursor: result.nextCursor } : {}),
    ...(result.command !== undefined ? { command: result.command } : {}),
    ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
    ...(result.workspaceRoot !== undefined ? { workspaceRoot: result.workspaceRoot } : {}),
    ...(visibleSourceWriteGuard !== undefined ? { sourceWriteGuard: visibleSourceWriteGuard } : {}),
    ...(result.unauthorizedSourceWrites !== undefined ? { unauthorizedSourceWrites: result.unauthorizedSourceWrites } : {}),
    ...(result.sourceWriteGuard?.changedFiles !== undefined
      ? { changedFiles: result.sourceWriteGuard.changedFiles }
      : {}),
    ...(patchArtifact !== undefined ? { patchRef: patchArtifact.ref } : {}),
    ...(result.sourceWriteGuard?.capturedBaseRevisions !== undefined
      ? { baseRevisions: result.sourceWriteGuard.capturedBaseRevisions }
      : {}),
  };
}

function mapStatus(
  status: DevShellProcessStatus,
  exitCode: number | undefined,
  failureReason: string | undefined,
): ExecCommandStatus {
  if (status === "RUNNING") {
    return "running";
  }
  if (status === "COMPLETED") {
    return "completed";
  }
  if (status === "STOPPED") {
    return "stopped";
  }
  if (exitCode === 124 || /\btimeout\b|\btimed out\b/iu.test(failureReason ?? "")) {
    return "timeout";
  }
  return "failed";
}
