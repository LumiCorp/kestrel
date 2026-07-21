import {
  parseExecutionTicketAuthorization,
  parseHostedMcpContext,
  parseHostedMcpRuntimeConnection,
} from "../../src/mcp/hosted-contracts.js";
import { parseRunnerCommandV2 } from "@kestrel-agents/protocol";
import { parseTaskAction } from "../../src/missionControl/contracts.js";
import { parseOperatorControlPolicyFields } from "../../src/orchestration/OperatorControlValidation.js";
import { parseProductProjectBoardAction } from "../../src/project/contracts.js";
import { maybeBuildDatabaseConnectionFailure } from "../../src/runtime/databasePreflight.js";
import { asRuntimeError } from "../../src/runtime/RuntimeFailure.js";
import { parseJobInputV1 } from "../job/contracts.js";
import { readDatabaseUrlSource } from "../localCoreEnv.js";
import type {
  JobRunCommandPayload,
  McpRefreshCommandPayload,
  McpStatusCommandPayload,
  OperatorControlCommandPayload,
  OperatorInboxCommandPayload,
  OperatorRunCommandPayload,
  OperatorRunReasoningCommandPayload,
  OperatorRunsCommandPayload,
  OperatorThreadCommandPayload,
  ProfileGetCommandPayload,
  ProfileListCommandPayload,
  ProjectActionCommandPayload,
  ProjectReviewActionCommandPayload,
  ProjectReviewGetCommandPayload,
  ProjectSnapshotGetCommandPayload,
  ProjectSnapshotUpdateCommandPayload,
  RunCancelCommandPayload,
  RunnerCommand,
  RunnerPingCommandPayload,
  RunStartCommandPayload,
  SessionDescribeCommandPayload,
  SessionStateCommandPayload,
  TaskGraphGetCommandPayload,
  TaskGraphUpdateCommandPayload,
  UserTerminalListCommandPayload,
  UserTerminalReadCommandPayload,
  UserTerminalResizeCommandPayload,
  UserTerminalStartCommandPayload,
  UserTerminalStopCommandPayload,
  UserTerminalWriteCommandPayload,
  WorkspaceChangesInspectCommandPayload,
  WorkspaceChangesMutateCommandPayload,
  WorkspaceFeedbackAddCommandPayload,
  WorkspaceFeedbackListCommandPayload,
  WorkspaceFeedbackRemoveCommandPayload,
  WorkspaceFeedbackSubmitCommandPayload,
  WorkspaceReviewRunCommandPayload,
  WorkspaceReviewListCommandPayload,
  WorkspaceReviewUpdateCommandPayload,
  WorkspaceReviewSubmitCommandPayload,
  WorkspaceValidationInspectCommandPayload,
  WorkspaceValidationRunCommandPayload,
  WorkspaceValidationCancelCommandPayload,
  WorkspaceValidationSubmitCommandPayload,
  WorkspaceGitInspectCommandPayload,
  WorkspaceGitActionCommandPayload,
  WorkspaceCheckpointCaptureCommandPayload,
  WorkspaceCheckpointCleanupCommandPayload,
  WorkspaceCheckpointDiffCommandPayload,
  WorkspaceCheckpointInspectCommandPayload,
  WorkspaceCheckpointListCommandPayload,
  WorkspaceCheckpointRestoreCommandPayload,
  WorkspacePromotionApplyCommandPayload,
  WorkspacePromotionListCommandPayload,
  WorkspacePromotionPreviewCommandPayload,
  WorkspacePromotionUndoLatestCommandPayload,
  WorkspaceManagedCleanupCommandPayload,
  WorkspaceManagedInspectCommandPayload,
  WorkspaceManagedRestoreCommandPayload,
  WorkspaceManagedSetupRetryCommandPayload,
} from "../protocol/contracts.js";
import {
  RUN_STARTED_ACT_SUBMODES,
  RUN_STARTED_INTERACTION_MODES,
} from "../protocol/contracts.js";
import type { RunnerEventSink } from "./EventWriter.js";
import type { RunnerHost } from "./RunnerHost.js";

export class CommandRouter {
  private readonly host: RunnerHost;
  private readonly writer: RunnerEventSink;

  constructor(host: RunnerHost, writer: RunnerEventSink) {
    this.host = host;
    this.writer = writer;
  }

