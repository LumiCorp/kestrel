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
  DialogListResult,
  DialogOpenResult,
  DialogReadResult,
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
  parentRunId?: string | undefined;
  name: string;
  childSessionId: string;
  sender: "kestrel" | "collaborator" | "system";
  text: string;
  createdAt: string;
  dialogStatus: "open" | "closed";
  /** The saved lifecycle activity when this message was recorded. */
  dialogActivity?: DialogSnapshot["activity"] | undefined;
  status?: "failed" | "cancelled" | undefined;
  delivery?: "pending" | "enqueued" | "delivered" | undefined;
}

export interface DelegationSupervisorOptions {
  profile: TuiProfile;
  runtimeStore: ThreadStore & EventStore;
  orchestrationStore: OrchestrationStore;
  submitChildTurn: (input: SubmitTurnInput) => Promise<SubmitTurnResult>;
  startChildThread: (input: {
    threadId?: string | undefined;
    title: string;
    parentThreadId: string;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<ThreadRecord>;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
  onDelegationUpdated?: ((input: {
    record: DelegationRecord;
    finalizedPayload?: unknown | undefined;
  }) => Promise<void> | void) | undefined;
  onDialogReply?: ((input: {
    record: DelegationRecord;
    message: DialogMessageRecord;
    dialogStatus: "open" | "closed";
    activity: DialogSnapshot["activity"];
  }) => Promise<void> | void) | undefined;
  onHandoffCompleted?: ((input: {
    runId: string;
    sessionId: string;
    threadId: string;
    stepIndex: number;
    specialistId: string;
    objective: string;
    result: unknown;
  }) => Promise<void>) | undefined;
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
  private readonly onHandoffCompleted: DelegationSupervisorOptions["onHandoffCompleted"];
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
    this.onHandoffCompleted = options.onHandoffCompleted;
  }

  async open(input: { parentSessionId: string; parentRunId?: string | undefined; name: string; message: string }): Promise<DialogOpenResult> {
    const name = normalizeDialogName(input.name);
    const existing = await this.store.listDelegations({ parentThreadId: input.parentSessionId });
    const existingDialog = findDialogByNormalizedName(existing, name);
    if (existingDialog !== undefined) {
      const recovered = await this.ensureDialogChildThread(existingDialog);
      if (recovered.started) void this.runDelegation(recovered.record);
      return { ...toDialogSnapshot(recovered.record), created: false };
    }
    try {
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
          dialog: createStoredDialogState({
            name,
            activity: "working",
            profileId: this.profile.id,
          }),
        },
      });
      const record = await this.requireDialog(handle.delegationId, input.parentSessionId);
      return { ...toDialogSnapshot(record), created: true };
    } catch (error) {
      const code = asRuntimeError(error).code;
      if (code !== "DIALOG_NAME_IN_USE" && code !== "DELEGATION_LIMIT_REACHED") throw error;
      const reserved = findDialogByNormalizedName(
        await this.store.listDelegations({ parentThreadId: input.parentSessionId }),
        name,
      );
      if (reserved === undefined) throw error;
      return { ...toDialogSnapshot(reserved), created: false };
    }
  }

  async send(input: { parentSessionId: string; parentRunId?: string | undefined; dialogId: string; message: string }): Promise<DialogSnapshot> {
    const record = await this.requireDialog(input.dialogId, input.parentSessionId);
    const dialog = readDialogState(record)!;
    if (dialog.status !== "open") throw dialogClosedFailure(dialog.name, input.dialogId);
    if (dialog.activity === "working") throw dialogBusyFailure(dialog.name, input.dialogId);
    const activeRecord = {
      ...record,
      prompt: input.message,
      status: "RUNNING" as const,
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      updatedAt: new Date().toISOString(),
    };
    const workingRecord = writeDialogState(
      activeRecord,
      { ...dialog, activity: "working", revision: dialog.revision + 1 },
    );
    const updated = appendDialogMessage(
      workingRecord,
      createDialogMessage(workingRecord, "kestrel", input.message),
    );
    if (!await this.store.compareAndSetDialog(updated, dialog.revision)) {
      const latest = await this.requireDialog(input.dialogId, input.parentSessionId);
      const latestDialog = readDialogState(latest)!;
      if (latestDialog.status !== "open") throw dialogClosedFailure(latestDialog.name, input.dialogId);
      throw dialogBusyFailure(latestDialog.name, input.dialogId);
    }
    const message = lastDialogMessage(updated)!;
    await this.appendDialogEvent("dialog.message", updated, message);
    this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "spawned", assistantText: null, dialogMessage: message });
    void this.runDelegation(updated);
    return toDialogSnapshot(updated);
  }

  async read(input: {
    parentSessionId: string;
    dialogId: string;
    afterCursor?: string | undefined;
    beforeCursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<DialogReadResult> {
    const record = await this.requireDialog(input.dialogId, input.parentSessionId);
    const dialog = readDialogState(record)!;
    const limit = normalizeDialogPageLimit(input.limit, 20);
    const messages = dialog.messages;
    if (input.afterCursor !== undefined && input.beforeCursor !== undefined) {
      throw createRuntimeFailure("TOOL_INPUT_INVALID", "Use either afterCursor or beforeCursor, not both.");
    }
    if (input.afterCursor === undefined && input.beforeCursor === undefined) {
      const start = Math.max(0, messages.length - limit);
      const page = messages.slice(start);
      return {
        ...toDialogSnapshot(record),
        messages: page.map(toDialogReadMessage),
        ...(page.at(-1) === undefined ? {} : { nextCursor: createDialogMessageCursor(record, page.at(-1)!) }),
        ...(start === 0 || page[0] === undefined ? {} : { previousCursor: createDialogMessageCursor(record, page[0]) }),
        hasEarlier: start > 0,
        hasMore: false,
      };
    }
    const cursorValue = input.afterCursor ?? input.beforeCursor!;
    const cursor = parseDialogCursor(cursorValue, input.parentSessionId, input.dialogId);
    const index = messages.findIndex((message) => message.messageId === cursor.messageId);
    if (index < 0) throw dialogCursorFailure();
    if (input.beforeCursor !== undefined) {
      const end = index;
      const start = Math.max(0, end - limit);
      const page = messages.slice(start, end);
      return {
        ...toDialogSnapshot(record),
        messages: page.map(toDialogReadMessage),
        ...(page.at(-1) === undefined ? {} : { nextCursor: createDialogMessageCursor(record, page.at(-1)!) }),
        ...(start === 0 || page[0] === undefined ? {} : { previousCursor: createDialogMessageCursor(record, page[0]) }),
        hasEarlier: start > 0,
        hasMore: end < messages.length,
      };
    }
    const available = messages.slice(index + 1);
    const page = available.slice(0, limit);
    return {
      ...toDialogSnapshot(record),
      messages: page.map(toDialogReadMessage),
      nextCursor: page.length > 0 ? createDialogMessageCursor(record, page.at(-1)!) : input.afterCursor,
      ...(page[0] === undefined ? {} : { previousCursor: createDialogMessageCursor(record, page[0]) }),
      hasEarlier: page.length > 0 || index > 0,
      hasMore: available.length > page.length,
    };
  }

  async list(input: {
    parentSessionId: string;
    status?: "open" | "closed" | "all" | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<DialogListResult> {
    const status = input.status ?? "all";
    const limit = normalizeDialogPageLimit(input.limit, 50);
    const cursor = input.cursor === undefined ? undefined : parseDialogListCursor(input.cursor, input.parentSessionId, status);
    const records = (await this.store.listDelegations({ parentThreadId: input.parentSessionId }))
      .filter((record) => {
        const dialog = readDialogState(record);
        return dialog !== undefined && (status === "all" || dialog.status === status);
      })
      .filter((record) => cursor === undefined || record.updatedAt < cursor.updatedAt || (record.updatedAt === cursor.updatedAt && record.delegationId < cursor.dialogId));
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      dialogs: page.map(toDialogSnapshot),
      ...(last === undefined ? {} : { nextCursor: createDialogListCursor(input.parentSessionId, status, last) }),
      hasMore: records.length > page.length,
    };
  }

  /** Replays saved collaborator replies that have not been acknowledged by the parent. */
  async reconcileSavedDialogReplies(parentSessionId: string): Promise<void> {
    const records = await this.store.listDelegations({ parentThreadId: parentSessionId });
    const replies: Array<{ record: DelegationRecord; message: DialogMessageRecord; dialog: StoredDialogState }> = [];
    for (const record of records) {
      const dialog = readDialogState(record);
      if (dialog === undefined) continue;
      for (const message of dialog.messages) {
        if (message.sender !== "collaborator" || message.delivery === "delivered") continue;
        replies.push({ record, message, dialog });
      }
    }
    replies.sort((left, right) => left.message.createdAt.localeCompare(right.message.createdAt) || left.message.messageId.localeCompare(right.message.messageId));
    for (const { record, message, dialog } of replies) {
      await this.onDialogReply?.({ record, message, dialogStatus: dialog.status, activity: dialog.activity });
    }
  }

  async markDialogReplyEnqueued(input: { parentSessionId: string; dialogId: string; messageId: string }): Promise<void> {
    await this.updateDialogReplyDelivery(input, "enqueued");
  }

  async markDialogReplyDelivered(input: { parentSessionId: string; dialogId: string; messageId: string }): Promise<void> {
    await this.updateDialogReplyDelivery(input, "delivered");
  }

  async isDialogReplyDelivered(input: { parentSessionId: string; dialogId: string; messageId: string }): Promise<boolean> {
    const record = await this.requireDialog(input.dialogId, input.parentSessionId);
    const message = readDialogState(record)?.messages.find((candidate) => candidate.messageId === input.messageId);
    return message?.delivery === "delivered";
  }

  private async updateDialogReplyDelivery(
    input: { parentSessionId: string; dialogId: string; messageId: string },
    delivery: "enqueued" | "delivered",
  ): Promise<void> {
    for (;;) {
      const record = await this.requireDialog(input.dialogId, input.parentSessionId);
      const dialog = readDialogState(record)!;
      const index = dialog.messages.findIndex((message) => message.messageId === input.messageId && message.sender === "collaborator");
      if (index < 0) {
        throw createRuntimeFailure("DIALOG_REPLY_NOT_FOUND", "This collaborator reply is no longer available.", { dialogId: input.dialogId, messageId: input.messageId });
      }
      const current = dialog.messages[index]!;
      if (current.delivery === "delivered" || current.delivery === delivery) return;
      const messages = [...dialog.messages];
      messages[index] = { ...current, delivery };
      const updated = writeDialogState(
        { ...record, updatedAt: new Date().toISOString() },
        { ...dialog, revision: dialog.revision + 1, messages },
      );
      if (await this.store.compareAndSetDialog(updated, dialog.revision)) return;
    }
  }

  async close(input: { parentSessionId: string; parentRunId?: string | undefined; dialogId: string }): Promise<DialogSnapshot> {
    for (;;) {
      const record = await this.requireDialog(input.dialogId, input.parentSessionId);
      const dialog = readDialogState(record)!;
      if (dialog.status === "closed") return toDialogSnapshot(record);
      const closedAt = new Date().toISOString();
      const closedRecord = writeDialogState(
        { ...record, status: "CANCELLED", ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}), updatedAt: closedAt },
        { ...dialog, status: "closed", activity: "idle", closedAt, revision: dialog.revision + 1 },
      );
      const closeMessage = { ...createDialogMessage(closedRecord, "system", "Dialog closed."), status: "cancelled" as const };
      const persisted = appendDialogMessage(closedRecord, closeMessage);
      if (!await this.store.compareAndSetDialog(persisted, dialog.revision)) continue;
      this.activeDialogRuns.get(record.delegationId)?.abort(new Error("Dialog closed."));
      await this.appendDialogEvent("dialog.closed", persisted, closeMessage);
      this.emit({ task: toTaskSnapshot(persisted, this.profile), kind: "completed", assistantText: null, dialogMessage: closeMessage });
      return toDialogSnapshot(persisted);
    }
  }

  cancelActiveDialogs(parentSessionId: string): void {
    for (const [dialogId, controller] of this.activeDialogRuns) {
      void this.store.getDelegation(dialogId).then((record) => {
        if (record?.parentThreadId === parentSessionId) controller.abort(new Error("Kestrel run stopped."));
      });
    }
  }

  /** Records work that disappeared with a runtime restart without replaying it. */
  async reconcileInterruptedDialogs(parentSessionId: string): Promise<void> {
    const records = await this.store.listDelegations({ parentThreadId: parentSessionId });
    for (const record of records) {
      const dialog = readDialogState(record);
      if (dialog === undefined || dialog.status !== "open" || dialog.activity !== "working") continue;
      const updated = writeDialogState(
        { ...record, status: "WAITING", errorMessage: "Collaborator work was interrupted by restart.", updatedAt: new Date().toISOString() },
        { ...dialog, activity: "interrupted", revision: dialog.revision + 1 },
      );
      await this.store.compareAndSetDialog(updated, dialog.revision);
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

    const dialogChildThreadId = input.policy?.dialog === undefined ? undefined : `thread-${randomUUID()}`;
    const childThread = dialogChildThreadId === undefined
      ? await this.startChildThread({
          title: buildChildTitle(input.title),
          parentThreadId: input.parentThreadId,
          metadata: { delegationPrompt: input.prompt },
        })
      : { threadId: dialogChildThreadId };
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
      ...(input.profileId !== undefined || input.policy?.dialog !== undefined
        ? { profileId: input.profileId ?? this.profile.id }
        : {}),
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
    if (dialog !== undefined) {
      const created = await this.store.createDialog(record);
      if (!created) {
        throw createRuntimeFailure(
          "DIALOG_NAME_IN_USE",
          `A collaborator named '${dialog.name}' already exists in this task. Use dialog.list to find it. Names cannot be reused after close.`,
          { dialogName: dialog.name },
        );
      }
    } else {
      await this.store.upsertDelegation(record);
    }
    if (dialog !== undefined) {
      record = (await this.ensureDialogChildThread(record)).record;
    }
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
      if (
        completed.status === "COMPLETED" &&
        completed.profileId !== undefined
      ) {
        await this.onHandoffCompleted?.({
          runId: result.output.runId,
          sessionId: result.output.sessionId,
          threadId: completed.parentThreadId,
          stepIndex: result.output.telemetry.stepsExecuted,
          specialistId: completed.profileId,
          objective: completed.prompt,
          result: resultEnvelope,
        });
      }
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

  private async ensureDialogChildThread(record: DelegationRecord): Promise<{
    record: DelegationRecord;
    started: boolean;
  }> {
    const dialog = readDialogState(record);
    if (dialog === undefined || dialog.status === "closed" || dialog.childThreadStarted !== false) {
      return { record, started: false };
    }
    try {
      await this.startChildThread({
        threadId: record.childThreadId,
        title: buildChildTitle(record.title),
        parentThreadId: record.parentThreadId,
        metadata: { delegationPrompt: record.prompt },
      });
    } catch (error) {
      await this.recordDialogChildThreadFailure(record, error);
      throw error;
    }

    const started = writeDialogState(
      { ...record, status: "RUNNING", errorMessage: undefined, updatedAt: new Date().toISOString() },
      { ...dialog, activity: "working", childThreadStarted: true, revision: dialog.revision + 1 },
    );
    if (await this.store.compareAndSetDialog(started, dialog.revision)) {
      return { record: started, started: true };
    }
    return { record: await this.requireDialog(record.delegationId, record.parentThreadId), started: false };
  }

  private async recordDialogChildThreadFailure(record: DelegationRecord, error: unknown): Promise<void> {
    const latest = await this.store.getDelegation(record.delegationId);
    const current = latest ?? record;
    const dialog = readDialogState(current);
    if (dialog === undefined || dialog.status === "closed" || dialog.childThreadStarted !== false) return;
    const runtimeError = asRuntimeError(error);
    const failedRecord = writeDialogState(
      { ...current, status: "WAITING", errorMessage: runtimeError.message, updatedAt: new Date().toISOString() },
      { ...dialog, activity: "interrupted", revision: dialog.revision + 1 },
    );
    const failure = {
      ...createDialogMessage(failedRecord, "system", `Could not start ${dialog.name}. Opening this collaborator again will retry.`),
      status: "failed" as const,
    };
    const updated = appendDialogMessage(failedRecord, failure);
    if (!await this.store.compareAndSetDialog(updated, dialog.revision)) return;
    await this.appendDialogEvent("dialog.execution_failed", updated, failure);
    this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "failed", assistantText: null, dialogMessage: failure });
    await this.onDelegationUpdated?.({ record: updated });
  }

  private async runDialogTurn(record: DelegationRecord): Promise<void> {
    const startingDialog = readDialogState(record);
    if (startingDialog === undefined || startingDialog.status !== "open") return;
    const expectedRevision = startingDialog.revision;
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
        const idleRecord = writeDialogState(
            { ...record, status: "WAITING", childRunId: result.output.runId, waitEventType: undefined, resultSummary: text, updatedAt: new Date().toISOString() },
            { ...startingDialog, activity: "idle", revision: expectedRevision + 1 },
        );
        const reply = createDialogMessage(idleRecord, "collaborator", text);
        const updated = appendDialogMessage(
          idleRecord,
          reply,
        );
        if (!await this.store.compareAndSetDialog(updated, expectedRevision)) return;
        await this.appendDialogEvent("dialog.message", updated, reply);
        this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "waiting", assistantText: null, dialogMessage: reply });
        const savedDialog = readDialogState(updated)!;
        await this.onDialogReply?.({
          record: updated,
          message: reply,
          dialogStatus: savedDialog.status,
          activity: savedDialog.activity,
        });
        return;
      }
      const failureText = result.output.status === "WAITING"
        ? `Waiting for ${result.output.waitFor?.eventType ?? "a response"}.`
        : result.output.errors[0]?.message ?? "The collaborator did not return a message.";
      const failedRecord = writeDialogState(
          { ...record, status: "WAITING", childRunId: result.output.runId, waitEventType: result.output.waitFor?.eventType, errorMessage: failureText, updatedAt: new Date().toISOString() },
          { ...startingDialog, activity: result.output.status === "WAITING" ? "waiting" : "idle", revision: expectedRevision + 1 },
      );
      const failure = { ...createDialogMessage(failedRecord, "system", failureText), status: "failed" as const };
      const updated = appendDialogMessage(
        failedRecord,
        failure,
      );
      if (!await this.store.compareAndSetDialog(updated, expectedRevision)) return;
      await this.appendDialogEvent("dialog.execution_failed", updated, failure);
      this.emit({ task: toTaskSnapshot(updated, this.profile), kind: "failed", assistantText: null, dialogMessage: failure });
    } catch (error) {
      const latest = await this.store.getDelegation(record.delegationId);
      if (readDialogState(latest ?? record)?.status === "closed") return;
      const runtimeError = asRuntimeError(error);
      const cancelled = controller.signal.aborted;
      const failedRecord = writeDialogState(
          { ...record, status: "WAITING", errorMessage: runtimeError.message, updatedAt: new Date().toISOString() },
          { ...startingDialog, activity: cancelled ? "interrupted" : "idle", revision: expectedRevision + 1 },
      );
      const failure = { ...createDialogMessage(failedRecord, "system", cancelled ? "Collaborator work stopped; the dialog remains open." : runtimeError.message), status: cancelled ? "cancelled" as const : "failed" as const };
      const updated = appendDialogMessage(
        failedRecord,
        failure,
      );
      if (!await this.store.compareAndSetDialog(updated, expectedRevision)) return;
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
        ...(record.childRunId !== undefined ? { childRunId: record.childRunId } : {}),
        provider: record.provider,
        model: record.model,
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

interface StoredDialogState extends Record<string, unknown> {
  version: "v1";
  name: string;
  normalizedName: string;
  status: "open" | "closed";
  activity: "idle" | "working" | "waiting" | "interrupted";
  revision: number;
  /** False only while a newly reserved dialog still needs its child Thread. */
  childThreadStarted?: boolean | undefined;
  closedAt?: string | undefined;
  profileId?: string | undefined;
  capabilityCeiling?: {
    allowedToolClasses: string[];
    allowedCapabilities: string[];
  } | undefined;
  messages: DialogMessageRecord[];
}

function normalizeDialogName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 40) {
    throw createRuntimeFailure("DIALOG_NAME_INVALID", "A collaborator name must contain 1 to 40 characters. Choose a short, memorable name.", { name });
  }
  if (name.toLocaleLowerCase() === "kestrel") {
    throw createRuntimeFailure("DIALOG_NAME_RESERVED", "'Kestrel' is the name of the primary participant. Choose another collaborator name.", { name });
  }
  return name;
}

