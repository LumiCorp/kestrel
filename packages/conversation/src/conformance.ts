import type {
  ConversationInteraction,
  ConversationMessageLike,
  ConversationQueueState,
  ConversationTurn,
} from "./contracts.js";
import type { ConversationActivityItem, ConversationRuntimeEventLike } from "./activity.js";
import type { ConversationComposerPolicy } from "./composer.js";

const createdAt = "2026-08-13T12:00:00.000Z";

export const conversationConformanceFixture = {
  threadId: "thread-conformance",
  turns: [
    { id: "turn-1", sequence: 1, inputMessageId: "message-user-1", rootRunId: "run-1", status: "completed" },
    { id: "turn-2", sequence: 2, inputMessageId: "message-user-2", rootRunId: "run-2", status: "running" },
  ],
  messages: [
    { id: "terminal:run-2", role: "assistant", turnId: "turn-2", text: "Working." },
    { id: "message-user-1", role: "user", text: "Inspect the workspace." },
    { id: "terminal:run-1", role: "assistant", turnId: "turn-1", text: "Ready." },
    { id: "message-user-2", role: "user", text: "Start the server." },
  ],
  expected: [
    { turnId: "turn-1", messageIds: ["message-user-1", "terminal:run-1"] },
    { turnId: "turn-2", messageIds: ["message-user-2", "terminal:run-2"] },
  ],
} as const;

export interface ConversationProjectionConformanceScenario {
  name: string;
  messages: ConversationMessageLike[];
  turns: ConversationTurn[];
  interactions: ConversationInteraction[];
  queue: ConversationQueueState;
  expected: Array<{ turnId: string; messageIds: string[]; interactionIds: string[] }>;
}

export const conversationProjectionConformanceScenarios: readonly ConversationProjectionConformanceScenario[] = [
  scenario({
    name: "optimistic submission",
    messages: [message("message-optimistic", "user", undefined, "submitting")],
    turns: [],
    expected: [],
  }),
  scenario({
    name: "active-run queueing",
    messages: [
      message("message-active", "user", "turn-active"),
      message("message-queued", "user", "turn-queued", "queued"),
    ],
    turns: [
      turn("turn-active", 1, "message-active", "running"),
      turn("turn-queued", 2, "message-queued", "queued"),
    ],
    queue: { state: "running", pauseReason: null, activeTurnId: "turn-active", version: 2 },
    expected: [
      { turnId: "turn-active", messageIds: ["message-active"], interactionIds: [] },
      { turnId: "turn-queued", messageIds: ["message-queued"], interactionIds: [] },
    ],
  }),
  scenario({
    name: "queue promotion with stable identity",
    messages: [message("message-active", "user", "turn-active", "queued")],
    turns: [turn("turn-active", 1, "message-active", "running")],
    queue: { state: "running", pauseReason: null, activeTurnId: "turn-active", version: 3 },
    expected: [{ turnId: "turn-active", messageIds: ["message-active"], interactionIds: [] }],
  }),
  scenario({
    name: "waiting interaction and response",
    messages: [
      message("message-user", "user", "turn-waiting"),
      message("message-request", "assistant", "turn-waiting"),
    ],
    turns: [turn("turn-waiting", 1, "message-user", "waiting_for_input")],
    interactions: [interaction({
      id: "interaction-request",
      requestId: "request-1",
      turnId: "turn-waiting",
      assistantMessageId: "message-request",
      responseMessageId: null,
      kind: "user_input",
    })],
    queue: { state: "paused", pauseReason: "interaction_required", activeTurnId: "turn-waiting", version: 4 },
    expected: [{
      turnId: "turn-waiting",
      messageIds: ["message-user", "message-request"],
      interactionIds: ["interaction-request"],
    }],
  }),
  ...(["completed", "failed", "cancelled"] as const).map((status, index) => scenario({
    name: `${status} terminal state`,
    messages: [
      message(`message-user-${status}`, "user", `turn-${status}`),
      message(`terminal:run-${status}`, "assistant", `turn-${status}`),
    ],
    turns: [turn(`turn-${status}`, index + 1, `message-user-${status}`, status)],
    expected: [{
      turnId: `turn-${status}`,
      messageIds: [`message-user-${status}`, `terminal:run-${status}`],
      interactionIds: [],
    }],
  })),
  scenario({
    name: "contract-failure terminal state",
    messages: [
      message("message-user-contract", "user", "turn-contract"),
      message("terminal:run-contract", "system", "turn-contract"),
    ],
    turns: [turn("turn-contract", 1, "message-user-contract", "failed")],
    expected: [{
      turnId: "turn-contract",
      messageIds: ["message-user-contract", "terminal:run-contract"],
      interactionIds: [],
    }],
  }),
  scenario({
    name: "approval remains explicitly blocked",
    messages: [message("message-user-approval", "user", "turn-approval")],
    turns: [turn("turn-approval", 1, "message-user-approval", "waiting_for_input")],
    interactions: [interaction({
      id: "interaction-approval",
      requestId: "request-approval",
      turnId: "turn-approval",
      assistantMessageId: null,
      responseMessageId: null,
      kind: "approval",
    })],
    queue: { state: "paused", pauseReason: "interaction_required", activeTurnId: "turn-approval", version: 5 },
    expected: [{
      turnId: "turn-approval",
      messageIds: ["message-user-approval"],
      interactionIds: ["interaction-approval"],
    }],
  }),
];

