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
import { DEV_SHELL_RUN_OUTPUT_CONTRACT } from "./outputContracts.js";
import {
  findDevShellCommandSafetyIssue,
  normalizeDevShellExecCommand,
} from "../../src/devshell/normalizeCommand.js";

export const devShellRunTool: SharedToolModule = {
  definition: {
    name: "dev.shell.run",
    description:
      "Run one bounded shell command in the workspace and return its final output and status. Use desktop.host.open, not this internal transport, for explicitly requested Desktop application, file, or URL launches. Multi-line commands run fail-fast, so an earlier failed setup step cannot be hidden by a later passing command. Quote or escape shell glob metacharacters in path segments, especially bracketed framework routes such as 'src/app/[id]' or src/app/\\[id\\]. Use this for scaffolding, installs, builds, tests, inspections, dev servers, and smoke checks.",
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
        timeoutMs: { type: "number", minimum: 1 },
        maxOutputBytes: { type: "number", minimum: 1 },
        envMode: {
          type: "string",
          enum: ["inherit", "allowlist"],
        },
      },
      required: ["command"],
    },
    outputContract: DEV_SHELL_RUN_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "host.shell"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Shell Run",
      aliases: ["developer shell run", "run in shell", "terminal command"],
      keywords: ["developer", "shell", "terminal", "command", "host"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.shell.run", input);
      const config = readDevShellConfig(context);
      const envMode = resolveDevShellEnvMode(config, "dev.shell.run", body);
      const sourceWriteGuard = buildDevShellSourceWriteGuardRequest(config);
      const sourceWriteAuthority = buildDevShellSourceWriteAuthority(config);
      const normalizedCommand = normalizeDevShellExecCommand(readString(body, "command"));
      if (normalizedCommand === undefined) {
        throw createToolInputError(
          "dev.shell.run",
          "Missing required string field 'command'.",
          {
            field: "command",
          },
        );
      }
      const commandSafetyIssue = findDevShellCommandSafetyIssue(normalizedCommand);
      if (commandSafetyIssue !== undefined) {
        throw createToolInputError("dev.shell.run", commandSafetyIssue.message, {
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
      return requireDevShellService(context).runCommand(
        {
          workspaceRoot,
          command: normalizedCommand,
          cwd: readString(body, "cwd")?.trim() ?? defaultCwd,
          strictMultiline: true,
          ...(parseStringArrayField("dev.shell.run", body, "requiredTools") !== undefined
            ? { requiredTools: parseStringArrayField("dev.shell.run", body, "requiredTools") }
            : {}),
          ...(parseStringArrayField("dev.shell.run", body, "envNames") !== undefined
            ? { envNames: parseStringArrayField("dev.shell.run", body, "envNames") }
            : {}),
          ...(typeof readNumber(body, "yieldTimeMs") === "number" ? { yieldTimeMs: readNumber(body, "yieldTimeMs") } : {}),
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
        },
        buildDevShellCommandOptions(context),
      );
    };
  },
};