  async acceptLine(
    line: string,
    options: {
      signal?: AbortSignal | undefined;
    } = {}
  ): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      this.writer.emit("runner.error", {
        code: "INVALID_COMMAND",
        message: "Command line is not valid JSON",
      });
      return;
    }

    let command: RunnerCommand;
    try {
      command = parseRunnerCommandV2(decoded) as RunnerCommand;
    } catch (error) {
      const commandId = readCommandId(decoded);
      this.writer.emit("runner.error", {
        code: "INVALID_COMMAND",
        message: error instanceof Error
          ? error.message
          : "Command envelope must include id, type, payload",
      }, commandId === undefined ? undefined : { commandId });
      return;
    }

    try {
      await this.host.executeCommand(() => this.dispatch(command, options));
    } catch (error) {
      this.emitCommandFailure(command, error);
    }
  }

  private async dispatch(
    command: RunnerCommand,
    options: {
      signal?: AbortSignal | undefined;
    }
  ): Promise<void> {
    try {
      if (command.type === "profile.list") {
        const payload = validateProfileListPayload(command.payload);
        await this.host.profileList(command.id, payload);
        return;
      }

      if (command.type === "profile.get") {
        const payload = validateProfileGetPayload(command.payload);
        await this.host.profileGet(command.id, payload);
        return;
      }

      if (command.type === "run.start") {
        const payload = validateRunStartPayload(command.payload);
        await this.host.runStart(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "job.run") {
        const payload = validateJobRunPayload(command.payload);
        await this.host.jobRun(command.id, payload);
        return;
      }

      if (command.type === "run.cancel") {
        const payload = validateRunCancelPayload(command.payload);
        await this.host.runCancel(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "session.describe") {
        const payload = validateSessionDescribePayload(command.payload);
        await this.host.describeSession(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "session.state") {
        const payload = validateSessionStatePayload(command.payload);
        await this.host.sessionState(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.inbox") {
        const payload = validateOperatorInboxPayload(command.payload);
        await this.host.operatorInbox(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.thread") {
        const payload = validateOperatorThreadPayload(command.payload);
        await this.host.operatorThread(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.runs") {
        const payload = validateOperatorRunsPayload(command.payload);
        await this.host.operatorRuns(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.run") {
        const payload = validateOperatorRunPayload(command.payload);
        await this.host.operatorRun(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.run.reasoning") {
        const payload = validateOperatorRunReasoningPayload(command.payload);
        await this.host.operatorRunReasoning(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "operator.control") {
        const payload = validateOperatorControlPayload(command.payload);
        await this.host.operatorControl(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "task.graph.get") {
        const payload = validateTaskGraphGetPayload(command.payload);
        await this.host.taskGraphGet(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "task.graph.update") {
        const payload = validateTaskGraphUpdatePayload(command.payload);
        await this.host.taskGraphUpdate(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "workspace.checkpoint.capture") {
        const payload = validateWorkspaceCheckpointCapturePayload(
          command.payload
        );
        await this.host.workspaceCheckpointCapture(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.checkpoint.list") {
        const payload = validateWorkspaceCheckpointListPayload(command.payload);
        await this.host.workspaceCheckpointList(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.checkpoint.inspect") {
        const payload = validateWorkspaceCheckpointInspectPayload(
          command.payload
        );
        await this.host.workspaceCheckpointInspect(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.checkpoint.diff") {
        const payload = validateWorkspaceCheckpointDiffPayload(command.payload);
        await this.host.workspaceCheckpointDiff(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.checkpoint.restore") {
        const payload = validateWorkspaceCheckpointRestorePayload(
          command.payload
        );
        await this.host.workspaceCheckpointRestore(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.checkpoint.cleanup") {
        const payload = validateWorkspaceCheckpointCleanupPayload(
          command.payload
        );
        await this.host.workspaceCheckpointCleanup(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.promotion.undo_latest") {
        const payload = validateWorkspacePromotionUndoLatestPayload(
          command.payload
        );
        await this.host.workspacePromotionUndoLatest(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.promotion.list") {
        const payload = validateWorkspacePromotionListPayload(command.payload);
        await this.host.workspacePromotionList(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.promotion.preview") {
        const payload = validateWorkspacePromotionPreviewPayload(
          command.payload
        );
        await this.host.workspacePromotionPreview(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.promotion.apply") {
        const payload = validateWorkspacePromotionApplyPayload(command.payload);
        await this.host.workspacePromotionApply(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "workspace.managed.inspect") {
        const payload = validateWorkspaceManagedInspectPayload(command.payload);
        await this.host.workspaceManagedInspect(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "workspace.managed.cleanup") {
        const payload = validateWorkspaceManagedCleanupPayload(command.payload);
        await this.host.workspaceManagedCleanup(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "workspace.managed.restore") {
        const payload = validateWorkspaceManagedRestorePayload(command.payload);
        await this.host.workspaceManagedRestore(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "workspace.managed.setup.retry") {
        const payload = validateWorkspaceManagedSetupRetryPayload(command.payload);
        await this.host.workspaceManagedSetupRetry(command.id, payload, command.metadata);
        return;
      }

      if (command.type === "user.terminal.start") {
        await this.host.userTerminalStart(command.id, validateUserTerminalStartPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "user.terminal.list") {
        await this.host.userTerminalList(command.id, validateUserTerminalListPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "user.terminal.read") {
        await this.host.userTerminalRead(command.id, validateUserTerminalReadPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "user.terminal.write") {
        await this.host.userTerminalWrite(command.id, validateUserTerminalWritePayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "user.terminal.resize") {
        await this.host.userTerminalResize(command.id, validateUserTerminalResizePayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "user.terminal.stop") {
        await this.host.userTerminalStop(command.id, validateUserTerminalStopPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.changes.inspect") {
        await this.host.workspaceChangesInspect(command.id, validateWorkspaceChangesInspectPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.changes.mutate") {
        await this.host.workspaceChangesMutate(command.id, validateWorkspaceChangesMutatePayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.feedback.add") {
        await this.host.workspaceFeedbackAdd(command.id, validateWorkspaceFeedbackAddPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.feedback.list") {
        await this.host.workspaceFeedbackList(command.id, validateWorkspaceFeedbackListPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.feedback.remove") {
        await this.host.workspaceFeedbackRemove(command.id, validateWorkspaceFeedbackRemovePayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.feedback.submit") {
        await this.host.workspaceFeedbackSubmit(command.id, validateWorkspaceFeedbackSubmitPayload(command.payload), command.metadata);
        return;
      }
      if (command.type === "workspace.review.run") { await this.host.workspaceReviewRun(command.id, validateWorkspaceReviewRunPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.review.list") { await this.host.workspaceReviewList(command.id, validateWorkspaceReviewListPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.review.update") { await this.host.workspaceReviewUpdate(command.id, validateWorkspaceReviewUpdatePayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.review.submit") { await this.host.workspaceReviewSubmit(command.id, validateWorkspaceReviewSubmitPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.validation.inspect") { await this.host.workspaceValidationInspect(command.id, validateWorkspaceValidationInspectPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.validation.run") { await this.host.workspaceValidationRun(command.id, validateWorkspaceValidationRunPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.validation.cancel") { await this.host.workspaceValidationCancel(command.id, validateWorkspaceValidationCancelPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.validation.submit") { await this.host.workspaceValidationSubmit(command.id, validateWorkspaceValidationSubmitPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.git.inspect") { await this.host.workspaceGitInspect(command.id, validateWorkspaceGitInspectPayload(command.payload), command.metadata); return; }
      if (command.type === "workspace.git.action") { await this.host.workspaceGitAction(command.id, validateWorkspaceGitActionPayload(command.payload), command.metadata); return; }

      if (command.type === "project.snapshot.get") {
        const payload = validateProjectSnapshotGetPayload(command.payload);
        await this.host.projectSnapshotGet(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "project.snapshot.update") {
        const payload = validateProjectSnapshotUpdatePayload(command.payload);
        await this.host.projectSnapshotUpdate(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "project.action") {
        const payload = validateProjectActionPayload(command.payload);
        await this.host.projectAction(command.id, payload, command.metadata);
        return;
      }
      if (command.type === "project.review.get") {
        const payload = validateProjectReviewGetPayload(command.payload);
        await this.host.projectReviewGet(command.id, payload, command.metadata);
        return;
      }
      if (command.type === "project.review.action") {
        const payload = validateProjectReviewActionPayload(command.payload);
        await this.host.projectReviewAction(
          command.id,
          payload,
          command.metadata
        );
        return;
      }

      if (command.type === "runner.ping") {
        const payload = validateRunnerPingPayload(command.payload);
        await this.host.ping(command.id, payload);
        return;
      }

      if (command.type === "mcp.status") {
        const payload = validateMcpStatusPayload(command.payload);
        await this.host.mcpStatus(command.id, payload);
        return;
      }

      if (command.type === "mcp.refresh") {
        const payload = validateMcpRefreshPayload(command.payload);
        await this.host.mcpRefresh(command.id, payload);
        return;
      }

      const unknownType = (command as { type?: string }).type ?? "unknown";
      const commandId = (command as { id?: string }).id;
      const metadata =
        typeof commandId === "string" ? { commandId } : undefined;
      this.writer.emit(
        "runner.error",
        {
          code: "INVALID_COMMAND",
          message: `Unsupported command type '${unknownType}'`,
        },
        metadata
      );
      return;
    } catch (error) {
      this.emitCommandFailure(command, error);
    }
  }

  private emitCommandFailure(command: RunnerCommand, error: unknown): void {
    const runtimeError = asRuntimeError(error);
    const normalizedFailure = normalizeDatabaseRuntimeFailure(error);
    const details = {
      runtimeCode: runtimeError.code,
      ...(runtimeError.details !== undefined ? runtimeError.details : {}),
      ...(normalizedFailure?.details ?? {}),
    };
    this.writer.emit(
      "runner.error",
      {
        code: normalizedFailure?.code ?? "RUNNER_RUNTIME_ERROR",
        message: normalizedFailure?.message ?? runtimeError.message,
        details,
      },
      { commandId: command.id },
    );
  }
}

function readCommandId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function normalizeDatabaseRuntimeFailure(error: unknown) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    return;
  }
  const databaseUrlSource = readDatabaseUrlSource();
  return maybeBuildDatabaseConnectionFailure({
    error,
    descriptor: {
      databaseUrl,
      databaseUrlSource,
    },
    env: process.env,
  });
}

function validateTaskGraphGetPayload(
  value: unknown
): TaskGraphGetCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task.graph.get payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "task.graph.get payload.sessionId must be a non-empty string"
    );
  }
  if (
    record.threadId !== undefined &&
    (typeof record.threadId !== "string" || record.threadId.trim().length === 0)
  ) {
    throw new Error(
      "task.graph.get payload.threadId must be a string when present"
    );
  }
  return {
    sessionId: record.sessionId,
    ...(typeof record.threadId === "string"
      ? { threadId: record.threadId }
      : {}),
  };
}

function validateTaskGraphUpdatePayload(
  value: unknown
): TaskGraphUpdateCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task.graph.update payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "task.graph.update payload.sessionId must be a non-empty string"
    );
  }
  if (
    typeof record.graph !== "object" ||
    record.graph === null ||
    Array.isArray(record.graph)
  ) {
    throw new Error("task.graph.update payload.graph must be an object");
  }
  if (
    record.threadId !== undefined &&
    (typeof record.threadId !== "string" || record.threadId.trim().length === 0)
  ) {
    throw new Error(
      "task.graph.update payload.threadId must be a string when present"
    );
  }
  if (
    record.expectedVersion !== undefined &&
    (!Number.isInteger(record.expectedVersion) ||
      Number(record.expectedVersion) < 0)
  ) {
    throw new Error(
      "task.graph.update payload.expectedVersion must be a non-negative integer when present"
    );
  }
  return {
    sessionId: record.sessionId,
    graph: record.graph as TaskGraphUpdateCommandPayload["graph"],
    ...(typeof record.threadId === "string"
      ? { threadId: record.threadId }
      : {}),
    ...(typeof record.expectedVersion === "number"
      ? { expectedVersion: record.expectedVersion }
      : {}),
  };
}

function validateWorkspaceCheckpointCapturePayload(
  value: unknown
): WorkspaceCheckpointCaptureCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.capture");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.capture payload.sessionId"
    ),
    ...(readOptionalNonEmptyString(record.label) !== undefined
      ? { label: readOptionalNonEmptyString(record.label) }
      : {}),
    ...(readOptionalNonEmptyString(record.reason) !== undefined
      ? { reason: readOptionalNonEmptyString(record.reason) }
      : {}),
    ...(readOptionalNonEmptyString(record.threadId) !== undefined
      ? { threadId: readOptionalNonEmptyString(record.threadId) }
      : {}),
    ...(readOptionalNonEmptyString(record.runId) !== undefined
      ? { runId: readOptionalNonEmptyString(record.runId) }
      : {}),
    ...(readOptionalNonEmptyString(record.taskId) !== undefined
      ? { taskId: readOptionalNonEmptyString(record.taskId) }
      : {}),
  };
}

function validateWorkspaceCheckpointListPayload(
  value: unknown
): WorkspaceCheckpointListCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.list");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.list payload.sessionId"
    ),
  };
}

function validateWorkspaceCheckpointInspectPayload(
  value: unknown
): WorkspaceCheckpointInspectCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.inspect");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.inspect payload.sessionId"
    ),
    checkpointId: requireNonEmptyString(
      record.checkpointId,
      "workspace.checkpoint.inspect payload.checkpointId"
    ),
  };
}

function validateWorkspaceCheckpointDiffPayload(
  value: unknown
): WorkspaceCheckpointDiffCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.diff");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.diff payload.sessionId"
    ),
    source: validateWorkspaceCheckpointDiffEndpoint(
      record.source,
      "workspace.checkpoint.diff payload.source"
    ),
    target: validateWorkspaceCheckpointDiffEndpoint(
      record.target,
      "workspace.checkpoint.diff payload.target"
    ),
    ...(typeof record.includeHunks === "boolean"
      ? { includeHunks: record.includeHunks }
      : {}),
  };
}

function validateWorkspaceCheckpointRestorePayload(
  value: unknown
): WorkspaceCheckpointRestoreCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.restore");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.restore payload.sessionId"
    ),
    checkpointId: requireNonEmptyString(
      record.checkpointId,
      "workspace.checkpoint.restore payload.checkpointId"
    ),
    ...(readOptionalNonEmptyString(record.reason) !== undefined
      ? { reason: readOptionalNonEmptyString(record.reason) }
      : {}),
    ...(readOptionalNonEmptyString(record.threadId) !== undefined
      ? { threadId: readOptionalNonEmptyString(record.threadId) }
      : {}),
    ...(readOptionalNonEmptyString(record.runId) !== undefined
      ? { runId: readOptionalNonEmptyString(record.runId) }
      : {}),
    ...(readOptionalNonEmptyString(record.taskId) !== undefined
      ? { taskId: readOptionalNonEmptyString(record.taskId) }
      : {}),
  };
}

function validateWorkspaceCheckpointCleanupPayload(
  value: unknown
): WorkspaceCheckpointCleanupCommandPayload {
  const record = ensureObjectPayload(value, "workspace.checkpoint.cleanup");
  const policyOverride = record.policyOverride;
  if (
    policyOverride !== undefined &&
    (typeof policyOverride !== "object" ||
      policyOverride === null ||
      Array.isArray(policyOverride))
  ) {
    throw new Error(
      "workspace.checkpoint.cleanup payload.policyOverride must be an object when present"
    );
  }
  const policyRecord = policyOverride as Record<string, unknown> | undefined;
  const maxAgeRecord =
    policyRecord?.maxAgeDaysByClass !== undefined &&
    typeof policyRecord.maxAgeDaysByClass === "object" &&
    policyRecord.maxAgeDaysByClass !== null &&
    Array.isArray(policyRecord.maxAgeDaysByClass) === false
      ? (policyRecord.maxAgeDaysByClass as Record<string, unknown>)
      : undefined;
  const maxCheckpointCount = readPositiveInteger(
    policyRecord?.maxCheckpointCount,
    "workspace.checkpoint.cleanup payload.policyOverride.maxCheckpointCount"
  );
  const maxRetainedBytes = readPositiveInteger(
    policyRecord?.maxRetainedBytes,
    "workspace.checkpoint.cleanup payload.policyOverride.maxRetainedBytes"
  );
  const maxAgeManual = readNonNegativeInteger(
    maxAgeRecord?.manual,
    "workspace.checkpoint.cleanup payload.policyOverride.maxAgeDaysByClass.manual"
  );
  const maxAgePreMutation = readNonNegativeInteger(
    maxAgeRecord?.pre_mutation,
    "workspace.checkpoint.cleanup payload.policyOverride.maxAgeDaysByClass.pre_mutation"
  );
  const maxAgeRecoveryAnchor = readNonNegativeInteger(
    maxAgeRecord?.recovery_anchor,
    "workspace.checkpoint.cleanup payload.policyOverride.maxAgeDaysByClass.recovery_anchor"
  );
  const maxAgeSourcePrePromotion = readNonNegativeInteger(
    maxAgeRecord?.source_pre_promotion,
    "workspace.checkpoint.cleanup payload.policyOverride.maxAgeDaysByClass.source_pre_promotion"
  );
  const maxAgeSourcePostPromotion = readNonNegativeInteger(
    maxAgeRecord?.source_post_promotion,
    "workspace.checkpoint.cleanup payload.policyOverride.maxAgeDaysByClass.source_post_promotion"
  );
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.checkpoint.cleanup payload.sessionId"
    ),
    ...(readOptionalNonEmptyString(record.reason) !== undefined
      ? { reason: readOptionalNonEmptyString(record.reason) }
      : {}),
    ...(policyRecord !== undefined
      ? {
          policyOverride: {
            ...(maxCheckpointCount !== undefined ? { maxCheckpointCount } : {}),
            ...(maxRetainedBytes !== undefined ? { maxRetainedBytes } : {}),
            ...(typeof policyRecord.protectLabeled === "boolean"
              ? { protectLabeled: policyRecord.protectLabeled }
              : {}),
            ...(typeof policyRecord.protectLatestPerThread === "boolean"
              ? { protectLatestPerThread: policyRecord.protectLatestPerThread }
              : {}),
            ...(typeof policyRecord.protectLatestPerRun === "boolean"
              ? { protectLatestPerRun: policyRecord.protectLatestPerRun }
              : {}),
            ...(typeof policyRecord.protectLatestPerTask === "boolean"
              ? { protectLatestPerTask: policyRecord.protectLatestPerTask }
              : {}),
            ...(maxAgeRecord !== undefined
              ? {
                  maxAgeDaysByClass: {
                    ...(maxAgeManual !== undefined
                      ? { manual: maxAgeManual }
                      : {}),
                    ...(maxAgePreMutation !== undefined
                      ? { pre_mutation: maxAgePreMutation }
                      : {}),
                    ...(maxAgeRecoveryAnchor !== undefined
                      ? { recovery_anchor: maxAgeRecoveryAnchor }
                      : {}),
                    ...(maxAgeSourcePrePromotion !== undefined
                      ? { source_pre_promotion: maxAgeSourcePrePromotion }
                      : {}),
                    ...(maxAgeSourcePostPromotion !== undefined
                      ? { source_post_promotion: maxAgeSourcePostPromotion }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function validateWorkspacePromotionUndoLatestPayload(
  value: unknown
): WorkspacePromotionUndoLatestCommandPayload {
  const record = ensureObjectPayload(value, "workspace.promotion.undo_latest");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.promotion.undo_latest payload.sessionId"
    ),
    ...(readOptionalNonEmptyString(record.reason) !== undefined
      ? { reason: readOptionalNonEmptyString(record.reason) }
      : {}),
  };
}

function validateWorkspacePromotionListPayload(
  value: unknown
): WorkspacePromotionListCommandPayload {
  const record = ensureObjectPayload(value, "workspace.promotion.list");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.promotion.list payload.sessionId"
    ),
  };
}

function validateWorkspacePromotionPreviewPayload(
  value: unknown
): WorkspacePromotionPreviewCommandPayload {
  const record = ensureObjectPayload(value, "workspace.promotion.preview");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.promotion.preview payload.sessionId"
    ),
    promotionId: requireNonEmptyString(
      record.promotionId,
      "workspace.promotion.preview payload.promotionId"
    ),
  };
}

function validateWorkspacePromotionApplyPayload(
  value: unknown
): WorkspacePromotionApplyCommandPayload {
  const record = ensureObjectPayload(value, "workspace.promotion.apply");
  return {
    sessionId: requireNonEmptyString(
      record.sessionId,
      "workspace.promotion.apply payload.sessionId"
    ),
    promotionId: requireNonEmptyString(
      record.promotionId,
      "workspace.promotion.apply payload.promotionId"
    ),
    candidateFingerprint: requireNonEmptyString(
      record.candidateFingerprint,
      "workspace.promotion.apply payload.candidateFingerprint"
    ),
  };
}

function validateWorkspaceManagedInspectPayload(
  value: unknown
): WorkspaceManagedInspectCommandPayload {
  const record = ensureObjectPayload(value, "workspace.managed.inspect");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.managed.inspect payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.managed.inspect payload.threadId"),
  };
}

function validateWorkspaceManagedCleanupPayload(
  value: unknown
): WorkspaceManagedCleanupCommandPayload {
  const record = ensureObjectPayload(value, "workspace.managed.cleanup");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.managed.cleanup payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.managed.cleanup payload.threadId"),
    reason: requireNonEmptyString(record.reason, "workspace.managed.cleanup payload.reason"),
  };
}

function validateWorkspaceManagedRestorePayload(
  value: unknown
): WorkspaceManagedRestoreCommandPayload {
  const record = ensureObjectPayload(value, "workspace.managed.restore");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.managed.restore payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.managed.restore payload.threadId"),
    checkpointId: requireNonEmptyString(record.checkpointId, "workspace.managed.restore payload.checkpointId"),
    ...(typeof record.reason === "string" && record.reason.trim().length > 0
      ? { reason: record.reason.trim() }
      : {}),
  };
}

function validateWorkspaceManagedSetupRetryPayload(
  value: unknown
): WorkspaceManagedSetupRetryCommandPayload {
  const record = ensureObjectPayload(value, "workspace.managed.setup.retry");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.managed.setup.retry payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.managed.setup.retry payload.threadId"),
  };
}

function validateUserTerminalStartPayload(value: unknown): UserTerminalStartCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.start");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.start payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "user.terminal.start payload.threadId"),
    ...(record.cols !== undefined ? { cols: readTerminalDimension(record.cols, "user.terminal.start payload.cols") } : {}),
    ...(record.rows !== undefined ? { rows: readTerminalDimension(record.rows, "user.terminal.start payload.rows") } : {}),
  };
}

function validateUserTerminalListPayload(value: unknown): UserTerminalListCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.list");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.list payload.sessionId"),
    ...(record.threadId !== undefined
      ? { threadId: requireNonEmptyString(record.threadId, "user.terminal.list payload.threadId") }
      : {}),
  };
}

function validateUserTerminalReadPayload(value: unknown): UserTerminalReadCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.read");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.read payload.sessionId"),
    terminalId: requireNonEmptyString(record.terminalId, "user.terminal.read payload.terminalId"),
    ...(record.cursor !== undefined
      ? { cursor: readRequiredNonNegativeInteger(record.cursor, "user.terminal.read payload.cursor") }
      : {}),
  };
}

function validateUserTerminalWritePayload(value: unknown): UserTerminalWriteCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.write");
  if (typeof record.data !== "string" || record.data.length === 0) {
    throw new Error("user.terminal.write payload.data must be a non-empty string");
  }
  const data = record.data;
  if (Buffer.byteLength(data, "utf8") > 64 * 1024) {
    throw new Error("user.terminal.write payload.data must contain at most 64 KB");
  }
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.write payload.sessionId"),
    terminalId: requireNonEmptyString(record.terminalId, "user.terminal.write payload.terminalId"),
    data,
  };
}

function validateUserTerminalResizePayload(value: unknown): UserTerminalResizeCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.resize");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.resize payload.sessionId"),
    terminalId: requireNonEmptyString(record.terminalId, "user.terminal.resize payload.terminalId"),
    cols: readTerminalDimension(record.cols, "user.terminal.resize payload.cols"),
    rows: readTerminalDimension(record.rows, "user.terminal.resize payload.rows"),
  };
}

function validateUserTerminalStopPayload(value: unknown): UserTerminalStopCommandPayload {
  const record = ensureObjectPayload(value, "user.terminal.stop");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "user.terminal.stop payload.sessionId"),
    terminalId: requireNonEmptyString(record.terminalId, "user.terminal.stop payload.terminalId"),
  };
}

