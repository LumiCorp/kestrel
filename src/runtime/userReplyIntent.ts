import type {
  ModelRequest,
  ModelResponse,
} from "../kestrel/contracts/model-io.js";

export type UserReplyIntentKind =
  | "continue"
  | "mode_switch"
  | "approval_decision"
  | "provide_information"
  | "unrelated";

export type UserReplyIntentConfidence = "high" | "low";
export type UserReplyIntentDecision = "approve" | "deny";
export type UserReplyIntentInteractionMode = "chat" | "plan" | "build";
export type UserReplyIntentActSubmode = "strict" | "safe" | "full_auto";

export interface UserReplyIntent {
  kind: UserReplyIntentKind;
  proceed?: boolean | undefined;
  decision?: UserReplyIntentDecision | undefined;
  interactionMode?: UserReplyIntentInteractionMode | undefined;
  actSubmode?: UserReplyIntentActSubmode | undefined;
  confidence: UserReplyIntentConfidence;
  reason?: string | undefined;
}

export interface UserReplyIntentWaitContract {
  eventType?: string | undefined;
  metadata?: unknown;
}

export type UserReplyIntentModelCaller = <T>(request: ModelRequest) => Promise<T | ModelResponse<unknown>>;

export interface ClassifyUserReplyIntentInput {
  reply: unknown;
  waitFor?: UserReplyIntentWaitContract | undefined;
  model?: string | undefined;
  useModel: UserReplyIntentModelCaller;
}

export const USER_REPLY_INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["continue", "mode_switch", "approval_decision", "provide_information", "unrelated"],
    },
    proceed: { type: "boolean" },
    decision: { type: "string", enum: ["approve", "deny"] },
    interactionMode: { type: "string", enum: ["chat", "plan", "build"] },
    confidence: { type: "string", enum: ["high", "low"] },
    reason: { type: "string" },
  },
  required: ["kind", "confidence"],
};

