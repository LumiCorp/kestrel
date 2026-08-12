import { randomUUID } from "node:crypto";

import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

import type { TuiProfile } from "../../../cli/contracts.js";
import type { RuntimeTurnInput, RuntimeTurnResult } from "../../runtime/RuntimeTurn.js";
import type {
  RuntimeAdapterCallbacksV1,
  RuntimeAdapterV1,
  RuntimeBindingV1,
  RuntimeDescriptorV1,
  RuntimeEnvironmentResolver,
  RuntimeNativeSessionStore,
  RuntimeEnvironmentMap,
} from "../contracts.js";
import { InMemoryRuntimeNativeSessionStore } from "../contracts.js";
import { claudePrompt } from "../input.js";
import { createRuntimeResult } from "../result.js";

const CLAUDE_AGENT_SDK_VERSION = "0.3.228";

interface PendingClaudeInteraction {
  requestId: string;
  nativeRequestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  prompt: string;
  response: Deferred<PermissionResult>;
}

interface ClaudeCompletion {
  status: "COMPLETED" | "FAILED" | "ABORTED";
  assistantText: string;
  durationMs: number;
  toolCalls: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  error?: { code: string; message: string } | undefined;
}

interface ClaudeSessionState {
  binding: RuntimeBindingV1;
  nativeSessionId: string;
  query: Query;
  abortController: AbortController;
  startedAt: number;
  assistantParts: string[];
  toolCalls: number;
  pending?: PendingClaudeInteraction | undefined;
  segment: Deferred<PendingClaudeInteraction>;
  completion: Promise<ClaudeCompletion>;
  awaitingDelivery?: {
    requestId: string;
    runId: string;
    activitySequence: number;
  } | undefined;
  resumed: boolean;
  nativeActivity: boolean;
  nativeActivitySequence: number;
  initialized: boolean;
  initialization: Promise<void>;
  credentialFingerprint: string;
  settled?: ClaudeCompletion | undefined;
}

type ReleasableClaudeSessionStore = SessionStore & {
  releaseSession?(sessionId: string): Promise<void>;
};

export class ClaudeRuntimeAdapter implements RuntimeAdapterV1 {
  private readonly sessions = new Map<string, ClaudeSessionState>();

  constructor(
    private readonly profile: TuiProfile,
    private readonly callbacks: RuntimeAdapterCallbacksV1 = {},
    private readonly env: RuntimeEnvironmentMap = {},
    private readonly nativeSessions: RuntimeNativeSessionStore =
      new InMemoryRuntimeNativeSessionStore(),
    private readonly sessionStore?: ReleasableClaudeSessionStore,
    private readonly resolveEnvironment?: RuntimeEnvironmentResolver,
    private readonly runQuery: typeof query = query,
  ) {}