function readTerminalDimension(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > 1000) {
    throw new Error(`${label} must be an integer between 2 and 1000`);
  }
  return Number(value);
}

function validateWorkspaceChangesInspectPayload(value: unknown): WorkspaceChangesInspectCommandPayload {
  const record = ensureObjectPayload(value, "workspace.changes.inspect");
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.changes.inspect payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.changes.inspect payload.threadId"),
    scope: validateWorkspaceChangeScope(record.scope, "workspace.changes.inspect payload.scope"),
    ...(record.options !== undefined ? { options: validateWorkspaceDiffOptions(record.options, "workspace.changes.inspect payload.options") } : {}),
  };
}

function validateWorkspaceChangesMutatePayload(value: unknown): WorkspaceChangesMutateCommandPayload {
  const record = ensureObjectPayload(value, "workspace.changes.mutate");
  const mutation = ensureObjectPayload(record.mutation, "workspace.changes.mutate payload.mutation");
  const operation = mutation.operation;
  if (!["stage_file", "unstage_file", "revert_file", "stage_hunk", "unstage_hunk", "revert_hunk"].includes(String(operation))) {
    throw new Error("workspace.changes.mutate payload.mutation.operation is invalid");
  }
  const mutationPath = requireNonEmptyString(mutation.path, "workspace.changes.mutate payload.mutation.path");
  let parsedMutation: WorkspaceChangesMutateCommandPayload["mutation"];
  if (operation === "revert_file") {
    if (mutation.confirmation !== "revert_file") {
      throw new Error("workspace.changes.mutate revert requires confirmation");
    }
    parsedMutation = { operation: "revert_file", path: mutationPath, confirmation: "revert_file" };
  } else if (operation === "revert_hunk") {
    if (mutation.confirmation !== "revert_hunk") throw new Error("workspace.changes.mutate hunk revert requires confirmation");
    parsedMutation = { operation: "revert_hunk", path: mutationPath, hunkId: requireNonEmptyString(mutation.hunkId, "workspace.changes.mutate payload.mutation.hunkId"), confirmation: "revert_hunk" };
  } else if (operation === "stage_hunk" || operation === "unstage_hunk") {
    parsedMutation = { operation, path: mutationPath, hunkId: requireNonEmptyString(mutation.hunkId, "workspace.changes.mutate payload.mutation.hunkId") };
  } else if (operation === "stage_file") {
    parsedMutation = { operation: "stage_file", path: mutationPath };
  } else {
    parsedMutation = { operation: "unstage_file", path: mutationPath };
  }
  return {
    sessionId: requireNonEmptyString(record.sessionId, "workspace.changes.mutate payload.sessionId"),
    threadId: requireNonEmptyString(record.threadId, "workspace.changes.mutate payload.threadId"),
    expectedFingerprint: requireNonEmptyString(record.expectedFingerprint, "workspace.changes.mutate payload.expectedFingerprint"),
    ...(record.scope !== undefined ? { scope: validateWorkspaceChangeScope(record.scope, "workspace.changes.mutate payload.scope") } : {}),
    ...(record.options !== undefined ? { options: validateWorkspaceDiffOptions(record.options, "workspace.changes.mutate payload.options") } : {}),
    mutation: parsedMutation,
  };
}

