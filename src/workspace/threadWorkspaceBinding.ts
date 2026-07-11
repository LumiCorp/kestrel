import type { WorkspaceRuntimeContext } from "../../cli/contracts.js";

export type ThreadWorkspaceBindingState = "active" | "detached";
export type ThreadWorkspaceBindingSource = "resolved_workspace" | "desktop_project";

export interface ThreadWorkspaceBinding {
  binding: ThreadWorkspaceBindingState;
  label?: string | undefined;
  workspaceId?: string | undefined;
  workspaceRoot?: string | undefined;
  source?: ThreadWorkspaceBindingSource | undefined;
  runtimeContext?: WorkspaceRuntimeContext | undefined;
}

export interface ThreadWorkspaceSummaryProjection {
  workspaceId?: string | undefined;
  workspaceLabel: string;
  workspaceRoot?: string | undefined;
}

export function normalizeThreadWorkspaceBinding(
  input: Partial<ThreadWorkspaceBinding> | undefined,
): ThreadWorkspaceBinding {
  const runtimeContext = input?.runtimeContext;
  const binding = input?.binding === "detached" ? "detached" : "active";
  const workspaceId = trimString(input?.workspaceId) ?? trimString(runtimeContext?.workspaceId);
  const workspaceRoot = trimString(input?.workspaceRoot) ?? trimString(runtimeContext?.workspaceRoot);
  const label =
    trimString(input?.label) ??
    trimString(runtimeContext?.label) ??
    (binding === "active" ? "Current workspace" : "Detached workspace");

  return {
    binding,
    label,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(input?.source !== undefined ? { source: input.source } : {}),
    ...(runtimeContext !== undefined ? { runtimeContext } : {}),
  };
}

export function createDesktopProjectThreadWorkspaceBinding(input: {
  path: string;
  label: string;
}): ThreadWorkspaceBinding {
  const workspaceRoot = input.path.trim();
  const label = input.label.trim() || workspaceRoot;
  return normalizeThreadWorkspaceBinding({
    binding: "active",
    workspaceId: workspaceRoot,
    workspaceRoot,
    label,
    source: "desktop_project",
  });
}

export function createResolvedWorkspaceThreadWorkspaceBinding(
  workspace: WorkspaceRuntimeContext,
): ThreadWorkspaceBinding {
  return normalizeThreadWorkspaceBinding({
    binding: "active",
    workspaceId: workspace.workspaceId,
    workspaceRoot: workspace.workspaceRoot,
    label: workspace.label,
    source: "resolved_workspace",
    runtimeContext: workspace,
  });
}

export function deriveThreadWorkspaceSummaryProjection(
  binding: ThreadWorkspaceBinding | undefined,
): ThreadWorkspaceSummaryProjection | undefined {
  if (binding === undefined) {
    return undefined;
  }
  const normalized = normalizeThreadWorkspaceBinding(binding);
  return {
    ...(normalized.workspaceId !== undefined ? { workspaceId: normalized.workspaceId } : {}),
    workspaceLabel: normalized.label ?? "Detached workspace",
    ...(normalized.workspaceRoot !== undefined ? { workspaceRoot: normalized.workspaceRoot } : {}),
  };
}

export function resolveThreadWorkspaceRuntimeContext(
  binding: ThreadWorkspaceBinding | undefined,
): WorkspaceRuntimeContext | undefined {
  if (binding === undefined) {
    return undefined;
  }
  const normalized = normalizeThreadWorkspaceBinding(binding);
  if (normalized.binding !== "active") {
    return undefined;
  }
  if (normalized.runtimeContext !== undefined) {
    return normalized.runtimeContext;
  }
  if (normalized.workspaceRoot === undefined) {
    return undefined;
  }
  return {
    workspaceId: normalized.workspaceId ?? normalized.workspaceRoot,
    workspaceRoot: normalized.workspaceRoot,
    appRoot: ".",
    commands: {},
    ...(normalized.label !== undefined ? { label: normalized.label } : {}),
  };
}

export function resolveThreadWorkspaceExecutionRoot(
  binding: ThreadWorkspaceBinding | undefined,
): string | undefined {
  return resolveThreadWorkspaceRuntimeContext(binding)?.workspaceRoot;
}

function trimString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
