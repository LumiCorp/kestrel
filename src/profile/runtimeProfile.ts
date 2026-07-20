import type { CodeModeProfileConfig } from "../code/contracts.js";
import {
  DEFAULT_CODE_MODE_DISABLED_CONFIG,
  DEFAULT_CODE_MODE_ENABLED_CONFIG,
} from "../code/contracts.js";
import type { DevShellProfileConfig } from "../devshell/contracts.js";
import {
  DEFAULT_DEV_SHELL_DISABLED_CONFIG,
  DEFAULT_DEV_SHELL_ENABLED_CONFIG,
} from "../devshell/contracts.js";
import { DEFAULT_BALANCED_TOOL_ALLOWLIST } from "../../tools/createDefaultToolGateway.js";
import { DEV_SHELL_TOOL_NAMES, FILESYSTEM_TOOL_NAMES } from "../../tools/index.js";
import { DEFAULT_MODEL_BY_PROVIDER } from "./modelDefaults.js";
export { DEFAULT_MODEL_BY_PROVIDER } from "./modelDefaults.js";

export type ShellKind = "cli" | "web" | "desktop";
export type CapabilityPackId =
  | "balanced"
  | "filesystem"
  | "dev_shell"
  | "desktop_host"
  | "sandbox_code";
export type ShellPresetId =
  | "cli_dev_local"
  | "web_balanced"
  | "desktop_dev_local";
export type ModelProviderId = "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio";

export interface RuntimeProfileAuthoringInput {
  shellKind?: ShellKind | undefined;
  presetId?: ShellPresetId | undefined;
  capabilityPacks?: CapabilityPackId[] | undefined;
  toolAllowlist?: string[] | undefined;
  codeMode?: CodeModeProfileConfig | undefined;
  devShell?: DevShellProfileConfig | undefined;
}

export interface ResolvedRuntimeProfileSelection {
  shellKind: ShellKind;
  presetId: ShellPresetId;
  capabilityPacks: CapabilityPackId[];
  toolAllowlist: string[];
  codeMode: CodeModeProfileConfig;
  devShell: DevShellProfileConfig;
}

export interface RuntimeIdentityMetadata {
  agentProfileId: string;
  agentProfileLabel: string;
  environmentShellKind: ShellKind;
  environmentPresetId: ShellPresetId;
  environmentCapabilityPackIds: CapabilityPackId[];
  effectiveAssemblyId?: string | undefined;
  effectiveAssemblyLabel?: string | undefined;
}

const PACK_ORDER: CapabilityPackId[] = [
  "balanced",
  "filesystem",
  "dev_shell",
  "desktop_host",
  "sandbox_code",
];

const CODING_FILESYSTEM_TOOL_NAMES: string[] = FILESYSTEM_TOOL_NAMES.filter(
  (toolName) => toolName !== "fs.write_text" && toolName !== "fs.replace_text",
);

const PACK_TOOL_NAMES: Record<CapabilityPackId, string[]> = {
  balanced: [...DEFAULT_BALANCED_TOOL_ALLOWLIST],
  filesystem: [...CODING_FILESYSTEM_TOOL_NAMES, "artifact.read"],
  dev_shell: [...DEV_SHELL_TOOL_NAMES],
  desktop_host: ["desktop.host.open"],
  sandbox_code: ["code.execute"],
};

export const SHELL_PRESET_PACKS: Record<ShellPresetId, CapabilityPackId[]> = {
  cli_dev_local: ["balanced", "filesystem", "dev_shell"],
  web_balanced: ["balanced"],
  desktop_dev_local: ["balanced", "filesystem", "dev_shell", "desktop_host"],
};

const DEFAULT_PRESET_BY_SHELL: Record<ShellKind, ShellPresetId> = {
  cli: "cli_dev_local",
  web: "web_balanced",
  desktop: "desktop_dev_local",
};

