import type { WorkspaceRuntimeContext } from "../../cli/contracts.js";
import type { ActSubmode, InteractionMode } from "../mode/contracts.js";
import { normalizeInteractionMode } from "../mode/contracts.js";

export type WorkspaceAuthorityMode = "draft_workspace" | "read_only_workspace" | "detached";

export interface WorkspaceAuthorityDescriptor {
  mode: WorkspaceAuthorityMode;
  label: string;
  source: "runtime_mode";
}

export type RuntimeWorkspaceAuthorityContext = WorkspaceRuntimeContext & {
  workspaceAuthority?: WorkspaceAuthorityDescriptor | undefined;
  managedWorktree?: boolean | undefined;
  managedWorktreeRequired?: boolean | undefined;
  sourceWorkspaceRoot?: string | undefined;
};

export interface ResolveWorkspaceAuthorityInput {
  workspace?: WorkspaceRuntimeContext | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  defaultInteractionMode?: InteractionMode | undefined;
  defaultActSubmode?: ActSubmode | undefined;
}

export function resolveRuntimeWorkspaceAuthority(
  input: ResolveWorkspaceAuthorityInput,
): RuntimeWorkspaceAuthorityContext | undefined {
  if (input.workspace === undefined) {
    return undefined;
  }

  const resolvedMode = normalizeInteractionMode({
    interactionMode: input.interactionMode,
    actSubmode: input.actSubmode,
    defaultInteractionMode: input.defaultInteractionMode,
    defaultActSubmode: input.defaultActSubmode,
  });
  const workspace = input.workspace as RuntimeWorkspaceAuthorityContext;
  if (workspace.managedWorktree === true) {
    return withWorkspaceAuthority(workspace, {
      mode: "draft_workspace",
      label: "Draft workspace",
      source: "runtime_mode",
    });
  }

  if (resolvedMode.interactionMode !== "build") {
    return withWorkspaceAuthority(workspace, {
      mode: "read_only_workspace",
      label: "Read-only workspace",
      source: "runtime_mode",
    });
  }

  if (workspace.managedWorktreeRequired === false) {
    return withWorkspaceAuthority(workspace, {
      mode: "draft_workspace",
      label: "Source workspace",
      source: "runtime_mode",
    });
  }

  return withWorkspaceAuthority({
    ...workspace,
    managedWorktreeRequired: workspace.managedWorktreeRequired ?? false,
  }, {
    mode: "draft_workspace",
    label: "Source workspace",
    source: "runtime_mode",
  });
}

function withWorkspaceAuthority(
  workspace: RuntimeWorkspaceAuthorityContext,
  workspaceAuthority: WorkspaceAuthorityDescriptor,
): RuntimeWorkspaceAuthorityContext {
  return {
    ...workspace,
    workspaceAuthority: workspace.workspaceAuthority ?? workspaceAuthority,
  };
}
