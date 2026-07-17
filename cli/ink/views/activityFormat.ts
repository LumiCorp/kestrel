import type { AgentRunLogLine } from "../../contracts.js";

export interface ActivityPresentation {
  summary: string;
  context: string;
}

export function formatActivityPresentation(line: AgentRunLogLine): ActivityPresentation {
  return {
    summary: summarizeLine(line),
    context: formatContext(line),
  };
}

function summarizeLine(line: AgentRunLogLine): string {
  const metadata = asRecord(line.metadata);
  const eventName = line.eventName;

  if (eventName === "run_started") {
    const eventType = readString(metadata, "eventType");
    return eventType === undefined ? "Run started." : `Run started for '${eventType}'.`;
  }

  if (eventName === "step_started") {
    const step = readString(metadata, "step");
    return step === undefined ? "Starting step." : `Starting ${step}.`;
  }

  if (eventName === "step_committed") {
    const status = readString(metadata, "transitionStatus");
    const step = readString(metadata, "step");
    if (step !== undefined && status !== undefined) {
      return `Saved ${step} (${status.toLowerCase()}).`;
    }
    if (status !== undefined) {
      return `Step saved (${status.toLowerCase()}).`;
    }
    return "Step saved.";
  }

  if (eventName === "route_decision") {
    const route = readString(metadata, "executionLane") ?? readString(metadata, "selectedLane");
    if (route === undefined) {
      return "Route selected.";
    }
    return `Routing to ${route}.`;
  }

  if (eventName === "route_override") {
    const reason = readString(metadata, "decisionCode");
    return reason === undefined ? "Route overridden by policy." : `Route override: ${reason}.`;
  }

  if (eventName === "resolver_generated") {
    const decision = readString(metadata, "decisionCode");
    const tools = readStringArray(metadata?.selectedTools);
    if (decision === "tool" || decision === "tool_batch") {
      if (tools.length > 0) {
        return `Resolver selected tool${tools.length > 1 ? "s" : ""}: ${tools.join(", ")}.`;
      }
      return "Resolver selected tool action.";
    }
    if (decision === "ask_user") {
      return "Resolver needs clarification from user.";
    }
    return decision === undefined ? "Resolver generated next action." : `Resolver chose '${decision}'.`;
  }

  if (eventName === "resolver_bypassed") {
    const decision = readString(metadata, "decisionCode");
    return decision === undefined
      ? "Skipped resolver and executed thinker action directly."
      : `Skipped resolver; thinker emitted direct '${decision}' action.`;
  }

  if (eventName === "clarification_triggered") {
    const attempt = typeof metadata?.attempt === "number" ? metadata.attempt : undefined;
    return attempt === undefined
      ? "Asked user for clarification."
      : `Asked user for clarification (attempt ${attempt}).`;
  }

  if (eventName === "tool_queue_enqueued") {
    const tool = readString(metadata, "tool");
    const runDepth = readNumber(metadata, "queueDepthRun");
    const globalDepth = readNumber(metadata, "queueDepthGlobal");
    if (tool !== undefined && runDepth !== undefined && globalDepth !== undefined) {
      return `Queued tool '${tool}' (run queue ${runDepth}, global queue ${globalDepth}).`;
    }
    return "Queued tool call.";
  }

  if (eventName === "tool_queue_dequeued") {
    const tool = readString(metadata, "tool");
    const waitMs = readNumber(metadata, "queueWaitMs");
    if (tool !== undefined && waitMs !== undefined) {
      return waitMs > 0
        ? `Tool '${tool}' left queue after ${waitMs}ms.`
        : `Tool '${tool}' started immediately.`;
    }
    return "Tool call dequeued.";
  }

  if (eventName === "tool_queue_overflow") {
    const max = readNumber(metadata, "maxQueuedPerRun");
    if (max !== undefined) {
      return `Tool queue overflowed (max queued per run ${max}).`;
    }
    return "Tool queue overflowed.";
  }

  if (eventName === "tool_retry") {
    const tool = readString(metadata, "tool");
    const attempt = readNumber(metadata, "attempt");
    const maxAttempts = readNumber(metadata, "maxAttempts");
    if (tool !== undefined && attempt !== undefined && maxAttempts !== undefined) {
      return `Retrying tool '${tool}' (${attempt}/${maxAttempts}).`;
    }
    return "Retrying tool call.";
  }

  if (eventName === "tool_chunk_started") {
    const chunkIndex = readNumber(metadata, "chunkIndex");
    const totalChunks = readNumber(metadata, "totalChunks");
    const chunkSize = readNumber(metadata, "chunkSize");
    if (chunkIndex !== undefined && totalChunks !== undefined && chunkSize !== undefined) {
      return `Processing chunk ${chunkIndex}/${totalChunks} (${chunkSize} tool jobs).`;
    }
    return "Processing tool chunk.";
  }

  if (eventName === "tool_chunk_completed") {
    const remaining = readNumber(metadata, "remainingItems");
    if (remaining !== undefined) {
      return remaining > 0
        ? `Tool chunk complete (${remaining} jobs remaining).`
        : "Tool chunk complete (all jobs finished).";
    }
    return "Tool chunk complete.";
  }

  if (eventName === "decision_generated") {
    const phase = readString(metadata, "decisionPhase");
    return phase === undefined ? "Model decision received." : `${phase} decision received.`;
  }

  if (eventName === "decision_compiled") {
    const phase = readString(metadata, "decisionPhase");
    const decision = readString(metadata, "decisionCode");
    if (phase !== undefined && decision !== undefined) {
      return `${phase} compiled action: ${decision}.`;
    }
    return "Decision compiled.";
  }

  if (eventName === "decision_executed") {
    const phase = readString(metadata, "decisionPhase");
    const decision = readString(metadata, "decisionCode");
    if (phase !== undefined && decision !== undefined) {
      return `${phase} executed action: ${decision}.`;
    }
    return "Decision executed.";
  }

  if (eventName === "decision_rejected") {
    const message = readString(metadata, "message");
    const code = readString(metadata, "decisionErrorCode");
    if (message !== undefined && code !== undefined) {
      return `Decision rejected (${code}): ${message}`;
    }
    if (message !== undefined) {
      return `Decision rejected: ${message}`;
    }
    return "Decision rejected.";
  }

  if (eventName.startsWith("progress_")) {
    const progressSummary = summarizeProgress(metadata);
    if (progressSummary !== undefined) {
      return progressSummary;
    }
  }

  if (eventName === "run_terminal") {
    const status = readString(metadata, "status");
    const finalStep = readString(metadata, "finalStep");
    if (status !== undefined && finalStep !== undefined) {
      return `Run ${status.toLowerCase()} at ${finalStep}.`;
    }
    if (status !== undefined) {
      return `Run ${status.toLowerCase()}.`;
    }
    return "Run reached terminal state.";
  }

  if (eventName === "run_failed") {
    const code = readString(metadata, "code");
    const message = readString(metadata, "message");
    if (code !== undefined && message !== undefined) {
      return `Run failed (${code}): ${message}`;
    }
    if (message !== undefined) {
      return `Run failed: ${message}`;
    }
    return "Run failed.";
  }

  if (eventName === "quality_computed") {
    const quality = asRecord(metadata?.quality);
    const citation = typeof quality?.citationCoverage === "number" ? quality.citationCoverage : undefined;
    const stepRecurrence = typeof quality?.thrashIndex === "number" ? quality.thrashIndex : undefined;
    if (citation !== undefined && stepRecurrence !== undefined) {
      return `Quality updated (citation ${citation}, step recurrence ${stepRecurrence}).`;
    }
    return "Quality metrics updated.";
  }

  return humanizeEventName(eventName);
}

