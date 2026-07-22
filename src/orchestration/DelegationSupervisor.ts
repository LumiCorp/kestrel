import { randomUUID } from "node:crypto";

import type { NormalizedOutput } from "../kestrel/contracts/execution.js";

import type {
  EventStore,
  ThreadStore,
} from "../kestrel/contracts/store.js";
import type { TuiProfile } from "../../cli/contracts.js";
import {
  asRuntimeError,
  createRuntimeFailure,
  delegationLimitReachedFailure,
  delegationModelMismatchFailure,
  delegationNotPersistedFailure,
  delegationProfileMismatchFailure,
  delegationProviderMismatchFailure,
} from "../runtime/RuntimeFailure.js";
import type {
  DelegationServicePort,
  DialogServicePort,
  DialogSnapshot,
  DelegationTaskResult,
  DelegationTaskSnapshot,
  DelegationTaskSpawnRequest,
} from "../../tools/contracts.js";
import type {
  ChildThreadPolicy,
  DelegationHandle,
  DelegationRecord,
  OrchestrationStore,
  SubmitTurnInput,
  SubmitTurnResult,
  ThreadRecord,
} from "./contracts.js";
import type { DialogView } from "./contracts.js";
import {
  deriveDelegationOutcomeState,
  normalizeLaunchPolicy,
  updateDelegationOutcomePolicy,
} from "./Supervision.js";
import { normalizeSubAgentResultEnvelope } from "./subAgentResult.js";

export interface DelegationTaskUpdate {
  task: DelegationTaskSnapshot;
  kind: "spawned" | "waiting" | "completed" | "failed";
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
  dialogMessage?: DialogMessageRecord | undefined;
}

export interface DialogMessageRecord {
  messageId: string;
  dialogId: string;
  name: string;
  childSessionId: string;
  sender: "kestrel" | "collaborator" | "system";
  text: string;
  createdAt: string;
  status?: "failed" | "cancelled" | undefined;
}

