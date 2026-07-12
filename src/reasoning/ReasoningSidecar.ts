import type {
  Transition,
} from "../kestrel/contracts/execution.js";
import type {
  ReasoningMilestone,
  ReasoningUpdateV1,
} from "../kestrel/contracts/events.js";
import type {
  ModelGateway,
  ModelRequest,
} from "../kestrel/contracts/model-io.js";
import {
  normalizeVisibleTodoState,
  type VisibleTodoState,
} from "../runtime/visibleTodos.js";
import { readActiveWaitState } from "../runtime/waitState.js";

const DEFAULT_REASONING_TIMEOUT_MS = 8_000;
const DEFAULT_REASONING_MAX_TOKENS = 192;
const MAX_REASONING_CONTEXT_CHARS = 2_400;
const MAX_REASONING_HISTORY = 2;
const INTERNAL_JARGON_PATTERNS = [
  /\bexecsubstate\b/iu,
  /\bdecision confidence\b/iu,
  /\bruntime snapshot\b/iu,
  /\bthe system has transitioned\b/iu,
  /\bi(?:'m| am)\s+(?:currently\s+)?in\s+the\s+(?:think|act|observe)\s+phase\b/iu,
  /\b(?:THINK|ACT|OBSERVE)\b/u,
];

export interface ReasoningMilestoneSelectionInput {
  stepAgent: string | undefined;
  previousState: Record<string, unknown>;
  currentState: Record<string, unknown>;
  transition: Transition;
}

export interface ReasoningGenerationInput {
  runId: string;
  sessionId: string;
  seq: number;
  milestone: ReasoningMilestone;
  stepAgent: string | undefined;
  stepIndex: number | undefined;
  previousState: Record<string, unknown>;
  currentState: Record<string, unknown>;
  transition: Transition;
  recentMessages?: string[] | undefined;
  runElapsedMs?: number | undefined;
  stepElapsedMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ModelReasoningSidecarOptions {
  enabled?: boolean | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  maxTokens?: number | undefined;
}

export interface ReasoningDropDiagnostic {
  reason: "disabled" | "message_missing" | "message_invalid" | "model_error";
  validator?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  configuredModel?: string | undefined;
  providerName?: string | undefined;
  providerModel?: string | undefined;
  providerEndpoint?: string | undefined;
  responseKeys?: string[] | undefined;
  outputKeys?: string[] | undefined;
  contentShape?: string | undefined;
}

export interface ReasoningGenerationResult {
  update?: ReasoningUpdateV1 | undefined;
  dropped?: ReasoningDropDiagnostic | undefined;
}

export function selectReasoningMilestone(
  input: ReasoningMilestoneSelectionInput,
): ReasoningMilestone | undefined {
  if (isReasoningStep(input.stepAgent) === false) {
    return undefined;
  }

  const previousReact = asRecord(input.previousState.agent) ?? {};
  const currentReact = asRecord(input.currentState.agent) ?? {};
  const previousPhase = asString(previousReact.phase);
  const currentPhase = asString(currentReact.phase);
  const previousAction = asRecord(previousReact.nextAction);
  const currentAction = asRecord(currentReact.nextAction);
  const currentActionKind = asString(currentAction?.kind);

  if (input.transition.status === "WAITING") {
    return "wait_entered";
  }
  if (input.transition.status === "COMPLETED" || input.transition.status === "FAILED") {
    return "run_terminal";
  }
  if (hasMeaningfulToolSelectionChange(previousAction, currentAction)) {
    return "tool_activity";
  }
  if (hasMeaningfulEffectSelection(input.transition, currentActionKind)) {
    return "effect_activity";
  }
  if (
    previousPhase !== currentPhase ||
    readObservationDelta(previousReact, currentReact) !== undefined ||
    hasMeaningfulActionStateChange(previousAction, currentAction)
  ) {
    return "phase_changed";
  }

  return undefined;
}

export function validateReasoningMonologue(message: string): string | undefined {
  const normalized = collapseWhitespace(message);
  if (normalized.length === 0) {
    return "empty";
  }
  if (normalized.includes("```") || normalized.includes("`")) {
    return "markdown";
  }
  const sentenceCount = countSentences(normalized);
  if (sentenceCount < 1 || sentenceCount > 2) {
    return "sentence_count";
  }
  if (INTERNAL_JARGON_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "internal_jargon";
  }
  return undefined;
}

export function buildReasoningPromptContext(input: {
  stepAgent: string | undefined;
  stepIndex: number | undefined;
  milestone: ReasoningMilestone;
  previousState?: Record<string, unknown> | undefined;
  currentState: Record<string, unknown>;
  transition: Transition;
  recentMessages?: string[] | undefined;
  runElapsedMs?: number | undefined;
  stepElapsedMs?: number | undefined;
}): Record<string, unknown> {
  const previousReact = asRecord(input.previousState?.agent) ?? {};
  const react = asRecord(input.currentState.agent) ?? {};
  const action = asRecord(react.nextAction);
  const transitionWait = input.transition.waitFor;
  const stateWait = readActiveWaitState(react);
  const waitMetadata =
    asRecord(transitionWait?.metadata) ??
    asRecord(stateWait?.metadata);
  const waitKind =
    transitionWait?.kind ??
    (typeof stateWait?.kind === "string" ? stateWait.kind : undefined);
  const waitEventType =
    transitionWait?.eventType ??
    (typeof stateWait?.eventType === "string" ? stateWait.eventType : undefined);
  const requiredCapabilities = toStringArray(react.requiredCapabilities);
  const capabilityEvidence = new Set(readCapabilityClassesFromFeedback(react));
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => capabilityEvidence.has(capability) === false,
  );
  const transitionEffects = (input.transition.effects ?? [])
    .map((effect) => effect.type)
    .filter((type): type is string => typeof type === "string" && type.trim().length > 0);
  const recentMessages = normalizeRecentMessages(input.recentMessages);
  const taskBeat = describeVisibleTodoBeat(normalizeVisibleTodoState(react.visibleTodos));
  const actionSummary = extractActionSummary(action);
  const observationDelta = readObservationDelta(previousReact, react);
  const wait =
    waitKind !== undefined || waitEventType !== undefined
      ? {
          ...(waitKind !== undefined ? { kind: waitKind } : {}),
          ...(waitEventType !== undefined ? { eventType: waitEventType } : {}),
          ...(asString(waitMetadata?.reason) !== undefined ? { reason: asString(waitMetadata?.reason) } : {}),
          ...(asString(waitMetadata?.prompt) !== undefined ? { prompt: asString(waitMetadata?.prompt) } : {}),
          ...(asString(waitMetadata?.question) !== undefined
            ? { question: asString(waitMetadata?.question) }
            : {}),
          ...(asString(waitMetadata?.requiredToolClass) !== undefined
            ? { requiredToolClass: asString(waitMetadata?.requiredToolClass) }
            : {}),
          ...(asString(waitMetadata?.toolName) !== undefined ? { toolName: asString(waitMetadata?.toolName) } : {}),
          ...(asString(waitMetadata?.resumeReply) !== undefined
            ? { resumeReply: asString(waitMetadata?.resumeReply) }
            : {}),
          ...(asString(waitMetadata?.resumeCommand) !== undefined
            ? { resumeCommand: asString(waitMetadata?.resumeCommand) }
            : {}),
          ...(readWaitResumeBehavior(waitMetadata) !== undefined
            ? { resumeBehavior: readWaitResumeBehavior(waitMetadata) }
            : {}),
        }
      : undefined;
  const beat = {
    ...(taskBeat !== undefined ? { task: taskBeat } : {}),
    ...(asString(react.decisionReason) !== undefined ? { reason: asString(react.decisionReason) } : {}),
    ...(actionSummary !== undefined ? { action: actionSummary } : {}),
    ...(observationDelta !== undefined ? { result: observationDelta } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(transitionEffects.length > 0 ? { effects: transitionEffects } : {}),
    ...(missingCapabilities.length > 0 ? { missingCapabilities } : {}),
    ...(requiredCapabilities.length > 0 ? { requiredCapabilities } : {}),
  };

  return {
    step: {
      ...(input.stepAgent !== undefined ? { agent: input.stepAgent } : {}),
      ...(input.stepIndex !== undefined ? { index: input.stepIndex } : {}),
      milestone: input.milestone,
      status: input.transition.status,
      ...(input.transition.nextStepAgent !== undefined
        ? { nextStepAgent: input.transition.nextStepAgent }
        : {}),
      ...(input.transition.stateNode !== undefined
        ? { stateNode: input.transition.stateNode }
        : {}),
    },
    ...(Object.keys(beat).length > 0 ? { beat } : {}),
    ...(recentMessages.length > 0 ? { recentMessages } : {}),
    context: {
      ...(input.runElapsedMs !== undefined || input.stepElapsedMs !== undefined
        ? {
            elapsedMs: {
              ...(input.runElapsedMs !== undefined ? { run: Math.max(0, Math.floor(input.runElapsedMs)) } : {}),
              ...(input.stepElapsedMs !== undefined ? { step: Math.max(0, Math.floor(input.stepElapsedMs)) } : {}),
            },
          }
        : {}),
    },
  };
}

export class ModelReasoningSidecar {
  private readonly modelGateway: ModelGateway;
  private readonly enabled: boolean;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(modelGateway: ModelGateway, options: ModelReasoningSidecarOptions = {}) {
    this.modelGateway = modelGateway;
    const enabledFromEnv = parseEnvBoolean("KCHAT_REASONING_ENABLED");
    this.enabled = options.enabled ?? enabledFromEnv ?? true;
    this.model =
      typeof options.model === "string" && options.model.trim().length > 0
        ? options.model.trim()
        : process.env.KCHAT_REASONING_MODEL;
    const timeoutFromEnv = parseEnvPositiveInt("KCHAT_REASONING_TIMEOUT_MS");
    const maxTokensFromEnv = parseEnvPositiveInt("KCHAT_REASONING_MAX_TOKENS");
    this.timeoutMs =
      typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : timeoutFromEnv ?? DEFAULT_REASONING_TIMEOUT_MS;
    this.maxTokens =
      typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens) && options.maxTokens > 0
        ? Math.floor(options.maxTokens)
        : maxTokensFromEnv ?? DEFAULT_REASONING_MAX_TOKENS;
  }

  async generate(input: ReasoningGenerationInput): Promise<ReasoningUpdateV1 | undefined> {
    const result = await this.generateWithDiagnostics(input);
    return result.update;
  }

  async generateWithDiagnostics(input: ReasoningGenerationInput): Promise<ReasoningGenerationResult> {
    if (this.enabled === false) {
      return {
        dropped: {
          reason: "disabled",
        },
      };
    }
    const context = buildReasoningPromptContext({
      stepAgent: input.stepAgent,
      stepIndex: input.stepIndex,
      milestone: input.milestone,
      previousState: input.previousState,
      currentState: input.currentState,
      transition: input.transition,
      recentMessages: input.recentMessages,
      runElapsedMs: input.runElapsedMs,
      stepElapsedMs: input.stepElapsedMs,
    });

    const request = this.buildRequest(context);
    const timeoutSignal = createTimeoutSignal(this.timeoutMs, input.signal);
    const startedAt = Date.now();

    try {
      const result = await this.modelGateway.call<unknown>(
        request,
        { signal: timeoutSignal.signal },
      );
      const extracted = extractReasoningMessage(result);
      if (extracted === undefined) {
        const diagnostics = describeResponseShape(result);
        const provider = describeProvider(result);
        return {
          dropped: {
            reason: "message_missing",
            ...(this.model !== undefined ? { configuredModel: this.model } : {}),
            ...(provider.providerName !== undefined ? { providerName: provider.providerName } : {}),
            ...(provider.providerModel !== undefined ? { providerModel: provider.providerModel } : {}),
            ...(provider.providerEndpoint !== undefined ? { providerEndpoint: provider.providerEndpoint } : {}),
            ...(diagnostics.responseKeys.length > 0
              ? { responseKeys: diagnostics.responseKeys }
              : {}),
            ...(diagnostics.outputKeys.length > 0
              ? { outputKeys: diagnostics.outputKeys }
              : {}),
            ...(diagnostics.contentShape !== undefined
              ? { contentShape: diagnostics.contentShape }
              : {}),
          },
        };
      }

      const normalized = collapseWhitespace(extracted);
      const condensed = truncateToSentenceBudget(normalized, 2);
      const validator = validateReasoningMonologue(condensed);
      if (validator !== undefined) {
        return {
          dropped: {
            reason: "message_invalid",
            validator,
          },
        };
      }
      if (isDuplicateReasoningMessage(condensed, input.recentMessages)) {
        return {
          dropped: {
            reason: "message_invalid",
            validator: "duplicate",
          },
        };
      }

      const model = extractModelMetadata(result, Date.now() - startedAt);
      return {
        update: {
          version: "v1",
          runId: input.runId,
          sessionId: input.sessionId,
          ts: new Date().toISOString(),
          seq: input.seq,
          milestone: input.milestone,
          message: condensed,
          ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
          ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
          ...(model !== undefined ? { model } : {}),
        },
      };
    } catch (error) {
      return {
        dropped: {
          reason: "model_error",
          errorCode: readErrorCode(error),
          errorMessage: readErrorMessage(error),
        },
      };
    } finally {
      timeoutSignal.cleanup();
    }
  }

  private buildRequest(context: Record<string, unknown>): ModelRequest {
    const serializedContext = safeJSONStringify(context, MAX_REASONING_CONTEXT_CHARS);
    return {
      model: this.model,
      messages: [
        {
          role: "system",
          content: [
            "You produce non-authoritative live progress updates that are shown to the user while the runtime works.",
            "Return plain text only.",
            "Use first-person singular voice.",
            "Use exactly one or two short sentences.",
            "Write like an engaged assistant narrating concrete work, not like a status dashboard.",
            "Continue the recent narrative when prior reasoning lines are provided instead of restarting from scratch.",
            "Treat beat as the only source of live work context.",
            "Ground each update in the newest concrete task, reason, action, result, or wait target from beat.",
            "Prefer beat.reason when it explains why the current action is happening.",
            "Treat step metadata, milestone names, elapsed time, and raw status values as control data, not user-facing wording.",
            "Do not include markdown, bullet points, quoted user text, tool arguments, raw payloads, or generic telemetry phrasing.",
            "If progress is blocked, use beat.wait to say exactly what I am waiting on.",
            "When beat.wait.prompt is present, restate that exact ask instead of using generic waiting language.",
            "When beat.wait.resumeBehavior is present, mention the concrete next action and that the run resumes automatically.",
            "For nonterminal work, describe only the observed result and selected next action; do not call an attempt last or final, count remaining attempts, or promise imminent completion unless beat explicitly establishes that bound.",
            "When recent reasoning lines are repetitive or procedural, combine the newest action, result, and next step into one more substantive task-level update instead of echoing another operation-by-operation status line.",
            "Avoid repeating wording or sentence structure from the recent reasoning lines.",
          ].join(" "),
        },
        {
          role: "user",
          content: renderReasoningSidecarUserPrompt(serializedContext),
        },
      ],
      input: serializedContext,
      providerOptions: {
        openrouter: {
          temperature: 0.2,
          maxTokens: this.maxTokens,
          toolChoice: "none",
        },
        openai: {
          temperature: 0.2,
          maxTokens: this.maxTokens,
          toolChoice: "none",
        },
        anthropic: {
          temperature: 0.2,
          maxTokens: this.maxTokens,
          toolChoice: "none",
        },
      },
      metadata: {
        nonAuthoritative: true,
        stream: "reasoning_sidecar",
        budgetChannel: "independent",
      },
    };
  }
}

function renderReasoningSidecarUserPrompt(serializedContext: string): string {
  return [
    "Write the next live reasoning update from this runtime snapshot.",
    "",
    "<context_guide>",
    "- `beat` is the single live-work context. Use it before any step metadata.",
    "- `beat.task.objective` and `beat.task.focus` describe the underlying task and current item; use them to avoid generic procedural updates.",
    "- `beat.reason` explains why the current action was chosen when present.",
    "- `beat.action`, `beat.result`, and `beat.wait` describe what changed most recently.",
    "- `recentMessages` contains prior live updates. Continue the narrative without repeating the same wording.",
    "- If recent messages are repetitive or operation-level, compress the next update into a single task-level beat that names the newest result and next useful move.",
    "- `beat.wait.prompt` is the exact user-facing ask when the runtime is waiting for input.",
    "- `beat.wait.resumeBehavior` describes the concrete automatic resume behavior when present.",
    "- For nonterminal work, do not claim an attempt is last or final, count remaining attempts, or promise imminent completion unless `beat` explicitly establishes that bound.",
    "- Step metadata, elapsed time, raw payloads, and tool arguments are control data. Do not expose them directly.",
    "</context_guide>",
    "",
    "<output_rule>",
    "Return plain text only: one or two short first-person sentences grounded in the newest concrete action, result, or wait target.",
    "</output_rule>",
    "",
    "<snapshot_json>",
    serializedContext,
    "</snapshot_json>",
  ].join("\n");
}

function extractActionSummary(
  action: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (action === undefined) {
    return undefined;
  }
  const kind = asString(action.kind);
  if (kind === undefined) {
    return undefined;
  }
  if (kind === "tool") {
    const toolName = asString(action.name);
    const target = readToolTarget(toolName, asRecord(action.input));
    return {
      kind,
      ...(toolName !== undefined ? { toolName } : {}),
      ...(target !== undefined ? { target } : {}),
    };
  }
  if (kind === "tool_batch") {
    const items = Array.isArray(action.items) ? action.items : [];
    const itemSummaries = items
      .map((item) => summarizeToolBatchItem(asRecord(item)))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    const toolNames = itemSummaries
      .map((item) => asString(item.toolName))
      .filter((item): item is string => item !== undefined);
    return {
      kind,
      toolNames,
      toolCount: toolNames.length,
      ...(itemSummaries.some((item) => Object.hasOwn(item, "target"))
        ? { items: itemSummaries.slice(0, 6) }
        : {}),
    };
  }
  if (kind === "effect") {
    const effectType = asString(action.type);
    return {
      kind,
      ...(effectType !== undefined ? { effectType } : {}),
    };
  }
  if (kind === "ask_user") {
    const waitFor = asRecord(action.waitFor);
    const waitMetadata = asRecord(waitFor?.metadata);
    return {
      kind,
      ...(asString(action.prompt) !== undefined ? { prompt: asString(action.prompt) } : {}),
      waitFor: {
        ...(asString(waitFor?.kind) !== undefined ? { kind: asString(waitFor?.kind) } : {}),
        ...(asString(waitFor?.eventType) !== undefined
          ? { eventType: asString(waitFor?.eventType) }
          : {}),
        ...(asString(waitMetadata?.reason) !== undefined ? { reason: asString(waitMetadata?.reason) } : {}),
        ...(asString(waitMetadata?.prompt) !== undefined ? { prompt: asString(waitMetadata?.prompt) } : {}),
        ...(asString(waitMetadata?.requiredToolClass) !== undefined
          ? { requiredToolClass: asString(waitMetadata?.requiredToolClass) }
          : {}),
        ...(asString(waitMetadata?.toolName) !== undefined ? { toolName: asString(waitMetadata?.toolName) } : {}),
        ...(readWaitResumeBehavior(waitMetadata) !== undefined
          ? { resumeBehavior: readWaitResumeBehavior(waitMetadata) }
          : {}),
      },
    };
  }
  if (kind === "cannot_satisfy") {
    return {
      kind,
      ...(asString(action.reasonCode) !== undefined ? { reasonCode: asString(action.reasonCode) } : {}),
    };
  }
  if (kind === "finalize") {
    return {
      kind,
      ...(asString(action.finalizeReason) !== undefined
        ? { finalizeReason: asString(action.finalizeReason) }
        : {}),
    };
  }
  return { kind };
}

function summarizeToolBatchItem(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const toolName = asString(item?.name);
  if (toolName === undefined) {
    return undefined;
  }
  const target = readToolTarget(toolName, asRecord(item?.input));
  return {
    toolName,
    ...(target !== undefined ? { target } : {}),
  };
}

function readToolTarget(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (toolName === undefined || input === undefined) {
    return undefined;
  }
  if (
    toolName === "fs.list" ||
    toolName === "fs.read_text" ||
    toolName === "fs.search_text" ||
    toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.patch_text" ||
    toolName === "fs.create_file"
  ) {
    const path = readNonEmptyString(input.path);
    return path !== undefined ? { kind: "file", path } : undefined;
  }
  if (toolName === "dev.shell.run") {
    const command = readNonEmptyString(input.command);
    return command !== undefined ? { kind: "shell_command", command } : undefined;
  }
  if (toolName === "fs.copy" || toolName === "fs.move") {
    const sourcePath = readNonEmptyString(input.sourcePath);
    const destinationPath = readNonEmptyString(input.destinationPath);
    if (sourcePath === undefined && destinationPath === undefined) {
      return undefined;
    }
    return {
      kind: "file_transfer",
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(destinationPath !== undefined ? { destinationPath } : {}),
    };
  }
  return undefined;
}

function describeVisibleTodoBeat(todos: VisibleTodoState | undefined): Record<string, unknown> | undefined {
  if (todos === undefined) {
    return undefined;
  }
  const activeItem = todos.items.find((item) => item.status === "in_progress");
  const nextItem = activeItem ??
    todos.items.find((item) => item.status === "pending") ??
    todos.items.find((item) => item.status === "blocked");
  return {
    ...(nextItem !== undefined
      ? {
          focus: {
            id: nextItem.id,
            text: nextItem.text,
            status: nextItem.status,
            ...(nextItem.note !== undefined ? { note: nextItem.note } : {}),
          },
        }
      : {}),
    counts: {
      done: todos.items.filter((item) => item.status === "done").length,
      pending: todos.items.filter((item) => item.status === "pending").length,
      blocked: todos.items.filter((item) => item.status === "blocked").length,
      total: todos.items.length,
    },
  };
}

function extractReasoningMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.output === "string") {
    return record.output;
  }
  const output = asRecord(record.output);
  if (output !== undefined) {
    if (typeof output.text === "string") {
      return output.text;
    }
    if (typeof output.message === "string") {
      return output.message;
    }
    if (typeof output.summary === "string") {
      return output.summary;
    }
  }
  return undefined;
}

