import type { RunnerActorMetadata, RunnerEvent } from "../../cli/protocol/contracts.js";
import type {
  RunnerAssistantTextHistoryDataV2,
  RunnerWaitingPromptHistoryDataV2,
} from "@kestrel-agents/protocol";
import type { RunTurnAttachment } from "../kestrel/contracts/orchestration.js";

import type {
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewTarget,
} from "../project/contracts.js";
import type { WorkspaceChangeMutation, WorkspaceChangeScope, WorkspaceDiffOptions } from "../changes/contracts.js";
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
import type { WorkspaceGitAction } from "../git/contracts.js";
import type { TuiProfile } from "../../cli/contracts.js";

interface WebHistoryLineBase {
  text: string;
  timestamp: string;
  attachments?: RunTurnAttachment[] | undefined;
}

export type WebHistoryLine = WebHistoryLineBase & (
  | {
      role: "user";
      data?: undefined;
    }
  | {
      role: "assistant";
      data?: RunnerAssistantTextHistoryDataV2 | undefined;
    }
  | {
      role: "system";
      data: RunnerWaitingPromptHistoryDataV2;
    }
);

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
  resumeRequestId?: string | undefined;
  workspace?: WorkspaceRuntimeContext | undefined;
  attachments?: RunTurnAttachment[] | undefined;
  metadata?: Record<string, unknown> | undefined;
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
        | "continue_waiting"
        | "focus_thread"
        | "resolve_context_checkpoint"
        | "approve_assembly_change"
        | "reject_assembly_change"
        | "spawn_child_thread"
        | "supersede_child_thread"
        | "resolve_fan_in_checkpoint"
        | "enqueue_follow_up"
        | "edit_follow_up"
        | "cancel_follow_up"
        | "resume_follow_up_queue";
      threadId: string;
      completionMode?: "terminal" | "accepted" | undefined;
      followUpId?: string | undefined;
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
      attachmentIds?: string[] | undefined;
      interactionMode?: "chat" | "plan" | "build" | undefined;
      actSubmode?: "strict" | "safe" | "full_auto" | undefined;
      title?: string | undefined;
      rolePrompt?: string | undefined;
      goal?: string | undefined;
      profileId?: string | undefined;
      provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
      model?: string | undefined;
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
      type: "workspace.promotion.list";
      sessionId: string;
    }
  | {
      type: "workspace.promotion.preview";
      sessionId: string;
      promotionId: string;
    }
  | {
      type: "workspace.promotion.apply";
      sessionId: string;
      promotionId: string;
      candidateFingerprint: string;
    }
  | {
      type: "workspace.promotion.undo_latest";
      sessionId: string;
      reason?: string | undefined;
    }
  | {
      type: "workspace.managed.inspect";
      sessionId: string;
      threadId: string;
    }
  | {
      type: "workspace.managed.cleanup";
      sessionId: string;
      threadId: string;
      reason: string;
    }
  | {
      type: "workspace.managed.restore";
      sessionId: string;
      threadId: string;
      checkpointId: string;
      reason?: string | undefined;
    }
  | {
      type: "workspace.managed.setup.retry";
      sessionId: string;
      threadId: string;
    }
  | {
      type: "user.terminal.start";
      sessionId: string;
      threadId: string;
      cols?: number | undefined;
      rows?: number | undefined;
    }
  | {
      type: "user.terminal.list";
      sessionId: string;
      threadId?: string | undefined;
    }
  | {
      type: "user.terminal.read";
      sessionId: string;
      terminalId: string;
      cursor?: number | undefined;
    }
  | {
      type: "user.terminal.write";
      sessionId: string;
      terminalId: string;
      data: string;
    }
  | {
      type: "user.terminal.resize";
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
    }
  | {
      type: "user.terminal.stop";
      sessionId: string;
      terminalId: string;
    }
  | {
      type: "workspace.changes.inspect";
      sessionId: string;
      threadId: string;
      scope: WorkspaceChangeScope;
      options?: Partial<WorkspaceDiffOptions> | undefined;
    }
  | {
      type: "workspace.changes.mutate";
      sessionId: string;
      threadId: string;
      expectedFingerprint: string;
      scope?: WorkspaceChangeScope | undefined;
      options?: Partial<WorkspaceDiffOptions> | undefined;
      mutation: WorkspaceChangeMutation;
    }
  | { type: "workspace.feedback.add"; sessionId: string; threadId: string; candidateFingerprint: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }
  | { type: "workspace.feedback.list"; sessionId: string; threadId: string }
  | { type: "workspace.feedback.remove"; sessionId: string; threadId: string; candidateFingerprint: string; commentId: string }
  | { type: "workspace.feedback.submit"; sessionId: string; threadId: string; candidateFingerprint: string; commentIds: string[] }
  | { type: "workspace.review.run"; sessionId: string; threadId: string; scope: WorkspaceChangeScope; mode?: "current_thread" | "detached_thread"; reviewerProfileId?: string; reviewerModel?: string }
  | { type: "workspace.review.list"; sessionId: string; threadId: string }
  | { type: "workspace.review.update"; sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingId: string; action: "accept" | "dismiss" | "reopen" | "mark_fixed"; reason?: string }
  | { type: "workspace.review.submit"; sessionId: string; threadId: string; candidateFingerprint: string; reviewId: string; findingIds: string[]; request: "address" | "more_evidence" | "verify" }
  | { type: "workspace.validation.inspect"; sessionId: string; threadId: string }
  | { type: "workspace.validation.run"; sessionId: string; threadId: string; candidateFingerprint: string; actionId?: string; suiteId?: string }
  | { type: "workspace.validation.cancel"; sessionId: string; threadId: string; resultId: string }
  | { type: "workspace.validation.submit"; sessionId: string; threadId: string; resultIds: string[] }
  | { type: "workspace.git.inspect"; sessionId: string; threadId: string }
  | { type: "workspace.git.action"; sessionId: string; threadId: string; candidateFingerprint: string; expectedHeadSha?: string; action: WorkspaceGitAction }
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
  /** Trusted caller-only inline profile override for this request. */
  profile?: TuiProfile | undefined;
}