  async describe(): Promise<RuntimeDescriptorV1> {
    let probe: Query | undefined;
    try {
      const runtimeEnv = this.resolveEnvironment === undefined
        ? this.env
        : (await this.resolveEnvironment("claude")).env;
      probe = this.runQuery({
        prompt: emptyClaudePrompt(),
        options: {
          env: stringEnvironment(runtimeEnv),
          settingSources: [],
          persistSession: false,
        },
      });
      const [initialization, account, models] = await Promise.all([
        probe.initializationResult(),
        probe.accountInfo(),
        probe.supportedModels(),
      ]);
      const authenticated =
        hasStructuredClaudeAuthentication(account) ||
        hasStructuredClaudeAuthentication(initialization.account);
      if (!authenticated) {
        return claudeDescriptor(
          "auth_required",
          "Claude Code requires a native login or Anthropic-compatible credential.",
        );
      }
      if (
        this.profile.model !== undefined &&
        !models.some(
          (model) =>
            model.value === this.profile.model ||
            model.resolvedModel === this.profile.model,
        )
      ) {
        return claudeDescriptor(
          "unavailable",
          `Claude Code does not expose the selected model '${this.profile.model}'.`,
        );
      }
      return claudeDescriptor("ready");
    } catch (error) {
      return claudeDescriptor(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      probe?.close();
    }
  }

  async execute(
    input:
      | { kind: "start"; binding: RuntimeBindingV1; turn: RuntimeTurnInput }
      | { kind: "continue"; binding: RuntimeBindingV1; turn: RuntimeTurnInput },
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RuntimeTurnResult> {
    try {
      return input.kind === "start"
        ? await this.start(input.binding, input.turn, options.signal)
        : await this.continue(input.binding, input.turn, options.signal);
    } catch (error) {
      const code = readErrorCode(error);
      if (
        code === "RUNTIME_ATTACHMENT_UNSUPPORTED" ||
        code === "RUNTIME_NATIVE_SESSION_LOST" ||
        code === "RUNTIME_LIVE_WAIT_LOST" ||
        code === "RUNTIME_BINDING_DEGRADED"
      ) {
        return failed(input.turn, code, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async cancel(input: {
    binding: RuntimeBindingV1;
    sessionId: string;
  }): Promise<void> {
    const state = this.sessions.get(input.sessionId);
    if (state === undefined || state.binding.bindingId !== input.binding.bindingId) return;
    state.pending?.response.resolve({
      behavior: "deny",
      message: "The Kestrel operator cancelled this Turn.",
      interrupt: true,
      toolUseID: state.pending.toolUseId,
    });
    state.abortController.abort();
    state.query.close();
  }

  async release(binding: RuntimeBindingV1): Promise<void> {
    const persisted = await this.nativeSessions.load(binding.bindingId);
    const state = this.sessions.get(binding.threadId);
    if (state !== undefined && state.binding.bindingId === binding.bindingId) {
      await this.cancel({ binding, sessionId: binding.threadId });
      this.sessions.delete(binding.threadId);
    }
    if (persisted?.nativeSessionId) {
      await this.sessionStore?.releaseSession?.(persisted.nativeSessionId);
    }
    await this.nativeSessions.release(binding.bindingId);
  }

  async dispose(): Promise<void> {
    const states = [...this.sessions.values()];
    this.sessions.clear();
    for (const state of states) {
      state.abortController.abort();
      state.query.close();
    }
  }

  private async start(
    binding: RuntimeBindingV1,
    turn: RuntimeTurnInput,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult> {
    assertBindingUsable(binding);
    if (this.sessions.has(turn.sessionId)) {
      return failed(turn, "RUNTIME_TURN_ALREADY_ACTIVE", "Claude already has an active Turn for this Thread.");
    }
    const abortController = new AbortController();
    pipeAbort(signal, abortController);
    const persisted = await this.nativeSessions.load(binding.bindingId);
    if (
      binding.nativeSessionState === "ready" &&
      (persisted === undefined || persisted.status === "released")
    ) {
      binding.status = "degraded";
      binding.nativeSessionState = "degraded";
      throw nativeSessionLost(
        "The persisted Claude Code session for this binding is missing.",
      );
    }
    if (persisted !== undefined && persisted.runtimeId !== "claude") {
      binding.status = "degraded";
      binding.nativeSessionState = "degraded";
      throw nativeSessionLost("The Runtime binding contains incompatible native state.");
    }
    const nativeSessionId = persisted?.nativeSessionId ?? randomUUID();
    const environmentSnapshot = this.resolveEnvironment === undefined
      ? { env: this.env, credentialFingerprint: "static" }
      : await this.resolveEnvironment("claude");
    const runtimeEnv = environmentSnapshot.env;
    const segment = deferred<PendingClaudeInteraction>();
    let state!: ClaudeSessionState;
    const canUseTool: CanUseTool = async (toolName, toolInput, permission) => {
      const pending: PendingClaudeInteraction = {
        requestId: randomUUID(),
        nativeRequestId: permission.requestId,
        toolName,
        toolUseId: permission.toolUseID,
        input: toolInput,
        prompt:
          permission.title ??
          permission.description ??
          `Claude wants to use ${toolName}.`,
        response: deferred<PermissionResult>(),
      };
      state.pending = pending;
      state.toolCalls += 1;
      state.segment.resolve(pending);
      return await pending.response.promise;
    };
    const runtimeQuery = this.runQuery({
      prompt: claudePrompt({
        ...turn,
        ...(persisted !== undefined ? { history: undefined } : {}),
      }),
      options: {
        abortController,
        ...(persisted === undefined
          ? { sessionId: nativeSessionId }
          : { resume: nativeSessionId }),
        cwd: workspaceRoot(turn) ?? process.cwd(),
        env: stringEnvironment(runtimeEnv),
        ...(this.profile.model !== undefined
          ? { model: this.profile.model }
          : {}),
        permissionMode: turn.interactionMode === "plan" ? "plan" : "default",
        tools:
          turn.interactionMode === "build"
            ? { type: "preset", preset: "claude_code" }
            : ["Read", "Glob", "Grep"],
        settingSources: [],
        canUseTool,
        persistSession: true,
        ...(this.sessionStore !== undefined
          ? { sessionStore: this.sessionStore, sessionStoreFlush: "eager" as const }
          : {}),
        ...(turn.systemInstructions?.length
          ? { systemPrompt: turn.systemInstructions }
          : {}),
      },
    });
    state = {
      binding,
      nativeSessionId,
      query: runtimeQuery,
      abortController,
      startedAt: Date.now(),
      assistantParts: [],
      toolCalls: 0,
      segment,
      completion: Promise.resolve(undefined as never),
      resumed: persisted !== undefined,
      nativeActivity: false,
      nativeActivitySequence: 0,
      initialized: false,
      initialization: Promise.resolve(),
      credentialFingerprint: environmentSnapshot.credentialFingerprint,
    };
    state.initialization = runtimeQuery.initializationResult().then(async () => {
      state.initialized = true;
      if (persisted !== undefined) return;
      const now = new Date().toISOString();
      await this.nativeSessions.save({
        version: "runtime_native_session_v1",
        bindingId: binding.bindingId,
        runtimeId: "claude",
        nativeSessionId,
        nativeVersion: CLAUDE_AGENT_SDK_VERSION,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
      binding.nativeSessionState = "ready";
      this.callbacks.onNativeSessionEstablished?.({
        version: "runtime_native_session_established_v1",
        sessionId: turn.sessionId,
        runId: requireRunId(turn),
        bindingId: binding.bindingId,
        participantId: binding.participantId,
        runtimeId: "claude",
      });
    });
    state.completion = this.consume(state).then((completion) => {
      state.settled = completion;
      return completion;
    });
    this.sessions.set(turn.sessionId, state);
    return await this.awaitSegment(state, turn);
  }

  private async continue(
    binding: RuntimeBindingV1,
    turn: RuntimeTurnInput,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult> {
    const state = this.sessions.get(turn.sessionId);
    const requestId = turn.resumeRequestId?.trim();
    if (
      state === undefined ||
      state.binding.bindingId !== binding.bindingId ||
      state.pending === undefined ||
      requestId === undefined ||
      state.pending.requestId !== requestId
    ) {
      return failed(turn, "RUNTIME_INTERACTION_NOT_FOUND", "The pending Claude interaction is not available.");
    }
    if (state.settled?.status === "FAILED") {
      return failed(
        turn,
        "RUNTIME_LIVE_WAIT_LOST",
        state.settled.error?.message ?? "The Claude live interaction connection was lost.",
      );
    }
    assertBindingUsable(binding);
    if (signal !== undefined) pipeAbort(signal, state.abortController);
    if (this.resolveEnvironment !== undefined) {
      try {
        const fresh = await this.resolveEnvironment("claude");
        if (
          fresh.credentialFingerprint !== state.credentialFingerprint ||
          (fresh.expiresAt !== undefined && Date.parse(fresh.expiresAt) <= Date.now())
        ) {
          throw new Error("Claude credentials rotated or expired.");
        }
      } catch {
        settleClaudePending(
          state,
          "Claude credentials changed or expired during the live interaction.",
        );
        return failed(
          turn,
          "RUNTIME_LIVE_WAIT_LOST",
          "Claude credentials changed or expired during the live interaction.",
        );
      }
    }
    const pending = state.pending;
    state.pending = undefined;
    state.segment = deferred<PendingClaudeInteraction>();
    state.awaitingDelivery = {
      requestId,
      runId: requireRunId(turn),
      activitySequence: state.nativeActivitySequence,
    };
    pending.response.resolve(
      approvalDecision(turn, pending.toolUseId, pending.toolName, pending.input),
    );
    return await this.awaitSegment(state, turn);
  }

  private async awaitSegment(
    state: ClaudeSessionState,
    turn: RuntimeTurnInput,
  ): Promise<RuntimeTurnResult> {
    const outcome = await Promise.race([
      state.completion.then((completion) => ({ kind: "terminal" as const, completion })),
      state.segment.promise.then((pending) => ({ kind: "waiting" as const, pending })),
    ]);
    const runId = requireRunId(turn);
    if (outcome.kind === "waiting") {
      const pending = outcome.pending;
      return createRuntimeResult({
        sessionId: turn.sessionId,
        runId,
        status: "WAITING",
        assistantText: state.assistantParts.join(""),
        durationMs: Date.now() - state.startedAt,
        toolCalls: state.toolCalls,
        waitFor: {
          kind: pending.toolName === "AskUserQuestion" ? "user" : "approval",
          eventType: "runtime.interaction.response",
          interaction: {
            version: "v1",
            requestId: pending.requestId,
            kind: pending.toolName === "AskUserQuestion" ? "user_input" : "approval",
            eventType: "runtime.interaction.response",
            prompt: pending.prompt,
            ...(pending.toolName === "AskUserQuestion"
              ? claudeQuestionContract(pending.input, pending.nativeRequestId)
              : {
                  privateRuntimeMetadata: {
                    nativeRequestId: pending.nativeRequestId,
                  },
                  approval: {
                    toolCallId: pending.toolUseId,
                    toolName: pending.toolName,
                    input: pending.input,
                  },
                }),
          },
        },
      });
    }
    this.sessions.delete(turn.sessionId);
    if (outcome.completion.status === "ABORTED") {
      throw new Error("Claude Runtime Turn was cancelled.");
    }
    return createRuntimeResult({
      sessionId: turn.sessionId,
      runId,
      status: outcome.completion.status,
      assistantText: outcome.completion.assistantText,
      durationMs: outcome.completion.durationMs,
      toolCalls: outcome.completion.toolCalls,
      inputTokens: outcome.completion.inputTokens,
      outputTokens: outcome.completion.outputTokens,
      error: outcome.completion.error,
    });
  }

  private async consume(state: ClaudeSessionState): Promise<ClaudeCompletion> {
    try {
      for await (const message of state.query) {
        state.nativeActivity = true;
        state.nativeActivitySequence += 1;
        acknowledgeClaudeDelivery(state, this.callbacks);
        consumeClaudeMessage(message, state);
      }
      await state.initialization;
      acknowledgeClaudeDelivery(state, this.callbacks, true);
      return terminalFromState(state, "COMPLETED");
    } catch (error) {
      if (state.abortController.signal.aborted) {
        return terminalFromState(state, "ABORTED");
      }
      const liveWaitLost =
        state.pending !== undefined || state.awaitingDelivery !== undefined;
      settleClaudePending(
        state,
        error instanceof Error ? error.message : String(error),
      );
      const nativeSessionMissing =
        state.resumed && !state.initialized && !state.nativeActivity;
      if (nativeSessionMissing) {
        state.binding.status = "degraded";
        state.binding.nativeSessionState = "degraded";
        const persisted = await this.nativeSessions.load(
          state.binding.bindingId,
        );
        if (persisted !== undefined) {
          await this.nativeSessions.save({
            ...persisted,
            status: "degraded",
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return terminalFromState(state, "FAILED", {
        code: liveWaitLost
          ? "RUNTIME_LIVE_WAIT_LOST"
          : nativeSessionMissing
          ? "RUNTIME_NATIVE_SESSION_LOST"
          : "CLAUDE_RUNTIME_FAILED",
        message: liveWaitLost
          ? "The Claude live interaction connection was lost."
          : nativeSessionMissing
          ? "Claude could not resume the native session for this binding."
          : error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function claudeQuestionContract(
  input: Record<string, unknown>,
  nativeRequestId: string,
): {
  inputSchema: Record<string, unknown>;
  privateRuntimeMetadata: Record<string, unknown>;
} {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const nativeQuestions: Record<string, string> = {};
  questions.forEach((question, index) => {
    const text = readString(question, "question");
    if (text === undefined) return;
    const id = `question-${index + 1}`;
    const record = typeof question === "object" && question !== null && !Array.isArray(question)
      ? question as Record<string, unknown>
      : {};
    const labels = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          const label = readString(option, "label");
          return label === undefined ? [] : [label];
        })
      : [];
    required.push(id);
    nativeQuestions[id] = text;
    properties[id] = {
      type: "array",
      title: text,
      minItems: 1,
      ...(record.multiSelect === true ? {} : { maxItems: 1 }),
      items: labels.length > 0 ? { type: "string", enum: labels } : { type: "string" },
    };
  });
  return {
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    privateRuntimeMetadata: { nativeRequestId, nativeQuestions },
  };
}

function stringEnvironment(env: RuntimeEnvironmentMap): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function hasStructuredClaudeAuthentication(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    "apiKeySource",
    "tokenSource",
    "apiProvider",
    "accountId",
    "organizationId",
    "email",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function claudeDescriptor(
  availability: RuntimeDescriptorV1["availability"],
  unavailableReason?: string,
): RuntimeDescriptorV1 {
  return {
    version: "runtime_descriptor_v1",
    runtimeId: "claude",
    displayName: "Claude",
    adapterContractVersion: 1,
    nativeVersion: CLAUDE_AGENT_SDK_VERSION,
    availability,
    interactionStrategies: ["live_callback"],
    capabilities: {
      modes: ["chat", "plan", "build"],
      continuation: true,
      cancellation: true,
      usage: true,
      attachments: ["image", "text"],
      conversationPersistence: "native_resume",
      interactionRecovery: "connection_bound",
    },
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}

function consumeClaudeMessage(message: SDKMessage, state: ClaudeSessionState): void {
  if (message.type === "assistant") {
    const content = (message.message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          state.assistantParts.push((block as { text: string }).text);
        }
      }
    }
  }
  if (message.type === "result") {
    const usage = readUsage(message);
    Object.assign(state, { finalUsage: usage });
  }
}

function readUsage(message: Extract<SDKMessage, { type: "result" }>): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const usage = "usage" in message ? message.usage : undefined;
  return {
    ...(typeof usage?.input_tokens === "number"
      ? { inputTokens: usage.input_tokens }
      : {}),
    ...(typeof usage?.output_tokens === "number"
      ? { outputTokens: usage.output_tokens }
      : {}),
  };
}

function terminalFromState(
  state: ClaudeSessionState,
  status: ClaudeCompletion["status"],
  error?: ClaudeCompletion["error"],
): ClaudeCompletion {
  const usage = (state as ClaudeSessionState & {
    finalUsage?: { inputTokens?: number; outputTokens?: number };
  }).finalUsage;
  return {
    status,
    assistantText: state.assistantParts.join(""),
    durationMs: Date.now() - state.startedAt,
    toolCalls: state.toolCalls,
    ...usage,
    ...(error !== undefined ? { error } : {}),
  };
}

function approvalDecision(
  turn: RuntimeTurnInput,
  toolUseID: string,
  toolName: string,
  input: Record<string, unknown>,
): PermissionResult {
  const approved = turn.interactionResponse?.approved;
  if (approved === false) {
    return {
      behavior: "deny",
      message: turn.interactionResponse?.reason ?? turn.message,
      toolUseID,
    };
  }
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const answers = Object.fromEntries(
      questions.flatMap((question, index) => {
        const text = readString(question, "question");
        if (text === undefined) return [];
        const stableId = `question-${index + 1}`;
        return [[text, turn.interactionResponse?.answers?.[stableId] ?? [turn.message]]];
      }),
    );
    return {
      behavior: "allow",
      toolUseID,
      updatedInput: { ...input, answers },
    };
  }
  return {
    behavior: "allow",
    toolUseID,
    ...(Object.keys(input).length > 0 ? { updatedInput: input } : {}),
  };
}

function workspaceRoot(turn: RuntimeTurnInput): string | undefined {
  return readString(turn.workspace, "workspaceRoot");
}

function requireRunId(turn: RuntimeTurnInput): string {
  return turn.runId ?? `run_${randomUUID()}`;
}

function failed(turn: RuntimeTurnInput, code: string, message: string): RuntimeTurnResult {
  return createRuntimeResult({
    sessionId: turn.sessionId,
    runId: requireRunId(turn),
    status: "FAILED",
    durationMs: 0,
    modelCalls: 0,
    error: { code, message },
  });
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function pipeAbort(source: AbortSignal | undefined, target: AbortController): void {
  if (source === undefined) return;
  if (source.aborted) {
    target.abort();
    return;
  }
  source.addEventListener("abort", () => target.abort(), { once: true });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function acknowledgeClaudeDelivery(
  state: ClaudeSessionState,
  callbacks: RuntimeAdapterCallbacksV1,
  successfulTerminal = false,
): void {
  const delivery = state.awaitingDelivery;
  if (delivery === undefined) return;
  if (
    !successfulTerminal &&
    state.nativeActivitySequence <= delivery.activitySequence
  ) {
    return;
  }
  state.awaitingDelivery = undefined;
  callbacks.onInteractionDelivered?.({
    version: "runtime_interaction_delivered_v1",
    sessionId: state.binding.threadId,
    runId: delivery.runId,
    bindingId: state.binding.bindingId,
    participantId: state.binding.participantId,
    requestId: delivery.requestId,
  });
}

function settleClaudePending(state: ClaudeSessionState, message: string): void {
  const pending = state.pending;
  state.pending = undefined;
  pending?.response.resolve({
    behavior: "deny",
    message,
    interrupt: true,
    toolUseID: pending.toolUseId,
  });
}

function emptyClaudePrompt(): AsyncIterable<SDKUserMessage> {
  return (async function* () {})();
}

function nativeSessionLost(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "RUNTIME_NATIVE_SESSION_LOST" });
}

function assertBindingUsable(binding: RuntimeBindingV1): void {
  if (
    binding.status === "degraded" ||
    binding.status === "released" ||
    binding.nativeSessionState === "degraded" ||
    binding.nativeSessionState === "released"
  ) {
    throw Object.assign(
      new Error("This Claude Runtime binding is read-only and requires recovery."),
      { code: "RUNTIME_BINDING_DEGRADED" },
    );
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