function validateWorkspaceChangeScope(value: unknown, label: string): WorkspaceChangesInspectCommandPayload["scope"] {
  const record = ensureObjectPayload(value, label);
  if (record.kind === "unstaged" || record.kind === "staged" || record.kind === "uncommitted") return { kind: record.kind };
  if (record.kind === "branch") return { kind: "branch", baseRef: requireNonEmptyString(record.baseRef, `${label}.baseRef`) };
  if (record.kind === "commit") return { kind: "commit", commitSha: requireNonEmptyString(record.commitSha, `${label}.commitSha`) };
  if (record.kind === "pull_request") { if (record.number === undefined) return { kind: "pull_request" }; const number = readPositiveInteger(record.number, `${label}.number`); if (number === undefined) throw new Error(`${label}.number is invalid`); return { kind: "pull_request", number }; }
  if (record.kind === "latest_run") return { kind: "latest_run", ...(record.runId !== undefined ? { runId: requireNonEmptyString(record.runId, `${label}.runId`) } : {}) };
  if (record.kind === "latest_turn") return { kind: "latest_turn", ...(record.turnId !== undefined ? { turnId: requireNonEmptyString(record.turnId, `${label}.turnId`) } : {}) };
  if (record.kind === "promotion") return { kind: "promotion", promotionId: requireNonEmptyString(record.promotionId, `${label}.promotionId`) };
  throw new Error(`${label}.kind is invalid`);
}

function validateWorkspaceDiffOptions(value: unknown, label: string): NonNullable<WorkspaceChangesInspectCommandPayload["options"]> {
  const record = ensureObjectPayload(value, label);
  const result: NonNullable<WorkspaceChangesInspectCommandPayload["options"]> = {};
  if (record.contextLines !== undefined) {
    if (!Number.isInteger(record.contextLines) || Number(record.contextLines) < 0 || Number(record.contextLines) > 100) throw new Error(`${label}.contextLines is invalid`);
    result.contextLines = Number(record.contextLines);
  }
  if (record.whitespace !== undefined) {
    if (record.whitespace !== "show" && record.whitespace !== "ignore_all" && record.whitespace !== "ignore_eol") throw new Error(`${label}.whitespace is invalid`);
    result.whitespace = record.whitespace;
  }
  return result;
}

