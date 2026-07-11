import "server-only";

import {
  createAgent,
  type KestrelAgent,
  type RunnerActorMetadata,
} from "@kestrel-agents/sdk";
import { readRequestCorrelation } from "@kestrel-agents/next";
import { buildKestrelOneCapabilityDescriptors } from "@/lib/agent/kestrel-capabilities";
import { generateKestrelOneExternalReplyFromAgent } from "@/lib/agent/kestrel-external-runtime-core";
import {
  adaptKestrelAgentForKestrelOne,
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgentResponsePersistMeta,
} from "@/lib/agent/kestrel-runtime-core";
import type { Session } from "@/lib/auth-types";
import type { UIMessage } from "ai";

const DEFAULT_PROFILE_ID = "kestrel-one";
const DEFAULT_AGENT_ID = "kestrel-one";
const DEFAULT_AGENT_NAME = "Kestrel One";

export type KestrelOneAgentResponseInput = {
  request: Request;
  agent?: KestrelAgent;
  session: Session;
  organizationId: string;
  chatId: string;
  messages: UIMessage[];
  transientTitle?: Promise<string | null> | null;
  onFinishPersist?: (
    messages: UIMessage[],
    meta: KestrelOneAgentResponsePersistMeta
  ) => Promise<void>;
};

export function createKestrelOneAgent() {
  return createAgent({
    id: process.env.KESTREL_ONE_AGENT_ID?.trim() || DEFAULT_AGENT_ID,
    name: process.env.KESTREL_ONE_AGENT_NAME?.trim() || DEFAULT_AGENT_NAME,
    profileId:
      process.env.KESTREL_ONE_PROFILE_ID?.trim() || DEFAULT_PROFILE_ID,
    baseUrl: process.env.KESTREL_RUNNER_SERVICE_URL,
    authToken: process.env.KESTREL_RUNNER_SERVICE_TOKEN,
  });
}

export async function generateKestrelOneExternalReply(input: {
  organizationId: string;
  apiUrl: string;
  sessionId: string;
  prompt: string;
  actor: RunnerActorMetadata;
}) {
  const agent = createKestrelOneAgent();

  try {
    return await generateKestrelOneExternalReplyFromAgent({
      agent,
      sessionId: input.sessionId,
      prompt: input.prompt,
      context: {
        actor: input.actor,
        tenantId: input.organizationId,
      },
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
    await agent.close();
  }
}

export function createKestrelOneAgentResponse(
  input: KestrelOneAgentResponseInput
) {
  const agent = input.agent ?? createKestrelOneAgent();

  return createKestrelOneAgentResponseFromAgent({
    request: input.request,
    agent: adaptKestrelAgentForKestrelOne(agent),
    ownsAgent: input.agent === undefined,
    session: input.session,
    organizationId: input.organizationId,
    correlation: readRequestCorrelation(input.request),
    chatId: input.chatId,
    messages: input.messages,
    transientTitle: input.transientTitle,
    onFinishPersist: input.onFinishPersist,
  });
}
