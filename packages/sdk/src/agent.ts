import { KestrelClient } from "./KestrelClient.js";
import type {
  KestrelClientOptions,
  KestrelRequestContext,
  RunnerEventSubscriptionFilter,
  RunnerHistoryEntry,
  RunnerRunTerminalEvent,
  RunnerRunStreamEvent,
  RunnerSessionDescription,
  RunnerStream,
  RunnerStreamEvent,
  RunnerTaskGraph,
  RunnerTurnInput,
} from "./contracts.js";

const DEFAULT_EVENT_TYPE = "user.message";
const SESSION_MEMORY_TASK_ID = "task:sdk:session-memory";

export interface KestrelMemorySnapshot {
  goal: string;
  currentPlan: string;
  findings: string;
  decisions: string;
  openQuestions: string;
  nextAction: string;
  linkedArtifacts: string[];
}

export interface KestrelMemoryUpdate {
  goal?: string | undefined;
  currentPlan?: string | undefined;
  findings?: string | undefined;
  decisions?: string | undefined;
  openQuestions?: string | undefined;
  nextAction?: string | undefined;
  linkedArtifacts?: string[] | undefined;
}

export interface KestrelVersionedMemorySnapshot {
  revision: number;
  value: KestrelMemorySnapshot;
}

export interface KestrelMemoryUpdateRequest {
  expectedRevision: number;
  patch: KestrelMemoryUpdate;
}

export interface KestrelAgentTurnInput extends Omit<
  RunnerTurnInput,
  "eventType" | "resumeBlockedRun" | "resumeRequestId"
> {
  sessionId: string;
  message: string;
  eventType?: string | undefined;
}

export interface KestrelAgentResumeInput extends KestrelAgentTurnInput {
  /** Exact durable interaction request being answered or approved. */
  requestId: string;
}

export interface KestrelAgentDefinition extends KestrelClientOptions {
  id: string;
  profileId: string;
  name?: string | undefined;
  description?: string | undefined;
  defaultEventType?: string | undefined;
}

export interface KestrelAgentSessionState extends RunnerSessionDescription {
  memory: KestrelMemorySnapshot;
  memoryRevision: number;
}

export interface KestrelSessionHandle {
  get(context: KestrelRequestContext): Promise<KestrelAgentSessionState>;
  memory: {
    get(context: KestrelRequestContext): Promise<KestrelVersionedMemorySnapshot>;
    update(update: KestrelMemoryUpdateRequest, context: KestrelRequestContext): Promise<KestrelVersionedMemorySnapshot>;
  };
}