function extractModelMetadata(
  value: unknown,
  latencyMs: number,
): ReasoningUpdateV1["model"] | undefined {
  const provider = asRecord(asRecord(value)?.provider);
  if (provider === undefined) {
    return {
      latencyMs,
    };
  }
  return {
    ...(asString(provider.name) !== undefined ? { provider: asString(provider.name) } : {}),
    ...(asString(provider.model) !== undefined ? { model: asString(provider.model) } : {}),
    ...(asString(provider.endpoint) !== undefined ? { endpoint: asString(provider.endpoint) } : {}),
    ...(asString(provider.requestId) !== undefined ? { requestId: asString(provider.requestId) } : {}),
    latencyMs,
  };
}

function createTimeoutSignal(timeoutMs: number, parent?: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const onAbort = () => {
    controller.abort();
  };
  if (parent !== undefined) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (parent !== undefined) {
        parent.removeEventListener("abort", onAbort);
      }
    },
  };
}

function isReasoningStep(stepAgent: string | undefined): boolean {
  return typeof stepAgent === "string" && stepAgent.startsWith("agent.");
}

function hasMeaningfulToolSelectionChange(
  previousAction: Record<string, unknown> | undefined,
  currentAction: Record<string, unknown> | undefined,
): boolean {
  const currentKind = asString(currentAction?.kind);
  if (currentKind !== "tool" && currentKind !== "tool_batch") {
    return false;
  }
  return summarizeActionForComparison(previousAction) !== summarizeActionForComparison(currentAction);
}