export interface DelegationSupervisorOptions {
  profile: TuiProfile;
  runtimeStore: ThreadStore & EventStore;
  orchestrationStore: OrchestrationStore;
  submitChildTurn: (input: SubmitTurnInput) => Promise<SubmitTurnResult>;
  startChildThread: (input: {
    title: string;
    parentThreadId: string;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<ThreadRecord>;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
  onDelegationUpdated?: ((input: {
    record: DelegationRecord;
    finalizedPayload?: unknown | undefined;
  }) => Promise<void> | void) | undefined;
  onDialogReply?: ((input: { record: DelegationRecord; message: DialogMessageRecord }) => Promise<void> | void) | undefined;
}

interface StoredDelegationResult {
  record: DelegationRecord;
  finalizedPayload?: unknown | undefined;
}

const DEFAULT_DELEGATION_MAX_DEPTH = 2;
const RESULT_SUMMARY_LIMIT = 240;

export class DelegationSupervisor implements DelegationServicePort, DialogServicePort {
  private readonly profile: TuiProfile;
  private readonly runtimeStore: ThreadStore & EventStore;
  private readonly store: OrchestrationStore;
  private readonly submitChildTurn: DelegationSupervisorOptions["submitChildTurn"];
  private readonly startChildThread: DelegationSupervisorOptions["startChildThread"];
  private readonly onTaskUpdate: DelegationSupervisorOptions["onTaskUpdate"];
  private readonly onDelegationUpdated: DelegationSupervisorOptions["onDelegationUpdated"];
  private readonly onDialogReply: DelegationSupervisorOptions["onDialogReply"];
  private readonly results = new Map<string, StoredDelegationResult>();
  private readonly activeDialogRuns = new Map<string, AbortController>();

  constructor(options: DelegationSupervisorOptions) {
    this.profile = options.profile;
    this.runtimeStore = options.runtimeStore;
    this.store = options.orchestrationStore;
    this.submitChildTurn = options.submitChildTurn;
    this.startChildThread = options.startChildThread;
    this.onTaskUpdate = options.onTaskUpdate;
    this.onDelegationUpdated = options.onDelegationUpdated;
    this.onDialogReply = options.onDialogReply;
  }

  async open(input: { parentSessionId: string; parentRunId?: string | undefined; name: string; message: string }): Promise<DialogSnapshot> {
    const name = normalizeDialogName(input.name);
    const existing = await this.store.listDelegations({ parentThreadId: input.parentSessionId });
    if (existing.some((record) => {
      const dialog = readDialogState(record);
      return dialog?.status === "open" && dialog.name.toLocaleLowerCase() === name.toLocaleLowerCase();
    })) {
      throw createRuntimeFailure("DIALOG_NAME_IN_USE", `An open dialog is already named '${name}'.`, { dialogName: name });
    }
    const handle = await this.spawnDelegation({
      parentThreadId: input.parentSessionId,
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      title: name,
      prompt: input.message,
      launchedBy: "agent",
      resultContract: "persistent_dialog_v1",
      policy: {
        depth: 1,
        maxDepth: 1,
        dialog: { version: "v1", name, status: "open", messages: [] },
      },
    });
    const record = await this.requireDialog(handle.delegationId, input.parentSessionId);
    return toDialogSnapshot(record);
  }

  async send(input: { parentSessionId: string; parentRunId?: string | undefined; dialogId: string; message: string }): Promise<DialogSnapshot> {
    const record = await this.requireDialog(input.dialogId, input.parentSessionId);
    const dialog = readDialogState(record)!;
    if (dialog.status !== "open") throw createRuntimeFailure("DIALOG_CLOSED", `Dialog '${input.dialogId}' is closed.`, { dialogId: input.dialogId });
    if (record.status === "RUNNING") throw createRuntimeFailure("DIALOG_BUSY", `Dialog '${input.dialogId}' is already processing a message.`, { dialogId: input.dialogId });
    const updated = appendDialogMessage({ ...record, prompt: input.message, status: "RUNNING", ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}), updatedAt: new Date().toISOString() }, createDialogMessage(record, "kestrel", input.message));
    await this.store.upsertDelegation(updated);
    const message = lastDialogMessage(updated)!;
    await this.appendDialogEvent("dialog.message", updated, message);
    this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "spawned", assistantText: null, dialogMessage: message });
    void this.runDelegation(updated);
    return toDialogSnapshot(updated);
  }

  async close(input: { parentSessionId: string; parentRunId?: string | undefined; dialogId: string }): Promise<DialogSnapshot> {
    const record = await this.requireDialog(input.dialogId, input.parentSessionId);
    const dialog = readDialogState(record)!;
    if (dialog.status === "closed") return toDialogSnapshot(record);
    this.activeDialogRuns.get(record.delegationId)?.abort(new Error("Dialog closed."));
    const updated = writeDialogState({ ...record, status: "CANCELLED", ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}), updatedAt: new Date().toISOString() }, { ...dialog, status: "closed" });
    const closeMessage = { ...createDialogMessage(updated, "system", "Dialog closed."), status: "cancelled" as const };
    const persisted = appendDialogMessage(updated, closeMessage);
    await this.store.upsertDelegation(persisted);
    await this.appendDialogEvent("dialog.closed", persisted, closeMessage);
    this.emit({ task: toTaskSnapshot(persisted, this.profile), kind: "completed", assistantText: null, dialogMessage: closeMessage });
    return toDialogSnapshot(persisted);
  }

  cancelActiveDialogs(parentSessionId: string): void {
    for (const [dialogId, controller] of this.activeDialogRuns) {
      void this.store.getDelegation(dialogId).then((record) => {
        if (record?.parentThreadId === parentSessionId) controller.abort(new Error("Kestrel run stopped."));
      });
    }
  }

  private async requireDialog(dialogId: string, parentSessionId: string): Promise<DelegationRecord> {
    const record = await this.store.getDelegation(dialogId);
    if (record === null || record.parentThreadId !== parentSessionId || readDialogState(record) === undefined) {
      throw createRuntimeFailure("DIALOG_NOT_FOUND", `Dialog '${dialogId}' was not found in this thread.`, { dialogId });
    }
    return record;
  }

  async spawnTask(input: DelegationTaskSpawnRequest): Promise<DelegationTaskSnapshot> {
    const parentDepth = normalizePolicyInteger(input.delegationDepth);
    const childDepth = parentDepth !== undefined ? parentDepth + 1 : 1;
    const handle = await this.spawnDelegation({
      parentThreadId: input.parentSessionId,
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      title: input.title,
      prompt: input.prompt,
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.resultContract !== undefined ? { resultContract: input.resultContract } : {}),
      ...(input.launchedBy !== undefined ? { launchedBy: input.launchedBy } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      delegationDepth: childDepth,
      ...(input.rootDelegationId !== undefined ? { rootDelegationId: input.rootDelegationId } : {}),
      policy: {
        depth: childDepth,
        maxDepth: this.profile.delegation?.maxDepth ?? DEFAULT_DELEGATION_MAX_DEPTH,
        ...(input.rootDelegationId !== undefined ? { rootDelegationId: input.rootDelegationId } : {}),
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      },
    });
    const record = await this.store.getDelegation(handle.delegationId);
    if (record === null) {
      throw delegationNotPersistedFailure(handle.delegationId);
    }
    return toTaskSnapshot(record, this.profile);
  }

  async listTasks(parentSessionId: string): Promise<DelegationTaskSnapshot[]> {
    const records = await this.store.listDelegations({
      parentThreadId: parentSessionId,
    });
    return records.map((record) => toTaskSnapshot(record, this.profile));
  }

  async getTaskResult(taskId: string): Promise<DelegationTaskResult | null> {
    const stored = this.results.get(taskId);
    if (stored !== undefined) {
      return {
        task: toTaskSnapshot(stored.record, this.profile),
        ...(stored.finalizedPayload !== undefined ? { finalizedPayload: stored.finalizedPayload } : {}),
      };
    }
    const record = await this.store.getDelegation(taskId);
    if (record === null) {
      return null;
    }
    return {
      task: toTaskSnapshot(record, this.profile),
    };
  }

  async spawnDelegation(input: {
    parentThreadId: string;
    parentRunId?: string | undefined;
    title: string;
    prompt: string;
    profileId?: string | undefined;
    provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    model?: string | undefined;
    launchedBy?: "operator" | "agent" | undefined;
    resultContract?: string | undefined;
    taskId?: string | undefined;
    parentTaskId?: string | undefined;
    delegationDepth?: number | undefined;
    rootDelegationId?: string | undefined;
    policy?: ChildThreadPolicy | undefined;
  }): Promise<DelegationHandle> {
    this.assertProfileCompatibility(input);
    const delegationId = `task-${randomUUID()}`;
    const policy = resolveLaunchPolicy({
      policy: normalizeLaunchPolicy({
        policy: input.policy,
        parentThreadId: input.parentThreadId,
      }),
      defaultMaxDepth: this.profile.delegation?.maxDepth ?? DEFAULT_DELEGATION_MAX_DEPTH,
      delegationId,
      parentTaskId: input.parentTaskId,
      delegationDepth: input.delegationDepth,
      rootDelegationId: input.rootDelegationId,
    });
    assertDelegationDepth(policy);
    await this.assertCapacity(input.parentThreadId);

    const childThread = await this.startChildThread({
      title: buildChildTitle(input.title),
      parentThreadId: input.parentThreadId,
      metadata: {
        delegationPrompt: input.prompt,
      },
    });
    const now = new Date().toISOString();
    let record: DelegationRecord = {
      delegationId,
      parentThreadId: input.parentThreadId,
      childThreadId: childThread.threadId,
      title: input.title.trim(),
      prompt: input.prompt,
      status: "RUNNING",
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      delegationDepth: policy.depth,
      rootDelegationId: policy.rootDelegationId,
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      provider: input.provider ?? this.profile.modelProvider ?? "openrouter",
      model: input.model ?? this.profile.model ?? "(env default)",
      ...(input.launchedBy !== undefined ? { launchedBy: input.launchedBy } : {}),
      ...(input.resultContract !== undefined ? { resultContract: input.resultContract } : {}),
      policy: writeDelegationLineagePolicy({
        policy,
        lineage: readInputLineage({
          ...input,
          delegationDepth: policy.depth,
          rootDelegationId: policy.rootDelegationId,
        }),
      }),
      createdAt: now,
      updatedAt: now,
    };
    const dialog = readDialogState(record);
    if (dialog !== undefined) {
      record = appendDialogMessage(record, createDialogMessage(record, "kestrel", input.prompt));
    }
    await this.store.upsertDelegation(record);
    await this.appendDelegationEvent("delegation.requested", record);
    await this.appendDelegationEvent("delegation.spawned", record);
    if (dialog !== undefined) {
      await this.appendDialogEvent("dialog.opened", record);
      const message = lastDialogMessage(record)!;
      await this.appendDialogEvent("dialog.message", record, message);
    }
    this.emit({
      task: toTaskSnapshot(record, this.profile),
      kind: "spawned",
      assistantText: null,
      ...(dialog !== undefined ? { dialogMessage: lastDialogMessage(record)! } : {}),
    });
    await this.onDelegationUpdated?.({ record });

    void this.runDelegation(record);

    return {
      delegationId: record.delegationId,
      childThreadId: childThread.threadId,
    };
  }

  private async runDelegation(record: DelegationRecord): Promise<void> {
    if (readDialogState(record) !== undefined) {
      await this.runDialogTurn(record);
      return;
    }
    try {
      const result = await this.submitChildTurn({
        threadId: record.childThreadId,
        message: record.prompt,
        eventType: "user.message",
      });
      if (result.output.status === "WAITING" && result.output.waitFor !== undefined) {
        const eventType = result.output.waitFor.eventType;
        const resultEnvelope = {
          status: "blocked" as const,
          result: `Waiting for ${eventType}.`,
          error: {
            code: eventType,
            message: `Child agent is waiting for ${eventType}.`,
          },
        };
        const waiting = updateDelegationOutcomePolicy({
          record: {
            ...record,
            status: "WAITING",
            waitEventType: eventType,
            childRunId: result.output.runId,
            result: resultEnvelope,
            resultSummary: summarizeResultText(resultEnvelope.result),
            updatedAt: new Date().toISOString(),
          },
          resultState: "blocked",
          outcomeReason: eventType,
        });
        await this.store.upsertDelegation(waiting);
        await this.appendDelegationEvent("delegation.waiting", waiting);
        this.emit({
          task: toTaskSnapshot(waiting, this.profile),
          kind: "waiting",
          assistantText: null,
        });
        this.results.set(waiting.delegationId, {
          record: waiting,
          ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
        });
        await this.onDelegationUpdated?.({
          record: waiting,
          ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
        });
        return;
      }

      const resultEnvelope = normalizeSubAgentResultEnvelope(
        result.finalizedPayload !== undefined ? result.finalizedPayload : result.output,
        result.output.status === "COMPLETED" ? "completed" : "failed",
        readFirstOutputError(result.output),
      );
      const baseCompletedRecord: DelegationRecord = {
        ...record,
        status: resultEnvelope.status === "completed" ? "COMPLETED" : "FAILED",
        childRunId: result.output.runId,
        result: resultEnvelope,
        resultSummary: result.assistantText ?? summarizeResultText(resultEnvelope.result),
        updatedAt: new Date().toISOString(),
      };
      const completed = updateDelegationOutcomePolicy({
        record: baseCompletedRecord,
        resultState: deriveDelegationOutcomeState({
          record: baseCompletedRecord,
          session: result.session,
          finalizedPayload: result.finalizedPayload,
        }),
        outcomeReason:
          result.output.status === "FAILED" ? result.output.errors[0]?.code ?? "failed" : undefined,
      });
      await this.store.upsertDelegation(completed);
      await this.appendDelegationEvent(
        completed.status === "COMPLETED" ? "delegation.completed" : "delegation.failed",
        completed,
        completed.status === "FAILED" && completed.result?.error !== undefined
          ? { errorCode: completed.result.error.code }
          : undefined,
      );
      this.results.set(completed.delegationId, {
        record: completed,
        ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
      });
      this.emit({
        task: toTaskSnapshot(completed, this.profile),
        kind: completed.status === "COMPLETED" ? "completed" : "failed",
        assistantText: completed.status === "COMPLETED" ? result.assistantText : null,
        ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
      });
      await this.onDelegationUpdated?.({
        record: completed,
        ...(result.finalizedPayload !== undefined ? { finalizedPayload: result.finalizedPayload } : {}),
      });
    } catch (error) {
      const runtimeError = asRuntimeError(error);
      const resultEnvelope = {
        status: "failed" as const,
        result: runtimeError.message,
        error: {
          code: runtimeError.code,
          message: runtimeError.message,
        },
      };
      const failed = updateDelegationOutcomePolicy({
        record: {
          ...record,
          status: "FAILED",
          result: resultEnvelope,
          resultSummary: summarizeResultText(resultEnvelope.result),
          errorMessage: runtimeError.message,
          updatedAt: new Date().toISOString(),
        },
        resultState: "failed",
        outcomeReason: runtimeError.code,
      });
      await this.store.upsertDelegation(failed);
      await this.appendDelegationEvent("delegation.failed", failed, {
        errorCode: runtimeError.code,
      });
      this.emit({
        task: toTaskSnapshot(failed, this.profile),
        kind: "failed",
        assistantText: null,
      });
      this.results.set(failed.delegationId, { record: failed });
      await this.onDelegationUpdated?.({ record: failed });
    }
  }

  private async runDialogTurn(record: DelegationRecord): Promise<void> {
    const controller = new AbortController();
    this.activeDialogRuns.set(record.delegationId, controller);
    try {
      const result = await this.submitChildTurn({
        threadId: record.childThreadId,
        message: record.prompt,
        eventType: "dialog.message",
        ...(record.waitEventType !== undefined ? { resumeBlockedRun: true } : {}),
        metadata: { dialogId: record.delegationId, dialogName: readDialogState(record)!.name },
        runtimeTurn: {
          sessionId: record.childThreadId,
          message: record.prompt,
          eventType: "dialog.message",
          systemInstructions: [
            `You are ${readDialogState(record)!.name}, participating in a private working dialog with Kestrel.`,
            "Respond directly to Kestrel's latest message. Keep continuity with this dialog only. Do not describe either participant as an agent, sub-agent, parent, or child. You cannot open additional collaborator dialogs.",
          ],
          actor: { actorType: "service", actorId: record.parentThreadId, displayName: "Kestrel" },
        },
        signal: controller.signal,
      });
      const text = result.assistantText?.trim();
      if (result.output.status === "COMPLETED" && text !== undefined && text.length > 0) {
        const reply = createDialogMessage(record, "collaborator", text);
        const updated = appendDialogMessage({ ...record, status: "WAITING", childRunId: result.output.runId, waitEventType: undefined, resultSummary: text, updatedAt: new Date().toISOString() }, reply);
        await this.store.upsertDelegation(updated);
        await this.appendDialogEvent("dialog.message", updated, reply);
        this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "waiting", assistantText: null, dialogMessage: reply });
        await this.onDialogReply?.({ record: updated, message: reply });
        return;
      }
      const failureText = result.output.status === "WAITING"
        ? `Waiting for ${result.output.waitFor?.eventType ?? "a response"}.`
        : result.output.errors[0]?.message ?? "The collaborator did not return a message.";
      const failure = { ...createDialogMessage(record, "system", failureText), status: "failed" as const };
      const updated = appendDialogMessage({ ...record, status: "WAITING", childRunId: result.output.runId, waitEventType: result.output.waitFor?.eventType, errorMessage: failureText, updatedAt: new Date().toISOString() }, failure);
      await this.store.upsertDelegation(updated);
      await this.appendDialogEvent("dialog.execution_failed", updated, failure);
      this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "failed", assistantText: null, dialogMessage: failure });
    } catch (error) {
      const latest = await this.store.getDelegation(record.delegationId);
      if (readDialogState(latest ?? record)?.status === "closed") return;
      const runtimeError = asRuntimeError(error);
      const cancelled = controller.signal.aborted;
      const failure = { ...createDialogMessage(record, "system", cancelled ? "Collaborator work stopped; the dialog remains open." : runtimeError.message), status: cancelled ? "cancelled" as const : "failed" as const };
      const updated = appendDialogMessage({ ...record, status: "WAITING", errorMessage: runtimeError.message, updatedAt: new Date().toISOString() }, failure);
      await this.store.upsertDelegation(updated);
      await this.appendDialogEvent(cancelled ? "dialog.execution_cancelled" : "dialog.execution_failed", updated, failure);
      this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "failed", assistantText: null, dialogMessage: failure });
    } finally {
      if (this.activeDialogRuns.get(record.delegationId) === controller) this.activeDialogRuns.delete(record.delegationId);
    }
  }

  private async appendDialogEvent(
    type: "dialog.opened" | "dialog.message" | "dialog.execution_failed" | "dialog.execution_cancelled" | "dialog.closed",
    record: DelegationRecord,
    message?: DialogMessageRecord,
  ): Promise<void> {
    if (record.parentRunId === undefined) return;
    const parent = await this.runtimeStore.getThread(record.parentThreadId);
    if (parent === null) return;
    await this.runtimeStore.appendRunEvent({
      runId: record.parentRunId,
      sessionId: parent.sessionId,
      type,
      level: type === "dialog.execution_failed" ? "WARN" : "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: record.parentThreadId,
        dialogId: record.delegationId,
        dialogName: readDialogState(record)?.name,
        ...(message !== undefined ? { dialogMessage: message } : {}),
      },
    });
  }

  private async appendDelegationEvent(
    type:
      | "delegation.requested"
      | "delegation.spawned"
      | "delegation.waiting"
      | "delegation.completed"
      | "delegation.failed",
    record: DelegationRecord,
    failure?: {
      errorCode?: string | undefined;
    } | undefined,
  ): Promise<void> {
    if (record.parentRunId === undefined) {
      return;
    }
    const parentThread = await this.runtimeStore.getThread(record.parentThreadId);
    if (parentThread === null) {
      return;
    }
    await this.runtimeStore.appendRunEvent({
      runId: record.parentRunId,
      sessionId: parentThread.sessionId,
      type,
      level: type === "delegation.failed" ? "WARN" : "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        delegationId: record.delegationId,
        childThreadId: record.childThreadId,
        title: record.title,
        status: record.status,
        ...(record.waitEventType !== undefined ? { waitEventType: record.waitEventType } : {}),
        ...(record.resultSummary !== undefined ? { resultSummary: record.resultSummary } : {}),
        ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
        ...(failure?.errorCode !== undefined ? { errorCode: failure.errorCode } : {}),
      },
    });
  }

  private async assertCapacity(parentThreadId: string): Promise<void> {
    const active = (await this.store.listDelegations({
      parentThreadId,
    })).filter((record) =>
      record.status === "PENDING" || record.status === "RUNNING" || record.status === "WAITING"
    );
    const maxConcurrent = this.profile.delegation?.maxConcurrentChildSessions ?? 2;
    if (active.length >= maxConcurrent) {
      throw delegationLimitReachedFailure({
        parentThreadId,
        maxConcurrent,
        activeDelegationCount: active.length,
      });
    }
  }

  private assertProfileCompatibility(input: {
    profileId?: string | undefined;
    provider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    model?: string | undefined;
  }): void {
    if (input.profileId !== undefined && input.profileId !== this.profile.id) {
      throw delegationProfileMismatchFailure({
        expectedProfileId: this.profile.id,
        actualProfileId: input.profileId,
      });
    }
    const expectedProvider = this.profile.modelProvider ?? "openrouter";
    if (input.provider !== undefined && input.provider !== expectedProvider) {
      throw delegationProviderMismatchFailure({
        expectedProvider,
        actualProvider: input.provider,
      });
    }
    if (input.model !== undefined && this.profile.model !== undefined && input.model !== this.profile.model) {
      throw delegationModelMismatchFailure({
        expectedModel: this.profile.model,
        actualModel: input.model,
      });
    }
  }

  private emit(update: DelegationTaskUpdate): void {
    this.onTaskUpdate?.(update);
  }
}

