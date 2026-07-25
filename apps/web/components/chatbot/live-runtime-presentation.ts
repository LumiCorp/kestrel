import type {
  KestrelProgressPresentation,
  KestrelProviderReasoningPresentation,
} from "@kestrel-agents/ai-sdk";

export const MAX_LIVE_REASONING_BYTES = 64 * 1024;
export const LIVE_REASONING_TRUNCATION_NOTICE =
  "[Earlier live reasoning was truncated.]\n\n";

export type LiveProviderReasoning = {
  assistantMessageId: string;
  runId: string;
  attempt: number;
  format: KestrelProviderReasoningPresentation["format"];
  text: string;
  truncated: boolean;
  isStreaming: boolean;
};

export type LiveActivityStatus = {
  assistantMessageId: string;
  phase: string;
  text: string;
  severity: "info" | "error";
  kind: "progress" | "reasoning_unavailable";
};

export type LiveRuntimePresentation = {
  assistantMessageId: string;
  reasoning: LiveProviderReasoning | null;
  activityStatus: LiveActivityStatus | null;
  reasoningStatus: LiveActivityStatus | null;
};

export function applyLiveProgress(
  current: LiveRuntimePresentation | null,
  progress: KestrelProgressPresentation,
): LiveRuntimePresentation | null {
  if (progress.persist !== false || !progress.assistantMessageId) {
    return current;
  }
  const next = forAssistantMessage(current, progress.assistantMessageId);
  return {
    ...next,
    activityStatus: {
      assistantMessageId: progress.assistantMessageId,
      phase: progress.phase,
      text: progress.text,
      severity: progress.severity,
      kind: "progress",
    },
  };
}

export function applyProviderRetry(
  current: LiveRuntimePresentation | null,
  progress: KestrelProgressPresentation,
): LiveRuntimePresentation | null {
  if (
    progress.code !== "MODEL_ATTEMPT_RETRYING" ||
    !progress.assistantMessageId
  ) {
    return current;
  }
  const next = forAssistantMessage(current, progress.assistantMessageId);
  return {
    ...next,
    reasoning: null,
    activityStatus: null,
    reasoningStatus: null,
  };
}

export function applyProviderReasoning(
  current: LiveRuntimePresentation | null,
  update: KestrelProviderReasoningPresentation,
): LiveRuntimePresentation | null {
  if (!update.assistantMessageId) {
    return current;
  }
  const next = forAssistantMessage(current, update.assistantMessageId);
  const existing = next.reasoning;
  if (existing && existing.attempt > update.attempt) {
    return next;
  }

  if (update.event === "unavailable") {
    return {
      ...next,
      reasoning: null,
      reasoningStatus: {
        assistantMessageId: update.assistantMessageId,
        phase: "chat",
        text: "Provider reasoning is unavailable for this model.",
        severity: "info",
        kind: "reasoning_unavailable",
      },
    };
  }

  const sameStream =
    existing?.attempt === update.attempt &&
    existing.format === update.format &&
    existing.runId === update.runId;
  const stream: LiveProviderReasoning =
    sameStream && existing
      ? existing
      : {
        assistantMessageId: update.assistantMessageId,
        runId: update.runId,
        attempt: update.attempt,
        format: update.format,
        text: "",
        truncated: false,
        isStreaming: true,
      };

  if (update.event === "delta" && update.contentState === "live" && update.delta) {
    const appended = appendReasoningTail(stream, update.delta);
    return {
      ...next,
      reasoning: { ...appended, isStreaming: true },
      reasoningStatus: null,
    };
  }

  if (update.event === "completed" || update.event === "failed") {
    return {
      ...next,
      reasoning: stream.text
        ? { ...stream, isStreaming: false }
        : null,
      reasoningStatus: null,
    };
  }

  return {
    ...next,
    reasoning: { ...stream, isStreaming: true },
    reasoningStatus: null,
  };
}

export function finishLiveRuntimePresentation(
  current: LiveRuntimePresentation | null,
): LiveRuntimePresentation | null {
  if (!current) {
    return null;
  }
  return {
    ...current,
    reasoning: current.reasoning
      ? { ...current.reasoning, isStreaming: false }
      : null,
    activityStatus: null,
  };
}

export function displayLiveReasoning(
  reasoning: LiveProviderReasoning,
): string {
  return reasoning.truncated
    ? `${LIVE_REASONING_TRUNCATION_NOTICE}${reasoning.text}`
    : reasoning.text;
}

function forAssistantMessage(
  current: LiveRuntimePresentation | null,
  assistantMessageId: string,
): LiveRuntimePresentation {
  if (current?.assistantMessageId === assistantMessageId) {
    return current;
  }
  return {
    assistantMessageId,
    reasoning: null,
    activityStatus: null,
    reasoningStatus: null,
  };
}

function appendReasoningTail(
  current: LiveProviderReasoning,
  delta: string,
): LiveProviderReasoning {
  const combined = `${current.text}${delta}`;
  const encoded = new TextEncoder().encode(combined);
  if (encoded.byteLength <= MAX_LIVE_REASONING_BYTES && !current.truncated) {
    return { ...current, text: combined };
  }
  let start = Math.max(0, encoded.byteLength - MAX_LIVE_REASONING_BYTES);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return {
    ...current,
    text: new TextDecoder().decode(encoded.slice(start)),
    truncated: true,
  };
}