function validateWorkspaceFeedbackAddPayload(value: unknown): WorkspaceFeedbackAddCommandPayload {
  const record = ensureObjectPayload(value, "workspace.feedback.add");
  const line = readPositiveInteger(record.line, "workspace.feedback.add payload.line");
  if (line === undefined) throw new Error("workspace.feedback.add payload.line is required");
  if (record.side !== "LEFT" && record.side !== "RIGHT") throw new Error("workspace.feedback.add payload.side is invalid");
  return { sessionId: requireNonEmptyString(record.sessionId, "workspace.feedback.add payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.feedback.add payload.threadId"), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.feedback.add payload.candidateFingerprint"), path: requireNonEmptyString(record.path, "workspace.feedback.add payload.path"), line, side: record.side, body: requireNonEmptyString(record.body, "workspace.feedback.add payload.body") };
}

function validateWorkspaceFeedbackListPayload(value: unknown): WorkspaceFeedbackListCommandPayload {
  const record = ensureObjectPayload(value, "workspace.feedback.list");
  return { sessionId: requireNonEmptyString(record.sessionId, "workspace.feedback.list payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.feedback.list payload.threadId") };
}

function validateWorkspaceFeedbackRemovePayload(value: unknown): WorkspaceFeedbackRemoveCommandPayload {
  const record = ensureObjectPayload(value, "workspace.feedback.remove");
  return { ...validateWorkspaceFeedbackListPayload(record), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.feedback.remove payload.candidateFingerprint"), commentId: requireNonEmptyString(record.commentId, "workspace.feedback.remove payload.commentId") };
}

function validateWorkspaceFeedbackSubmitPayload(value: unknown): WorkspaceFeedbackSubmitCommandPayload {
  const record = ensureObjectPayload(value, "workspace.feedback.submit");
  if (!Array.isArray(record.commentIds) || record.commentIds.length === 0 || record.commentIds.length > 100) throw new Error("workspace.feedback.submit payload.commentIds is invalid");
  return { ...validateWorkspaceFeedbackListPayload(record), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.feedback.submit payload.candidateFingerprint"), commentIds: record.commentIds.map((id) => requireNonEmptyString(id, "workspace.feedback.submit payload.commentIds[]")) };
}

function validateWorkspaceReviewRunPayload(value: unknown): WorkspaceReviewRunCommandPayload { const record = ensureObjectPayload(value, "workspace.review.run"); const mode = record.mode; if (mode !== undefined && mode !== "current_thread" && mode !== "detached_thread") throw new Error("workspace.review.run payload.mode is invalid"); return { sessionId: requireNonEmptyString(record.sessionId, "workspace.review.run payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.review.run payload.threadId"), scope: validateWorkspaceChangeScope(record.scope, "workspace.review.run payload.scope"), ...(mode ? { mode } : {}), ...(record.reviewerProfileId !== undefined ? { reviewerProfileId: requireNonEmptyString(record.reviewerProfileId, "workspace.review.run payload.reviewerProfileId") } : {}), ...(record.reviewerModel !== undefined ? { reviewerModel: requireNonEmptyString(record.reviewerModel, "workspace.review.run payload.reviewerModel") } : {}) }; }
function validateWorkspaceReviewListPayload(value: unknown): WorkspaceReviewListCommandPayload { const record = ensureObjectPayload(value, "workspace.review.list"); return { sessionId: requireNonEmptyString(record.sessionId, "workspace.review.list payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.review.list payload.threadId") }; }
function validateWorkspaceReviewUpdatePayload(value: unknown): WorkspaceReviewUpdateCommandPayload { const record = ensureObjectPayload(value, "workspace.review.update"); const action = record.action; if (action !== "accept" && action !== "dismiss" && action !== "reopen" && action !== "mark_fixed") throw new Error("workspace.review.update payload.action is invalid"); return { ...validateWorkspaceReviewListPayload(record), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.review.update payload.candidateFingerprint"), reviewId: requireNonEmptyString(record.reviewId, "workspace.review.update payload.reviewId"), findingId: requireNonEmptyString(record.findingId, "workspace.review.update payload.findingId"), action, ...(record.reason !== undefined ? { reason: requireNonEmptyString(record.reason, "workspace.review.update payload.reason") } : {}) }; }
function validateWorkspaceReviewSubmitPayload(value: unknown): WorkspaceReviewSubmitCommandPayload { const record = ensureObjectPayload(value, "workspace.review.submit"); const request = record.request; if (request !== "address" && request !== "more_evidence" && request !== "verify") throw new Error("workspace.review.submit payload.request is invalid"); if (!Array.isArray(record.findingIds) || record.findingIds.length === 0 || record.findingIds.length > 100) throw new Error("workspace.review.submit payload.findingIds is invalid"); return { ...validateWorkspaceReviewListPayload(record), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.review.submit payload.candidateFingerprint"), reviewId: requireNonEmptyString(record.reviewId, "workspace.review.submit payload.reviewId"), findingIds: record.findingIds.map((id) => requireNonEmptyString(id, "workspace.review.submit payload.findingIds[]")), request }; }
function validateWorkspaceValidationInspectPayload(value: unknown): WorkspaceValidationInspectCommandPayload { const record = ensureObjectPayload(value, "workspace.validation.inspect"); return { sessionId: requireNonEmptyString(record.sessionId, "workspace.validation.inspect payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.validation.inspect payload.threadId") }; }
function validateWorkspaceValidationRunPayload(value: unknown): WorkspaceValidationRunCommandPayload { const record = ensureObjectPayload(value, "workspace.validation.run"); const base = validateWorkspaceValidationInspectPayload(record); const actionId = record.actionId === undefined ? undefined : requireNonEmptyString(record.actionId, "workspace.validation.run payload.actionId"); const suiteId = record.suiteId === undefined ? undefined : requireNonEmptyString(record.suiteId, "workspace.validation.run payload.suiteId"); if ((actionId === undefined) === (suiteId === undefined)) throw new Error("workspace.validation.run must select exactly one action or suite"); return { ...base, candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.validation.run payload.candidateFingerprint"), ...(actionId ? { actionId } : {}), ...(suiteId ? { suiteId } : {}) }; }
function validateWorkspaceValidationCancelPayload(value: unknown): WorkspaceValidationCancelCommandPayload { const record = ensureObjectPayload(value, "workspace.validation.cancel"); return { ...validateWorkspaceValidationInspectPayload(record), resultId: requireNonEmptyString(record.resultId, "workspace.validation.cancel payload.resultId") }; }
function validateWorkspaceValidationSubmitPayload(value: unknown): WorkspaceValidationSubmitCommandPayload { const record = ensureObjectPayload(value, "workspace.validation.submit"); if (!Array.isArray(record.resultIds) || record.resultIds.length === 0 || record.resultIds.length > 100) throw new Error("workspace.validation.submit payload.resultIds is invalid"); return { ...validateWorkspaceValidationInspectPayload(record), resultIds: record.resultIds.map((id) => requireNonEmptyString(id, "workspace.validation.submit payload.resultIds[]")) }; }
function validateWorkspaceGitInspectPayload(value: unknown): WorkspaceGitInspectCommandPayload { const record = ensureObjectPayload(value, "workspace.git.inspect"); return { sessionId: requireNonEmptyString(record.sessionId, "workspace.git.inspect payload.sessionId"), threadId: requireNonEmptyString(record.threadId, "workspace.git.inspect payload.threadId") }; }
function validateWorkspaceGitActionPayload(value: unknown): WorkspaceGitActionCommandPayload {
  const record = ensureObjectPayload(value, "workspace.git.action"); const action = ensureObjectPayload(record.action, "workspace.git.action payload.action"); const kind = action.kind;
  const string = (key: string) => requireNonEmptyString(action[key], `workspace.git.action payload.action.${key}`);
  let parsed: WorkspaceGitActionCommandPayload["action"];
  if (kind === "branch_create") parsed = { kind, branchName: string("branchName") };
  else if (kind === "fetch") parsed = { kind, remote: string("remote") };
  else if (kind === "commit") { if (!Array.isArray(action.paths) || action.paths.length === 0 || action.paths.length > 1000) throw new Error("workspace.git.action payload.action.paths is invalid"); parsed = { kind, message: string("message"), paths: action.paths.map((value) => requireNonEmptyString(value, "workspace.git.action payload.action.paths[]")) }; }
  else if (kind === "push") { if (typeof action.setUpstream !== "boolean") throw new Error("workspace.git.action payload.action.setUpstream must be boolean"); parsed = { kind, remote: string("remote"), branch: string("branch"), setUpstream: action.setUpstream }; }
  else if (kind === "pr_create") { if (typeof action.body !== "string" || typeof action.draft !== "boolean") throw new Error("workspace.git.action pull request payload is invalid"); parsed = { kind, title: string("title"), body: action.body, baseBranch: string("baseBranch"), draft: action.draft }; }
  else if (kind === "pr_ready") parsed = { kind, number: positiveNumber(action.number, "workspace.git.action payload.action.number") };
  else if (kind === "pr_comment") { const side = action.side; if (side !== undefined && side !== "LEFT" && side !== "RIGHT") throw new Error("workspace.git.action payload.action.side is invalid"); parsed = { kind, number: positiveNumber(action.number, "workspace.git.action payload.action.number"), body: string("body"), ...(action.path !== undefined ? { path: string("path") } : {}), ...(action.line !== undefined ? { line: positiveNumber(action.line, "workspace.git.action payload.action.line") } : {}), ...(side ? { side } : {}) }; }
  else throw new Error("workspace.git.action payload.action.kind is invalid");
  return { ...validateWorkspaceGitInspectPayload(record), candidateFingerprint: requireNonEmptyString(record.candidateFingerprint, "workspace.git.action payload.candidateFingerprint"), ...(record.expectedHeadSha !== undefined ? { expectedHeadSha: requireNonEmptyString(record.expectedHeadSha, "workspace.git.action payload.expectedHeadSha") } : {}), action: parsed };
}
function positiveNumber(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }

function readRequiredNonNegativeInteger(value: unknown, label: string): number {
  const result = readNonNegativeInteger(value, label);
  if (result === undefined) {
    throw new Error(`${label} is required`);
  }
  return result;
}

function readPositiveInteger(
  value: unknown,
  label: string
): number | undefined {
  if (value === undefined) {
    return;
  }
  if (Number.isInteger(value) === false || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer when present`);
  }
  return Number(value);
}

function readNonNegativeInteger(
  value: unknown,
  label: string
): number | undefined {
  if (value === undefined) {
    return;
  }
  if (Number.isInteger(value) === false || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer when present`);
  }
  return Number(value);
}

function validateWorkspaceCheckpointDiffEndpoint(
  value: unknown,
  label: string
): WorkspaceCheckpointDiffCommandPayload["source"] {
  const record = ensureObjectPayload(value, label);
  const checkpointId = readOptionalNonEmptyString(record.checkpointId);
  const gitRef = readOptionalNonEmptyString(record.gitRef);
  const workingTree = record.workingTree === true;
  if (
    [checkpointId !== undefined, gitRef !== undefined, workingTree].filter(
      Boolean
    ).length !== 1
  ) {
    throw new Error(
      `${label} must specify exactly one of checkpointId, gitRef, or workingTree`
    );
  }
  return {
    ...(checkpointId !== undefined ? { checkpointId } : {}),
    ...(gitRef !== undefined ? { gitRef } : {}),
    ...(workingTree ? { workingTree: true } : {}),
  };
}

function validateProjectSnapshotGetPayload(
  value: unknown
): ProjectSnapshotGetCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project.snapshot.get payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.snapshot.get payload.sessionId must be a non-empty string"
    );
  }
  return { sessionId: record.sessionId };
}

function validateProjectSnapshotUpdatePayload(
  value: unknown
): ProjectSnapshotUpdateCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project.snapshot.update payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.snapshot.update payload.sessionId must be a non-empty string"
    );
  }
  if (
    typeof record.snapshot !== "object" ||
    record.snapshot === null ||
    Array.isArray(record.snapshot)
  ) {
    throw new Error(
      "project.snapshot.update payload.snapshot must be an object"
    );
  }
  return {
    sessionId: record.sessionId,
    snapshot:
      record.snapshot as ProjectSnapshotUpdateCommandPayload["snapshot"],
  };
}

function validateProjectActionPayload(
  value: unknown
): ProjectActionCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project.action payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.action payload.sessionId must be a non-empty string"
    );
  }
  if (
    record.type !== "branch.create" &&
    record.type !== "branch.switch" &&
    record.type !== "worktree.create" &&
    record.type !== "commit.create" &&
    record.type !== "git.push" &&
    record.type !== "pull_request.create" &&
    record.type !== "pull_request.merge" &&
    record.type !== "board.autopilot.configure" &&
    record.type !== "board.autopilot.tick" &&
    record.type !== "board.card.create" &&
    record.type !== "board.card.update" &&
    record.type !== "board.card.move" &&
    record.type !== "board.card.manual_done" &&
    record.type !== "board.card.delete" &&
    record.type !== "board.card.start_implementation" &&
    record.type !== "board.card.start_testing" &&
    record.type !== "board.card.thread_completed" &&
    record.type !== "board.card.thread_failed" &&
    record.type !== "board.card.thread_stopped" &&
    record.type !== "board.card.testing_verdict" &&
    record.type !== "task.create" &&
    record.type !== "task.propose" &&
    record.type !== "task.approve" &&
    record.type !== "task.update" &&
    record.type !== "task.reorder" &&
    record.type !== "task.claim" &&
    record.type !== "task.mark_running" &&
    record.type !== "task.needs_attention" &&
    record.type !== "task.submit_review" &&
    record.type !== "task.request_changes" &&
    record.type !== "task.retry" &&
    record.type !== "task.accept" &&
    record.type !== "task.discard" &&
    record.type !== "task.stop"
  ) {
    throw new Error("project.action payload.type is invalid");
  }
  if (record.type.startsWith("task.")) {
    return parseTaskAction(record);
  }
  if (record.type.startsWith("board.")) {
    return parseProductProjectBoardAction(record);
  }
  return validateGitProjectActionPayload(record);
}

