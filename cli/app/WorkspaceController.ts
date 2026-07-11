import path from "node:path";

import type { ResolvedWorkspace, TuiSessionMeta } from "../contracts.js";
import {
  describeResolvedWorkspace,
  resolveWorkspaceFromBinding,
  resolveWorkspaceFromCwd,
} from "../workspace/WorkspaceResolver.js";
import type { TuiAppContext } from "./TuiAppContext.js";

export type WorkspaceSelection =
  | { kind: "active" | "detached" }
  | { kind: "workspace"; workspace: ResolvedWorkspace }
  | { kind: "invalid" };

export interface WorkspaceControllerContext extends TuiAppContext {
  recordStartupNotices(notices: string[]): void;
}

export class WorkspaceController {
  private readonly context: WorkspaceControllerContext;

  constructor(context: WorkspaceControllerContext) {
    this.context = context;
  }

  async handleWorkspaceCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const state = this.context.uiStore.getState();

    if (subcommand === undefined) {
      this.context.navigateToView("workspace");
      await this.context.persistUiState();
      return;
    }

    if (subcommand === "status") {
      let activeWorkspace = this.context.getActiveWorkspace();
      const sessionIsDetached = state.activeSession.workspaceBinding === "detached";
      if (activeWorkspace === undefined) {
        const resolved = await resolveWorkspaceFromCwd(this.context.options.cwd, this.context.workspaceStore);
        this.context.recordStartupNotices(resolved.notices);
        activeWorkspace = resolved.workspace;
        if (activeWorkspace === undefined) {
          await this.context.appendHistoryLine(
            "system",
            "Workspace: none",
          );
          return;
        }
        if (sessionIsDetached === false) {
          this.context.setActiveWorkspace(activeWorkspace);
          this.context.setLaunchWorkspace(activeWorkspace);
          await this.context.setActiveSessionState({
            workspaceBinding: "active",
            workspaceId: activeWorkspace.manifest.workspaceId,
            workspaceRoot: activeWorkspace.rootPath,
            workspaceLabel: describeResolvedWorkspace(activeWorkspace),
            profileId: state.activeProfile.id,
            updatedAt: new Date().toISOString(),
          });
          await this.context.persistSessionAndUi();
        }
      }

      const latestState = this.context.uiStore.getState();
      const workspaces = await this.context.workspaceStore.load();
      const registryEntry = this.context.workspaceStore.findById(
        workspaces,
        activeWorkspace.manifest.workspaceId,
      );
      const lines = [
        `Workspace: ${activeWorkspace.manifest.workspaceId}`,
        `Root: ${activeWorkspace.rootPath}`,
        ...(activeWorkspace.runtimeContext.launchCwd !== undefined &&
        path.resolve(activeWorkspace.runtimeContext.launchCwd) !== path.resolve(activeWorkspace.rootPath)
          ? [`Launch cwd: ${activeWorkspace.runtimeContext.launchCwd}`]
          : []),
        `Automation: ${registryEntry?.automationEnabled === true ? "enabled" : "disabled"}`,
        `Session binding: ${latestState.activeSession.workspaceBinding === "detached"
          ? "detached"
          : latestState.activeSession.workspaceId ?? "none"}`,
      ];
      await this.context.appendHistoryLine("system", lines.join("\n"));
      return;
    }

    if (subcommand === "list") {
      const workspaces = await this.listDiscoveredWorkspaces();
      if (workspaces.length === 0) {
        await this.context.appendHistoryLine("system", "No workspaces discovered.");
        return;
      }
      const activeWorkspace = this.context.getActiveWorkspace();
      const lines = workspaces.map((workspace) => {
        const active = activeWorkspace?.manifest.workspaceId === workspace.manifest.workspaceId ? " active=yes" : "";
        return `${workspace.manifest.workspaceId} root=${workspace.rootPath}${active}`;
      });
      await this.context.appendHistoryLine("system", `Workspaces:\n${lines.join("\n")}`);
      return;
    }