function normalizeDialogMessage(value: unknown): DialogMessageRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  if (
    typeof item.messageId !== "string" ||
    typeof item.dialogId !== "string" ||
    typeof item.name !== "string" ||
    typeof item.childSessionId !== "string" ||
    (item.sender !== "kestrel" && item.sender !== "collaborator" && item.sender !== "system") ||
    typeof item.text !== "string" ||
    typeof item.createdAt !== "string" ||
    (item.dialogStatus !== "open" && item.dialogStatus !== "closed")
  ) return [];
  const delivery = item.delivery === "pending" || item.delivery === "enqueued" || item.delivery === "delivered"
    ? item.delivery
    : item.sender === "collaborator" ? "pending" : undefined;
  return [{
    messageId: item.messageId,
    dialogId: item.dialogId,
    ...(typeof item.parentRunId === "string" ? { parentRunId: item.parentRunId } : {}),
    name: item.name,
    childSessionId: item.childSessionId,
    sender: item.sender,
    text: item.text,
    createdAt: item.createdAt,
    dialogStatus: item.dialogStatus,
    ...(item.dialogActivity === "idle" || item.dialogActivity === "working" || item.dialogActivity === "waiting" || item.dialogActivity === "interrupted" ? { dialogActivity: item.dialogActivity } : {}),
    ...(item.status === "failed" || item.status === "cancelled" ? { status: item.status } : {}),
    ...(delivery !== undefined ? { delivery } : {}),
  }];
}

