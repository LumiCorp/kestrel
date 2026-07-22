import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ToolExecutionClass } from "../../src/index.js";
import type { OperatorCheckpointSummary } from "../contracts.js";
import type {
  OperatorControlledEventPayload,
  OperatorInboxEventPayload,
  WorkspaceCheckpointEventPayload,
} from "../protocol/contracts.js";
import type { TuiAppContext } from "./TuiAppContext.js";

const DEFAULT_STOP_MESSAGE = "Stop your current work immediately and wait for further instructions.";

export type OperatorControlApplyAction =
  | "approve"
  | "reject"
  | "reply"
  | "retry"
  | "steer"
  | "stop"
  | "operator_resume_wait"
  | "operator_approve"
  | "operator_retry_delegation"
  | "focus"
  | "checkpoint"
  | "assembly_approve"
  | "assembly_reject"
  | "child_spawn"
  | "child_supersede"
  | "fanin";

export interface OperatorControllerContext extends TuiAppContext {
  cancelActiveRun(): Promise<void>;
  applyOperatorControlResponse(
    action: OperatorControlApplyAction,
    payload: OperatorControlledEventPayload,
  ): Promise<void>;
  refreshCurrentSessionDescribe(): Promise<void>;
  refreshWorkspaceCheckpointList(): Promise<void>;
  beginChildMissionJourney(): Promise<void>;
}

export class OperatorController {
  private readonly context: OperatorControllerContext;

  constructor(context: OperatorControllerContext) {
    this.context = context;
  }