function hasMeaningfulEffectSelection(
  transition: Transition,
  currentActionKind: string | undefined,
): boolean {
  if (currentActionKind === "effect") {
    return true;
  }
  return (transition.effects ?? []).length > 0;
}

function hasMeaningfulActionStateChange(
  previousAction: Record<string, unknown> | undefined,
  currentAction: Record<string, unknown> | undefined,
): boolean {
  const currentKind = asString(currentAction?.kind);
  if (currentKind !== "finalize" && currentKind !== "cannot_satisfy" && currentKind !== "ask_user") {
    return false;
  }
  return summarizeActionForComparison(previousAction) !== summarizeActionForComparison(currentAction);
}

function summarizeActionForComparison(action: Record<string, unknown> | undefined): string | undefined {
  const summary = extractActionSummary(action);
  return summary !== undefined ? JSON.stringify(summary) : undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readCapabilityClassesFromFeedback(react: Record<string, unknown>): string[] {
  const capabilities = new Set<string>();
  const add = (value: unknown): void => {
    for (const item of toStringArray(value)) {
      capabilities.add(item.trim());
    }
  };
  for (const observation of Array.isArray(react.observations) ? react.observations : []) {
    add(asRecord(observation)?.capabilityClasses);
  }
  const lastActionResult = asRecord(react.lastActionResult);
  add(lastActionResult?.capabilityClasses);
  for (const item of Array.isArray(lastActionResult?.items) ? lastActionResult.items : []) {
    add(asRecord(item)?.capabilityClasses);
  }
  return [...capabilities];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateToSentenceBudget(value: string, sentenceBudget: number): string {
  if (sentenceBudget <= 0) {
    return value;
  }
  const matches = value.match(/[^.!?]+[.!?]+/gu);
  if (matches === null || matches.length === 0) {
    return value;
  }
  const limited = matches.slice(0, sentenceBudget).join(" ").trim();
  return collapseWhitespace(limited.length > 0 ? limited : value);
}

function countSentences(value: string): number {
  const withPunctuation = value.match(/[^.!?]+[.!?]+/gu);
  if (withPunctuation !== null) {
    return withPunctuation.length;
  }
  return value.length > 0 ? 1 : 0;
}

function normalizeRecentMessages(value: string[] | undefined): string[] {
  return toStringArray(value).slice(-MAX_REASONING_HISTORY);
}

function readWaitResumeBehavior(
  metadata: Record<string, unknown> | undefined,
): "auto_resume_on_valid_mode_switch" | undefined {
  const reason = asString(metadata?.reason);
  if (
    reason === "route_mode_blocked" ||
    reason === "planner_mode_blocked" ||
    reason === "acter_mode_blocked"
  ) {
    return "auto_resume_on_valid_mode_switch";
  }
  return undefined;
}

function isDuplicateReasoningMessage(message: string, recentMessages: string[] | undefined): boolean {
  const normalized = collapseWhitespace(message).toLowerCase();
  return normalizeRecentMessages(recentMessages).some(
    (entry) => collapseWhitespace(entry).toLowerCase() === normalized,
  );
}

function readObservationDelta(
  previousReact: Record<string, unknown>,
  currentReact: Record<string, unknown>,
): string | undefined {
  const previousCount = Array.isArray(previousReact.observations) ? previousReact.observations.length : 0;
  const currentCount = Array.isArray(currentReact.observations) ? currentReact.observations.length : 0;
  if (currentCount > previousCount) {
    const latestEvidenceDelta =
      asRecord(currentReact.latestEvidenceDelta) ?? asRecord(previousReact.latestEvidenceDelta);
    if (asString(latestEvidenceDelta?.kind) === "duplicate_cached_result") {
      const toolName = asString(latestEvidenceDelta?.toolName);
      return toolName !== undefined
        ? `received the same cached result again from '${toolName}'`
        : "received the same cached result again";
    }
    if (asString(latestEvidenceDelta?.kind) === "duplicate_executed_result") {
      const toolName = asString(latestEvidenceDelta?.toolName);
      return toolName !== undefined
        ? `executed '${toolName}' again and got the same result`
        : "executed a tool again and got the same result";
    }
    const freshResult = summarizeFreshResultDelta(currentReact, currentCount - previousCount);
    if (freshResult !== undefined) {
      return freshResult;
    }
    return currentCount - previousCount === 1
      ? "picked up one new result"
      : `picked up ${currentCount - previousCount} new results`;
  }
  return undefined;
}

function summarizeFreshResultDelta(
  react: Record<string, unknown>,
  observationDeltaCount: number,
): string | undefined {
  const lastActionResult = asRecord(react.lastActionResult);
  const kind = asString(lastActionResult?.kind);
  if (kind === "tool") {
    const toolName = asString(lastActionResult?.toolName) ?? asString(lastActionResult?.name);
    if (toolName === undefined) {
      return undefined;
    }
    const targetText = renderToolTarget(readToolTarget(toolName, asRecord(lastActionResult?.input)));
    return targetText !== undefined
      ? `received a result from ${toolName} for ${targetText}`
      : `received a result from ${toolName}`;
  }
  if (kind === "tool_batch") {
    const items = asArray(lastActionResult?.items)
      .map((item) => summarizeToolBatchItem(asRecord(item)))
      .filter((item): item is Record<string, unknown> => item !== undefined);
    if (items.length === 0) {
      return undefined;
    }
    const namedTargets = items
      .map((item) => {
        const toolName = asString(item.toolName);
        const targetText = renderToolTarget(asRecord(item.target));
        if (toolName === undefined) {
          return undefined;
        }
        return targetText !== undefined ? `${toolName} for ${targetText}` : toolName;
      })
      .filter((item): item is string => item !== undefined)
      .slice(0, 3);
    if (namedTargets.length === 0) {
      return undefined;
    }
    const suffix = items.length > namedTargets.length ? ` and ${items.length - namedTargets.length} more` : "";
    return `received ${observationDeltaCount} new results from ${namedTargets.join(", ")}${suffix}`;
  }
  return undefined;
}

function renderToolTarget(target: Record<string, unknown> | undefined): string | undefined {
  const kind = asString(target?.kind);
  if (kind === "file") {
    return asString(target?.path);
  }
  if (kind === "file_transfer") {
    const sourcePath = asString(target?.sourcePath);
    const destinationPath = asString(target?.destinationPath);
    if (sourcePath !== undefined && destinationPath !== undefined) {
      return `${sourcePath} -> ${destinationPath}`;
    }
    return sourcePath ?? destinationPath;
  }
  if (kind === "shell_command") {
    return asString(target?.command);
  }
  return undefined;
}

function safeJSONStringify(value: unknown, limit: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= limit) {
    return serialized;
  }
  return `${serialized.slice(0, limit - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEnvBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function parseEnvPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) === false || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readErrorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code;
  return typeof code === "string" ? code : undefined;
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  const message = asRecord(error)?.message;
  return typeof message === "string" ? message : undefined;
}

function describeResponseShape(value: unknown): {
  responseKeys: string[];
  outputKeys: string[];
  contentShape?: string | undefined;
} {
  const record = asRecord(value);
  if (record === undefined) {
    return {
      responseKeys: [],
      outputKeys: [],
      contentShape: describeValueShape(value),
    };
  }

  const output = record.output;
  return {
    responseKeys: Object.keys(record).slice(0, 20),
    outputKeys: asRecord(output) !== undefined ? Object.keys(asRecord(output)!).slice(0, 20) : [],
    contentShape: [
      `root:${describeValueShape(value)}`,
      `output:${describeValueShape(output)}`,
    ].join(" "),
  };
}

function describeProvider(value: unknown): {
  providerName?: string | undefined;
  providerModel?: string | undefined;
  providerEndpoint?: string | undefined;
} {
  const provider = asRecord(asRecord(value)?.provider);
  if (provider === undefined) {
    return {};
  }
  return {
    ...(asString(provider.name) !== undefined ? { providerName: asString(provider.name) } : {}),
    ...(asString(provider.model) !== undefined ? { providerModel: asString(provider.model) } : {}),
    ...(asString(provider.endpoint) !== undefined ? { providerEndpoint: asString(provider.endpoint) } : {}),
  };
}

function describeValueShape(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  return typeof value;
}