function toTaskSnapshot(record: DelegationRecord, profile: TuiProfile): DelegationTaskSnapshot {
  const lineage = readRecordLineage(record);
  return {
    taskId: record.delegationId,
    parentSessionId: record.parentThreadId,
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(lineage.taskId !== undefined ? { sourceTaskId: lineage.taskId } : {}),
    ...(lineage.parentTaskId !== undefined ? { parentTaskId: lineage.parentTaskId } : {}),
    ...(lineage.delegationDepth !== undefined ? { delegationDepth: lineage.delegationDepth } : {}),
    ...(lineage.rootDelegationId !== undefined ? { rootDelegationId: lineage.rootDelegationId } : {}),
    title: record.title,
    status: record.status === "CANCELLED" ? "FAILED" : record.status,
    childSessionId: record.childThreadId,
    childSessionName: buildChildTitle(record.title),
    profileId: record.profileId ?? profile.id,
    provider: record.provider ?? profile.modelProvider ?? "openrouter",
    model: record.model ?? profile.model ?? "(env default)",
    ...(record.waitEventType !== undefined ? { waitEventType: record.waitEventType } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.resultSummary !== undefined ? { resultSummary: record.resultSummary } : {}),
    ...(record.result?.error?.code !== undefined ? { errorCode: record.result.error.code } : {}),
    ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    ...(record.result?.references !== undefined ? { references: record.result.references } : {}),
    ...(record.launchedBy !== undefined ? { launchedBy: record.launchedBy } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

interface StoredDialogState {
  version: "v1";
  name: string;
  status: "open" | "closed";
  messages: DialogMessageRecord[];
}

function normalizeDialogName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 40) {
    throw createRuntimeFailure("DIALOG_NAME_INVALID", "A dialog name must contain 1 to 40 characters.", { name });
  }
  if (name.toLocaleLowerCase() === "kestrel") {
    throw createRuntimeFailure("DIALOG_NAME_RESERVED", "'Kestrel' is reserved for the primary participant.", { name });
  }
  return name;
}

function readDialogState(record: DelegationRecord): StoredDialogState | undefined {
  const value = record.policy?.dialog;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const dialog = value as Record<string, unknown>;
  if (dialog.version !== "v1" || typeof dialog.name !== "string") return undefined;
  const messages = Array.isArray(dialog.messages)
    ? dialog.messages.filter((message): message is DialogMessageRecord => {
        if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
        const item = message as Record<string, unknown>;
        return typeof item.messageId === "string" && typeof item.dialogId === "string" && typeof item.name === "string" && typeof item.childSessionId === "string" && (item.sender === "kestrel" || item.sender === "collaborator" || item.sender === "system") && typeof item.text === "string" && typeof item.createdAt === "string";
      })
    : [];
  return { version: "v1", name: dialog.name, status: dialog.status === "closed" ? "closed" : "open", messages };
}

export function readDialogView(record: DelegationRecord): DialogView | undefined {
  const dialog = readDialogState(record);
  if (dialog === undefined) return undefined;
  return {
    dialogId: record.delegationId,
    name: dialog.name,
    status: dialog.status,
    childThreadId: record.childThreadId,
    messages: dialog.messages,
  };
}

function writeDialogState(record: DelegationRecord, dialog: StoredDialogState): DelegationRecord {
  return { ...record, policy: { ...(record.policy ?? {}), dialog } };
}

function createDialogMessage(record: DelegationRecord, sender: DialogMessageRecord["sender"], text: string): DialogMessageRecord {
  return {
    messageId: `dialog-message-${randomUUID()}`,
    dialogId: record.delegationId,
    name: readDialogState(record)?.name ?? record.title,
    childSessionId: record.childThreadId,
    sender,
    text,
    createdAt: new Date().toISOString(),
  };
}

function appendDialogMessage(record: DelegationRecord, message: DialogMessageRecord): DelegationRecord {
  const dialog = readDialogState(record);
  if (dialog === undefined) return record;
  return writeDialogState(record, { ...dialog, messages: [...dialog.messages, message] });
}

function lastDialogMessage(record: DelegationRecord): DialogMessageRecord | undefined {
  return readDialogState(record)?.messages.at(-1);
}

function toDialogSnapshot(record: DelegationRecord): DialogSnapshot {
  const dialog = readDialogState(record);
  if (dialog === undefined) throw createRuntimeFailure("DIALOG_NOT_FOUND", `Dialog '${record.delegationId}' was not found.`, { dialogId: record.delegationId });
  return {
    dialogId: record.delegationId,
    name: dialog.name,
    parentSessionId: record.parentThreadId,
    childSessionId: record.childThreadId,
    status: dialog.status,
    active: record.status === "RUNNING",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function resolveLaunchPolicy(input: {
  policy: ChildThreadPolicy;
  defaultMaxDepth: number;
  delegationId: string;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
}): ChildThreadPolicy & {
  depth: number;
  maxDepth: number;
  rootDelegationId: string;
} {
  const depth = input.policy.depth ?? (
    input.delegationDepth !== undefined ? normalizePolicyInteger(input.delegationDepth) : 1
  ) ?? 1;
  const maxDepth =
    input.policy.maxDepth ??
    normalizePolicyInteger(input.defaultMaxDepth) ??
    DEFAULT_DELEGATION_MAX_DEPTH;
  const rootDelegationId =
    normalizePolicyString(input.policy.rootDelegationId) ??
    normalizePolicyString(input.rootDelegationId) ??
    input.delegationId;
  const parentTaskId =
    normalizePolicyString(input.policy.parentTaskId) ??
    normalizePolicyString(input.parentTaskId);
  const sourceMutationFanIn = normalizeSourceMutationFanIn(input.policy.sourceMutationFanIn) ?? "manual";
  return {
    ...input.policy,
    depth,
    maxDepth,
    rootDelegationId,
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
    sourceMutationFanIn,
  };
}

function assertDelegationDepth(policy: { depth: number; maxDepth: number }): void {
  if (policy.depth <= policy.maxDepth) {
    return;
  }
  throw createRuntimeFailure(
    "DELEGATION_DEPTH_LIMIT_REACHED",
    `Delegation depth limit reached (${policy.depth}/${policy.maxDepth}).`,
    {
      depth: policy.depth,
      maxDepth: policy.maxDepth,
      classification: "policy",
      recoverable: true,
    },
  );
}

function normalizePolicyInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return ;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePolicyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSourceMutationFanIn(value: ChildThreadPolicy["sourceMutationFanIn"]): "manual" | undefined {
  return value === "manual" ? "manual" : undefined;
}

interface DelegationLineagePolicy {
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
}

function writeDelegationLineagePolicy(input: {
  policy: ChildThreadPolicy;
  lineage: DelegationLineagePolicy;
}): Record<string, unknown> {
  const policy = input.policy as Record<string, unknown>;
  if (Object.keys(input.lineage).length === 0) {
    return policy;
  }
  return {
    ...policy,
    lineage: input.lineage,
  };
}

function readInputLineage(input: {
  taskId?: string | undefined;
  parentTaskId?: string | undefined;
  delegationDepth?: number | undefined;
  rootDelegationId?: string | undefined;
}): DelegationLineagePolicy {
  return {
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
    ...(input.delegationDepth !== undefined ? { delegationDepth: input.delegationDepth } : {}),
    ...(input.rootDelegationId !== undefined ? { rootDelegationId: input.rootDelegationId } : {}),
  };
}

function readRecordLineage(record: DelegationRecord): DelegationLineagePolicy {
  const policyLineage = asRecord(asRecord(record.policy)?.lineage);
  return {
    ...(record.taskId !== undefined
      ? { taskId: record.taskId }
      : typeof policyLineage?.taskId === "string"
        ? { taskId: policyLineage.taskId }
        : {}),
    ...(record.parentTaskId !== undefined
      ? { parentTaskId: record.parentTaskId }
      : typeof policyLineage?.parentTaskId === "string"
        ? { parentTaskId: policyLineage.parentTaskId }
        : {}),
    ...(record.delegationDepth !== undefined
      ? { delegationDepth: record.delegationDepth }
      : typeof policyLineage?.delegationDepth === "number"
        ? { delegationDepth: policyLineage.delegationDepth }
        : {}),
    ...(record.rootDelegationId !== undefined
      ? { rootDelegationId: record.rootDelegationId }
      : typeof policyLineage?.rootDelegationId === "string"
        ? { rootDelegationId: policyLineage.rootDelegationId }
        : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function buildChildTitle(title: string): string {
  const compact = title.trim();
  return compact.length > 0 ? `task:${compact.slice(0, 48)}` : "task:background";
}

function readFirstOutputError(output: NormalizedOutput): { code: string; message: string } | undefined {
  const first = output.errors[0];
  return first === undefined
    ? undefined
    : {
        code: first.code,
        message: first.message,
      };
}

function summarizeResultText(value: string): string {
  return value.slice(0, RESULT_SUMMARY_LIMIT);
}
