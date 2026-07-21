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

export interface ThreadWorkspaceAuthorityProjection {
  kind: "local" | "managed";
  workspaceId?: string | undefined;
  label: string;
  workspaceRoot: string;
  sourceWorkspaceRoot: string;
  sourceRepoRoot?: string | undefined;
  managedWorktreeRoot?: string | undefined;
  baseRefName?: string | undefined;
  baseHead?: string | undefined;
  lastObservedSourceHead?: string | undefined;
  leaseId?: string | undefined;
  leaseKind?: "run" | "process" | undefined;
  dirty?: boolean | undefined;
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
    return ;
  }
  const normalized = normalizeThreadWorkspaceBinding(binding);
  return {
    ...(normalized.workspaceId !== undefined ? { workspaceId: normalized.workspaceId } : {}),
    workspaceLabel: normalized.label ?? "Detached workspace",
    ...(normalized.workspaceRoot !== undefined ? { workspaceRoot: normalized.workspaceRoot } : {}),
  };
}

export function deriveThreadWorkspaceAuthorityProjection(input: {
  threadMetadata?: Record<string, unknown> | undefined;
  sessionState?: Record<string, unknown> | undefined;
}): ThreadWorkspaceAuthorityProjection | undefined {
  const submittedWorkspace = asRecord(input.threadMetadata?.workspace);
  const submittedRoot = trimUnknownString(submittedWorkspace?.workspaceRoot);
  const sourceWorkspaceRoot =
    trimUnknownString(submittedWorkspace?.sourceWorkspaceRoot) ?? submittedRoot;
  const managedBinding = asRecord(
    asRecord(asRecord(input.sessionState?.agent)?.exec)?.managedWorktreeBinding,
  );

  if (managedBinding?.status === "bound") {
    const worktreeRoot = trimUnknownString(managedBinding.worktreeRoot);
    const managedSourceRoot = trimUnknownString(managedBinding.sourceWorkspaceRoot);
    if (worktreeRoot !== undefined && managedSourceRoot !== undefined) {
      const dirtyState = asRecord(managedBinding.dirtyState);
      const leaseKind = managedBinding.leaseKind === "process" ? "process" : "run";
      return {
        kind: "managed",
        ...(trimUnknownString(submittedWorkspace?.workspaceId) !== undefined
          ? { workspaceId: trimUnknownString(submittedWorkspace?.workspaceId) }
          : {}),
        label:
          trimUnknownString(submittedWorkspace?.label) ??
          trimUnknownString(input.threadMetadata?.workspaceLabel) ??
          "Managed worktree",
        workspaceRoot: worktreeRoot,
        sourceWorkspaceRoot: managedSourceRoot,
        ...(trimUnknownString(managedBinding.sourceRepoRoot) !== undefined
          ? { sourceRepoRoot: trimUnknownString(managedBinding.sourceRepoRoot) }
          : {}),
        managedWorktreeRoot: worktreeRoot,
        ...(trimUnknownString(managedBinding.baseRefName) !== undefined
          ? { baseRefName: trimUnknownString(managedBinding.baseRefName) }
          : {}),
        ...(trimUnknownString(managedBinding.baseHead) !== undefined
          ? { baseHead: trimUnknownString(managedBinding.baseHead) }
          : {}),
        ...(trimUnknownString(managedBinding.lastObservedSourceHead) !== undefined
          ? { lastObservedSourceHead: trimUnknownString(managedBinding.lastObservedSourceHead) }
          : {}),
        ...(trimUnknownString(managedBinding.leaseId) !== undefined
          ? { leaseId: trimUnknownString(managedBinding.leaseId) }
          : {}),
        leaseKind,
        ...(typeof dirtyState?.dirty === "boolean" ? { dirty: dirtyState.dirty } : {}),
      };
    }
  }

  if (submittedRoot === undefined || sourceWorkspaceRoot === undefined) {
    return ;
  }
  return {
    kind: "local",
    ...(trimUnknownString(submittedWorkspace?.workspaceId) !== undefined
      ? { workspaceId: trimUnknownString(submittedWorkspace?.workspaceId) }
      : {}),
    label:
      trimUnknownString(submittedWorkspace?.label) ??
      trimUnknownString(input.threadMetadata?.workspaceLabel) ??
      "Current workspace",
    workspaceRoot: submittedRoot,
    sourceWorkspaceRoot,
    ...(trimUnknownString(submittedWorkspace?.sourceRepoRoot) !== undefined
      ? { sourceRepoRoot: trimUnknownString(submittedWorkspace?.sourceRepoRoot) }
      : {}),
  };
}

export function resolveThreadWorkspaceRuntimeContext(
  binding: ThreadWorkspaceBinding | undefined,
): WorkspaceRuntimeContext | undefined {
  if (binding === undefined) {
    return ;
  }
  const normalized = normalizeThreadWorkspaceBinding(binding);
  if (normalized.binding !== "active") {
    return ;
  }
  if (normalized.runtimeContext !== undefined) {
    return normalized.runtimeContext;
  }
  if (normalized.workspaceRoot === undefined) {
    return ;
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
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function trimUnknownString(value: unknown): string | undefined {
  return typeof value === "string" ? trimString(value) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}
