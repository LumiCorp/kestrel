import { createHash } from "node:crypto";
import path from "node:path";

import type { WebRunTurnRequest } from "../../../src/web/contracts.js";
import type { DesktopProjectRegistration } from "./contracts.js";
import type { ManagedTaskWorktreeSetupSpec } from "../../../src/workspace/ManagedTaskWorktreeService.js";
import { resolveRegisteredDesktopProjectRoot } from "./fileAccess.js";

export function resolveDesktopThreadWorkspace(input: {
  projectPath?: string | undefined;
  projects: readonly DesktopProjectRegistration[];
  defaultKestrelRoot: string;
  workspaceMode?: "local" | "managed" | undefined;
  workspaceBaseRef?: string | undefined;
  workspaceSetup?: ManagedTaskWorktreeSetupSpec | undefined;
}): NonNullable<WebRunTurnRequest["workspace"]> {
  const requestedProjectPath = input.projectPath?.trim();
  const workspaceRoot = requestedProjectPath === undefined
    ? path.resolve(input.defaultKestrelRoot)
    : resolveRegisteredDesktopProjectRoot(
        requestedProjectPath,
        input.projects.map((project) => project.path),
      );
  const project = requestedProjectPath === undefined
    ? undefined
    : input.projects.find((candidate) => path.resolve(candidate.path) === workspaceRoot);

  const managedWorktreeRequired = input.workspaceMode === "managed";
  return {
    workspaceId: deriveDesktopWorkspaceId(workspaceRoot),
    workspaceRoot,
    ...(requestedProjectPath !== undefined
      ? {
          sourceWorkspaceRoot: workspaceRoot,
        }
      : {}),
    launchCwd: workspaceRoot,
    appRoot: ".",
    commands: {},
    label: project?.label ?? (requestedProjectPath === undefined ? "Kestrel" : path.basename(workspaceRoot)),
    managedWorktreeRequired,
    ...(managedWorktreeRequired
      ? {
          managedWorktreeIsolation: "scoped" as const,
          sourceWorkspaceRoot: workspaceRoot,
          ...(input.workspaceBaseRef?.trim() ? { managedWorktreeBaseRef: input.workspaceBaseRef.trim() } : {}),
          ...(input.workspaceSetup !== undefined ? { managedWorktreeSetup: input.workspaceSetup } : {}),
        }
      : {}),
  };
}

export function deriveDesktopWorkspaceId(workspaceRoot: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(workspaceRoot))
    .digest("hex")
    .slice(0, 16);
  return `local:${digest}`;
}
