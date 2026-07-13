import "server-only";

import { readRequestCorrelation } from "@kestrel-agents/next";
import {
  createAgent,
  type KestrelAgent,
  type RunnerActorMetadata,
} from "@kestrel-agents/sdk";
import {
  KestrelClient,
  type KestrelRequestContext,
  type RunnerProfile,
  type RunnerRunStreamEvent,
  type RunnerRunTerminalEvent,
  type RunnerStream,
  type RunnerTurnInput,
} from "@kestrel-agents/sdk/runner";
import type { UIMessage } from "ai";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import {
  createProfileBoundExternalReplyAgent,
  generateKestrelOneExternalReplyFromAgent,
} from "@/lib/agent/kestrel-external-runtime-core";
import {
  adaptKestrelAgentForKestrelOne,
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneAgentResponsePersistMeta,
} from "@/lib/agent/kestrel-runtime-core";
import {
  applyKestrelOneModelToProfile,
  toKestrelOneRuntimeModelSelection,
} from "@/lib/agent/kestrel-runtime-model";
import { getResolvedKestrelRuntimeExecutionModel } from "@/lib/ai/gateways";
import { getGatewayResolutionFailureMessage } from "@/lib/ai/surface-policy";
import type { Session } from "@/lib/auth-types";

const DEFAULT_PROFILE_ID = "kestrel-one";
const DEFAULT_AGENT_ID = "kestrel-one";
const DEFAULT_AGENT_NAME = "Kestrel One";

export function createKestrelOneAgent() {
  return createAgent({
    id: process.env.KESTREL_ONE_AGENT_ID?.trim() || DEFAULT_AGENT_ID,
    name: process.env.KESTREL_ONE_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
    profileId: getKestrelOneProfileId(),
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
  });
}

class KestrelOneRunnerClient extends KestrelClient {
  runWithProfile(
    input: { profile: RunnerProfile; turn: RunnerTurnInput },
    context: KestrelRequestContext
  ): Promise<RunnerRunTerminalEvent> {
    return this.sendCommand(
      "run.start",
      { profile: input.profile, turn: input.turn },
      context
    );
  }

  streamRunWithProfile(
    input: {
      profile: RunnerProfile;
      turn: RunnerTurnInput;
      signal?: AbortSignal | undefined;
    },
    context: KestrelRequestContext
  ): RunnerStream<RunnerRunStreamEvent, RunnerRunTerminalEvent> {
    return this.createStream(
      "run.start",
      {
        profile: input.profile,
        turn: input.turn,
      },
      context,
      {
        signal: input.signal,
        onCancel: async (runId, commandId) => {
          await this.cancelRun(
            {
              sessionId: input.turn.sessionId,
              ...(runId !== undefined ? { runId } : {}),
              commandId,
            },
            context
          );
        },
      }
    );
  }
}

function getKestrelOneProfileId() {
  return process.env.KESTREL_ONE_PROFILE_ID?.trim() || DEFAULT_PROFILE_ID;
}

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent?: KestrelAgent;
  session: Session;
  organizationId: string;
  threadId: string;
  messages: UIMessage[];
  modelId?: string;
  projectContext?: {
    projectId: string;
    contextRevisionId: string;
    contextRevision: number;
    grantId: string;
    systemContext: string;
  };
  transientTitle?: Promise<string | null> | null;
  onFinishPersist?: (
    messages: UIMessage[],
    meta: KestrelOneAgentResponsePersistMeta
  ) => Promise<void>;
};

function createModelAwareKestrelOneAgent(): KestrelOneAgent {
  const client = new KestrelOneRunnerClient({
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
  });

  return {
    async stream(input, context, runtimeModel) {
      const { signal, ...turn } = input;
      const normalizedTurn = {
        ...turn,
        eventType: turn.eventType || "user.message",
      };

      if (!runtimeModel) {
        return client.streamRun(
          {
            profileId: getKestrelOneProfileId(),
            turn: normalizedTurn,
            ...(signal ? { signal } : {}),
          },
          context
        );
      }

      const baseProfile = await client.getProfile(
        getKestrelOneProfileId(),
        context
      );
      return client.streamRunWithProfile(
        {
          profile: applyKestrelOneModelToProfile(baseProfile, runtimeModel),
          turn: normalizedTurn,
          ...(signal ? { signal } : {}),
        },
        context
      );
    },
    close() {
      return client.close();
    },
  };
}

export async function generateKestrelOneExternalReply(input: {
  organizationId: string;
  apiUrl: string;
  sessionId: string;
  prompt: string;
  actor: RunnerActorMetadata;
}) {
  const client = new KestrelOneRunnerClient({
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
  });
  const context: KestrelRequestContext = {
    actor: input.actor,
    tenantId: input.organizationId,
  };

  try {
    const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
      organizationId: input.organizationId,
    });
    if (!resolvedModel) {
      throw new Error(
        getGatewayResolutionFailureMessage({
          surface: "chat",
        })
      );
    }
    const baseProfile = await client.getProfile(
      getKestrelOneProfileId(),
      context
    );
    const profile = applyKestrelOneModelToProfile(
      baseProfile,
      toKestrelOneRuntimeModelSelection({
        ...resolvedModel.model,
        organizationId: input.organizationId,
      })
    );
    return await generateKestrelOneExternalReplyFromAgent({
      agent: createProfileBoundExternalReplyAgent({
        profile,
        run: (request, requestContext) =>
          client.runWithProfile(request, requestContext),
      }),
      sessionId: input.sessionId,
      prompt: input.prompt,
      context,
      clientCapabilities: {
        kestrelOne: {
          tenantId: input.organizationId,
          capabilities: buildKestrelOneCapabilityDescriptors({
            request: new Request(new URL("/", input.apiUrl)),
          }),
        },
      },
    });
  } finally {
    await client.close();
  }
}

export async function createKestrelOneAgentResponse(
  input: KestrelOneAgentResponseInput
) {
  const resolvedModel = await getResolvedKestrelRuntimeExecutionModel({
    selection: input.modelId,
    organizationId: input.organizationId,
  });
  if (!resolvedModel) {
    throw new Error(
      getGatewayResolutionFailureMessage({
        surface: "chat",
        modelId: input.modelId,
      })
    );
  }

  const runtimeModel = toKestrelOneRuntimeModelSelection({
    ...resolvedModel.model,
    organizationId: input.organizationId,
  });
  const agent = input.agent;
  const runtimeAgent = agent
    ? adaptKestrelAgentForKestrelOne(agent)
    : createModelAwareKestrelOneAgent();

  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent: runtimeAgent,
    ownsAgent: input.agent === undefined,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    threadId: input.threadId,
    messages: input.messages,
    modelId: resolvedModel.model.id,
    runtimeModel,
    projectContext: input.projectContext,
    transientTitle: input.transientTitle,
    onFinishPersist: input.onFinishPersist,
  });
}