export interface KestrelAgent {
  readonly id: string;
  readonly profileId: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  run(input: KestrelAgentTurnInput, context: KestrelRequestContext): Promise<RunnerRunTerminalEvent>;
  stream(
    input: KestrelAgentTurnInput & {
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext,
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>;
  resume(input: KestrelAgentResumeInput, context: KestrelRequestContext): Promise<RunnerRunTerminalEvent>;
  resumeStream(
    input: KestrelAgentResumeInput & {
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext,
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent>;
  subscribe(
    filter: RunnerEventSubscriptionFilter,
    context: KestrelRequestContext,
    options?: {
      signal?: AbortSignal | undefined;
    },
  ): RunnerStream<import("./contracts.js").RunnerEventEnvelope, void>;
  session(sessionId: string): KestrelSessionHandle;
  close(): Promise<void>;
}

export function createAgent(definition: KestrelAgentDefinition): KestrelAgent {
  const runner = new KestrelClient(definition);
  const defaultEventType = definition.defaultEventType ?? DEFAULT_EVENT_TYPE;

  return {
    id: definition.id,
    profileId: definition.profileId,
    ...(definition.name !== undefined ? { name: definition.name } : {}),
    ...(definition.description !== undefined ? { description: definition.description } : {}),

    async run(input, context) {
      return runner.run(
        {
          profileId: definition.profileId,
          turn: toTurnInput(input, defaultEventType),
        },
        context,
      );
    },

    stream(input, context) {
      return runner.streamRun(
        {
          profileId: definition.profileId,
          turn: toTurnInput(input, defaultEventType),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        context,
      );
    },

    async resume(input, context) {
      return runner.run(
        {
          profileId: definition.profileId,
          turn: toResumeTurnInput(input, defaultEventType),
        },
        context,
      );
    },

    resumeStream(input, context) {
      return runner.streamRun(
        {
          profileId: definition.profileId,
          turn: toResumeTurnInput(input, defaultEventType),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        },
        context,
      );
    },

    subscribe(filter, context, options) {
      return runner.subscribe(filter, context, options);
    },

    session(sessionId) {
      return {
        get: async (context) => {
          const state = await runner.getSessionState(sessionId, context);
          const session = state.session;
          return {
            ...session,
            memory: readMemorySnapshot(state.graph, session.threadId),
            memoryRevision: state.version,
          };
        },
        memory: {
          get: async (context) => {
            const state = await runner.getSessionState(sessionId, context);
            return {
              revision: state.version,
              value: readMemorySnapshot(state.graph, state.session.threadId),
            };
          },
          update: async (update, context) => {
            const state = await runner.getSessionState(sessionId, context);
            const session = state.session;
            const nextGraph = updateMemorySnapshot({
              sessionId,
              threadId: session.threadId,
              graph: state.graph,
              update: update.patch,
            });
            const persisted = await runner.updateTaskGraph(
              {
                sessionId,
                graph: nextGraph,
                expectedVersion: update.expectedRevision,
                ...(typeof session.threadId === "string" ? { threadId: session.threadId } : {}),
              },
              context,
            );
            return {
              revision: persisted.version,
              value: readMemorySnapshot(persisted.graph, session.threadId),
            };
          },
        },
      };
    },

    async close() {
      await runner.close();
    },
  };
}

function toResumeTurnInput(
  input: KestrelAgentResumeInput,
  defaultEventType: string,
): RunnerTurnInput {
  const { requestId, ...turn } = input;
  return {
    ...toTurnInput(turn, defaultEventType),
    resumeBlockedRun: true,
    resumeRequestId: requestId,
  };
}

function toTurnInput(input: KestrelAgentTurnInput, defaultEventType: string): RunnerTurnInput {
  const eventType = input.eventType ?? defaultEventType;
  const {
    sessionId,
    message,
    eventType: _eventType,
    ...rest
  } = input;
  return {
    sessionId,
    message,
    eventType,
    ...rest,
  };
}

function readMemorySnapshot(graph: RunnerTaskGraph, threadId: string | undefined): KestrelMemorySnapshot {
  const normalizedGraph = normalizeTaskGraph(graph);
  const taskId = resolveMemoryTaskId(normalizedGraph, threadId);
  return normalizeMemorySnapshot(normalizedGraph.tasks[taskId]?.memory);
}

function updateMemorySnapshot(input: {
  sessionId: string;
  threadId: string | undefined;
  graph: RunnerTaskGraph;
  update: KestrelMemoryUpdate;
}): RunnerTaskGraph {
  const normalizedGraph = normalizeTaskGraph(input.graph);
  const taskId = resolveMemoryTaskId(normalizedGraph, input.threadId);
  const currentTask = normalizedGraph.tasks[taskId];
  const nextMemory = {
    ...normalizeMemorySnapshot(currentTask?.memory),
    ...input.update,
    ...(input.update.linkedArtifacts !== undefined ? { linkedArtifacts: [...input.update.linkedArtifacts] } : {}),
  };
  const nextTask: Record<string, unknown> = {
    ...(currentTask ?? {}),
    id: taskId,
    title: typeof currentTask?.title === "string" ? currentTask.title : "Session memory",
    order: typeof currentTask?.order === "number" ? currentTask.order : normalizedGraph.rootTaskIds.length,
    status: typeof currentTask?.status === "string" ? currentTask.status : "planned",
    source: typeof currentTask?.source === "string" ? currentTask.source : "manual",
    proposedByAgent: typeof currentTask?.proposedByAgent === "boolean" ? currentTask.proposedByAgent : false,
    linkedSessionId:
      typeof currentTask?.linkedSessionId === "string"
        ? currentTask.linkedSessionId
        : input.sessionId,
    ...(input.threadId !== undefined ? { linkedThreadId: input.threadId } : {}),
    ...(input.threadId !== undefined ? { activeThreadLineageId: input.threadId } : {}),
    runtime: asRecord(currentTask?.runtime) ?? {},
    memory: nextMemory,
    updatedAt: new Date().toISOString(),
  };

  const rootTaskIds =
    input.threadId !== undefined && taskId === threadTaskId(input.threadId) && normalizedGraph.rootTaskIds.includes(taskId) === false
      ? [...normalizedGraph.rootTaskIds, taskId]
      : normalizedGraph.rootTaskIds;

  return {
    ...normalizedGraph.raw,
    version: 1,
    rootTaskIds,
    tasks: {
      ...normalizedGraph.tasks,
      [taskId]: nextTask,
    },
    ...(normalizedGraph.activeTaskId !== undefined ? { activeTaskId: normalizedGraph.activeTaskId } : {}),
  };
}

function resolveMemoryTaskId(
  graph: NormalizedTaskGraph,
  threadId: string | undefined,
): string {
  const preferredTaskId = threadId !== undefined ? threadTaskId(threadId) : undefined;
  if (preferredTaskId !== undefined && graph.tasks[preferredTaskId] !== undefined) {
    return preferredTaskId;
  }
  if (graph.tasks[SESSION_MEMORY_TASK_ID] !== undefined) {
    return SESSION_MEMORY_TASK_ID;
  }
  return preferredTaskId ?? SESSION_MEMORY_TASK_ID;
}

function threadTaskId(threadId: string): string {
  return `task:thread:${threadId}`;
}

interface NormalizedTaskGraph {
  raw: Record<string, unknown>;
  activeTaskId?: string | undefined;
  rootTaskIds: string[];
  tasks: Record<string, Record<string, unknown>>;
}

function normalizeTaskGraph(graph: RunnerTaskGraph): NormalizedTaskGraph {
  const raw = asRecord(graph) ?? {};
  const tasksRecord = asRecord(raw.tasks) ?? {};
  const tasks = Object.fromEntries(
    Object.entries(tasksRecord).flatMap(([taskId, taskValue]) => {
      const task = asRecord(taskValue);
      return task === undefined ? [] : [[taskId, task]];
    }),
  );
  const rootTaskIds = Array.isArray(raw.rootTaskIds)
    ? raw.rootTaskIds.filter((taskId): taskId is string => typeof taskId === "string")
    : [];
  return {
    raw,
    ...(typeof raw.activeTaskId === "string" ? { activeTaskId: raw.activeTaskId } : {}),
    rootTaskIds,
    tasks,
  };
}

function normalizeMemorySnapshot(value: unknown): KestrelMemorySnapshot {
  const record = asRecord(value);
  return {
    goal: typeof record?.goal === "string" ? record.goal : "",
    currentPlan: typeof record?.currentPlan === "string" ? record.currentPlan : "",
    findings: typeof record?.findings === "string" ? record.findings : "",
    decisions: typeof record?.decisions === "string" ? record.decisions : "",
    openQuestions: typeof record?.openQuestions === "string" ? record.openQuestions : "",
    nextAction: typeof record?.nextAction === "string" ? record.nextAction : "",
    linkedArtifacts: Array.isArray(record?.linkedArtifacts)
      ? record.linkedArtifacts.filter((artifact): artifact is string => typeof artifact === "string")
      : [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export type {
  KestrelClientOptions,
  KestrelRequestContext,
  RunnerEventSubscriptionFilter,
  RunnerHistoryEntry,
  RunnerRunTerminalEvent,
  RunnerSessionDescription,
  RunnerStream,
  RunnerStreamEvent,
};