export function readUserReplyIntent(value: unknown): UserReplyIntent | undefined {
  const record = asRecord(value);
  const kind = readKind(record?.kind);
  const confidence = readConfidence(record?.confidence);
  if (kind === undefined || confidence === undefined) {
    return ;
  }
  const proceed = typeof record?.proceed === "boolean" ? record.proceed : undefined;
  const decision = readDecision(record?.decision);
  const interactionMode = readInteractionMode(record?.interactionMode);
  const reason = readString(record?.reason);
  return {
    kind,
    confidence,
    ...(proceed !== undefined ? { proceed } : {}),
    ...(decision !== undefined ? { decision } : {}),
    ...(interactionMode !== undefined ? { interactionMode } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function parseExplicitModeCommand(reply: unknown):
  | { interactionMode: UserReplyIntentInteractionMode; actSubmode?: UserReplyIntentActSubmode | undefined }
  | undefined {
  if (typeof reply !== "string") {
    return ;
  }
  const normalized = normalizeReply(reply);
  if (normalized.startsWith("/mode ") === false) {
    return ;
  }
  return parseModePhrase(normalized.slice("/mode ".length).trim());
}

export async function classifyUserReplyIntent(
  input: ClassifyUserReplyIntentInput,
): Promise<UserReplyIntent> {
  const explicitMode = parseExplicitModeCommand(input.reply);
  if (explicitMode !== undefined) {
    return {
      kind: "mode_switch",
      proceed: true,
      interactionMode: explicitMode.interactionMode,
      confidence: "high",
      reason: "explicit_mode_command",
    };
  }

  const message = readString(input.reply);
  if (message === undefined) {
    return unresolved("empty_or_non_string_reply");
  }

  try {
    const context = {
      waitFor: summarizeWaitFor(input.waitFor),
      userReply: message,
    };
    const response = await input.useModel<ModelResponse<unknown>>({
      model: input.model,
      responseFormat: "json",
      messages: [
        {
          role: "system",
          content: buildUserReplyIntentSystemPrompt(),
        },
        {
          role: "user",
          content: renderUserReplyIntentPrompt(context),
        },
      ],
      input: context,
      responseSchema: USER_REPLY_INTENT_SCHEMA,
      providerOptions: {
        openrouter: {
          endpoint: "chat",
          toolChoice: "none",
          responseSchemaName: "kestrel_user_reply_intent",
        },
        openai: {
          toolChoice: "none",
          responseSchemaName: "kestrel_user_reply_intent",
        },
        anthropic: {
          toolChoice: "none",
          responseSchemaName: "kestrel_user_reply_intent",
        },
      },
      metadata: {
        phase: "runtime.user_reply_intent",
        modelRole: "user_reply_intent",
      },
    });
    return readUserReplyIntent(readModelRoot(response)) ?? unresolved("invalid_model_reply");
  } catch {
    return unresolved("classification_failed");
  }
}

function buildUserReplyIntentSystemPrompt(): string {
  return [
    "You are Kestrel's User Reply Classifier.",
    "Your job is to classify one user reply against a runtime wait contract. You do not continue the run, approve tools, switch modes, or answer the user directly.",
    "Return only JSON matching the schema.",
    "Base the classification only on the wait contract and user reply in the user message.",
    "The wait contract is authoritative context.",
    "Use high confidence only when the user's control intent is unambiguous.",
    "Never approve, deny, switch modes, or continue on mixed or uncertain language.",
  ].join(" ");
}

export function renderUserReplyIntentPrompt(context: {
  waitFor: Record<string, unknown> | undefined;
  userReply: string;
}): string {
  return [
    "Classify the user's reply to the paused runtime.",
    "",
    "Return one JSON object that matches the response schema.",
    "",
    "<context_guide>",
    "- `waitFor.eventType` names the event the runtime is waiting for.",
    "- `waitFor.reason` and `waitFor.purpose` explain why the runtime paused.",
    "- `waitFor.resumeReply` and `waitFor.resumeCommand` describe continuation wording when present.",
    "- `waitFor.approvalId`, `waitFor.toolName`, `waitFor.toolClass`, and `waitFor.riskLevel` describe a pending approval when present.",
    "- `userReply` is the user's new message. Classify its control intent; do not answer it.",
    "</context_guide>",
    "",
    "<classification_rules>",
    "Choose kind='continue' only when the user unambiguously wants the paused run to proceed without adding a new instruction.",
    "Choose kind='mode_switch' only when the user unambiguously accepts or requests the mode needed by the wait contract; include interactionMode when known.",
    "Choose kind='approval_decision' only for a user.approval wait and only when the reply clearly approves or denies the pending approval; include decision='approve' or decision='deny'.",
    "Choose kind='provide_information' when the reply answers the paused question or gives a narrower instruction instead of simply resuming.",
    "Choose kind='unrelated' for unrelated, mixed, contradictory, or uncertain replies.",
    "Use high confidence only when the user's control intent is unambiguous.",
    "Never approve, deny, switch modes, or continue on mixed or uncertain language.",
    "</classification_rules>",
    "",
    "<context_json>",
    JSON.stringify(context),
    "</context_json>",
  ].join("\n");
}

export function isHighConfidenceContinuation(intent: UserReplyIntent | undefined): boolean {
  return intent?.kind === "continue" && intent.proceed === true && intent.confidence === "high";
}

export function readHighConfidenceApprovalDecision(
  intent: UserReplyIntent | undefined,
): UserReplyIntentDecision | undefined {
  return intent?.kind === "approval_decision" && intent.confidence === "high"
    ? intent.decision
    : undefined;
}

function unresolved(reason: string): UserReplyIntent {
  return {
    kind: "unrelated",
    proceed: false,
    confidence: "low",
    reason,
  };
}

function readModelRoot(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.output !== undefined) {
    return record.output;
  }
  const text = readString(record?.text);
  if (text !== undefined) {
    try {
      return JSON.parse(text);
    } catch {
      return ;
    }
  }
  return value;
}

function summarizeWaitFor(waitFor: UserReplyIntentWaitContract | undefined): Record<string, unknown> | undefined {
  const metadata = asRecord(waitFor?.metadata);
  if (waitFor === undefined && metadata === undefined) {
    return ;
  }
  return {
    eventType: waitFor?.eventType,
    reason: readString(metadata?.reason),
    purpose: readString(metadata?.purpose),
    requiredToolClass: readString(metadata?.requiredToolClass),
    requiredMode: readString(metadata?.requiredMode),
    resumeReply: readString(metadata?.resumeReply),
    resumeCommand: readString(metadata?.resumeCommand),
    approvalId: readString(metadata?.approvalId),
    toolName: readString(metadata?.toolName),
    toolClass: readString(metadata?.toolClass),
    riskLevel: readString(metadata?.riskLevel),
    question: readString(metadata?.question),
    prompt: readString(metadata?.prompt),
    blockedOn: readString(metadata?.blockedOn),
    suggestedNextFile: readString(metadata?.suggestedNextFile),
  };
}

function parseModePhrase(value: string):
  | { interactionMode: UserReplyIntentInteractionMode; actSubmode?: UserReplyIntentActSubmode | undefined }
  | undefined {
  const phrase = normalizeReply(value);
  if (phrase === "chat") {
    return { interactionMode: "chat" };
  }
  if (phrase === "plan") {
    return { interactionMode: "plan" };
  }
  if (phrase === "build") {
    return { interactionMode: "build" };
  }
  return ;
}

function normalizeReply(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/[.!?,:;]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function readKind(value: unknown): UserReplyIntentKind | undefined {
  return value === "continue" ||
    value === "mode_switch" ||
    value === "approval_decision" ||
    value === "provide_information" ||
    value === "unrelated"
    ? value
    : undefined;
}

function readConfidence(value: unknown): UserReplyIntentConfidence | undefined {
  return value === "high" || value === "low" ? value : undefined;
}

function readDecision(value: unknown): UserReplyIntentDecision | undefined {
  return value === "approve" || value === "deny" ? value : undefined;
}

function readInteractionMode(value: unknown): UserReplyIntentInteractionMode | undefined {
  return value === "chat" || value === "plan" || value === "build" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
