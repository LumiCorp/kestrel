export type ConversationMode = "chat" | "plan" | "build";

export type ConversationTurnStatus =
  | "queued"
  | "running"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "cancelled";

export type ConversationTerminalStatus =
  | "working"
  | "completed"
  | "waiting"
  | "failed"
  | "cancelled"
  | "contract_failure";

export type ConversationDeliveryState = "submitting" | "queued";

export interface ConversationMessageMetadata {
  terminalStatus: ConversationTerminalStatus;
  turnId?: string | undefined;
  runId?: string | undefined;
  requestId?: string | undefined;
  deliveryState?: ConversationDeliveryState | undefined;
  contractFailure?: { code: string; message: string } | undefined;
}

export interface ConversationMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  metadata?: {
    kestrelTurnId?: string | undefined;
    kestrelRunId?: string | undefined;
    deliveryState?: string | undefined;
  } | undefined;
}

export interface ConversationTurn {
  id: string;
  threadId?: string | undefined;
  sequence: number | null;
  inputMessageId: string | null;
  status: ConversationTurnStatus;
  rootRunId?: string | null | undefined;
  activeRunId?: string | null | undefined;
  terminalRunId?: string | null | undefined;
  failureCode?: string | null | undefined;
  failureMessage?: string | null | undefined;
  cancelRequestedAt?: string | null | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationInteraction {
  id: string;
  requestId: string;
  source: "runtime" | "mcp";
  kind: "user_input" | "approval" | "mcp_sampling" | "mcp_elicitation";
  eventType: string;
  prompt: string;
  status: "pending" | "processing" | "resolved" | "cancelled" | "failed";
  turnId: string | null;
  assistantMessageId: string | null;
  responseMessageId: string | null;
  createdAt: string;
  resolvedAt?: string | null | undefined;
  requestEnvelope?: Record<string, unknown> | undefined;
  responseEnvelope?: Record<string, unknown> | null | undefined;
}

export interface ConversationQueueState {
  state: "running" | "paused";
  pauseReason: "turn_failed" | "turn_cancelled" | "interaction_required" | null;
  activeTurnId: string | null;
  version: number;
}

export interface ConversationSnapshot<Message extends ConversationMessageLike = ConversationMessageLike> {
  threadId: string;
  /**
   * The host's durable transcript order. This order never establishes turn
   * ownership; after ownership is established, projection preserves it unless
   * explicit turn or interaction identities require a causal reordering.
   */
  messages: Message[];
  turns: ConversationTurn[];
  interactions: ConversationInteraction[];
  queue: ConversationQueueState;
}

export interface ConversationProgressPresentation {
  id: string;
  assistantMessageId?: string | undefined;
  runId?: string | undefined;
  sequence?: number | undefined;
  timestamp: string;
  source: "runtime" | "environment" | "worker";
  phase: string;
  code: string;
  text: string;
  severity: "info" | "error";
  persist?: boolean | undefined;
}

export interface ConversationAgentProgressPresentation {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  text: string;
  stepAgent: string;
  label: "Agent progress";
}

export interface ConversationProviderReasoningPresentation {
  id: string;
  assistantMessageId?: string | undefined;
  runId: string;
  sequence: number;
  timestamp: string;
  attempt: number;
  format: "summary" | "provider_thinking" | "provider_reasoning_text";
  label: "Provider reasoning summary" | "Provider-visible thinking" | "Provider reasoning" | "Provider reasoning unavailable";
  event: "started" | "delta" | "completed" | "failed" | "unavailable";
  contentState: "live" | "not_retained";
  delta?: string | undefined;
}

export interface ConversationToolPresentation {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  toolCallId: string;
  toolName: string;
  phase: "started" | "completed" | "failed";
  displayName?: string | undefined;
  provider?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?: { code?: string | undefined; message: string } | undefined;
}

export interface ConversationCitationPresentation {
  id: string;
  title: string;
  url?: string | undefined;
  documentId?: string | undefined;
  excerpt?: string | undefined;
}

export interface ConversationArtifactPresentation {
  id: string;
  title: string;
  kind: string;
  url?: string | undefined;
  mediaType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConversationLinkPresentation {
  id: string;
  url: string;
  title?: string | undefined;
  label?: string | undefined;
}

export interface ConversationInteractionPresentation<Approval = unknown> {
  version: "v1";
  requestId: string;
  kind: "user_input" | "approval" | "mcp_sampling" | "mcp_elicitation";
  eventType: string;
  prompt: string;
  inputSchema?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  approval?: Approval | undefined;
  source?: "runtime" | "mcp" | undefined;
  status: "pending" | "processing" | "resolved" | "cancelled" | "failed";
  approvalOutcome?: {
    decision: "approved" | "denied";
    authorizationState: "pending" | "accepted" | "failed";
    effectState: "not_started" | "started" | "unknown";
    failureCode?: string | undefined;
    publicMessage?: string | undefined;
    retryEligible: boolean;
  } | undefined;
}

export interface ConversationStatusPresentation {
  status: ConversationTerminalStatus;
  runId?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export interface ConversationDialogMessagePresentation {
  version: "v1";
  messageId: string;
  dialogId: string;
  name: string;
  childSessionId: string;
  sender: "kestrel" | "collaborator" | "system";
  text: string;
  createdAt: string;
  dialogStatus: "open" | "closed";
  dialogActivity?: "idle" | "working" | "waiting" | "interrupted" | undefined;
  status?: "failed" | "cancelled" | undefined;
}

export interface ConversationModeSwitchPresentation {
  version: "v1";
  recommendationId: string;
  fromMode: ConversationMode;
  toMode: ConversationMode;
  reason: string;
  originatingMessageId: string;
  status: "pending" | "accepted" | "dismissed";
}

export type ConversationPresentationPart =
  | { kind: "text"; text: string; streaming?: boolean | undefined }
  | { kind: "progress"; data: ConversationProgressPresentation }
  | { kind: "agent_progress"; data: ConversationAgentProgressPresentation }
  | { kind: "provider_reasoning"; data: ConversationProviderReasoningPresentation }
  | { kind: "tool"; data: ConversationToolPresentation }
  | { kind: "citation"; data: ConversationCitationPresentation }
  | { kind: "artifact"; data: ConversationArtifactPresentation }
  | { kind: "link"; data: ConversationLinkPresentation }
  | { kind: "interaction"; data: ConversationInteractionPresentation }
  | { kind: "status"; data: ConversationStatusPresentation }
  | { kind: "dialog_message"; data: ConversationDialogMessagePresentation }
  | { kind: "mode_switch"; data: ConversationModeSwitchPresentation };

export type ConversationRendererMap<Output> = {
  [Kind in ConversationPresentationPart["kind"]]: (
    part: Extract<ConversationPresentationPart, { kind: Kind }>,
  ) => Output;
};

export interface ConversationCommandAdapter<
  TurnSubmission,
  InteractionAnswer extends { requestId: string },
  Result = void,
> {
  startTurn(submission: TurnSubmission): Promise<Result>;
  queueTurn(submission: TurnSubmission): Promise<Result>;
  answerInteraction(answer: InteractionAnswer): Promise<Result>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<Result>;
  switchModeAndRetry(input: {
    recommendationId: string;
    mode: ConversationMode;
    answer: InteractionAnswer;
  }): Promise<Result>;
}
