import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerRunTerminalEvent,
  RunnerTelemetry,
} from "@kestrel-agents/sdk";
import type { UIMessage } from "ai";
import { extractFinalizedAssistantText } from "@/lib/agent/kestrel-stream-events";

const EMPTY_FINAL_TEXT =
  "The run completed without a final assistant message.";

export type KestrelOneExternalReplyUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type KestrelOneExternalReply = {
  userMessage: UIMessage;
  text: string;
  usage: KestrelOneExternalReplyUsage | undefined;
};

export async function generateKestrelOneExternalReplyFromAgent(input: {
  agent: Pick<KestrelAgent, "run">;
  sessionId: string;
  prompt: string;
  context: KestrelRequestContext;
  clientCapabilities: KestrelAgentTurnInput["clientCapabilities"];
}): Promise<KestrelOneExternalReply> {
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: input.prompt }],
  };

  const terminal = await input.agent.run(
    {
      sessionId: input.sessionId,
      message: input.prompt,
      clientCapabilities: input.clientCapabilities,
    },
    input.context
  );

  return {
    userMessage,
    text: readTerminalText(terminal),
    usage: readTokenUsage(terminal),
  };
}

function readTerminalText(terminal: RunnerRunTerminalEvent): string {
  if (terminal.type === "run.failed") {
    throw Object.assign(new Error(terminal.payload.error.message), {
      code: terminal.payload.error.code,
    });
  }

  if (terminal.type === "run.cancelled") {
    throw Object.assign(new Error("The Kestrel run was cancelled."), {
      code: "RUN_CANCELLED",
    });
  }

  return (
    extractFinalizedAssistantText(terminal.payload.result.finalizedPayload) ||
    EMPTY_FINAL_TEXT
  );
}

function readTokenUsage(
  terminal: RunnerRunTerminalEvent
): KestrelOneExternalReplyUsage | undefined {
  if (terminal.type !== "run.completed") {
    return undefined;
  }

  return tokenUsageFromTelemetry(terminal.payload.result.output.telemetry);
}

function tokenUsageFromTelemetry(
  telemetry: RunnerTelemetry | undefined
): KestrelOneExternalReplyUsage | undefined {
  const inputTokens = readFiniteNumber(telemetry?.inputTokens);
  const outputTokens = readFiniteNumber(telemetry?.outputTokens);
  const totalTokens = readFiniteNumber(telemetry?.totalTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function readFiniteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
