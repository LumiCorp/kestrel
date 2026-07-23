import type { RunnerInteractionRequestV1 } from "@kestrel-agents/protocol";
import type { RunnerTelemetry } from "@kestrel-agents/sdk";
import type { UIMessage } from "ai";

export type KestrelTerminalStatus =
  | "working"
  | "completed"
  | "waiting"
  | "failed"
  | "cancelled"
  | "contract_failure";

export interface KestrelProgressPresentation {
  id: string;
  runId?: string | undefined;
  sequence?: number | undefined;
  timestamp: string;
  source: "runtime" | "environment" | "worker";
  phase: string;
  code: string;
  text: string;
  severity: "info" | "error";
}

export interface KestrelAgentProgressPresentation {
  id: string;
  runId: string;
  sequence: number;
  timestamp: string;
  text: string;
  stepAgent: string;
  label: "Agent progress";
}

export interface KestrelProviderReasoningPresentation {
  id: string;
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

export interface KestrelToolPresentation {
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

export interface KestrelCitationPresentation {
  id: string;
  title: string;
  url?: string | undefined;
  documentId?: string | undefined;
  excerpt?: string | undefined;
}

export interface KestrelArtifactPresentation {
  id: string;
  title: string;
  kind: string;
  url?: string | undefined;
  mediaType?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type KestrelInteractionKind =
  | RunnerInteractionRequestV1["kind"]
  | "mcp_sampling"
  | "mcp_elicitation";

export interface KestrelInteractionPresentation {
  version: "v1";
  requestId: string;
  kind: KestrelInteractionKind;
  eventType: string;
  prompt: string;
  inputSchema?: Record<string, unknown> | undefined;
  approval?: RunnerInteractionRequestV1["approval"];
  source?: "runtime" | "mcp" | undefined;
  status: "pending" | "resolved" | "cancelled";
}

export interface KestrelStatusPresentation {
  status: KestrelTerminalStatus;
  runId?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export interface KestrelDialogMessagePresentation {
  version: "v1";
  messageId: string;
  dialogId: string;
  name: string;
  childSessionId: string;
  sender: "kestrel" | "collaborator" | "system";
  text: string;
  createdAt: string;
  dialogStatus: "open" | "closed";
  status?: "failed" | "cancelled" | undefined;
}

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
  failureVisible: boolean;
  interaction: KestrelInteractionPresentation | null;
  finalizedPayload?: unknown | undefined;
  telemetry?: RunnerTelemetry | undefined;
}