export interface ConversationActivityConformanceScenario {
  name: string;
  events: ConversationRuntimeEventLike[];
  expected: Array<Pick<ConversationActivityItem, "kind" | "runId" | "status" | "text">>;
}

export const conversationActivityConformanceScenarios: readonly ConversationActivityConformanceScenario[] = [
  {
    name: "out-of-order progress replay follows authoritative sequence",
    events: [
      activityEvent("progress-new", "run-1", "run.agent_progress", 2, { message: "new" }),
      activityEvent("progress-old", "run-1", "run.agent_progress", 1, { message: "old" }),
    ],
    expected: [
      { kind: "agent_progress", runId: "run-1", status: "active", text: "old" },
      { kind: "agent_progress", runId: "run-1", status: "active", text: "new" },
    ],
  },
  {
    name: "retry attempts retain separate reasoning identity",
    events: [
      activityEvent("reasoning-1", "run-1", "run.model.reasoning.delta", 1, { attempt: 1, format: "summary", contentState: "live", delta: "first" }),
      activityEvent("reasoning-2", "run-1", "run.model.reasoning.delta", 2, { attempt: 2, format: "summary", contentState: "live", delta: "second" }),
      activityEvent("reasoning-stale", "run-1", "run.model.reasoning.delta", 1, { attempt: 2, format: "summary", contentState: "live", delta: " stale" }),
    ],
    expected: [
      { kind: "reasoning", runId: "run-1", status: "active", text: "first" },
      { kind: "reasoning", runId: "run-1", status: "active", text: "second" },
    ],
  },
  {
    name: "interleaved tool lifecycles stay keyed by tool call",
    events: [
      activityEvent("tool-a-start", "run-1", "run.tool.started", 1, { toolCallId: "call-a", toolName: "read" }),
      activityEvent("tool-b-start", "run-1", "run.tool.started", 2, { toolCallId: "call-b", toolName: "write" }),
      activityEvent("tool-a-complete", "run-1", "run.tool.completed", 3, { toolCallId: "call-a", toolName: "read" }),
      activityEvent("tool-b-fail", "run-1", "run.tool.failed", 4, { toolCallId: "call-b", toolName: "write", error: { message: "denied" } }),
    ],
    expected: [
      { kind: "tool", runId: "run-1", status: "completed", text: "Completed read" },
      { kind: "tool", runId: "run-1", status: "failed", text: "write failed: denied" },
    ],
  },
];

export interface ConversationComposerConformanceScenario {
  name: string;
  turns: ConversationTurn[];
  interactions: ConversationInteraction[];
  queue: ConversationQueueState;
  transportStatus: "submitted" | "streaming" | "ready" | "error";
  expectedMode: ConversationComposerPolicy["mode"];
}