export function resolveRuntimeProfileSelection(
  input: RuntimeProfileAuthoringInput,
): ResolvedRuntimeProfileSelection {
  const shellKind = normalizeShellKind(input.shellKind);
  const presetId = normalizeShellPresetId(input.presetId) ?? DEFAULT_PRESET_BY_SHELL[shellKind];
  const explicitToolAllowlist = normalizeToolAllowlist(input.toolAllowlist);
  const capabilityPacks = resolveCapabilityPacks({
    shellKind,
    presetId,
    capabilityPacks: input.capabilityPacks,
  });

  const toolAllowlist = explicitToolAllowlist ?? expandCapabilityPacks(capabilityPacks);
  const nextToolAllowlist = applyCapabilityPackToolRequirements({
    toolAllowlist,
    capabilityPacks,
  });

  return {
    shellKind,
    presetId,
    capabilityPacks,
    toolAllowlist: nextToolAllowlist,
    codeMode: capabilityPacks.includes("sandbox_code")
      ? {
          ...DEFAULT_CODE_MODE_ENABLED_CONFIG,
          ...(input.codeMode ?? {}),
          enabled: true,
        }
      : {
          ...DEFAULT_CODE_MODE_DISABLED_CONFIG,
          ...(input.codeMode ?? {}),
          enabled: false,
        },
    devShell: capabilityPacks.includes("dev_shell")
      ? {
          ...DEFAULT_DEV_SHELL_ENABLED_CONFIG,
          ...(input.devShell ?? {}),
          enabled: true,
        }
      : {
          ...DEFAULT_DEV_SHELL_DISABLED_CONFIG,
          ...(input.devShell ?? {}),
          enabled: false,
        },
  };
}

export function buildRuntimeIdentityMetadata(input: {
  agentProfileId: string;
  agentProfileLabel?: string | undefined;
  legacyProfileLabel?: string | undefined;
  shellKind?: ShellKind | undefined;
  presetId?: ShellPresetId | undefined;
  capabilityPacks?: CapabilityPackId[] | undefined;
  effectiveAssemblyId?: string | undefined;
  effectiveAssemblyLabel?: string | undefined;
}): RuntimeIdentityMetadata {
  const resolved = resolveRuntimeProfileSelection({
    shellKind: input.shellKind,
    presetId: input.presetId,
    capabilityPacks: input.capabilityPacks,
  });
  const agentProfileLabel = normalizeIdentityLabel(
    input.agentProfileLabel,
    input.legacyProfileLabel,
    input.agentProfileId,
  ) ?? input.agentProfileId;
  const effectiveAssemblyLabel = normalizeIdentityLabel(
    input.effectiveAssemblyLabel,
    input.effectiveAssemblyId !== undefined
      ? formatRuntimeAssemblyLabel({
          agentProfileLabel,
          environmentShellKind: resolved.shellKind,
          environmentPresetId: resolved.presetId,
        })
      : undefined,
    undefined,
  );

  return {
    agentProfileId: input.agentProfileId,
    agentProfileLabel,
    environmentShellKind: resolved.shellKind,
    environmentPresetId: resolved.presetId,
    environmentCapabilityPackIds: [...resolved.capabilityPacks],
    ...(input.effectiveAssemblyId !== undefined ? { effectiveAssemblyId: input.effectiveAssemblyId } : {}),
    ...(effectiveAssemblyLabel !== undefined ? { effectiveAssemblyLabel } : {}),
  };
}

export function formatRuntimeAssemblyLabel(input: {
  agentProfileLabel: string;
  environmentShellKind: ShellKind;
  environmentPresetId: ShellPresetId;
}): string {
  return `${input.agentProfileLabel} on ${input.environmentShellKind}:${input.environmentPresetId}`;
}

export function normalizeShellKind(value: unknown): ShellKind {
  return value === "cli" || value === "web" || value === "desktop" ? value : "web";
}

export function normalizeShellPresetId(value: unknown): ShellPresetId | undefined {
  return value === "cli_dev_local" ||
      value === "web_balanced" ||
      value === "desktop_dev_local"
    ? value
    : undefined;
}

export function normalizeCapabilityPackIds(value: unknown): CapabilityPackId[] | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const packs = value.filter(
    (entry): entry is CapabilityPackId =>
      entry === "balanced" ||
      entry === "filesystem" ||
      entry === "dev_shell" ||
      entry === "desktop_host" ||
      entry === "sandbox_code",
  );
  return packs.length > 0 ? sortCapabilityPacks([...new Set(packs)]) : [];
}