function summarizeProgress(metadata: Record<string, unknown> | undefined): string | undefined {
  const tool = asRecord(metadata?.tool);
  const toolName = readString(tool, "name");
  const toolStatus = readString(tool, "status");
  const latency = typeof tool?.latencyMs === "number" ? tool.latencyMs : undefined;
  const queueDepthRun = readNumber(metadata, "queueDepthRun");
  const queueDepthGlobal = readNumber(metadata, "queueDepthGlobal");
  const queueWaitMs = readNumber(metadata, "queueWaitMs");
  const chunkIndex = readNumber(metadata, "chunkIndex");
  const chunkSize = readNumber(metadata, "chunkSize");

  if (chunkIndex !== undefined && chunkSize !== undefined) {
    return `Processing chunk ${chunkIndex} (${chunkSize} tool jobs).`;
  }

  if (toolName !== undefined && toolStatus !== undefined) {
    if (toolStatus === "STARTED") {
      if (queueDepthRun !== undefined && queueDepthGlobal !== undefined) {
        return `Queued tool '${toolName}' (run queue ${queueDepthRun}, global queue ${queueDepthGlobal}).`;
      }
      return `Calling tool '${toolName}'.`;
    }
    if (toolStatus === "DONE") {
      if (queueWaitMs !== undefined && queueWaitMs > 0) {
        return latency === undefined
          ? `Tool '${toolName}' completed (queued ${queueWaitMs}ms).`
          : `Tool '${toolName}' completed in ${latency}ms (queued ${queueWaitMs}ms).`;
      }
      return latency === undefined
        ? `Tool '${toolName}' completed.`
        : `Tool '${toolName}' completed in ${latency}ms.`;
    }
    if (toolStatus === "FAILED") {
      return `Tool '${toolName}' failed.`;
    }
  }

  const waitFor = asRecord(metadata?.waitFor);
  const eventType = readString(waitFor, "eventType");
  if (eventType !== undefined) {
    return `Waiting for '${eventType}'.`;
  }

  const message = readString(metadata, "message");
  if (message !== undefined) {
    return message;
  }

  return ;
}

function formatContext(line: AgentRunLogLine): string {
  const run = line.runId === undefined ? "runtime" : `run ${shortId(line.runId)}`;
  if (line.stepIndex === undefined) {
    return run;
  }
  return `${run} · step ${line.stepIndex}`;
}

function shortId(value: string): string {
  if (value.length <= 8) {
    return value;
  }
  return value.slice(0, 8);
}

function humanizeEventName(eventName: string): string {
  return eventName
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\b\w/gu, (match) => match.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    return ;
  }
  return field;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  if (typeof field !== "number" || Number.isFinite(field) === false) {
    return ;
  }
  return field;
}
