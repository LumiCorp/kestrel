import { randomUUID } from "node:crypto";

import type { TuiProfile } from "../../../cli/contracts.js";
import type { RuntimeTurnInput, RuntimeTurnResult } from "../../runtime/RuntimeTurn.js";
import type {
  CodexRolloutCheckpointStore,
  RuntimeAdapterCallbacksV1,
  RuntimeAdapterV1,
  RuntimeBindingV1,
  RuntimeDescriptorV1,
  RuntimeEnvironmentResolver,
  RuntimeNativeSessionStore,
  RuntimeEnvironmentMap,
} from "../contracts.js";
import { InMemoryRuntimeNativeSessionStore } from "../contracts.js";
import { prepareCodexInput } from "../input.js";
import { createRuntimeResult } from "../result.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./CodexAppServerClient.js";
import type {
  CodexRequestId,
  CodexAnyServerRequest,
  CodexServerNotification,
  CodexServerRequest,
  CodexThreadStartResponse,
  CodexThreadResumeResponse,
  CodexTurnStartResponse,
} from "./protocol.js";

const CODEX_VERSION = "0.147.0";

interface PendingCodexInteraction {
  requestId: string;
  nativeRequestId: CodexRequestId;
  method: CodexServerRequest["method"];
  prompt: string;
  toolName: string;
  toolCallId: string;
  input: unknown;
  resolved: Deferred<boolean>;
}

interface CodexCompletion {
  status: "COMPLETED" | "FAILED" | "ABORTED";
  error?: { code: string; message: string } | undefined;
}

interface CodexSessionState {
  binding: RuntimeBindingV1;
  nativeThreadId: string;
  nativeTurnId: string;
  bufferedNativeMessages: Array<
    | { kind: "request"; value: CodexAnyServerRequest }
    | { kind: "notification"; value: CodexServerNotification }
  >;
  startedAt: number;
  assistantParts: string[];
  toolCalls: number;
  pending?: PendingCodexInteraction | undefined;
  segment: Deferred<PendingCodexInteraction>;
  completion: Deferred<CodexCompletion>;
  liveConnectionLost?: boolean | undefined;
  cleanupInput?: (() => Promise<void>) | undefined;
  rolloutPath?: string | undefined;
  codexHome?: string | undefined;
  tornDown?: boolean | undefined;
  processFailureCode?: "CODEX_PROTOCOL_INVALID" | "CODEX_RUNTIME_FAILED" | undefined;
}

export class CodexRuntimeAdapter implements RuntimeAdapterV1 {
  private readonly sessions = new Map<string, CodexSessionState>();
  private readonly sessionByNativeThread = new Map<string, CodexSessionState>();
  private readonly lostWaits = new Map<
    string,
    { bindingId: string; requestId: string }
  >();
  private client: CodexClient | undefined;
  private clientStart: Promise<void> | undefined;
  private credentialFingerprint: string | undefined;
  private clientEnvironment: RuntimeEnvironmentMap | undefined;

  constructor(
    private readonly profile: TuiProfile,
    private readonly callbacks: RuntimeAdapterCallbacksV1 = {},
    private readonly env: RuntimeEnvironmentMap = {},
    private readonly nativeSessions: RuntimeNativeSessionStore =
      new InMemoryRuntimeNativeSessionStore(),
    private readonly resolveEnvironment?: RuntimeEnvironmentResolver,
    private readonly createClient: (
      options: CodexAppServerClientOptions,
    ) => CodexClient = (options) => new CodexAppServerClient(options),
    private readonly checkpoints?: CodexRolloutCheckpointStore,
  ) {}

  async describe(): Promise<RuntimeDescriptorV1> {
    try {
      await this.ensureClient();
      const account = await this.client!.request<{
        account: unknown | null;
        requiresOpenaiAuth: boolean;
      }>("account/read", { refreshToken: false });
      const ready = account.account !== null || account.requiresOpenaiAuth === false;
      if (!ready) {
        return descriptor(
          "auth_required",
          "Codex requires a managed login or OpenAI API key.",
        );
      }
      const models = await this.client!.request<{
        data: Array<{ id: string; model: string }>;
      }>("model/list", { includeHidden: true });
      if (
        this.profile.model !== undefined &&
        !models.data.some(
          (model) =>
            model.id === this.profile.model || model.model === this.profile.model,
        )
      ) {
        return descriptor(
          "unavailable",
          `Codex does not expose the selected model '${this.profile.model}'.`,
        );
      }
      return descriptor(
        "ready",
      );
    } catch (error) {
      const code = readErrorCode(error);
      return descriptor(
        code === "CODEX_PROTOCOL_INVALID" ? "version_mismatch" : "unavailable",
        code === "CODEX_PROTOCOL_INVALID"
          ? "The installed Codex app-server protocol is incompatible."
          : "Codex readiness could not be established.",
      );
    }
  }

