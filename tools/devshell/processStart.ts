import type { SharedToolModule } from "../contracts.js";
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
  resolveWorkspaceAppCwd,
  resolveDevShellEnvMode,
} from "./shared.js";
import {
  findDevShellCommandSafetyIssue,
  normalizeDevShellExecCommand,
} from "../../src/devshell/normalizeCommand.js";
import { DEV_PROCESS_START_OUTPUT_CONTRACT } from "./outputContracts.js";

export const devProcessStartTool: SharedToolModule = {
  definition: {
    name: "dev.process.start",
    description:
      "Start a managed live process only when the task needs ongoing stdin/output interaction. Quote or escape shell glob metacharacters in path segments, especially bracketed framework routes such as 'src/app/[id]' or src/app/\\[id\\]. Use exec_command for ordinary bounded commands.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceRoot: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1 },
        cwd: { type: "string", minLength: 1 },
        requiredTools: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        envNames: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        yieldTimeMs: { type: "number", minimum: 0 },
        maxOutputBytes: { type: "number", minimum: 1 },
        envMode: {
          type: "string",
          enum: ["inherit", "allowlist"],
        },
      },
      required: ["command"],
    },
    outputContract: DEV_PROCESS_START_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.process", "host.shell"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Process Start",
      aliases: ["developer process start", "start process", "start terminal process"],
      keywords: ["developer", "process", "terminal", "command", "stdin"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.process.start", input);
      const config = readDevShellConfig(context);
      const envMode = resolveDevShellEnvMode(config, "dev.process.start", body);
      const sourceWriteGuard = buildDevShellSourceWriteGuardRequest(config);
      const sourceWriteAuthority = buildDevShellSourceWriteAuthority(config);
      const normalizedCommand = normalizeDevShellExecCommand(readString(body, "command"));
      if (normalizedCommand === undefined) {
        throw createToolInputError("dev.process.start", "Missing required string field 'command'.", {
          field: "command",
        });
      }
      const commandSafetyIssue = findDevShellCommandSafetyIssue(normalizedCommand);
      if (commandSafetyIssue !== undefined) {
        throw createToolInputError("dev.process.start", commandSafetyIssue.message, {
          field: "command",
          code: commandSafetyIssue.code,
          token: commandSafetyIssue.token,
          requiredCorrection: commandSafetyIssue.correction,
        });
      }
      const workspaceRoot = readString(body, "workspaceRoot")?.trim() ??
        context.fileSystem?.workspaceRoot ??
        ".";
      const defaultCwd = resolveWorkspaceAppCwd(workspaceRoot, context.workspace?.appRoot);
      return requireDevShellService(context).startProcess(
        {
          workspaceRoot,
          command: normalizedCommand,
          cwd: readString(body, "cwd")?.trim() ?? defaultCwd,
          ...(parseStringArrayField("dev.process.start", body, "requiredTools") !== undefined
            ? { requiredTools: parseStringArrayField("dev.process.start", body, "requiredTools") }
            : {}),
          ...(parseStringArrayField("dev.process.start", body, "envNames") !== undefined
            ? { envNames: parseStringArrayField("dev.process.start", body, "envNames") }
            : {}),
          ...(typeof readNumber(body, "yieldTimeMs") === "number" ? { yieldTimeMs: readNumber(body, "yieldTimeMs") } : {}),
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
        },
        buildDevShellCommandOptions(context),
      );
    };
  },
};
