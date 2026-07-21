import type {
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeLeaseOwnerLookup,
  ManagedTaskWorktreeProposal,
  ManagedTaskWorktreeProvisionResult,
  ManagedTaskWorktreeRequest,
} from "./ManagedTaskWorktreeService.js";
import type { ManagedTaskWorktreeService } from "./ManagedTaskWorktreeService.js";

export interface WorkspaceLifecycleDevToolRequest extends ManagedTaskWorktreeRequest {
  toolName: string;
  leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup | undefined;
}

export interface WorkspaceLifecycleApprovedWorktreeRequest extends ManagedTaskWorktreeRequest {
  approvedProposal: ManagedTaskWorktreeProposal;
  leaseOwnerLookup?: ManagedTaskWorktreeLeaseOwnerLookup | undefined;
}

export interface WorkspaceLifecycleEventPayloadMetadata extends Record<string, unknown> {
  triggeringTool: string;
  autoProvisioned?: true | undefined;
  approvalDecision?: "approve" | undefined;
  recoveredOrphan?: true | undefined;
  rotatedFromWorktreeRoot?: string | undefined;
}

export interface WorkspaceLifecycleSessionAgentPatch {
  exec: {
    pendingApproval?: undefined;
    managedWorktreeBinding: ManagedTaskWorktreeBinding;
  };
}

export interface WorkspaceLifecycleBoundContext {
  status: "bound";
  binding: ManagedTaskWorktreeBinding;
  disposition: ManagedTaskWorktreeProvisionResult["disposition"];
  eventKind: "created" | "reused";
  runtimeWorkspace: Record<string, unknown>;
  eventPayloadMetadata: WorkspaceLifecycleEventPayloadMetadata;
  sessionAgentPatch: WorkspaceLifecycleSessionAgentPatch;
}

export class WorkspaceLifecycleService {
  constructor(private readonly managedTaskWorktreeService: ManagedTaskWorktreeService) {}

  async ensureManagedWorktreeForDevTool(
    input: WorkspaceLifecycleDevToolRequest,
  ): Promise<WorkspaceLifecycleBoundContext | undefined> {
    return this.provisionAutoWorkspaceTool(input);
  }

  async provisionAutoDevTool(
    input: WorkspaceLifecycleDevToolRequest,
  ): Promise<WorkspaceLifecycleBoundContext | undefined> {
    return this.provisionAutoWorkspaceTool(input);
  }

  async provisionAutoWorkspaceTool(
    input: WorkspaceLifecycleDevToolRequest,
  ): Promise<WorkspaceLifecycleBoundContext | undefined> {
    if (isAutoProvisionedWorkspaceTool(input.toolName) === false) {
      return ;
    }

    const provisioned = await this.managedTaskWorktreeService.provision({
      sessionId: input.sessionId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sourceWorkspaceRoot: input.sourceWorkspaceRoot,
      ...(input.sourceRepoRoot !== undefined ? { sourceRepoRoot: input.sourceRepoRoot } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.toolName,
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
      ...(input.setup !== undefined ? { setup: input.setup } : {}),
      ...(input.leaseOwnerLookup !== undefined ? { leaseOwnerLookup: input.leaseOwnerLookup } : {}),
    });

    return this.toBoundWorkspaceContext(provisioned, {
      triggeringTool: input.toolName,
      autoProvisioned: true,
    });
  }

  async provisionApprovedWorktree(
    input: WorkspaceLifecycleApprovedWorktreeRequest,
  ): Promise<WorkspaceLifecycleBoundContext> {
    const provisioned = await this.managedTaskWorktreeService.provision({
      sessionId: input.sessionId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sourceWorkspaceRoot: input.sourceWorkspaceRoot,
      ...(input.sourceRepoRoot !== undefined ? { sourceRepoRoot: input.sourceRepoRoot } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.isolation !== undefined ? { isolation: input.isolation } : {}),
      triggeringTool: input.triggeringTool,
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
      approvedProposal: input.approvedProposal,
      ...(input.leaseOwnerLookup !== undefined ? { leaseOwnerLookup: input.leaseOwnerLookup } : {}),
    });

    return this.toBoundWorkspaceContext(provisioned, {
      triggeringTool: input.triggeringTool,
      approvalDecision: "approve",
    }, { clearPendingApproval: true });
  }

  toRuntimeWorkspace(binding: ManagedTaskWorktreeBinding): Record<string, unknown> {
    return this.managedTaskWorktreeService.toRuntimeWorkspace(binding);
  }

  toBoundWorkspaceContext(
    provisioned: ManagedTaskWorktreeProvisionResult,
    eventPayloadMetadata: WorkspaceLifecycleEventPayloadMetadata,
    options: { clearPendingApproval?: boolean | undefined } = {},
  ): WorkspaceLifecycleBoundContext {
    const binding = provisioned.binding;
    return {
      status: "bound",
      binding,
      disposition: provisioned.disposition,
      eventKind: provisioned.disposition,
      runtimeWorkspace: this.toRuntimeWorkspace(binding),
      eventPayloadMetadata: {
        ...eventPayloadMetadata,
        ...(provisioned.recovery === "orphan_reclaimed" ? { recoveredOrphan: true } : {}),
        ...(provisioned.recovery === "rotated" && provisioned.previousWorktreeRoot !== undefined
          ? { rotatedFromWorktreeRoot: provisioned.previousWorktreeRoot }
          : {}),
      },
      sessionAgentPatch: {
        exec: {
          ...(options.clearPendingApproval === true ? { pendingApproval: undefined } : {}),
          managedWorktreeBinding: binding,
        },
      },
    };
  }
}

export function isAutoProvisionedDevWorkspaceTool(toolName: string): boolean {
  return (
    toolName === "exec_command" ||
    toolName === "dev.shell.run" ||
    toolName === "dev.process.start"
  );
}

export function isAutoProvisionedSourceWorkspaceTool(toolName: string): boolean {
  return (
    toolName === "fs.create_text" ||
    toolName === "fs.edit_text" ||
    toolName === "fs.apply_patch" ||
    toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.copy" ||
    toolName === "fs.move" ||
    toolName === "fs.delete" ||
    toolName === "fs.mkdir"
  );
}

export function isAutoProvisionedWorkspaceTool(toolName: string): boolean {
  return isAutoProvisionedDevWorkspaceTool(toolName) || isAutoProvisionedSourceWorkspaceTool(toolName);
}