function readDialogState(record: DelegationRecord): StoredDialogState | undefined {
  const value = record.policy?.dialog;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const dialog = value as Record<string, unknown>;
  if (dialog.version !== "v1" || typeof dialog.name !== "string") return undefined;
  const messages = Array.isArray(dialog.messages)
    ? dialog.messages.flatMap(normalizeDialogMessage)
    : [];
  const status = dialog.status === "closed" ? "closed" : "open";
  const activity = dialog.activity === "idle" || dialog.activity === "working" || dialog.activity === "waiting" || dialog.activity === "interrupted"
    ? dialog.activity
    : status === "closed" ? "idle" : record.status === "RUNNING" ? "working" : "idle";
  return {
    version: "v1",
    name: dialog.name,
    normalizedName: typeof dialog.normalizedName === "string" && dialog.normalizedName.length > 0
      ? dialog.normalizedName
      : dialog.name.trim().toLocaleLowerCase(),
    status,
    activity,
    revision: typeof dialog.revision === "number" && Number.isInteger(dialog.revision) && dialog.revision >= 0
      ? dialog.revision
      : 0,
    ...(dialog.childThreadStarted === false ? { childThreadStarted: false } : { childThreadStarted: true }),
    ...(typeof dialog.closedAt === "string" ? { closedAt: dialog.closedAt } : {}),
    ...(typeof dialog.profileId === "string" ? { profileId: dialog.profileId } : {}),
    ...(readCapabilityCeiling(dialog.capabilityCeiling) !== undefined ? { capabilityCeiling: readCapabilityCeiling(dialog.capabilityCeiling) } : {}),
    messages,
  };
}