function validateGitProjectActionPayload(
  record: Record<string, unknown>
): ProjectActionCommandPayload {
  const taskId =
    typeof record.taskId === "string" && record.taskId.trim().length > 0
      ? { taskId: record.taskId }
      : {};
  switch (record.type) {
    case "branch.create":
    case "branch.switch":
      if (
        typeof record.branchName !== "string" ||
        record.branchName.trim().length === 0
      ) {
        throw new Error(
          `project.action payload.branchName must be a non-empty string for ${record.type}`
        );
      }
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        branchName: record.branchName,
      } as ProjectActionCommandPayload;
    case "worktree.create":
      if (
        typeof record.branchName !== "string" ||
        record.branchName.trim().length === 0
      ) {
        throw new Error(
          "project.action payload.branchName must be a non-empty string for worktree.create"
        );
      }
      if (
        typeof record.targetPath !== "string" ||
        record.targetPath.trim().length === 0
      ) {
        throw new Error(
          "project.action payload.targetPath must be a non-empty string for worktree.create"
        );
      }
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        branchName: record.branchName,
        targetPath: record.targetPath,
      } as ProjectActionCommandPayload;
    case "commit.create":
      if (
        typeof record.message !== "string" ||
        record.message.trim().length === 0
      ) {
        throw new Error(
          "project.action payload.message must be a non-empty string for commit.create"
        );
      }
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        message: record.message,
      } as ProjectActionCommandPayload;
    case "git.push":
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        ...(typeof record.branchName === "string"
          ? { branchName: record.branchName }
          : {}),
      } as ProjectActionCommandPayload;
    case "pull_request.create":
      if (
        typeof record.title !== "string" ||
        record.title.trim().length === 0
      ) {
        throw new Error(
          "project.action payload.title must be a non-empty string for pull_request.create"
        );
      }
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        title: record.title,
        ...(typeof record.body === "string" ? { body: record.body } : {}),
        ...(typeof record.baseBranch === "string"
          ? { baseBranch: record.baseBranch }
          : {}),
        ...(typeof record.branchName === "string"
          ? { branchName: record.branchName }
          : {}),
      } as ProjectActionCommandPayload;
    case "pull_request.merge":
      if (typeof record.pullRequestNumber !== "number") {
        throw new Error(
          "project.action payload.pullRequestNumber must be a number for pull_request.merge"
        );
      }
      return {
        type: record.type,
        sessionId: record.sessionId,
        ...taskId,
        pullRequestNumber: record.pullRequestNumber,
      } as ProjectActionCommandPayload;
    default:
      throw new Error("project.action payload.type is invalid");
  }
}

function validateProjectReviewGetPayload(
  value: unknown
): ProjectReviewGetCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project.review.get payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.review.get payload.sessionId must be a non-empty string"
    );
  }
  if (
    typeof record.target !== "object" ||
    record.target === null ||
    Array.isArray(record.target)
  ) {
    throw new Error("project.review.get payload.target must be an object");
  }
  return {
    sessionId: record.sessionId,
    target: record.target as ProjectReviewGetCommandPayload["target"],
  };
}

function validateProjectReviewActionPayload(
  value: unknown
): ProjectReviewActionCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("project.review.action payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.review.action payload.sessionId must be a non-empty string"
    );
  }
  if (
    typeof record.action !== "object" ||
    record.action === null ||
    Array.isArray(record.action)
  ) {
    throw new Error("project.review.action payload.action must be an object");
  }
  const action = record.action as Record<string, unknown>;
  if (
    action.type !== "review.refresh" &&
    action.type !== "review.comment.create"
  ) {
    throw new Error("project.review.action payload.action.type is invalid");
  }
  if (
    typeof action.sessionId !== "string" ||
    action.sessionId.trim().length === 0
  ) {
    throw new Error(
      "project.review.action payload.action.sessionId must be a non-empty string"
    );
  }
  if (
    typeof action.target !== "object" ||
    action.target === null ||
    Array.isArray(action.target)
  ) {
    throw new Error(
      "project.review.action payload.action.target must be an object"
    );
  }
  if (action.body !== undefined && typeof action.body !== "string") {
    throw new Error(
      "project.review.action payload.action.body must be a string"
    );
  }
  if (action.path !== undefined && typeof action.path !== "string") {
    throw new Error(
      "project.review.action payload.action.path must be a string"
    );
  }
  if (
    action.line !== undefined &&
    (typeof action.line !== "number" ||
      !Number.isFinite(action.line) ||
      action.line <= 0)
  ) {
    throw new Error(
      "project.review.action payload.action.line must be a positive number"
    );
  }
  if (
    action.side !== undefined &&
    action.side !== "LEFT" &&
    action.side !== "RIGHT"
  ) {
    throw new Error("project.review.action payload.action.side is invalid");
  }
  return {
    sessionId: record.sessionId,
    action: action as unknown as ProjectReviewActionCommandPayload["action"],
  };
}

function ensureObjectPayload(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function validateRunStartPayload(value: unknown): RunStartCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("run.start payload must be an object");
  }

  const record = value as Record<string, unknown>;
  const profile = record.profile;
  const profileId = record.profileId;
  const turn = record.turn;
  const hasProfileObject =
    typeof profile === "object" &&
    profile !== null &&
    Array.isArray(profile) === false;
  const hasProfileId =
    typeof profileId === "string" && profileId.trim().length > 0;
  if (hasProfileObject === false && hasProfileId === false) {
    throw new Error("run.start payload must include profile or profileId");
  }
  if (hasProfileObject && hasProfileId) {
    throw new Error("run.start payload must include only one of profile or profileId");
  }
  if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
    throw new Error("run.start payload.turn must be an object");
  }

  const turnRecord = turn as Record<string, unknown>;
  if (hasProfileObject) {
    validateProfilePayload(profile, "run.start payload.profile");
  }
  if (
    typeof turnRecord.sessionId !== "string" ||
    turnRecord.sessionId.trim().length === 0
  ) {
    throw new Error(
      "run.start payload.turn.sessionId must be a non-empty string"
    );
  }
  if (typeof turnRecord.message !== "string") {
    throw new Error("run.start payload.turn.message must be a string");
  }
  if (
    typeof turnRecord.eventType !== "string" ||
    turnRecord.eventType.trim().length === 0
  ) {
    throw new Error(
      "run.start payload.turn.eventType must be a non-empty string"
    );
  }
  if (
    turnRecord.modeSystemV2Enabled !== undefined &&
    typeof turnRecord.modeSystemV2Enabled !== "boolean"
  ) {
    throw new Error(
      "run.start payload.turn.modeSystemV2Enabled must be a boolean when present"
    );
  }
  if (
    turnRecord.interactionMode !== undefined &&
    typeof turnRecord.interactionMode !== "string"
  ) {
    throw new Error(
      "run.start payload.turn.interactionMode must be a string when present"
    );
  }
  if (
    typeof turnRecord.interactionMode === "string" &&
    RUN_STARTED_INTERACTION_MODES.includes(
      turnRecord.interactionMode as (typeof RUN_STARTED_INTERACTION_MODES)[number]
    ) === false
  ) {
    throw new Error(
      `run.start payload.turn.interactionMode must be one of ${RUN_STARTED_INTERACTION_MODES.join(", ")} when present`
    );
  }
  if (
    turnRecord.actSubmode !== undefined &&
    typeof turnRecord.actSubmode !== "string"
  ) {
    throw new Error(
      "run.start payload.turn.actSubmode must be a string when present"
    );
  }
  if (
    typeof turnRecord.actSubmode === "string" &&
    RUN_STARTED_ACT_SUBMODES.includes(
      turnRecord.actSubmode as (typeof RUN_STARTED_ACT_SUBMODES)[number]
    ) === false
  ) {
    throw new Error(
      `run.start payload.turn.actSubmode must be ${RUN_STARTED_ACT_SUBMODES.join(", ")} when present`
    );
  }
  const mcpContext =
    turnRecord.mcpContext === undefined
      ? undefined
      : parseHostedMcpContext(
          turnRecord.mcpContext,
          "run.start payload.turn.mcpContext"
        );
  const mcpAuthorization =
    turnRecord.mcpAuthorization === undefined
      ? undefined
      : mcpContext === undefined
        ? parseExecutionTicketAuthorization(turnRecord.mcpAuthorization)
        : parseHostedMcpRuntimeConnection({
            mcpContext,
            mcpAuthorization: turnRecord.mcpAuthorization,
          }).executionTicket;
  if (
    turnRecord.clientCapabilities !== undefined &&
    (typeof turnRecord.clientCapabilities !== "object" ||
      turnRecord.clientCapabilities === null ||
      Array.isArray(turnRecord.clientCapabilities))
  ) {
    throw new Error(
      "run.start payload.turn.clientCapabilities must be an object when present"
    );
  }
  if (
    turnRecord.executionPolicy !== undefined &&
    (typeof turnRecord.executionPolicy !== "object" ||
      turnRecord.executionPolicy === null ||
      Array.isArray(turnRecord.executionPolicy))
  ) {
    throw new Error(
      "run.start payload.turn.executionPolicy must be an object when present"
    );
  }
  if (
    turnRecord.workspace !== undefined &&
    (typeof turnRecord.workspace !== "object" ||
      turnRecord.workspace === null ||
      Array.isArray(turnRecord.workspace))
  ) {
    throw new Error(
      "run.start payload.turn.workspace must be an object when present"
    );
  }
  if (turnRecord.projectContext !== undefined) {
    validateProjectContextPayload(turnRecord.projectContext, "run.start payload.turn.projectContext");
  }
  const normalizedTurn: RunStartCommandPayload["turn"] = {
    ...(turn as RunStartCommandPayload["turn"]),
    ...(mcpContext !== undefined ? { mcpContext } : {}),
    ...(mcpAuthorization !== undefined
      ? { mcpAuthorization: { executionTicket: mcpAuthorization } }
      : {}),
  };
  return hasProfileObject
    ? {
        profile: profile as NonNullable<RunStartCommandPayload["profile"]>,
        turn: normalizedTurn,
      }
    : {
        profileId: profileId as string,
        turn: normalizedTurn,
      };
}

