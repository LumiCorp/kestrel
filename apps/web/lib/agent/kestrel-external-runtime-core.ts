import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerProfile,
  RunnerRunTerminalEvent,
  RunnerTelemetry,
  RunnerTurnInput,
} from "@kestrel-agents/sdk";
import type { UIMessage } from "ai";

export type KestrelOneExternalReplyUsage = {
  modelCalls?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  pricedCostUsd?: number;
  validationRejections?: number;
};

export type KestrelOneExternalReply = {
  userMessage: UIMessage;
  text: string;
  usage: KestrelOneExternalReplyUsage | undefined;
};

export function createProfileBoundExternalReplyAgent(input: {
  profile: RunnerProfile;
  run: (
    request: { profile: RunnerProfile; turn: RunnerTurnInput },
    context: KestrelRequestContext
  ) => Promise<RunnerRunTerminalEvent>;
}): Pick<KestrelAgent, "run"> {
  return {
    run(turn, context) {
      return input.run(
        {
          profile: input.profile,
          turn: {
            ...turn,
            eventType: turn.eventType || "user.message",
          },
        },
        context
      );
    },
  };
}

export async function generateKestrelOneExternalReplyFromAgent(input: {
  agent: Pick<KestrelAgent, "run">;
  runId?: string | undefined;
  sessionId: string;
  prompt: string;
  context: KestrelRequestContext;
  clientCapabilities: KestrelAgentTurnInput["clientCapabilities"];
  workspaceSkills?: RunnerTurnInput["workspaceSkills"] | undefined;
  mcpContext?: RunnerTurnInput["mcpContext"] | undefined;
  mcpAuthorization?: RunnerTurnInput["mcpAuthorization"] | undefined;
}): Promise<KestrelOneExternalReply> {
  const userMessage: UIMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: input.prompt }],
  };

  const terminal = await input.agent.run(
    {
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      sessionId: input.sessionId,
      message: input.prompt,
      clientCapabilities: input.clientCapabilities,
      ...(input.workspaceSkills
        ? { workspaceSkills: input.workspaceSkills }
        : {}),
      ...(input.mcpContext ? { mcpContext: input.mcpContext } : {}),
      ...(input.mcpAuthorization
        ? { mcpAuthorization: input.mcpAuthorization }
        : {}),
    },
    input.context
  );
  const usage = readTokenUsage(terminal);

  return {
    userMessage,
    text: readTerminalText(terminal, usage),
    usage,
  };
}

function readTerminalText(
  terminal: RunnerRunTerminalEvent,
  usage: KestrelOneExternalReplyUsage | undefined,
): string {
  if (terminal.type === "run.failed") {
    throw Object.assign(new Error(terminal.payload.error.message), {
      code: terminal.payload.error.code,
      ...(usage !== undefined ? { usage } : {}),
    });
  }

  if (terminal.type === "run.cancelled") {
    const cancellation = terminal.payload.result.output.errors.find(
      (error) => error.code === "RUN_CANCELLED",
    );
    throw Object.assign(new Error("The Kestrel run was cancelled."), {
      code: "RUN_CANCELLED",
      ...(cancellation?.details !== undefined
        ? { details: cancellation.details }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
    });
  }

  const assistantText = terminal.payload.result.assistantText;
  if (assistantText === null) {
    throw Object.assign(new Error("The Kestrel run completed without an assistant response."), {
      code: "RUN_ASSISTANT_TEXT_MISSING",
    });
  }
  return assistantText;
}

function readTokenUsage(
  terminal: RunnerRunTerminalEvent
): KestrelOneExternalReplyUsage | undefined {
  return tokenUsageFromTelemetry(terminal.payload.result.output.telemetry);
}

function tokenUsageFromTelemetry(
  telemetry: RunnerTelemetry | undefined
): KestrelOneExternalReplyUsage | undefined {
  const modelCalls = readFiniteNumber(telemetry?.modelCalls);
  const inputTokens = readFiniteNumber(telemetry?.inputTokens);
  const cachedInputTokens = readFiniteNumber(telemetry?.cachedInputTokens);
  const outputTokens = readFiniteNumber(telemetry?.outputTokens);
  const reasoningTokens = readFiniteNumber(telemetry?.reasoningTokens);
  const totalTokens = readFiniteNumber(telemetry?.totalTokens);
  const durationMs = readFiniteNumber(telemetry?.durationMs);
  const pricedCostUsd = readFiniteNumber(telemetry?.pricedCostUsd);
  const validationRejections = readFiniteNumber(telemetry?.validationRejections);

  if (
    modelCalls === undefined &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined &&
    durationMs === undefined &&
    pricedCostUsd === undefined &&
    validationRejections === undefined
  ) {
    return;
  }

  return {
    ...(modelCalls !== undefined ? { modelCalls } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(pricedCostUsd !== undefined ? { pricedCostUsd } : {}),
    ...(validationRejections !== undefined ? { validationRejections } : {}),
  };
}

function readFiniteNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
