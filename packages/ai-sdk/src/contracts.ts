import type { RunnerInteractionRequestV1 } from "@kestrel-agents/protocol";
import type { RunnerTelemetry } from "@kestrel-agents/sdk";
import type {
  ConversationAgentProgressPresentation,
  ConversationArtifactPresentation,
  ConversationCitationPresentation,
  ConversationDialogMessagePresentation,
  ConversationInteractionPresentation,
  ConversationModeSwitchPresentation,
  ConversationProgressPresentation,
  ConversationProviderReasoningPresentation,
  ConversationStatusPresentation,
  ConversationTerminalStatus,
  ConversationToolPresentation,
} from "@kestrel-agents/conversation";
import type { UIMessage } from "ai";

export type KestrelTerminalStatus = ConversationTerminalStatus;
export type KestrelProgressPresentation = ConversationProgressPresentation;
export type KestrelAgentProgressPresentation = ConversationAgentProgressPresentation;
export type KestrelProviderReasoningPresentation = ConversationProviderReasoningPresentation;
export type KestrelToolPresentation = ConversationToolPresentation;
export type KestrelCitationPresentation = ConversationCitationPresentation;
export type KestrelArtifactPresentation = ConversationArtifactPresentation;

export type KestrelInteractionKind =
  | RunnerInteractionRequestV1["kind"]
  | "mcp_sampling"
  | "mcp_elicitation";

export type KestrelInteractionPresentation = ConversationInteractionPresentation<
  RunnerInteractionRequestV1["approval"]
>;
export type KestrelStatusPresentation = ConversationStatusPresentation;
export type KestrelDialogMessagePresentation = ConversationDialogMessagePresentation;
export type KestrelModeSwitchPresentation = ConversationModeSwitchPresentation;

export interface KestrelMessageMetadata {
  kestrelTerminalStatus: KestrelTerminalStatus;
  /** Durable product turn that owns this assistant stream segment. */
  kestrelTurnId?: string | undefined;
  kestrelRunId?: string | undefined;
  kestrelRequestId?: string | undefined;
  kestrelContractFailure?: {
    code: string;
    message: string;
  } | undefined;
}

export const KESTREL_PRESENTATION_DATA_PART_KEYS = [
  "kestrel-progress",
  "kestrel-agent-progress",
  "kestrel-provider-reasoning",
  "kestrel-tool",
  "kestrel-citation",
  "kestrel-artifact",
  "kestrel-interaction",
  "kestrel-status",
  "kestrel-dialog-message",
  "kestrel-mode-switch",
] as const;

export type KestrelPresentationDataPartKey =
  (typeof KESTREL_PRESENTATION_DATA_PART_KEYS)[number];

type KestrelPresentationDataPartPayloads = {
  "kestrel-progress": KestrelProgressPresentation;
  "kestrel-agent-progress": KestrelAgentProgressPresentation;
  "kestrel-provider-reasoning": KestrelProviderReasoningPresentation;
  "kestrel-tool": KestrelToolPresentation;
  "kestrel-citation": KestrelCitationPresentation;
  "kestrel-artifact": KestrelArtifactPresentation;
  "kestrel-interaction": KestrelInteractionPresentation;
  "kestrel-status": KestrelStatusPresentation;
  "kestrel-dialog-message": KestrelDialogMessagePresentation;
  "kestrel-mode-switch": KestrelModeSwitchPresentation;
};

export type KestrelPresentationDataParts = {
  [Key in KestrelPresentationDataPartKey]:
    KestrelPresentationDataPartPayloads[Key];
};

export type KestrelUIMessage = UIMessage<
  KestrelMessageMetadata,
  KestrelPresentationDataParts
>;

export type KestrelPresentationPart = KestrelUIMessage["parts"][number];

export interface KestrelPresentationSnapshot {
  message: KestrelUIMessage;
  assistantText: string | null;
  terminalStatus: KestrelTerminalStatus;
  errorMessage: string | null;
  errorCode?: string | undefined;
  failureVisible: boolean;
  interaction: KestrelInteractionPresentation | null;
  finalizedPayload?: unknown | undefined;
  telemetry?: RunnerTelemetry | undefined;
}