export const conversationComposerConformanceScenarios: readonly ConversationComposerConformanceScenario[] = [
  {
    name: "ready starts a turn",
    turns: [], interactions: [],
    queue: { state: "running", pauseReason: null, activeTurnId: null, version: 0 },
    transportStatus: "ready",
    expectedMode: "start_turn",
  },
  {
    name: "active run queues a turn",
    turns: [turn("turn-active", 1, "message-active", "running")], interactions: [],
    queue: { state: "running", pauseReason: null, activeTurnId: "turn-active", version: 1 },
    transportStatus: "ready",
    expectedMode: "queue_turn",
  },
  {
    name: "runtime user input answers interaction",
    turns: [turn("turn-wait", 1, "message-wait", "waiting_for_input")],
    interactions: [interaction({ id: "input-1", requestId: "request-1", turnId: "turn-wait", assistantMessageId: null, responseMessageId: null, kind: "user_input" })],
    queue: { state: "paused", pauseReason: "interaction_required", activeTurnId: "turn-wait", version: 2 },
    transportStatus: "ready",
    expectedMode: "answer_interaction",
  },
  {
    name: "approval blocks plain composer input",
    turns: [turn("turn-approval", 1, "message-approval", "waiting_for_input")],
    interactions: [interaction({ id: "approval-1", requestId: "request-approval", turnId: "turn-approval", assistantMessageId: null, responseMessageId: null, kind: "approval" })],
    queue: { state: "paused", pauseReason: "interaction_required", activeTurnId: "turn-approval", version: 3 },
    transportStatus: "ready",
    expectedMode: "blocked_interaction",
  },
];

export function normalizeConversationConformanceProjection(input: {
  items: ReadonlyArray<
    | { kind: "durable_turn"; turnId: string; messages: readonly { id: string }[] }
    | { kind: "standalone_message"; message: { id: string } }
  >;
}) {
  return input.items.flatMap((item) => item.kind === "durable_turn"
    ? [{ turnId: item.turnId, messageIds: item.messages.map((entry) => entry.id) }]
    : []);
}

export function normalizeConversationProjectionConformance(input: {
  items: ReadonlyArray<
    | { kind: "durable_turn"; turnId: string; messages: readonly { id: string }[]; interactions: readonly { id: string }[] }
    | { kind: "standalone_message"; message: { id: string } }
  >;
}) {
  return input.items.flatMap((item) => item.kind === "durable_turn"
    ? [{
        turnId: item.turnId,
        messageIds: item.messages.map((entry) => entry.id),
        interactionIds: item.interactions.map((entry) => entry.id),
      }]
    : []);
}

function scenario(input: {
  name: string;
  messages: ConversationMessageLike[];
  turns: ConversationTurn[];
  interactions?: ConversationInteraction[];
  queue?: ConversationQueueState;
  expected: ConversationProjectionConformanceScenario["expected"];
}): ConversationProjectionConformanceScenario {
  return {
    name: input.name,
    messages: input.messages,
    turns: input.turns,
    interactions: input.interactions ?? [],
    queue: input.queue ?? { state: "running", pauseReason: null, activeTurnId: null, version: 0 },
    expected: input.expected,
  };
}

function turn(id: string, sequence: number, inputMessageId: string, status: ConversationTurn["status"]): ConversationTurn {
  return { id, sequence, inputMessageId, status, createdAt, updatedAt: createdAt };
}

function message(
  id: string,
  role: ConversationMessageLike["role"],
  turnId?: string,
  deliveryState?: "submitting" | "queued",
): ConversationMessageLike {
  return {
    id,
    role,
    ...((turnId !== undefined || deliveryState !== undefined)
      ? { metadata: {
          ...(turnId !== undefined ? { kestrelTurnId: turnId } : {}),
          ...(deliveryState !== undefined ? { deliveryState } : {}),
        } }
      : {}),
  };
}

function interaction(input: {
  id: string;
  requestId: string;
  turnId: string;
  assistantMessageId: string | null;
  responseMessageId: string | null;
  kind: ConversationInteraction["kind"];
}): ConversationInteraction {
  return {
    ...input,
    source: "runtime",
    eventType: "runtime.user_input",
    prompt: "Continue?",
    status: "pending",
    createdAt,
  };
}

function activityEvent(
  id: string,
  runId: string,
  type: string,
  sequence: number,
  update: Record<string, unknown>,
): ConversationRuntimeEventLike {
  return {
    id,
    type,
    ts: createdAt,
    runId,
    payload: { update: { runId, ts: createdAt, seq: sequence, ...update } },
  };
}