function createStoredDialogState(input: {
  name: string;
  activity: StoredDialogState["activity"];
  profileId: string;
  allowedToolClasses?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
}): StoredDialogState {
  return {
    version: "v1",
    name: input.name,
    normalizedName: input.name.toLocaleLowerCase(),
    status: "open",
    activity: input.activity,
    revision: 0,
    childThreadStarted: false,
    profileId: input.profileId,
    capabilityCeiling: {
      allowedToolClasses: [...(input.allowedToolClasses ?? [])],
      allowedCapabilities: [...(input.allowedCapabilities ?? [])],
    },
    messages: [],
  };
}

function readCapabilityCeiling(value: unknown): StoredDialogState["capabilityCeiling"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ceiling = value as Record<string, unknown>;
  if (!Array.isArray(ceiling.allowedToolClasses) || !Array.isArray(ceiling.allowedCapabilities)) return undefined;
  if (!ceiling.allowedToolClasses.every((item) => typeof item === "string") || !ceiling.allowedCapabilities.every((item) => typeof item === "string")) return undefined;
  return {
    allowedToolClasses: [...ceiling.allowedToolClasses],
    allowedCapabilities: [...ceiling.allowedCapabilities],
  };
}

export function readDialogView(record: DelegationRecord): DialogView | undefined {
  const dialog = readDialogState(record);
  if (dialog === undefined) return undefined;
  return {
    dialogId: record.delegationId,
    name: dialog.name,
    status: dialog.status,
    activity: dialog.activity,
    revision: dialog.revision,
    ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    childThreadId: record.childThreadId,
    messages: dialog.messages,
  };
}