  async handleOperatorControlCommand(
    action: "approve" | "reject" | "reply" | "retry" | "steer" | "stop",
    args: string[],
  ): Promise<void> {
    const state = this.context.uiStore.getState();
    const message = args.join(" ").trim();
    if ((action === "steer" || action === "reply") && message.length === 0) {
      await this.context.appendHistoryLine("system", action === "steer" ? "Usage: /steer <message>" : "Usage: /reply <message>");
      return;
    }
    if (action === "stop") {
      await this.context.cancelActiveRun();
    }
    const response = await this.context.client.sendCommand("operator.control", {
      action: action === "stop" ? "steer" : action,
      threadId: state.activeSession.focusedThreadId ?? state.activeSession.sessionId,
      ...((message.length > 0 || action === "stop")
        ? { message: message.length > 0 ? message : DEFAULT_STOP_MESSAGE }
        : {}),
    }, this.context.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator control response '${response.type}'`);
    }
    await this.context.applyOperatorControlResponse(action, response.payload);
  }

  async handleFocusThreadCommand(args: string[]): Promise<void> {
    const targetThreadId = args[0]?.trim();
    if (targetThreadId === undefined || targetThreadId.length === 0) {
      await this.context.appendHistoryLine("system", "Usage: /focus <threadId>");
      return;
    }
    const response = await this.context.client.sendCommand("operator.control", {
      action: "focus_thread",
      threadId: targetThreadId,
    }, this.context.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator focus response '${response.type}'`);
    }
    await this.context.applyOperatorControlResponse("focus", response.payload);
  }

  async handleOperatorQuickPathCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;

    if (subcommand === "resume-wait") {
      const threadId = readCommandOption(rest, "--thread-id") ?? focusedThreadId;
      const reason = readCommandOption(rest, "--reason");
      const response = await this.context.client.sendCommand("operator.control", {
        action: "retry",
        threadId,
        ...(reason !== undefined ? { message: reason } : {}),
      }, this.context.getActiveRunnerMetadata());
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator response '${response.type}'`);
      }
      await this.context.applyOperatorControlResponse("operator_resume_wait", response.payload);
      return;
    }

    if (subcommand === "approve") {
      const requestId =
        readCommandOption(rest, "--request-id") ??
        rest.find((entry) => entry.startsWith("--") === false);
      if (requestId === undefined || requestId.trim().length === 0) {
        await this.context.appendHistoryLine(
          "system",
          "Usage: /operator approve --request-id <id> [--thread-id <id>] [--allow-tool-class ...] [--allow-capability ...]",
        );
        return;
      }
      const threadId = readCommandOption(rest, "--thread-id") ?? focusedThreadId;
      const allowToolClasses = readCommandMultiOption(rest, "--allow-tool-class")
        .map((entry) => normalizeToolClassToken(entry))
        .filter((entry): entry is ToolExecutionClass => entry !== undefined);
      const allowCapabilities = readCommandMultiOption(rest, "--allow-capability");
      const response = await this.context.client.sendCommand("operator.control", {
        action: "approve",
        threadId,
        requestId,
        ...(allowToolClasses.length > 0 ? { allowToolClasses } : {}),
        ...(allowCapabilities.length > 0 ? { allowCapabilities } : {}),
      }, this.context.getActiveRunnerMetadata());
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator response '${response.type}'`);
      }
      await this.context.applyOperatorControlResponse("operator_approve", response.payload);
      return;
    }

    if (subcommand === "retry-delegation") {
      const delegationId =
        readCommandOption(rest, "--delegation-id") ??
        rest.find((entry) => entry.startsWith("--") === false);
      if (delegationId === undefined || delegationId.trim().length === 0) {
        await this.context.appendHistoryLine(
          "system",
          "Usage: /operator retry-delegation --delegation-id <id> [--thread-id <id>]",
        );
        return;
      }
      const threadId = readCommandOption(rest, "--thread-id") ?? focusedThreadId;
      const response = await this.context.client.sendCommand("operator.control", {
        action: "supersede_child_thread",
        threadId,
        delegationId,
        message: "Retry delegation requested via operator quick path.",
      }, this.context.getActiveRunnerMetadata());
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator response '${response.type}'`);
      }
      await this.context.applyOperatorControlResponse("operator_retry_delegation", response.payload);
      return;
    }

    if (subcommand === "doctor-export") {
      const runId = readCommandOption(rest, "--run-id") ?? rest[0];
      const outPath = readCommandOption(rest, "--out") ?? rest[1];
      if (runId === undefined || outPath === undefined) {
        await this.context.appendHistoryLine(
          "system",
          "Usage: /operator doctor-export --run-id <id> --out <file>",
        );
        return;
      }
      const core = this.context.getLocalCoreClient?.();
      if (core === undefined) {
        throw new Error("Doctor export requires the authenticated Local Core API.");
      }
      const report = await core.runtimeDoctor({ runId });
      const target = path.resolve(this.context.options.cwd, outPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await this.context.appendHistoryLine(
        "system",
        `Doctor report exported to '${outPath}' status=${report.status}.`,
      );
      return;
    }

    await this.context.appendHistoryLine(
      "system",
      "Usage: /operator <resume-wait|approve|retry-delegation|doctor-export> ...",
    );
  }

  async handleAssemblyCommand(args: string[]): Promise<void> {
    const [subcommand, maybeProposalId, ...rest] = args;
    if (subcommand !== "approve" && subcommand !== "reject") {
      await this.context.appendHistoryLine("system", "Usage: /assembly <approve|reject> [proposalId] [reason]");
      return;
    }
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    const proposalId =
      maybeProposalId?.trim() || (await this.resolvePendingAssemblyProposalId(focusedThreadId));
    if (proposalId === undefined) {
      await this.context.appendHistoryLine("system", "No pending assembly proposal id is available.");
      return;
    }
    const response = await this.context.client.sendCommand("operator.control", {
      action: subcommand === "approve" ? "approve_assembly_change" : "reject_assembly_change",
      threadId: focusedThreadId,
      proposalId,
      ...(rest.join(" ").trim().length > 0 ? { message: rest.join(" ").trim() } : {}),
    }, this.context.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator assembly response '${response.type}'`);
    }
    await this.context.applyOperatorControlResponse(`assembly_${subcommand}`, response.payload);
  }

  async handleChildCommand(args: string[]): Promise<void> {
    const [subcommand, ...rest] = args;
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    if (subcommand === undefined) {
      await this.openDelegationReview();
      return;
    }
    if (subcommand === "spawn") {
      await this.context.appendHistoryLine("system", "Collaborator dialogs are opened by Kestrel in the conversation; they cannot be launched manually.");
      return;
    }
    if (subcommand === "supersede") {
      const delegationId = rest[0]?.trim();
      if (delegationId === undefined || delegationId.length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /child supersede <delegationId> [reason]");
        return;
      }
      const response = await this.context.client.sendCommand("operator.control", {
        action: "supersede_child_thread",
        threadId: focusedThreadId,
        delegationId,
        ...(rest.slice(1).join(" ").trim().length > 0 ? { message: rest.slice(1).join(" ").trim() } : {}),
      }, this.context.getActiveRunnerMetadata());
      if (response.type !== "operator.controlled") {
        throw new Error(`Unexpected operator child response '${response.type}'`);
      }
      await this.context.applyOperatorControlResponse("child_supersede", response.payload);
      return;
    }
    await this.context.appendHistoryLine("system", "Usage: /child supersede <delegationId> [reason]");
  }

  async handleFanInCommand(args: string[]): Promise<void> {
    const [subcommand, maybeCheckpointId] = args;
    if (subcommand === undefined) {
      await this.openDelegationReview();
      return;
    }
    if (subcommand !== "accept" && subcommand !== "defer") {
      await this.context.appendHistoryLine("system", "Usage: /fanin <accept|defer> [checkpointId]");
      return;
    }
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    const checkpointId =
      maybeCheckpointId?.trim() ||
      state.activeSession.operatorState?.latestFanInDisposition?.checkpointId ||
      state.activeSession.operatorState?.supervision?.checkpointId;
    if (checkpointId === undefined) {
      await this.context.appendHistoryLine("system", "No fan-in checkpoint id is available.");
      return;
    }
    const response = await this.context.client.sendCommand("operator.control", {
      action: "resolve_fan_in_checkpoint",
      threadId: focusedThreadId,
      checkpointId,
      actionValue: subcommand,
    }, this.context.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator fan-in response '${response.type}'`);
    }
    await this.context.applyOperatorControlResponse("fanin", response.payload);
  }

  async handleCheckpointCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.openRecoveryCenter();
      return;
    }
    const state = this.context.uiStore.getState();
    const [subcommand, ...rest] = args;
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;

    if (subcommand === "capture") {
      const response = await this.context.client.sendCommand("workspace.checkpoint.capture", {
        sessionId: state.activeSession.sessionId,
        threadId: focusedThreadId,
        ...(rest.join(" ").trim().length > 0 ? { label: rest.join(" ").trim() } : {}),
      });
      if (response.type !== "workspace.checkpoint") {
        throw new Error(`Unexpected workspace checkpoint response '${response.type}'`);
      }
      const payload = response.payload as WorkspaceCheckpointEventPayload;
      const label = payload.checkpoint?.checkpoint.label ?? "workspace checkpoint";
      this.context.uiStore.patch({
        workspaceCheckpoints: payload.checkpoints ?? this.context.uiStore.getState().workspaceCheckpoints,
      });
      await this.context.appendHistoryLine("system", `Captured ${label}.`);
      return;
    }

    if (subcommand === "list") {
      await this.context.refreshWorkspaceCheckpointList();
      await this.openRecoveryCenter();
      return;
    }

    if (subcommand === "inspect") {
      const checkpointId = rest[0]?.trim();
      if (checkpointId === undefined || checkpointId.length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /checkpoint inspect <checkpointId>");
        return;
      }
      const response = await this.context.client.sendCommand("workspace.checkpoint.inspect", {
        sessionId: state.activeSession.sessionId,
        checkpointId,
      });
      if (response.type !== "workspace.checkpoint") {
        throw new Error(`Unexpected workspace checkpoint response '${response.type}'`);
      }
      const payload = response.payload as WorkspaceCheckpointEventPayload;
      await this.context.appendHistoryLine(
        "system",
        payload.checkpoint === undefined
          ? `Checkpoint '${checkpointId}' not found.`
          : `Checkpoint ${payload.checkpoint.checkpoint.label} files=${payload.checkpoint.files.length} reason=${payload.checkpoint.checkpoint.reason}`,
      );
      return;
    }

    if (subcommand === "restore") {
      const checkpointId = rest[0]?.trim();
      if (checkpointId === undefined || checkpointId.length === 0) {
        await this.context.appendHistoryLine("system", "Usage: /checkpoint restore <checkpointId> [reason]");
        return;
      }
      const response = await this.context.client.sendCommand("workspace.checkpoint.restore", {
        sessionId: state.activeSession.sessionId,
        checkpointId,
        threadId: focusedThreadId,
        ...(rest.slice(1).join(" ").trim().length > 0 ? { reason: rest.slice(1).join(" ").trim() } : {}),
      });
      if (response.type !== "workspace.checkpoint") {
        throw new Error(`Unexpected workspace checkpoint response '${response.type}'`);
      }
      const payload = response.payload as WorkspaceCheckpointEventPayload;
      await this.context.appendHistoryLine(
        "system",
        payload.restore === undefined
          ? `Restore for '${checkpointId}' did not return a result.`
          : `Restore ${payload.restore.status.toLowerCase()} for checkpoint '${checkpointId}'.`,
      );
      await this.context.refreshWorkspaceCheckpointList();
      return;
    }

    if (subcommand === "undo-last-promotion") {
      const response = await this.context.client.sendCommand("workspace.promotion.undo_latest", {
        sessionId: state.activeSession.sessionId,
        ...(rest.join(" ").trim().length > 0 ? { reason: rest.join(" ").trim() } : {}),
      });
      if (response.type !== "workspace.checkpoint") {
        throw new Error(`Unexpected workspace promotion undo response '${response.type}'`);
      }
      const payload = response.payload as WorkspaceCheckpointEventPayload;
      await this.context.appendHistoryLine(
        "system",
        payload.restore?.promotionId !== undefined
          ? `Promotion ${payload.restore.promotionId} restored checkpoint ${payload.restore.checkpointId} with restore ${payload.restore.restoreId}.`
          : "Latest promotion undo did not return a restore result.",
      );
      await this.context.refreshWorkspaceCheckpointList();
      return;
    }

    if (subcommand !== "accept" && subcommand !== "defer") {
      await this.context.appendHistoryLine(
        "system",
        "Usage: /checkpoint [capture|list|inspect|restore|undo-last-promotion|accept|defer] ...",
      );
      return;
    }

    const requestedCheckpointId = rest[0]?.trim();
    const checkpoint = await this.resolvePendingContextCheckpoint({
      threadId: focusedThreadId,
      checkpointId: requestedCheckpointId !== undefined && requestedCheckpointId.length > 0
        ? requestedCheckpointId
        : undefined,
    });
    if (checkpoint === undefined) {
      await this.context.appendHistoryLine("system", "No pending context checkpoint is available for this session.");
      return;
    }
    const actionValue =
      subcommand === "defer"
        ? "continue"
        : checkpoint.recommendedAction;
    const resolvedThreadId = this.context.uiStore.getState().activeSession.focusedThreadId ?? focusedThreadId;
    const response = await this.context.client.sendCommand("operator.control", {
      action: "resolve_context_checkpoint",
      threadId: resolvedThreadId,
      checkpointId: checkpoint.checkpointId,
      actionValue,
    }, this.context.getActiveRunnerMetadata());
    if (response.type !== "operator.controlled") {
      throw new Error(`Unexpected operator checkpoint response '${response.type}'`);
    }
    await this.context.applyOperatorControlResponse("checkpoint", response.payload);
  }

  async handleSnapshotCommand(args: string[]): Promise<void> {
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    const response = await this.context.client.sendCommand("workspace.checkpoint.capture", {
      sessionId: state.activeSession.sessionId,
      threadId: focusedThreadId,
      ...(args.join(" ").trim().length > 0 ? { label: args.join(" ").trim() } : {}),
    });
    if (response.type !== "workspace.checkpoint") {
      throw new Error(`Unexpected workspace snapshot response '${response.type}'`);
    }
    const payload = response.payload as WorkspaceCheckpointEventPayload;
    const label = payload.checkpoint?.checkpoint.label ?? "workspace snapshot";
    this.context.uiStore.patch({
      workspaceCheckpoints: payload.checkpoints ?? this.context.uiStore.getState().workspaceCheckpoints,
    });
    await this.context.appendHistoryLine("system", `Saved snapshot ${label}.`);
  }

  async handleRestoreCommand(args: string[]): Promise<void> {
    const state = this.context.uiStore.getState();
    const focusedThreadId = state.activeSession.focusedThreadId ?? state.activeSession.sessionId;
    const snapshotId = args[0]?.trim();
    if (snapshotId === undefined || snapshotId.length === 0) {
      await this.openRecoveryCenter();
      return;
    }
    const response = await this.context.client.sendCommand("workspace.checkpoint.restore", {
      sessionId: state.activeSession.sessionId,
      checkpointId: snapshotId,
      threadId: focusedThreadId,
      ...(args.slice(1).join(" ").trim().length > 0 ? { reason: args.slice(1).join(" ").trim() } : {}),
    });
    if (response.type !== "workspace.checkpoint") {
      throw new Error(`Unexpected workspace restore response '${response.type}'`);
    }
    const payload = response.payload as WorkspaceCheckpointEventPayload;
    await this.context.appendHistoryLine(
      "system",
      payload.restore === undefined
        ? `Restore for snapshot '${snapshotId}' did not return a result.`
        : `Restore ${payload.restore.status.toLowerCase()} for snapshot '${snapshotId}'.`,
    );
    await this.context.refreshWorkspaceCheckpointList();
  }

  private async resolvePendingContextCheckpoint(input: {
    threadId: string;
    checkpointId?: string | undefined;
  }): Promise<OperatorCheckpointSummary | undefined> {
    const findCheckpoint = () => {
      const checkpoint = this.context.uiStore.getState().activeSession.operatorState?.latestCheckpoint;
      if (checkpoint === undefined || checkpoint.status !== "PENDING") {
        return ;
      }
      if (input.checkpointId !== undefined && checkpoint.checkpointId !== input.checkpointId) {
        return ;
      }
      return checkpoint;
    };

    const existing = findCheckpoint();
    if (existing !== undefined) {
      return existing;
    }

    await this.context.refreshCurrentSessionDescribe();
    const refreshed = findCheckpoint();
    if (refreshed !== undefined) {
      return refreshed;
    }

    const inboxThreadId = this.context.uiStore.getState().activeSession.focusedThreadId ?? input.threadId;
    const response = await this.context.client.sendCommand(
      "operator.inbox",
      { threadId: inboxThreadId },
      this.context.getActiveRunnerMetadata(),
    );
    if (response.type !== "operator.inbox") {
      throw new Error(`Unexpected operator inbox response '${response.type}'`);
    }
    const inbox = response.payload as OperatorInboxEventPayload;
    const item = inbox.inbox.items.find((candidate) =>
      candidate.kind === "context_checkpoint" &&
      candidate.checkpointId !== undefined &&
      (input.checkpointId === undefined || candidate.checkpointId === input.checkpointId),
    );
    const recommendedAction = normalizeContextCheckpointAction(item?.recommendedAction);
    if (item?.checkpointId === undefined || recommendedAction === undefined) {
      return ;
    }
    return {
      checkpointId: item.checkpointId,
      status: "PENDING",
      recommendedAction,
      reason: item.title,
    };
  }

  private async resolvePendingAssemblyProposalId(threadId: string): Promise<string | undefined> {
    const response = await this.context.client.sendCommand(
      "operator.inbox",
      { threadId },
      this.context.getActiveRunnerMetadata(),
    );
    if (response.type !== "operator.inbox") {
      throw new Error(`Unexpected operator inbox response '${response.type}'`);
    }
    const inbox = response.payload as OperatorInboxEventPayload;
    const proposal = inbox.inbox.items.find((item) => item.kind === "assembly_change_proposal");
    return typeof proposal?.metadata?.proposalId === "string"
      ? proposal.metadata.proposalId
      : undefined;
  }

  private async openDelegationReview(): Promise<void> {
    await this.context.refreshCurrentSessionDescribe();
    this.context.navigateToView("delegation");
    await this.context.persistUiState();
  }

  private async openRecoveryCenter(): Promise<void> {
    await this.context.refreshCurrentSessionDescribe();
    await this.context.refreshWorkspaceCheckpointList();
    this.context.navigateToView("recovery");
    await this.context.persistUiState();
  }
}

function normalizeContextCheckpointAction(value: unknown): OperatorCheckpointSummary["recommendedAction"] | undefined {
  if (
    value === "continue" ||
    value === "compact" ||
    value === "summarize_forward" ||
    value === "handoff" ||
    value === "split_into_child_thread" ||
    value === "operator_checkpoint"
  ) {
    return value;
  }
  return ;
}

function readCommandOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return ;
  }
  const value = args[index + 1];
  return value !== undefined && value.startsWith("--") === false ? value : undefined;
}

function readCommandMultiOption(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) {
      continue;
    }
    const value = args[index + 1];
    if (value !== undefined && value.startsWith("--") === false) {
      values.push(value);
    }
  }
  return values;
}

function normalizeToolClassToken(value: string): ToolExecutionClass | undefined {
  if (
    value === "read_only" ||
    value === "planning_write" ||
    value === "sandboxed_only" ||
    value === "external_side_effect"
  ) {
    return value;
  }
  return ;
}