  async execute(
    input:
      | { kind: "start"; binding: RuntimeBindingV1; turn: RuntimeTurnInput }
      | { kind: "continue"; binding: RuntimeBindingV1; turn: RuntimeTurnInput },
    options: { signal?: AbortSignal | undefined } = {},
  ): Promise<RuntimeTurnResult> {
    try {
      if (input.kind === "continue") {
        return await this.continue(input.binding, input.turn, options.signal);
      }
      await this.ensureClient();
      return await this.start(input.binding, input.turn, options.signal);
    } catch (error) {
      const code = readErrorCode(error);
      if (
        code === "RUNTIME_ATTACHMENT_UNSUPPORTED" ||
        code === "RUNTIME_NATIVE_SESSION_LOST" ||
        code === "RUNTIME_LIVE_WAIT_LOST" ||
        code === "RUNTIME_BINDING_DEGRADED" ||
        code === "CODEX_PROTOCOL_INVALID" ||
        code === "CODEX_RUNTIME_FAILED"
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
    await this.client?.request("turn/interrupt", {
      threadId: state.nativeThreadId,
      turnId: state.nativeTurnId,
    });
  }

  async release(binding: RuntimeBindingV1): Promise<void> {
    const state = this.sessions.get(binding.threadId);
    if (state !== undefined && state.binding.bindingId === binding.bindingId) {
      state.pending?.resolved.resolve(false);
      await this.teardownState(state, true);
    }
    await this.checkpoints?.release(binding.bindingId);
    this.lostWaits.delete(binding.threadId);
    await this.nativeSessions.release(binding.bindingId);
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map((state) => this.teardownState(state, false)),
    );
    this.client?.close();
    this.client = undefined;
    this.clientStart = undefined;
    this.clientEnvironment = undefined;
    this.lostWaits.clear();
  }

  private async ensureClient(): Promise<void> {
    const snapshot = this.resolveEnvironment === undefined
      ? { env: this.env, credentialFingerprint: "static" }
      : await this.resolveEnvironment("codex");
    if (
      this.client !== undefined &&
      this.credentialFingerprint !== undefined &&
      this.credentialFingerprint !== snapshot.credentialFingerprint
    ) {
      if (this.sessions.size > 0) {
        await Promise.allSettled(
          [...this.sessions.values()].map((state) =>
            state.pending !== undefined
              ? this.failLiveWait(
                  state,
                  "Codex credentials changed or expired during the live interaction.",
                )
              : Promise.resolve(
                  state.completion.resolve({
                    status: "FAILED",
                    error: {
                      code: "CODEX_RUNTIME_FAILED",
                      message:
                        "Codex credentials changed during the active Turn.",
                    },
                  }),
                ),
          ),
        );
        throw Object.assign(
          new Error(
            "Codex credentials changed or expired during the live interaction.",
          ),
          { code: "RUNTIME_LIVE_WAIT_LOST" },
        );
      }
      this.client.close();
      this.client = undefined;
      this.clientStart = undefined;
    }
    if (this.clientStart !== undefined) return await this.clientStart;
    this.client = this.createClient({
      env: snapshot.env,
      onNotification: (notification) => this.onNotification(notification),
      onServerRequest: (request) => this.onServerRequest(request),
      onExit: (error) => this.onExit(error),
    });
    this.credentialFingerprint = snapshot.credentialFingerprint;
    this.clientEnvironment = { ...snapshot.env };
    this.clientStart = this.client.start().catch((error) => {
      this.clientStart = undefined;
      throw error;
    });
    await this.clientStart;
  }

  private async start(
    binding: RuntimeBindingV1,
    turn: RuntimeTurnInput,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult> {
    assertBindingUsable(binding);
    if (this.sessions.has(turn.sessionId)) {
      return failed(turn, "RUNTIME_TURN_ALREADY_ACTIVE", "Codex already has an active Turn for this Thread.");
    }
    const mode = turn.interactionMode ?? "chat";
    const cwd = workspaceRoot(turn) ?? process.cwd();
    const persisted = await this.nativeSessions.load(binding.bindingId);
    if (
      binding.nativeSessionState === "ready" &&
      (persisted === undefined || persisted.status === "released")
    ) {
      binding.status = "degraded";
      binding.nativeSessionState = "degraded";
      throw nativeSessionLost("The persisted Codex Thread for this binding is missing.");
    }
    if (persisted?.status === "degraded") {
      binding.status = "degraded";
      binding.nativeSessionState = "degraded";
      throw nativeSessionLost("The persisted Codex Thread is degraded.");
    }
    if (persisted !== undefined && persisted.status !== "released") {
      await this.ensurePersistedCorrelation(persisted, binding);
    }
    const prepared = await prepareCodexInput({
      ...turn,
      ...(persisted !== undefined ? { history: undefined } : {}),
    });
    let nativeThreadId: string;
    let rolloutPath: string | undefined;
    if (persisted !== undefined && persisted.status !== "released") {
      if (persisted.runtimeId !== "codex") {
        throw nativeSessionLost("The Runtime binding contains incompatible native state.");
      }
      try {
        const codexHome = this.clientEnvironment?.CODEX_HOME;
        if (codexHome !== undefined) {
          await this.checkpoints?.materialize({
            bindingId: binding.bindingId,
            codexHome,
          });
          // A missing checkpoint is not proof of loss when the app-server is
          // still using the original CODEX_HOME. Let thread/resume establish
          // whether the native rollout remains available. Cross-root loss
          // fails here naturally without replaying canonical history.
        }
        const resumed = await this.client!.request<CodexThreadResumeResponse>("thread/resume", {
          threadId: persisted.nativeSessionId,
        });
        nativeThreadId = resumed.thread.id;
        rolloutPath = resumed.thread.path ?? undefined;
      } catch {
        await prepared.cleanup();
        binding.status = "degraded";
        binding.nativeSessionState = "degraded";
        await this.nativeSessions.save({
          ...persisted,
          status: "degraded",
          updatedAt: new Date().toISOString(),
        });
        throw nativeSessionLost("Codex could not resume the native Thread for this binding.");
      }
    } else {
      let thread: CodexThreadStartResponse;
      try {
        thread = await this.client!.request<CodexThreadStartResponse>("thread/start", {
        cwd,
        ...(this.profile.model !== undefined
          ? { model: this.profile.model }
          : {}),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: mode === "build" ? "workspace-write" : "read-only",
        config: {
          features: { apps: false },
          mcp_servers: {},
        },
        developerInstructions: [
          mode === "build"
            ? "Operate only inside the Kestrel-granted workspace."
            : "This Kestrel mode is read-only. Do not modify files or external state.",
          ...(turn.systemInstructions ?? []),
        ].join("\n\n"),
        ephemeral: false,
        });
      } catch (error) {
        await prepared.cleanup();
        throw error;
      }
      nativeThreadId = thread.thread.id;
      rolloutPath = thread.thread.path ?? undefined;
      const now = new Date().toISOString();
      await this.nativeSessions.save({
        version: "runtime_native_session_v1",
        bindingId: binding.bindingId,
        runtimeId: "codex",
        threadId: binding.threadId,
        participantId: binding.participantId,
        environmentId: binding.environmentId,
        nativeSessionId: nativeThreadId,
        nativeVersion: CODEX_VERSION,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
      binding.nativeSessionState = "ready";
      if (this.callbacks.onNativeSessionEstablished !== undefined && turn.runId !== undefined) {
        this.callbacks.onNativeSessionEstablished({
        version: "runtime_native_session_established_v1",
        sessionId: turn.sessionId,
        runId: turn.runId,
        bindingId: binding.bindingId,
        participantId: binding.participantId,
        runtimeId: "codex",
        });
      }
    }
    const segment = deferred<PendingCodexInteraction>();
    const completion = deferred<CodexCompletion>();
    const state: CodexSessionState = {
      binding,
      nativeThreadId,
      nativeTurnId: "pending",
      bufferedNativeMessages: [],
      startedAt: Date.now(),
      assistantParts: [],
      toolCalls: 0,
      segment,
      completion,
      ...(rolloutPath !== undefined ? { rolloutPath } : {}),
      ...(this.clientEnvironment?.CODEX_HOME !== undefined
        ? { codexHome: this.clientEnvironment.CODEX_HOME }
        : {}),
    };
    this.sessions.set(turn.sessionId, state);
    this.sessionByNativeThread.set(state.nativeThreadId, state);
    try {
      state.cleanupInput = prepared.cleanup;
      const started = await this.client!.request<CodexTurnStartResponse>("turn/start", {
        threadId: state.nativeThreadId,
        input: prepared.input,
        cwd,
        approvalPolicy: "on-request",
      });
      state.nativeTurnId = started.turn.id;
      this.flushBufferedNativeMessages(state);
    } catch (error) {
      await this.teardownState(state, true);
      throw error;
    }
    if (signal !== undefined) {
      signal.addEventListener(
        "abort",
        () => void this.cancel({ binding, sessionId: turn.sessionId }),
        { once: true },
      );
    }
    return await this.awaitSegment(state, turn);
  }

  private async continue(
    binding: RuntimeBindingV1,
    turn: RuntimeTurnInput,
    signal?: AbortSignal,
  ): Promise<RuntimeTurnResult> {
    const state = this.sessions.get(turn.sessionId);
    const requestId = turn.resumeRequestId?.trim();
    const lostWait = this.lostWaits.get(turn.sessionId);
    if (
      state === undefined &&
      lostWait !== undefined &&
      lostWait.bindingId === binding.bindingId &&
      requestId === lostWait.requestId
    ) {
      return failed(
        turn,
        "RUNTIME_LIVE_WAIT_LOST",
        "The Codex live interaction connection was lost.",
      );
    }
    if (
      state === undefined ||
      state.binding.bindingId !== binding.bindingId ||
      state.pending === undefined ||
      requestId === undefined ||
      state.pending.requestId !== requestId
    ) {
      return failed(turn, "RUNTIME_INTERACTION_NOT_FOUND", "The pending Codex interaction is not available.");
    }
    if (state.liveConnectionLost || this.client === undefined) {
      return failed(
        turn,
        "RUNTIME_LIVE_WAIT_LOST",
        "The Codex live interaction connection was lost.",
      );
    }
    assertBindingUsable(binding);
    try {
      await this.ensureClient();
    } catch {
      return failed(
        turn,
        "RUNTIME_LIVE_WAIT_LOST",
        "Codex credentials changed or expired during the live interaction.",
      );
    }
    const pending = state.pending;
    state.segment = deferred<PendingCodexInteraction>();
    this.client!.respond(
      pending.nativeRequestId,
      codexInteractionResponse(pending, turn),
    );
    const delivered = await pending.resolved.promise;
    if (!delivered) {
      await this.failLiveWait(
        state,
        "The Codex live interaction connection was lost.",
      );
      return failed(turn, "RUNTIME_LIVE_WAIT_LOST", "The Codex live interaction connection was lost.");
    }
    if (state.pending === pending) state.pending = undefined;
    this.callbacks.onInteractionDelivered?.({
      version: "runtime_interaction_delivered_v1",
      sessionId: turn.sessionId,
      runId: requireRunId(turn),
      bindingId: binding.bindingId,
      participantId: binding.participantId,
      requestId,
    });
    if (signal !== undefined) {
      signal.addEventListener(
        "abort",
        () => void this.cancel({ binding, sessionId: turn.sessionId }),
        { once: true },
      );
    }
    return await this.awaitSegment(state, turn);
  }

  private async awaitSegment(
    state: CodexSessionState,
    turn: RuntimeTurnInput,
  ): Promise<RuntimeTurnResult> {
    const outcome = await Promise.race([
      state.completion.promise.then((completion) => ({ kind: "terminal" as const, completion })),
      state.segment.promise.then((pending) => ({ kind: "waiting" as const, pending })),
    ]);
    const runId = requireRunId(turn);
    if (outcome.kind === "waiting") {
      return createRuntimeResult({
        sessionId: turn.sessionId,
        runId,
        status: "WAITING",
        assistantText: state.assistantParts.join(""),
        durationMs: Date.now() - state.startedAt,
        toolCalls: state.toolCalls,
        waitFor: {
          kind:
            outcome.pending.method === "item/tool/requestUserInput"
              ? "user"
              : "approval",
          eventType: "runtime.interaction.response",
          interaction: {
            version: "v1",
            requestId: outcome.pending.requestId,
            kind:
              outcome.pending.method === "item/tool/requestUserInput"
                ? "user_input"
                : "approval",
            eventType: "runtime.interaction.response",
            prompt: outcome.pending.prompt,
            ...(outcome.pending.method === "item/tool/requestUserInput"
              ? codexQuestionContract(outcome.pending)
              : {
                  privateRuntimeMetadata: {
                    nativeRequestId: String(outcome.pending.nativeRequestId),
                  },
                  approval: {
                    toolCallId: outcome.pending.toolCallId,
                    toolName: outcome.pending.toolName,
                    input: outcome.pending.input,
                  },
                }),
          },
        },
      });
    }
    if (
      outcome.completion.status === "COMPLETED" &&
      state.codexHome !== undefined &&
      state.rolloutPath !== undefined
    ) {
      try {
        await this.checkpoints?.capture({
          bindingId: state.binding.bindingId,
          codexHome: state.codexHome,
          rolloutPath: state.rolloutPath,
        });
      } catch {
        outcome.completion = {
          status: "FAILED",
          error: {
            code: "CODEX_RUNTIME_FAILED",
            message: "Codex continuation state could not be checkpointed.",
          },
        };
      }
    }
    await this.teardownState(state, true);
    if (outcome.completion.status === "ABORTED") {
      throw new Error("Codex Runtime Turn was cancelled.");
    }
    return createRuntimeResult({
      sessionId: turn.sessionId,
      runId,
      status: outcome.completion.status,
      assistantText: state.assistantParts.join(""),
      durationMs: Date.now() - state.startedAt,
      toolCalls: state.toolCalls,
      error: outcome.completion.error,
    });
  }

  private onServerRequest(request: CodexAnyServerRequest): void {
    if (!isSupportedCodexRequest(request)) {
      this.client?.respondError(request.id, {
        code: -32601,
        message: `Kestrel does not expose Codex server request '${request.method}'.`,
      });
      return;
    }
    const state = this.sessionByNativeThread.get(request.params.threadId);
    if (state === undefined || state.pending !== undefined) {
      this.client?.respondError(request.id, {
        code: -32000,
        message: "No unique Kestrel Runtime binding owns this request.",
      });
      return;
    }
    if (state.nativeTurnId === "pending") {
      state.bufferedNativeMessages.push({ kind: "request", value: request });
      return;
    }
    if (request.params.turnId !== state.nativeTurnId) {
      this.client?.respondError(request.id, {
        code: -32000,
        message: "The Codex request does not belong to the active native Turn.",
      });
      return;
    }
    const requestId = randomUUID();
    const pending: PendingCodexInteraction = {
      requestId,
      nativeRequestId: request.id,
      method: request.method,
      prompt: codexPrompt(request),
      toolName: codexToolName(request),
      toolCallId: request.params.itemId,
      input: request.params,
      resolved: deferred<boolean>(),
    };
    state.pending = pending;
    state.toolCalls += 1;
    state.segment.resolve(pending);
  }

  private onNotification(notification: CodexServerNotification): void {
    if (notification.method === "item/agentMessage/delta") {
      const state = this.sessionByNativeThread.get(notification.params.threadId);
      if (state?.nativeTurnId === "pending") {
        state.bufferedNativeMessages.push({ kind: "notification", value: notification });
        return;
      }
      if (state?.nativeTurnId === notification.params.turnId) {
        state.assistantParts.push(notification.params.delta);
      }
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      const state = this.sessionByNativeThread.get(notification.params.threadId);
      if (
        state?.pending !== undefined &&
        String(notification.params.requestId) === String(state.pending.nativeRequestId)
      ) {
        state.pending.resolved.resolve(true);
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const state = this.sessionByNativeThread.get(notification.params.threadId);
      if (state?.nativeTurnId === "pending") {
        state.bufferedNativeMessages.push({ kind: "notification", value: notification });
        return;
      }
      if (state === undefined || state.nativeTurnId !== notification.params.turn.id) return;
      const status = notification.params.turn.status;
      state.completion.resolve({
        status:
          status === "completed"
            ? "COMPLETED"
            : status === "interrupted"
              ? "ABORTED"
              : "FAILED",
        ...(notification.params.turn.error !== null
          ? {
              error: {
                code: "CODEX_TURN_FAILED",
                message: JSON.stringify(notification.params.turn.error),
              },
            }
          : {}),
      });
      void cleanupCodexInput(state);
      void this.teardownState(state, false);
    }
  }

  private flushBufferedNativeMessages(state: CodexSessionState): void {
    const buffered = state.bufferedNativeMessages.splice(0);
    for (const message of buffered) {
      if (message.kind === "request") this.onServerRequest(message.value);
      else this.onNotification(message.value);
    }
  }

  private onExit(error: Error): void {
    for (const state of this.sessions.values()) {
      const liveWaitLost = state.pending !== undefined;
      const processFailureCode =
        readErrorCode(error) === "CODEX_PROTOCOL_INVALID"
          ? "CODEX_PROTOCOL_INVALID"
          : "CODEX_RUNTIME_FAILED";
      state.processFailureCode = processFailureCode;
      if (liveWaitLost) {
        state.binding.status = "degraded";
        state.binding.nativeSessionState = "degraded";
        state.liveConnectionLost = true;
        state.pending?.resolved.resolve(false);
        this.lostWaits.set(state.binding.threadId, {
          bindingId: state.binding.bindingId,
          requestId: state.pending!.requestId,
        });
        void this.persistDegraded(state.binding.bindingId);
      }
      state.completion.resolve({
        status: "FAILED",
        error: {
          code: liveWaitLost
            ? "RUNTIME_LIVE_WAIT_LOST"
            : processFailureCode,
          message: liveWaitLost
            ? "The Codex live interaction connection was lost."
            : processFailureCode === "CODEX_PROTOCOL_INVALID"
              ? "The Codex app-server emitted an invalid protocol message."
              : "The Codex app-server exited during the Turn.",
        },
      });
      void this.teardownState(state, false);
    }
    this.client = undefined;
    this.clientStart = undefined;
  }

  private async failLiveWait(
    state: CodexSessionState,
    message: string,
  ): Promise<void> {
    state.binding.status = "degraded";
    state.binding.nativeSessionState = "degraded";
    state.liveConnectionLost = true;
    if (state.pending !== undefined) {
      this.lostWaits.set(state.binding.threadId, {
        bindingId: state.binding.bindingId,
        requestId: state.pending.requestId,
      });
    }
    state.pending?.resolved.resolve(false);
    state.completion.resolve({
      status: "FAILED",
      error: { code: "RUNTIME_LIVE_WAIT_LOST", message },
    });
    await this.persistDegraded(state.binding.bindingId);
    await this.teardownState(state, false);
  }

  private async persistDegraded(bindingId: string): Promise<void> {
    const persisted = await this.nativeSessions.load(bindingId);
    if (persisted === undefined || persisted.status !== "ready") return;
    await this.nativeSessions.save({
      ...persisted,
      status: "degraded",
      updatedAt: new Date().toISOString(),
    });
  }

  private async ensurePersistedCorrelation(
    persisted: Exclude<
      Awaited<ReturnType<RuntimeNativeSessionStore["load"]>>,
      undefined | { status: "released" }
    >,
    binding: RuntimeBindingV1,
  ): Promise<void> {
    for (const [stored, expected] of [
      [persisted.threadId, binding.threadId],
      [persisted.participantId, binding.participantId],
      [persisted.environmentId, binding.environmentId],
    ] as const) {
      if (stored !== undefined && stored !== expected) {
        binding.status = "degraded";
        binding.nativeSessionState = "degraded";
        throw nativeSessionLost(
          "The persisted Codex Thread correlation does not match this binding.",
        );
      }
    }
    if (
      persisted.threadId === undefined ||
      persisted.participantId === undefined ||
      persisted.environmentId === undefined
    ) {
      await this.nativeSessions.save({
        ...persisted,
        threadId: binding.threadId,
        participantId: binding.participantId,
        environmentId: binding.environmentId,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async teardownState(
    state: CodexSessionState,
    unsubscribe: boolean,
  ): Promise<void> {
    if (state.tornDown) return;
    state.tornDown = true;
    this.sessions.delete(state.binding.threadId);
    this.sessionByNativeThread.delete(state.nativeThreadId);
    await cleanupCodexInput(state);
    if (unsubscribe) {
      await this.client?.request("thread/unsubscribe", {
        threadId: state.nativeThreadId,
      }).catch(() => undefined);
    }
  }
}

async function cleanupCodexInput(state: CodexSessionState): Promise<void> {
  const cleanup = state.cleanupInput;
  state.cleanupInput = undefined;
  await cleanup?.();
}

function isSupportedCodexRequest(
  request: CodexAnyServerRequest,
): request is CodexServerRequest {
  if (
    request.method !== "item/commandExecution/requestApproval" &&
    request.method !== "item/fileChange/requestApproval" &&
    request.method !== "item/tool/requestUserInput"
  ) {
    return false;
  }
  return (
    typeof request.params.threadId === "string" &&
    typeof request.params.turnId === "string" &&
    typeof request.params.itemId === "string" &&
    (request.method !== "item/tool/requestUserInput" ||
      Array.isArray(request.params.questions))
  );
}

function descriptor(
  availability: RuntimeDescriptorV1["availability"],
  unavailableReason?: string,
): RuntimeDescriptorV1 {
  return {
    version: "runtime_descriptor_v1",
    runtimeId: "codex",
    displayName: "Codex",
    adapterContractVersion: 1,
    nativeVersion: CODEX_VERSION,
    availability,
    interactionStrategies: ["live_connection"],
    capabilities: {
      modes: ["chat", "plan", "build"],
      continuation: true,
      cancellation: true,
      usage: false,
      attachments: ["image", "text"],
      conversationPersistence: "native_resume",
      interactionRecovery: "connection_bound",
    },
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}

function codexQuestionContract(
  pending: PendingCodexInteraction,
): {
  inputSchema: Record<string, unknown>;
  privateRuntimeMetadata: Record<string, unknown>;
} {
  const questions = (
    pending.input as {
      questions?: Array<{
        id?: unknown;
        question?: unknown;
        options?: unknown;
        multiSelect?: unknown;
      }>;
    }
  ).questions ?? [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const question of questions) {
    if (typeof question.id !== "string" || typeof question.question !== "string") continue;
    required.push(question.id);
    const labels = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (typeof option !== "object" || option === null || Array.isArray(option)) return [];
          const label = (option as { label?: unknown }).label;
          return typeof label === "string" ? [label] : [];
        })
      : [];
    properties[question.id] = {
      type: "array",
      title: question.question,
      minItems: 1,
      ...(question.multiSelect === true ? {} : { maxItems: 1 }),
      items: labels.length > 0 ? { type: "string", enum: labels } : { type: "string" },
    };
  }
  return {
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    privateRuntimeMetadata: {
      nativeRequestId: String(pending.nativeRequestId),
      nativeQuestionIds: required,
    },
  };
}

function codexPrompt(request: Extract<CodexServerRequest, {
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/tool/requestUserInput";
}>): string {
  if (request.method === "item/tool/requestUserInput") {
    return request.params.questions.map((question) => question.question).join("\n");
  }
  if (request.method === "item/commandExecution/requestApproval") {
    return request.params.reason ?? "Codex wants to run a command.";
  }
  return request.params.reason ?? "Codex wants to change files.";
}

function codexToolName(request: Extract<CodexServerRequest, {
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/tool/requestUserInput";
}>): string {
  if (request.method === "item/commandExecution/requestApproval") return "commandExecution";
  if (request.method === "item/fileChange/requestApproval") return "fileChange";
  return "requestUserInput";
}

function codexInteractionResponse(
  pending: PendingCodexInteraction,
  turn: RuntimeTurnInput,
): unknown {
  if (pending.method === "item/tool/requestUserInput") {
    const params = pending.input as { questions?: Array<{ id?: unknown }> };
    return {
      answers: Object.fromEntries(
        (params.questions ?? [])
          .filter((question): question is { id: string } => typeof question.id === "string")
          .map((question) => [
            question.id,
            { answers: turn.interactionResponse?.answers?.[question.id] ?? [turn.message] },
          ]),
      ),
    };
  }
  const decision = turn.interactionResponse?.approved === false ? "decline" : "accept";
  return { decision };
}

function workspaceRoot(turn: RuntimeTurnInput): string | undefined {
  if (typeof turn.workspace !== "object" || turn.workspace === null || Array.isArray(turn.workspace)) return;
  const value = (turn.workspace as Record<string, unknown>).workspaceRoot;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export interface CodexClient {
  start(): Promise<void>;
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  respond(id: CodexRequestId, result: unknown): void;
  respondError(id: CodexRequestId, error: { code: number; message: string; data?: unknown }): void;
  close(): void;
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
      new Error("This Codex Runtime binding is read-only and requires recovery."),
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

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