function validateProjectContextPayload(value: unknown, label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object when present`);
  }
  const projectContext = value as Record<string, unknown>;
  requireNonEmptyString(projectContext.projectId, `${label}.projectId`);
  requireNonEmptyString(projectContext.contextRevisionId, `${label}.contextRevisionId`);
  if (
    typeof projectContext.contextRevision !== "number" ||
    Number.isSafeInteger(projectContext.contextRevision) === false ||
    projectContext.contextRevision < 1
  ) {
    throw new Error(`${label}.contextRevision must be a positive integer`);
  }
  requireNonEmptyString(projectContext.content, `${label}.content`);
}

function validateJobRunPayload(value: unknown): JobRunCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("job.run payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const input = parseJobInputV1(record.input);
  const hasProfileObject =
    typeof record.profile === "object" &&
    record.profile !== null &&
    Array.isArray(record.profile) === false;
  const hasProfileId =
    typeof record.profileId === "string" && record.profileId.trim().length > 0;
  const referenceCount = Number(hasProfileObject)
    + Number(hasProfileId)
    + Number(input.profile !== undefined)
    + Number(input.profileId !== undefined);
  if (referenceCount === 0) {
    throw new Error(
      "job.run payload must include profile/profileId or input.profile/input.profileId"
    );
  }
  if (referenceCount > 1) {
    throw new Error(
      "job.run payload must include exactly one profile reference across the payload and input"
    );
  }
  if (hasProfileObject) {
    validateProfilePayload(record.profile, "job.run payload.profile");
  }
  const inputBase = {
    version: input.version,
    turn: input.turn,
    ...(input.storeDriver !== undefined ? { storeDriver: input.storeDriver } : {}),
    ...(input.approvalPolicyPackId !== undefined
      ? { approvalPolicyPackId: input.approvalPolicyPackId }
      : {}),
  };
  if (hasProfileObject) {
    return {
      profile: record.profile as NonNullable<JobRunCommandPayload["profile"]>,
      input: inputBase,
    };
  }
  if (hasProfileId) {
    return {
      profileId: String(record.profileId),
      input: inputBase,
    };
  }
  if (input.profile !== undefined) {
    return {
      input: {
        ...inputBase,
        profile: input.profile,
      },
    };
  }
  return {
    input: {
      ...inputBase,
      profileId: input.profileId as string,
    },
  };
}

function validateRunCancelPayload(value: unknown): RunCancelCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("run.cancel payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error("run.cancel payload.sessionId must be a non-empty string");
  }
  if (record.runId !== undefined && typeof record.runId !== "string") {
    throw new Error("run.cancel payload.runId must be a string when present");
  }
  if (record.commandId !== undefined && typeof record.commandId !== "string") {
    throw new Error(
      "run.cancel payload.commandId must be a string when present"
    );
  }

  return value as RunCancelCommandPayload;
}

function validateSessionDescribePayload(
  value: unknown
): SessionDescribeCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session.describe payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "session.describe payload.sessionId must be a non-empty string"
    );
  }

  return value as SessionDescribeCommandPayload;
}

function validateSessionStatePayload(
  value: unknown
): SessionStateCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("session.state payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    throw new Error(
      "session.state payload.sessionId must be a non-empty string"
    );
  }
  return {
    sessionId: record.sessionId,
  };
}

function validateRunnerPingPayload(value: unknown): RunnerPingCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runner.ping payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (record.nonce !== undefined && typeof record.nonce !== "string") {
    throw new Error("runner.ping payload.nonce must be a string when present");
  }

  return value as RunnerPingCommandPayload;
}

function validateProfileListPayload(value: unknown): ProfileListCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile.list payload must be an object");
  }

  return {};
}

function validateProfileGetPayload(value: unknown): ProfileGetCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile.get payload must be an object");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.profileId !== "string" ||
    record.profileId.trim().length === 0
  ) {
    throw new Error("profile.get payload.profileId must be a non-empty string");
  }

  return {
    profileId: record.profileId,
  };
}

function validateOperatorInboxPayload(
  value: unknown
): OperatorInboxCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.inbox payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") {
    throw new Error(
      "operator.inbox payload.sessionId must be a string when present"
    );
  }
  if (record.threadId !== undefined && typeof record.threadId !== "string") {
    throw new Error(
      "operator.inbox payload.threadId must be a string when present"
    );
  }
  return value as OperatorInboxCommandPayload;
}

function validateOperatorThreadPayload(
  value: unknown
): OperatorThreadCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.thread payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    record.threadId.trim().length === 0
  ) {
    throw new Error(
      "operator.thread payload.threadId must be a non-empty string"
    );
  }
  return value as OperatorThreadCommandPayload;
}

function validateOperatorRunsPayload(
  value: unknown
): OperatorRunsCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.runs payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.sessionId !== undefined &&
    (typeof record.sessionId !== "string" ||
      record.sessionId.trim().length === 0)
  ) {
    throw new Error(
      "operator.runs payload.sessionId must be a non-empty string when present"
    );
  }
  if (
    record.status !== undefined &&
    record.status !== "RUNNING" &&
    record.status !== "WAITING" &&
    record.status !== "COMPLETED" &&
    record.status !== "FAILED"
  ) {
    throw new Error("operator.runs payload.status is invalid");
  }
  if (
    record.limit !== undefined &&
    (typeof record.limit !== "number" ||
      Number.isInteger(record.limit) === false ||
      record.limit < 1 ||
      record.limit > 50)
  ) {
    throw new Error(
      "operator.runs payload.limit must be an integer from 1 to 50"
    );
  }
  return {
    ...(typeof record.sessionId === "string"
      ? { sessionId: record.sessionId.trim() }
      : {}),
    ...(record.status !== undefined
      ? { status: record.status as OperatorRunsCommandPayload["status"] }
      : {}),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
  };
}

function validateOperatorRunPayload(value: unknown): OperatorRunCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.run payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim().length === 0) {
    throw new Error("operator.run payload.runId must be a non-empty string");
  }
  return value as OperatorRunCommandPayload;
}

function validateOperatorRunReasoningPayload(value: unknown): OperatorRunReasoningCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.run.reasoning payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.runId !== "string" || record.runId.trim().length === 0) {
    throw new Error("operator.run.reasoning payload.runId must be a non-empty string");
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw new Error("operator.run.reasoning payload.sessionId must be a non-empty string");
  }
  if (record.action !== undefined && record.action !== "read" && record.action !== "delete") {
    throw new Error("operator.run.reasoning payload.action must be read or delete");
  }
  return {
    runId: record.runId.trim(),
    sessionId: record.sessionId.trim(),
    ...(record.action !== undefined ? { action: record.action } : {}),
  };
}

function validateOperatorControlPayload(
  value: unknown
): OperatorControlCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("operator.control payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.action !== "approve" &&
    record.action !== "reject" &&
    record.action !== "reply" &&
    record.action !== "steer" &&
    record.action !== "retry" &&
    record.action !== "continue_waiting" &&
    record.action !== "focus_thread" &&
    record.action !== "resolve_context_checkpoint" &&
    record.action !== "approve_assembly_change" &&
    record.action !== "reject_assembly_change" &&
    record.action !== "spawn_child_thread" &&
    record.action !== "supersede_child_thread" &&
    record.action !== "resolve_fan_in_checkpoint" &&
    record.action !== "enqueue_follow_up" &&
    record.action !== "edit_follow_up" &&
    record.action !== "cancel_follow_up" &&
    record.action !== "resume_follow_up_queue"
  ) {
    throw new Error("operator.control payload.action is invalid");
  }
  if (
    typeof record.threadId !== "string" ||
    record.threadId.trim().length === 0
  ) {
    throw new Error(
      "operator.control payload.threadId must be a non-empty string"
    );
  }
  if (record.requestId !== undefined && typeof record.requestId !== "string") {
    throw new Error(
      "operator.control payload.requestId must be a string when present"
    );
  }
  if (record.followUpId !== undefined && typeof record.followUpId !== "string") {
    throw new Error("operator.control payload.followUpId must be a string when present");
  }
  if (
    record.proposalId !== undefined &&
    typeof record.proposalId !== "string"
  ) {
    throw new Error(
      "operator.control payload.proposalId must be a string when present"
    );
  }
  if (
    record.checkpointId !== undefined &&
    typeof record.checkpointId !== "string"
  ) {
    throw new Error(
      "operator.control payload.checkpointId must be a string when present"
    );
  }
  if (
    record.delegationId !== undefined &&
    typeof record.delegationId !== "string"
  ) {
    throw new Error(
      "operator.control payload.delegationId must be a string when present"
    );
  }
  if (
    record.actionValue !== undefined &&
    record.actionValue !== "continue" &&
    record.actionValue !== "compact" &&
    record.actionValue !== "summarize_forward" &&
    record.actionValue !== "handoff" &&
    record.actionValue !== "split_into_child_thread" &&
    record.actionValue !== "operator_checkpoint" &&
    record.actionValue !== "accept" &&
    record.actionValue !== "defer"
  ) {
    throw new Error("operator.control payload.actionValue is invalid");
  }
  if (record.message !== undefined && typeof record.message !== "string") {
    throw new Error(
      "operator.control payload.message must be a string when present"
    );
  }
  if (
    record.attachmentIds !== undefined &&
    (Array.isArray(record.attachmentIds) === false || record.attachmentIds.some((id) => typeof id !== "string" || id.trim().length === 0))
  ) {
    throw new Error("operator.control payload.attachmentIds must contain non-empty strings");
  }
  if (record.interactionMode !== undefined && record.interactionMode !== "chat" && record.interactionMode !== "plan" && record.interactionMode !== "build") {
    throw new Error("operator.control payload.interactionMode is invalid");
  }
  if (record.actSubmode !== undefined && record.actSubmode !== "strict" && record.actSubmode !== "safe" && record.actSubmode !== "full_auto") {
    throw new Error("operator.control payload.actSubmode is invalid");
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    throw new Error(
      "operator.control payload.title must be a string when present"
    );
  }
  if (
    record.rolePrompt !== undefined &&
    typeof record.rolePrompt !== "string"
  ) {
    throw new Error(
      "operator.control payload.rolePrompt must be a string when present"
    );
  }
  if (record.goal !== undefined && typeof record.goal !== "string") {
    throw new Error(
      "operator.control payload.goal must be a string when present"
    );
  }
  if (record.profileId !== undefined && typeof record.profileId !== "string") {
    throw new Error(
      "operator.control payload.profileId must be a string when present"
    );
  }
  if (
    record.provider !== undefined &&
    record.provider !== "openrouter" &&
    record.provider !== "openai" &&
    record.provider !== "anthropic"
  ) {
    throw new Error("operator.control payload.provider is invalid");
  }
  if (record.model !== undefined && typeof record.model !== "string") {
    throw new Error(
      "operator.control payload.model must be a string when present"
    );
  }
  if (
    record.skillPackId !== undefined &&
    typeof record.skillPackId !== "string"
  ) {
    throw new Error(
      "operator.control payload.skillPackId must be a string when present"
    );
  }
  if (
    record.maxTurns !== undefined &&
    (typeof record.maxTurns !== "number" ||
      !Number.isInteger(record.maxTurns) ||
      record.maxTurns < 1)
  ) {
    throw new Error(
      "operator.control payload.maxTurns must be a positive integer when present"
    );
  }
  if (
    record.maxRuntimeMs !== undefined &&
    (typeof record.maxRuntimeMs !== "number" ||
      !Number.isInteger(record.maxRuntimeMs) ||
      record.maxRuntimeMs < 1)
  ) {
    throw new Error(
      "operator.control payload.maxRuntimeMs must be a positive integer when present"
    );
  }
  if (
    record.allowApprovalInheritance !== undefined &&
    typeof record.allowApprovalInheritance !== "boolean"
  ) {
    throw new Error(
      "operator.control payload.allowApprovalInheritance must be a boolean when present"
    );
  }
  const operatorPolicy = parseOperatorControlPolicyFields({
    allowToolClasses: record.allowToolClasses,
    allowCapabilities: record.allowCapabilities,
  });
  if (operatorPolicy.ok === false) {
    throw new Error(`operator.control payload.${operatorPolicy.message}`);
  }
  return value as OperatorControlCommandPayload;
}

function validateMcpStatusPayload(value: unknown): McpStatusCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("mcp.status payload must be an object");
  }
  const record = value as Record<string, unknown>;
  return validateProfileReference(record, "mcp.status payload");
}

function validateMcpRefreshPayload(value: unknown): McpRefreshCommandPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("mcp.refresh payload must be an object");
  }
  const record = value as Record<string, unknown>;
  return validateProfileReference(record, "mcp.refresh payload");
}

function validateProfilePayload(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    throw new Error(`${path}.id must be a non-empty string`);
  }
  if (typeof record.agent !== "string" || record.agent.trim().length === 0) {
    throw new Error(`${path}.agent must be a non-empty string`);
  }
  validateModelCredentialPayload(record, path);
}

function validateModelCredentialPayload(
  profile: Record<string, unknown>,
  path: string
): void {
  if (profile.modelCredential === undefined) {
    return;
  }
  if (
    typeof profile.modelCredential !== "object" ||
    profile.modelCredential === null ||
    Array.isArray(profile.modelCredential)
  ) {
    throw new Error(`${path}.modelCredential must be an object`);
  }

  const reference = profile.modelCredential as Record<string, unknown>;
  if (reference.source !== "kestrel-one") {
    throw new Error(`${path}.modelCredential.source must be 'kestrel-one'`);
  }
  const gatewayId = requireNonEmptyString(
    reference.gatewayId,
    `${path}.modelCredential.gatewayId`
  );
  const organizationId = requireNonEmptyString(
    reference.organizationId,
    `${path}.modelCredential.organizationId`,
  );
  const environmentId = requireNonEmptyString(
    reference.environmentId,
    `${path}.modelCredential.environmentId`,
  );
  const rawModelId = requireNonEmptyString(
    reference.rawModelId,
    `${path}.modelCredential.rawModelId`
  );
  const model = requireNonEmptyString(profile.model, `${path}.model`);
  if (model.trim() !== rawModelId.trim()) {
    throw new Error(
      `${path}.model must match ${path}.modelCredential.rawModelId for gateway-managed execution`
    );
  }
  const agentStageConfig = ensureObjectPayload(
    profile.agentStageConfig,
    `${path}.agentStageConfig`,
  );
  const modelByStage = ensureObjectPayload(
    agentStageConfig.modelByStage,
    `${path}.agentStageConfig.modelByStage`,
  );
  const agentLoopModel = requireNonEmptyString(
    modelByStage["agent.loop"],
    `${path}.agentStageConfig.modelByStage.agent.loop`,
  );
  if (agentLoopModel.trim() !== rawModelId.trim()) {
    throw new Error(
      `${path}.agentStageConfig.modelByStage.agent.loop must match ${path}.modelCredential.rawModelId for gateway-managed execution`,
    );
  }
  if (gatewayId.trim() !== reference.gatewayId) {
    throw new Error(
      `${path}.modelCredential.gatewayId must not contain surrounding whitespace`
    );
  }
  if (organizationId.trim() !== reference.organizationId) {
    throw new Error(
      `${path}.modelCredential.organizationId must not contain surrounding whitespace`,
    );
  }
  if (environmentId.trim() !== reference.environmentId) {
    throw new Error(
      `${path}.modelCredential.environmentId must not contain surrounding whitespace`,
    );
  }
  if (rawModelId.trim() !== reference.rawModelId) {
    throw new Error(
      `${path}.modelCredential.rawModelId must not contain surrounding whitespace`
    );
  }
}

function validateProfileReference(
  record: Record<string, unknown>,
  path: string
): McpStatusCommandPayload {
  const profile = record.profile;
  const profileId = record.profileId;
  const hasProfileObject =
    typeof profile === "object" &&
    profile !== null &&
    Array.isArray(profile) === false;
  const hasProfileId =
    typeof profileId === "string" && profileId.trim().length > 0;
  if (hasProfileObject === false && hasProfileId === false) {
    throw new Error(`${path} must include profile or profileId`);
  }
  if (hasProfileObject && hasProfileId) {
    throw new Error(`${path} must include only one of profile or profileId`);
  }
  if (hasProfileObject) {
    validateProfilePayload(profile, `${path}.profile`);
  }
  return hasProfileObject
    ? { profile: profile as NonNullable<McpStatusCommandPayload["profile"]> }
    : { profileId: profileId as string };
}