    if (subcommand === "use") {
      const target = rest.join(" ").trim();
      if (target.length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /workspace use <workspaceId|rootPath|detached>");
        return;
      }

      if (target === "detached") {
        this.context.setActiveWorkspace(undefined);
        this.context.setLaunchWorkspace(undefined);
        await this.context.setActiveSessionState({
          workspaceBinding: "detached",
          workspaceId: undefined,
          workspaceRoot: undefined,
          workspaceLabel: "Detached workspace",
          profileId: state.activeProfile.id,
          updatedAt: new Date().toISOString(),
        });
        await this.context.persistSessionAndUi();
        await this.context.appendHistoryLine("system", "Detached the active session from any workspace.");
        return;
      }

      const selectedWorkspace = await this.resolveWorkspaceFromSelectionValue(target);
      if (selectedWorkspace === undefined) {
        await this.context.appendHistoryLine(
          "system",
          `Workspace '${target}' was not found. Use '/workspace list' to inspect discovered workspaces.`,
        );
        return;
      }
      this.context.setActiveWorkspace(selectedWorkspace);
      this.context.setLaunchWorkspace(selectedWorkspace);
      await this.context.setActiveSessionState({
        workspaceBinding: "active",
        workspaceId: selectedWorkspace.manifest.workspaceId,
        workspaceRoot: selectedWorkspace.rootPath,
        workspaceLabel: describeResolvedWorkspace(selectedWorkspace),
        profileId: state.activeProfile.id,
        updatedAt: new Date().toISOString(),
      });
      await this.context.persistSessionAndUi();
      await this.context.appendHistoryLine(
        "system",
        `Bound the active session to workspace '${selectedWorkspace.manifest.workspaceId}' at '${selectedWorkspace.rootPath}'.`,
      );
      return;
    }

    await this.context.appendHistoryLine(
      "system",
      "Usage: /workspace status | /workspace list | /workspace use <workspaceId|rootPath|detached>",
    );
  }

  async resolveWorkspaceForSession(session: TuiSessionMeta): Promise<ResolvedWorkspace | undefined> {
    const resolved = await resolveWorkspaceFromBinding({
      workspaceId: session.workspaceId,
      workspaceRoot: session.workspaceRoot,
    }, this.context.workspaceStore);
    this.context.recordStartupNotices(resolved.notices);
    return resolved.workspace;
  }

  buildStartupWorkspaceSessionTitle(workspace: ResolvedWorkspace): string {
    const basename = path.basename(workspace.rootPath).trim();
    return basename.length > 0 ? `default-${basename}` : `default-${workspace.manifest.workspaceId}`;
  }

  async listDiscoveredWorkspaces(): Promise<ResolvedWorkspace[]> {
    const workspaces = await this.context.workspaceStore.load();
    const resolved: ResolvedWorkspace[] = [];
    const seen = new Set<string>();
    for (const entry of [...workspaces.workspaces].sort((left, right) => left.rootPath.localeCompare(right.rootPath))) {
      const candidate = await this.resolveWorkspaceFromSelectionValue(entry.workspaceId) ??
        await this.resolveWorkspaceFromSelectionValue(entry.rootPath);
      if (candidate === undefined) {
        continue;
      }
      const key = path.resolve(candidate.rootPath);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push(candidate);
    }
    return resolved;
  }

  resolveWorkspaceSelection(raw: string, discovered: ResolvedWorkspace[]): WorkspaceSelection {
    const normalized = raw.trim();
    if (normalized === "active" || normalized === "current") {
      return { kind: "active" };
    }
    if (normalized === "detached") {
      return { kind: "detached" };
    }
    const matched = discovered.find((workspace) =>
      workspace.manifest.workspaceId === normalized ||
      path.resolve(workspace.rootPath) === path.resolve(normalized),
    );
    return matched === undefined ? { kind: "invalid" } : { kind: "workspace", workspace: matched };
  }

  async resolveWorkspaceFromSelectionValue(value: string | undefined): Promise<ResolvedWorkspace | undefined> {
    if (value === undefined || value.trim().length === 0) {
      return undefined;
    }
    const resolved = await resolveWorkspaceFromBinding({
      workspaceId: value,
      workspaceRoot: value,
    }, this.context.workspaceStore);
    return resolved.workspace;
  }

  async refreshWorkspaceForActiveSession(): Promise<ResolvedWorkspace | undefined> {
    const state = this.context.uiStore.getState();
    const activeSession = state.activeSession;
    if (activeSession.workspaceId === undefined && activeSession.workspaceRoot === undefined) {
      this.context.setActiveWorkspace(undefined);
      return undefined;
    }
    const resolved = await resolveWorkspaceFromBinding({
      workspaceId: activeSession.workspaceId,
      workspaceRoot: activeSession.workspaceRoot,
    }, this.context.workspaceStore);
    this.context.setActiveWorkspace(resolved.workspace);
    for (const notice of resolved.notices) {
      await this.context.appendHistoryLine("system", notice);
    }
    return resolved.workspace;
  }
}
