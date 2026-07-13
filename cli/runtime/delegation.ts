import { randomUUID } from "node:crypto";

import type { SessionStore } from "../../src/kestrel/contracts/store.js";

import type { TuiProfile } from "../contracts.js";
import type {
  DelegationServicePort,
  DelegationTaskResult,
  DelegationTaskSnapshot,
  DelegationTaskSpawnRequest,
} from "../../tools/contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { readActiveWaitState } from "../../src/runtime/waitState.js";
import { normalizeSubAgentResultEnvelope } from "../../src/orchestration/subAgentResult.js";
import { getSkillPackById } from "./skillPacks.js";

export interface DelegationTaskUpdate {
  task: DelegationTaskSnapshot;
  kind: "spawned" | "waiting" | "completed" | "failed";
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
}

export interface RuntimeDelegationServiceOptions {
  profile: TuiProfile;
  store: SessionStore;
  runChildTurn: (input: {
    sessionId: string;
    message: string;
    skillPackId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<void>;
  onTaskUpdate?: ((update: DelegationTaskUpdate) => void) | undefined;
}

interface StoredTaskRecord {
  task: DelegationTaskSnapshot;
  finalizedPayload?: unknown | undefined;
}

const DEFAULT_DELEGATION_MAX_DEPTH = 2;

export class RuntimeDelegationService implements DelegationServicePort {
  private readonly profile: TuiProfile;
  private readonly store: SessionStore;
  private readonly runChildTurn: RuntimeDelegationServiceOptions["runChildTurn"];
  private readonly onTaskUpdate: RuntimeDelegationServiceOptions["onTaskUpdate"];
  private readonly tasks = new Map<string, StoredTaskRecord>();

  constructor(options: RuntimeDelegationServiceOptions) {
    this.profile = options.profile;
    this.store = options.store;
    this.runChildTurn = options.runChildTurn;
    this.onTaskUpdate = options.onTaskUpdate;
  }

  async spawnTask(input: DelegationTaskSpawnRequest): Promise<DelegationTaskSnapshot> {
    this.assertProfileCompatibility(input);
    const parentDepth = normalizePolicyInteger(input.delegationDepth);
    const childDepth = parentDepth !== undefined ? parentDepth + 1 : 1;
    const maxDepth = normalizePolicyInteger(this.profile.delegation?.maxDepth) ?? DEFAULT_DELEGATION_MAX_DEPTH;
    assertDelegationDepth({ depth: childDepth, maxDepth });
    this.assertDelegationCapacity(input.parentSessionId);

    const now = new Date().toISOString();
    const taskId = `task-${randomUUID()}`;
    const childSessionName = buildChildSessionName(input.title);
    const childSessionId = `${this.profile.sessionPrefix}-${slugify(childSessionName)}-${Date.now()}`;
    const task: DelegationTaskSnapshot = {
      taskId,
      parentSessionId: input.parentSessionId,
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      ...(input.taskId !== undefined ? { sourceTaskId: input.taskId } : {}),
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      delegationDepth: childDepth,
      rootDelegationId: normalizePolicyString(input.rootDelegationId) ?? taskId,
      title: input.title.trim(),
      status: "PENDING",
      childSessionId,
      childSessionName,
      profileId: input.profileId ?? this.profile.id,
      provider: input.provider ?? this.profile.modelProvider ?? "openrouter",
      model: input.model ?? this.profile.model ?? "(env default)",
      ...(input.skillPackId !== undefined ? { skillPackId: input.skillPackId } : {}),
      ...(input.launchedBy !== undefined ? { launchedBy: input.launchedBy } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.tasks.set(taskId, { task });
    await this.bootstrapChildSession(task, input);
    await this.appendDelegationEvent("delegation.requested", task, input.parentRunId, {
      title: task.title,
      childSessionId,
      launchedBy: input.launchedBy ?? "agent",
    });
    await this.appendDelegationEvent("delegation.spawned", task, input.parentRunId, {
      childSessionId,
      childSessionName,
      provider: task.provider,
      model: task.model,
    });
    this.emitUpdate({
      task: {
        ...task,
        status: "RUNNING",
        updatedAt: new Date().toISOString(),
      },
      kind: "spawned",
      assistantText: null,
    });

    void this.executeTask({
      ...input,
      title: task.title,
      prompt: input.prompt,
    }, taskId);

    return this.tasks.get(taskId)?.task ?? task;
  }

  async listTasks(parentSessionId: string): Promise<DelegationTaskSnapshot[]> {
    return [...this.tasks.values()]
      .map((entry) => entry.task)
      .filter((task) => task.parentSessionId === parentSessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((task) => ({ ...task }));
  }

  async getTaskResult(taskId: string): Promise<DelegationTaskResult | null> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      return null;
    }
    return {
      task: { ...entry.task },
      ...(entry.finalizedPayload !== undefined ? { finalizedPayload: entry.finalizedPayload } : {}),
    };
  }

  private async executeTask(input: DelegationTaskSpawnRequest, taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId);
    if (entry === undefined) {
      return;
    }
    try {
      await this.runChildTurn({
        sessionId: entry.task.childSessionId,
        message: input.prompt,
        ...(input.skillPackId !== undefined ? { skillPackId: input.skillPackId } : {}),
        metadata: buildChildTurnMetadata(entry.task),
      });
      const session = await this.store.getSession(entry.task.childSessionId);
      const react = asRecord(session?.state.agent);
      const finalOutput = react?.finalOutput;
      const waitEventType = readActiveWaitState(react)?.eventType;

      if (waitEventType !== undefined) {
        const result = {
          status: "blocked" as const,
          result: `Waiting for ${waitEventType}.`,
          error: {
            code: waitEventType,
            message: `Child agent is waiting for ${waitEventType}.`,
          },
        };
        const waitingTask = this.patchTask(taskId, {
          status: "WAITING",
          waitEventType,
          result,
          resultSummary: result.result,
          errorCode: result.error.code,
          errorMessage: result.error.message,
          updatedAt: new Date().toISOString(),
        });
        await this.appendDelegationEvent("delegation.waiting", waitingTask, input.parentRunId, {
          childSessionId: waitingTask.childSessionId,
          waitEventType,
        });
        this.emitUpdate({
          task: waitingTask,
          kind: "waiting",
          assistantText: null,
        });
        return;
      }

      const assistantText = readAssistantText(react?.assistantText);
      const result = normalizeSubAgentResultEnvelope(finalOutput, "completed");
      const completedTask = this.patchTask(taskId, {
        status: "COMPLETED",
        waitEventType: undefined,
        result,
        resultSummary: assistantText ?? summarizeResult(result.result),
        ...(result.error?.code !== undefined ? { errorCode: result.error.code } : {}),
        ...(result.error?.message !== undefined ? { errorMessage: result.error.message } : {}),
        ...(result.references !== undefined ? { references: result.references } : {}),
        updatedAt: new Date().toISOString(),
      });
      this.tasks.set(taskId, {
        task: completedTask,
        finalizedPayload: finalOutput,
      });
      await this.appendDelegationEvent("delegation.completed", completedTask, input.parentRunId, {
        childSessionId: completedTask.childSessionId,
        resultSummary: completedTask.resultSummary,
      });
      this.emitUpdate({
        task: completedTask,
        kind: "completed",
        assistantText,
        finalizedPayload: finalOutput,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const result = {
        status: "failed" as const,
        result: errorMessage,
        error: {
          code: "delegation.runtime_failed",
          message: errorMessage,
        },
      };
      const failedTask = this.patchTask(taskId, {
        status: "FAILED",
        result,
        resultSummary: errorMessage,
        errorCode: result.error.code,
        errorMessage,
        updatedAt: new Date().toISOString(),
      });
      await this.appendDelegationEvent("delegation.failed", failedTask, input.parentRunId, {
        childSessionId: failedTask.childSessionId,
        errorMessage: failedTask.errorMessage,
      });
      this.emitUpdate({
        task: failedTask,
        kind: "failed",
        assistantText: null,
      });
    }
  }

  private emitUpdate(update: DelegationTaskUpdate): void {
    this.tasks.set(update.task.taskId, {
      task: update.task,
      ...(update.finalizedPayload !== undefined ? { finalizedPayload: update.finalizedPayload } : {}),
    });
    this.onTaskUpdate?.(update);
  }

  private patchTask(taskId: string, patch: Partial<DelegationTaskSnapshot>): DelegationTaskSnapshot {
    const current = this.tasks.get(taskId);
    if (current === undefined) {
      throw new Error(`Unknown delegation task '${taskId}'`);
    }
    return {
      ...current.task,
      ...patch,
    };
  }

  private async bootstrapChildSession(
    task: DelegationTaskSnapshot,
    input: DelegationTaskSpawnRequest,
  ): Promise<void> {
    const ensured = await this.store.ensureSession(task.childSessionId);
    const childSession = await this.store.getSession(task.childSessionId);
    if (childSession === null) {
      return;
    }
    await this.store.commitStep({
      runId: `delegation-bootstrap:${task.taskId}`,
      event: {
        id: `${task.taskId}:bootstrap`,
        type: "system.meta_reasoning",
        sessionId: task.childSessionId,
        payload: {
          reason: "delegation.bootstrap",
        },
      },
      sessionId: task.childSessionId,
      expectedVersion: childSession.version,
      nextStepAgent: ensured.currentStepAgent,
      statePatch: {
        agent: {
          ...(asRecord(childSession.state.agent) ?? {}),
          delegation: {
            taskId: task.taskId,
            parentSessionId: task.parentSessionId,
            ...(task.parentRunId !== undefined ? { parentRunId: task.parentRunId } : {}),
            lineage: {
              ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
              ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
              ...(task.delegationDepth !== undefined ? { delegationDepth: task.delegationDepth } : {}),
              ...(task.rootDelegationId !== undefined ? { rootDelegationId: task.rootDelegationId } : {}),
            },
            title: task.title,
            launchedBy: input.launchedBy ?? "agent",
            profileId: task.profileId,
          },
        },
      },
      effects: [],
      emitEvents: [],
      stepIndex: 0,
    });
  }

  private async appendDelegationEvent(
    type:
      | "delegation.requested"
      | "delegation.spawned"
      | "delegation.waiting"
      | "delegation.completed"
      | "delegation.failed",
    task: DelegationTaskSnapshot,
    runId: string | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (runId === undefined) {
      return;
    }
    await this.store.appendRunEvent({
      runId,
      sessionId: task.parentSessionId,
      type,
      level: type === "delegation.failed" ? "WARN" : "INFO",
      timestamp: new Date().toISOString(),
      metadata: {
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        ...metadata,
      },
    });
  }

  private assertProfileCompatibility(input: DelegationTaskSpawnRequest): void {
    if (input.profileId !== undefined && input.profileId !== this.profile.id) {
      throw new Error(`Delegation from the agent currently supports only the active profile '${this.profile.id}'.`);
    }
    if (input.provider !== undefined && input.provider !== (this.profile.modelProvider ?? "openrouter")) {
      throw new Error(`Delegation from the agent currently supports only provider '${this.profile.modelProvider ?? "openrouter"}'.`);
    }
    if (input.model !== undefined && this.profile.model !== undefined && input.model !== this.profile.model) {
      throw new Error(`Delegation from the agent currently supports only model '${this.profile.model}'.`);
    }
    if (input.skillPackId !== undefined && getSkillPackById(input.skillPackId) === undefined) {
      throw new Error(`Unknown skill pack '${input.skillPackId}'.`);
    }
  }

  private assertDelegationCapacity(parentSessionId: string): void {
    const active = [...this.tasks.values()].filter((entry) => {
      return (
        entry.task.parentSessionId === parentSessionId &&
        (entry.task.status === "PENDING" ||
          entry.task.status === "RUNNING" ||
          entry.task.status === "WAITING")
      );
    });
    const maxConcurrent = this.profile.delegation?.maxConcurrentChildSessions ?? 2;
    if (active.length >= maxConcurrent) {
      throw new Error(`Delegation limit reached (${maxConcurrent} active child sessions).`);
    }
  }
}

function readAssistantText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeResult(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 240);
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

function buildChildSessionName(title: string): string {
  const compact = title.trim();
  return compact.length > 0 ? `task:${compact.slice(0, 48)}` : "task:background";
}

function buildChildTurnMetadata(task: DelegationTaskSnapshot): Record<string, unknown> {
  const activeTaskId = task.sourceTaskId ?? task.parentTaskId;
  return {
    delegationId: task.taskId,
    ...(activeTaskId !== undefined ? { activeTaskId, taskId: activeTaskId } : {}),
    ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
    delegationDepth: task.delegationDepth ?? 1,
    rootDelegationId: task.rootDelegationId ?? task.taskId,
  };
}

function assertDelegationDepth(input: { depth: number; maxDepth: number }): void {
  if (input.depth <= input.maxDepth) {
    return;
  }
  throw createRuntimeFailure(
    "DELEGATION_DEPTH_LIMIT_REACHED",
    `Delegation depth limit reached (${input.depth}/${input.maxDepth}).`,
    {
      depth: input.depth,
      maxDepth: input.maxDepth,
      classification: "policy",
      recoverable: true,
    },
  );
}

function normalizePolicyInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizePolicyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function slugify(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return compact.length > 0 ? compact : "task";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
