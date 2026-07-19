import path from "node:path";

import { createToolInputError, parseObjectInput, parseOptionalStringArray, readString } from "../helpers.js";
import type { SharedToolContext } from "../contracts.js";
import type {
  DevShellCommandOptions,
  DevShellEnvMode,
  DevShellPackageManagerPreflightConfig,
  DevShellProfileConfig,
  DevShellSourceWriteAuthority,
  DevShellSourceWriteGuardRequest,
  DevShellServicePort,
} from "../../src/devshell/contracts.js";

export const DEV_SHELL_TOOL_NAMES = [
  "exec_command",
  "dev.shell.run",
  "dev.process.start",
  "dev.process.write",
  "dev.process.write_and_read",
  "dev.process.read",
  "dev.process.stop",
] as const;

export function requireDevShellService(context: SharedToolContext): DevShellServicePort {
  if (context.devShell?.enabled !== true || context.devShellService === undefined) {
    throw createToolInputError("dev.shell", "Developer shell is disabled for this profile.", {
      toolFamily: "dev-shell",
    });
  }
  return context.devShellService;
}

export function readDevShellConfig(context: SharedToolContext): DevShellProfileConfig {
  return context.devShell ?? { enabled: false };
}

export function buildDevShellCommandOptions(context: SharedToolContext): DevShellCommandOptions | undefined {
  if (context.toolConsole === undefined) {
    return ;
  }
  return {
    outputObserver: (chunk) =>
      context.toolConsole?.({
        status: "chunk",
        channel: chunk.channel,
        text: chunk.text,
        byteLength: chunk.byteLength,
        cursor: chunk.cursor,
        nextCursor: chunk.nextCursor,
        processId: chunk.processId,
        command: chunk.command,
        cwd: chunk.cwd,
        truncated: chunk.truncated,
      }),
  };
}

export function buildDevShellSourceWriteGuardRequest(
  config: DevShellProfileConfig,
  mutationPolicy?: "reject" | "capture" | "direct" | undefined,
): DevShellSourceWriteGuardRequest | undefined {
  if (config.enabled !== true) {
    return ;
  }
  const guard = config.sourceWriteGuard;
  if (guard?.enabled === false) {
    return ;
  }
  return {
    enabled: true,
    ...(mutationPolicy !== undefined ? { mutationPolicy } : {}),
    ...(guard?.managedWorktree === true ? { managedWorktree: true } : {}),
    ...(guard?.sourceRoots !== undefined ? { sourceRoots: [...guard.sourceRoots] } : {}),
    ...(guard?.allowedWriteRoots !== undefined ? { allowedWriteRoots: [...guard.allowedWriteRoots] } : {}),
    ...(guard?.approvalGrants !== undefined ? { approvalGrants: [...guard.approvalGrants] } : {}),
  };
}

export function buildDevShellSourceWriteAuthority(
  config: DevShellProfileConfig,
): DevShellSourceWriteAuthority | undefined {
  return config.sourceWriteAuthority;
}

export function buildDevShellPackageManagerPreflight(
  context: SharedToolContext,
): DevShellPackageManagerPreflightConfig | undefined {
  if (context.interactionMode !== "build") {
    return ;
  }
  return {
    pnpmApproveBuilds: "approve_all",
  };
}

export function parseStringArrayField(
  toolName: string,
  body: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const parsed = parseOptionalStringArray(body, key, 50);
  return parsed.length > 0 ? parsed : undefined;
}

export function requireStringValue(
  toolName: string,
  body: Record<string, unknown>,
  key: string,
): string {
  const value = readString(body, key);
  if (value === undefined || value.trim().length === 0) {
    throw createToolInputError(toolName, `Missing required string field '${key}'.`, {
      field: key,
    });
  }
  return value.trim();
}

export function resolveDevShellEnvMode(
  config: DevShellProfileConfig,
  toolName: string,
  body: Record<string, unknown>,
): DevShellEnvMode | undefined {
  const requested = readString(body, "envMode")?.trim();
  if (requested !== undefined && requested !== "inherit" && requested !== "allowlist") {
    throw createToolInputError(toolName, "Invalid envMode. Expected 'inherit' or 'allowlist'.", {
      field: "envMode",
      receivedValue: requested,
    });
  }
  const requestedMode: DevShellEnvMode | undefined =
    requested === "inherit" || requested === "allowlist" ? requested : undefined;
  if (config.envMode === "allowlist" && requestedMode === "inherit") {
    return "allowlist";
  }
  return requestedMode ?? config.envMode;
}

export function parseToolInput(toolName: string, input: unknown): Record<string, unknown> {
  return parseObjectInput(toolName, input);
}

export function resolveWorkspaceAppCwd(workspaceRoot: string, appRoot: string | undefined): string {
  const normalizedAppRoot = normalizeWorkspaceAppRoot(appRoot);
  if (normalizedAppRoot === undefined || normalizedAppRoot === ".") {
    return workspaceRoot;
  }
  return path.resolve(workspaceRoot, normalizedAppRoot);
}

function normalizeWorkspaceAppRoot(appRoot: string | undefined): string | undefined {
  const raw = appRoot?.trim();
  if (raw === undefined || raw.length === 0 || path.isAbsolute(raw)) {
    return ;
  }
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (normalized === "" || normalized === ".") {
    return ".";
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    return ;
  }
  return normalized;
}