export function expandCapabilityPacks(capabilityPacks: CapabilityPackId[]): string[] {
  const allowlist: string[] = [];
  for (const packId of sortCapabilityPacks(capabilityPacks)) {
    for (const toolName of PACK_TOOL_NAMES[packId]) {
      if (allowlist.includes(toolName) === false) {
        allowlist.push(toolName);
      }
    }
  }
  return allowlist;
}

export function inferCapabilityPacksFromAllowlist(toolAllowlist: string[]): CapabilityPackId[] {
  const allowlisted = new Set(toolAllowlist);
  const inferred: CapabilityPackId[] = [];
  for (const packId of PACK_ORDER) {
    const packToolNames = PACK_TOOL_NAMES[packId];
    if (packToolNames.some((toolName) => allowlisted.has(toolName))) {
      inferred.push(packId);
    }
  }
  return inferred;
}

function resolveCapabilityPacks(input: {
  shellKind: ShellKind;
  presetId: ShellPresetId;
  capabilityPacks?: CapabilityPackId[] | undefined;
}): CapabilityPackId[] {
  const explicitPacks = normalizeCapabilityPackIds(input.capabilityPacks);
  const base = explicitPacks ??
    [...SHELL_PRESET_PACKS[input.presetId ?? DEFAULT_PRESET_BY_SHELL[input.shellKind]]];
  return sortCapabilityPacks([...base]);
}

function applyCapabilityPackToolRequirements(input: {
  toolAllowlist: string[];
  capabilityPacks: CapabilityPackId[];
}): string[] {
  const next = [...new Set(input.toolAllowlist)];
  for (const packId of input.capabilityPacks) {
    for (const toolName of PACK_TOOL_NAMES[packId]) {
      if (next.includes(toolName) === false) {
        next.push(toolName);
      }
    }
  }

  const hasFilesystem = input.capabilityPacks.includes("filesystem");
  const hasSandboxCode = input.capabilityPacks.includes("sandbox_code");
  const hasDevShell = input.capabilityPacks.includes("dev_shell");
  const hasDesktopHost = input.capabilityPacks.includes("desktop_host");

  for (const toolName of FILESYSTEM_TOOL_NAMES) {
    if (hasFilesystem) {
      if (CODING_FILESYSTEM_TOOL_NAMES.includes(toolName) && next.includes(toolName) === false) {
        next.push(toolName);
      }
      if (CODING_FILESYSTEM_TOOL_NAMES.includes(toolName) === false) {
        removeTool(next, toolName);
      }
      continue;
    }
    removeTool(next, toolName);
  }
  if (hasFilesystem && next.includes("artifact.read") === false) {
    next.push("artifact.read");
  }
  if (hasFilesystem === false) {
    removeTool(next, "artifact.read");
  }

  if (hasSandboxCode && next.includes("code.execute") === false) {
    next.push("code.execute");
  }
  if (hasSandboxCode === false) {
    removeTool(next, "code.execute");
  }

  for (const toolName of DEV_SHELL_TOOL_NAMES) {
    if (hasDevShell) {
      if (next.includes(toolName) === false) {
        next.push(toolName);
      }
      continue;
    }
    removeTool(next, toolName);
  }

  if (hasDesktopHost) {
    if (next.includes("desktop.host.open") === false) {
      next.push("desktop.host.open");
    }
  } else {
    removeTool(next, "desktop.host.open");
  }

  return next;
}

function normalizeToolAllowlist(value: unknown): string[] | undefined {
  if (Array.isArray(value) === false) {
    return ;
  }
  const next = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(next)];
}

function normalizeIdentityLabel(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }
  return ;
}

function sortCapabilityPacks(capabilityPacks: CapabilityPackId[]): CapabilityPackId[] {
  return [...capabilityPacks].sort(
    (left, right) => PACK_ORDER.indexOf(left) - PACK_ORDER.indexOf(right),
  );
}

function removeTool(toolAllowlist: string[], toolName: string): void {
  const index = toolAllowlist.indexOf(toolName);
  if (index >= 0) {
    toolAllowlist.splice(index, 1);
  }
}
