import type { RunnerActorMetadata, RunnerEvent } from "../../cli/protocol/contracts.js";
import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";

import type {
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewTarget,
} from "../project/contracts.js";
import type { WorkspaceCheckpointCleanupPolicy } from "../workspaceCheckpoints/contracts.js";
import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import type { ClientCapabilities } from "../clientCapabilities.js";
import type {
  ActSubmode,
  ExecutionPolicyOverride,
  InteractionMode,
  ToolExecutionClass,
} from "../mode/contracts.js";
import type { WorkspaceRuntimeContext } from "../../cli/contracts.js";

export interface WebHistoryLine {
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  attachments?: RunTurnAttachment[] | undefined;
}

export interface WebRunTurnRequest {
  sessionId: string;
  runId?: string | undefined;
  message: string;
  eventType: string;
  history?: WebHistoryLine[] | undefined;
  interactionMode?: InteractionMode | undefined;
  actSubmode?: ActSubmode | undefined;
  clientCapabilities?: ClientCapabilities | undefined;
  executionPolicy?: ExecutionPolicyOverride | undefined;
  resumeFromWait?: boolean | undefined;
  resumeBlockedRun?: boolean | undefined;
  workspace?: WorkspaceRuntimeContext | undefined;
  attachments?: RunTurnAttachment[] | undefined;
}

export type WebControlCommand =
  | {
      type: "ping";
      nonce?: string | undefined;
    }
  | {
      type: "session.state";
      sessionId: string;
    }
  | {
      type: "profile.list";
    }
  | {
      type: "mcp.status";
    }
  | {
      type: "mcp.refresh";
    }
  | {
      type: "run.cancel";
      sessionId: string;
      runId?: string | undefined;
      commandId?: string | undefined;
    }
  | {
      type: "operator.inbox";
      sessionId?: string | undefined;
      threadId?: string | undefined;
    }
  | {
      type: "operator.thread";
      threadId: string;
    }
  | {
      type: "operator.runs";
      sessionId?: string | undefined;
      status?: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | undefined;
      limit?: number | undefined;
    }
  | {
      type: "operator.run";
      runId: string;
    }
  | {
      type: "operator.control";
      action:
        | "approve"
        | "reject"
        | "reply"
        | "steer"
        | "retry"
        | "focus_thread"
        | "resolve_context_checkpoint"
        | "approve_assembly_change"
        | "reject_assembly_change"
        | "spawn_child_thread"
        | "supersede_child_thread"
        | "resolve_fan_in_checkpoint";
      threadId: string;
      requestId?: string | undefined;
      proposalId?: string | undefined;
      checkpointId?: string | undefined;
      delegationId?: string | undefined;
      actionValue?:
        | "continue"
        | "compact"
        | "summarize_forward"
        | "handoff"
        | "split_into_child_thread"
        | "operator_checkpoint"
        | "accept"
        | "defer"
        | undefined;
      message?: string | undefined;
      attachments?: RunTurnAttachment[] | undefined;
      title?: string | undefined;
      rolePrompt?: string | undefined;
      goal?: string | undefined;
      profileId?: string | undefined;
      provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
      model?: string | undefined;
      skillPackId?: string | undefined;
      maxTurns?: number | undefined;
      maxRuntimeMs?: number | undefined;
      allowApprovalInheritance?: boolean | undefined;
      allowToolClasses?: ToolExecutionClass[] | undefined;
      allowCapabilities?: string[] | undefined;
    }
  | {
      type: "task.graph.get";
      sessionId: string;
      threadId?: string | undefined;
    }
  | {
      type: "task.graph.update";
      sessionId: string;
      graph: ProductTaskGraph;
      threadId?: string | undefined;
      expectedVersion?: number | undefined;
    }
  | {
      type: "workspace.checkpoint.capture";
      sessionId: string;
      label?: string | undefined;
      reason?: string | undefined;
      threadId?: string | undefined;
      runId?: string | undefined;
      taskId?: string | undefined;
    }
  | {
      type: "workspace.checkpoint.list";
      sessionId: string;
    }
  | {
      type: "workspace.checkpoint.inspect";
      sessionId: string;
      checkpointId: string;
    }
  | {
      type: "workspace.checkpoint.diff";
      sessionId: string;
      source: {
        checkpointId?: string | undefined;
        gitRef?: string | undefined;
        workingTree?: boolean | undefined;
      };
      target: {
        checkpointId?: string | undefined;
        gitRef?: string | undefined;
        workingTree?: boolean | undefined;
      };
      includeHunks?: boolean | undefined;
    }
  | {
      type: "workspace.checkpoint.restore";
      sessionId: string;
      checkpointId: string;
      reason?: string | undefined;
      threadId?: string | undefined;
      runId?: string | undefined;
      taskId?: string | undefined;
    }
  | {
      type: "workspace.checkpoint.cleanup";
      sessionId: string;
      reason?: string | undefined;
      policyOverride?: Partial<WorkspaceCheckpointCleanupPolicy> | undefined;
    }
  | {
      type: "workspace.promotion.undo_latest";
      sessionId: string;
      reason?: string | undefined;
    }
  | {
      type: "project.snapshot.get";
      sessionId: string;
    }
  | {
      type: "project.snapshot.update";
      sessionId: string;
      snapshot: ProductProjectSnapshot;
    }
  | {
      type: "project.action";
      action: ProductProjectAction;
    }
  | {
      type: "project.review.get";
      sessionId: string;
      target: ProductReviewTarget;
    }
  | {
      type: "project.review.action";
      sessionId: string;
      action: ProductReviewAction;
    };

export type WebRunnerEvent = RunnerEvent;

export type ThreadRunCheckInStatus =
  | "none"
  | "starting"
  | "running"
  | "waiting"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled"
  | "lost";

export interface ThreadRunCheckIn {
  threadId: string;
  runId: string | null;
  status: ThreadRunCheckInStatus;
  lastEventId: string | null;
  lastActivityAt: string | null;
  active: boolean;
  canSubscribe: boolean;
  canCancel: boolean;
  message?: string | undefined;
}

export interface ThreadRunStartAccepted {
  threadId: string;
  sessionId: string;
  runId: string;
  commandId: string;
  acceptedAt: string;
}

export interface WebRunTurnStreamOptions {
  onEvent: (event: WebRunnerEvent) => void;
  signal?: AbortSignal | undefined;
}

export interface WebRunnerRequestContext {
  actor?: RunnerActorMetadata | undefined;
  tenantId?: string | undefined;
}