function writeDialogState(record: DelegationRecord, dialog: StoredDialogState): DelegationRecord {
  return { ...record, policy: { ...(record.policy ?? {}), dialog } };
}

function createDialogMessage(record: DelegationRecord, sender: DialogMessageRecord["sender"], text: string): DialogMessageRecord {
  const dialog = readDialogState(record);
  return {
    messageId: `dialog-message-${randomUUID()}`,
    dialogId: record.delegationId,
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    name: dialog?.name ?? record.title,
    childSessionId: record.childThreadId,
    sender,
    text,
    createdAt: new Date().toISOString(),
    dialogStatus: dialog?.status ?? "open",
    ...(dialog !== undefined ? { dialogActivity: dialog.activity } : {}),
    ...(sender === "collaborator" ? { delivery: "pending" as const } : {}),
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

function findDialogByNormalizedName(records: DelegationRecord[], name: string): DelegationRecord | undefined {
  return records.find((record) => readDialogState(record)?.normalizedName === name.toLocaleLowerCase());
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
    activity: dialog.activity,
    active: dialog.status === "open" && dialog.activity === "working",
    ...(lastDialogMessage(record) === undefined ? {} : { cursor: createDialogMessageCursor(record, lastDialogMessage(record)!) }),
    ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDialogReadMessage(message: DialogMessageRecord): DialogReadResult["messages"][number] {
  return {
    messageId: message.messageId,
    sender: message.sender,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.status === undefined ? {} : { status: message.status }),
  };
}

function normalizeDialogPageLimit(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw createRuntimeFailure("TOOL_INPUT_INVALID", "Dialog limits must be whole numbers from 1 through 100.");
  return value;
}

function createDialogMessageCursor(record: DelegationRecord, message: DialogMessageRecord): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "message", parentThreadId: record.parentThreadId, dialogId: record.delegationId, messageId: message.messageId })).toString("base64url");
}

