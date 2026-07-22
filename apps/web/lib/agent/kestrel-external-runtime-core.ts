import type {
  KestrelAgent,
  KestrelAgentTurnInput,
  KestrelRequestContext,
  RunnerProfile,
  RunnerRunTerminalEvent,
  RunnerTelemetry,
  RunnerTurnInput,
} from "@kestrel-agents/sdk";
import type { WorkspaceSkillCatalogEntry } from "@kestrel-agents/workspace-skills";
import type { UIMessage } from "ai";

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
  workspaceSkills?: WorkspaceSkillCatalogEntry[] | undefined;
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
  if (terminal.type !== "run.completed") {
    return;
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
    return;
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