function createDialogListCursor(parentThreadId: string, status: "open" | "closed" | "all", record: DelegationRecord): string {
  return Buffer.from(JSON.stringify({ v: 1, kind: "list", parentThreadId, status, updatedAt: record.updatedAt, dialogId: record.delegationId })).toString("base64url");
}

function parseDialogCursor(value: string, parentThreadId: string, dialogId: string): { messageId: string } {
  const parsed = parseDialogCursorValue(value);
  if (parsed.kind !== "message" || parsed.parentThreadId !== parentThreadId || parsed.dialogId !== dialogId || typeof parsed.messageId !== "string" || parsed.messageId.length === 0) throw dialogCursorFailure();
  return { messageId: parsed.messageId };
}

function parseDialogListCursor(value: string, parentThreadId: string, status: "open" | "closed" | "all"): { updatedAt: string; dialogId: string } {
  const parsed = parseDialogCursorValue(value);
  if (parsed.kind !== "list" || parsed.parentThreadId !== parentThreadId || parsed.status !== status || typeof parsed.updatedAt !== "string" || typeof parsed.dialogId !== "string" || parsed.updatedAt.length === 0 || parsed.dialogId.length === 0) throw dialogCursorFailure();
  return { updatedAt: parsed.updatedAt, dialogId: parsed.dialogId };
}

function parseDialogCursorValue(value: string): Record<string, unknown> {
  if (value.trim().length === 0) throw dialogCursorFailure();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as Record<string, unknown>).v !== 1) throw dialogCursorFailure();
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (asRuntimeError(error).code === "DIALOG_CURSOR_INVALID") throw error;
    throw dialogCursorFailure();
  }
}

function dialogCursorFailure() {
  return createRuntimeFailure("DIALOG_CURSOR_INVALID", "This cursor does not belong to this collaborator or list. Start a new read or list without the cursor.");
}

function dialogBusyFailure(name: string, dialogId: string) {
  return createRuntimeFailure("DIALOG_BUSY", `'${name}' is still working. Wait for the reply or use dialog.read to check the saved status.`, { dialogId });
}

function dialogClosedFailure(name: string, dialogId: string) {
  return createRuntimeFailure("DIALOG_CLOSED", `'${name}' is closed. You can read its history, but you cannot send another message or reopen it.`, { dialogId });
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
