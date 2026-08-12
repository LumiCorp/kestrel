import test from "node:test";
import "../../scripts/register-server-only.mjs";

import assert from "node:assert/strict";
import type {
  ExecutionProfileResolveCommandPayload,
  ExecutionProfileResolvedEventPayload,
  KestrelRequestContext,
} from "@kestrel-agents/sdk/runner";
import {
  getKestrelOneHostedAgentId,
  resolveHostedKestrelExecutionProfile,
} from "./kestrel-runtime";

test(
  "hosted Kestrel keeps product agent identity separate from policy profile id",
  () => {
    const previous = process.env.KESTREL_ONE_AGENT_ID;
    try {
      delete process.env.KESTREL_ONE_AGENT_ID;
      assert.equal(getKestrelOneHostedAgentId(), "kestrel-one");
      process.env.KESTREL_ONE_AGENT_ID = "hosted-agent";
      assert.equal(getKestrelOneHostedAgentId(), "hosted-agent");
    } finally {
      if (previous === undefined) {
        delete process.env.KESTREL_ONE_AGENT_ID;
      } else {
        process.env.KESTREL_ONE_AGENT_ID = previous;
      }
    }
  },
);

test(
  "hosted Kestrel resolves a registered profile before execution",
  async () => {
    const calls: Array<{
      input: ExecutionProfileResolveCommandPayload;
      context: KestrelRequestContext;
    }> = [];
    const context: KestrelRequestContext = {
      tenantId: "org_123",
      actor: {
        actorId: "user_123",
        actorType: "end_user",
        tenantId: "org_123",
      },
    };
    const result = await resolveHostedKestrelExecutionProfile({
      client: {
        async resolveExecutionProfile(input, requestContext) {
          calls.push({ input, context: requestContext });
          return {
            version: 1,
            profileId: `kestrel:workspace_hosted:${"a".repeat(64)}`,
            fingerprint: "a".repeat(64),
            policy: { id: "kestrel", version: 2 },
            environmentPreset: { id: "workspace_hosted", version: 1 },
            resolvedProfile: {
              id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
              label: "Kestrel One",
              agent: "reference-react",
              sessionPrefix: "kestrel",
              agentProfileId: "kestrel",
            },
          } satisfies ExecutionProfileResolvedEventPayload;
        },
      },
      context,
      route: {
        runId: "exec_123",
        environmentId: "env_123",
        effectiveCapabilities: [
          "app:built_in.knowledge_search.searchKnowledgeDocuments:auto",
          "app:google_workspace.calendar.events.read:ask",
        ],
        reasoningPolicy: {
          request: { mode: "summary", effort: "high" },
          retention: { mode: "provider_visible", days: 7 },
        },
      },
      runtimeModels: [
        {
          id: "gateway_model_123",
          provider: "openai",
          model: "gpt-5.1",
          gatewayId: "gateway_123",
          organizationId: "org_123",
          environmentId: "env_123",
        },
        {
          id: "gateway_model_456",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          gatewayId: "gateway_456",
          organizationId: "org_123",
          environmentId: "env_123",
        },
      ],
    });

    assert.equal(result.profileId, `kestrel:workspace_hosted:${"a".repeat(64)}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.context, context);
    assert.deepEqual(calls[0]?.input, {
      environmentPresetId: "workspace_hosted",
      managedConfiguration: {
        label: "Kestrel One",
        additionalToolNames: [
          "kestrel_one.google_calendar_list_events",
          "kestrel_one.search_knowledge_documents",
        ],
        kestrelOneAppApprovalModes: {
          "kestrel_one.google_calendar_list_events": "ask",
          "kestrel_one.search_knowledge_documents": "auto",
        },
        reasoning: {
          request: { mode: "summary", effort: "high" },
          retention: { mode: "provider_visible", days: 7 },
        },
        modelProvider: "openai",
        model: "gpt-5.1",
        agentStageConfig: {
          modelByStage: {
            "agent.loop": "gpt-5.1",
          },
        },
        modelCredential: {
          source: "kestrel-one",
          runId: "exec_123",
          gatewayId: "gateway_123",
          organizationId: "org_123",
          environmentId: "env_123",
          rawModelId: "gpt-5.1",
          provider: "openai",
        },
        default: false,
      },
    });
    assert.equal("profile" in calls[0]!.input, false);
  },
);

test(
  "hosted Kestrel resolves desktop-local model profiles without hosted credentials",
  async () => {
    const calls: Array<{
      input: ExecutionProfileResolveCommandPayload;
      context: KestrelRequestContext;
    }> = [];
    const context: KestrelRequestContext = {
      tenantId: "org_123",
      actor: {
        actorId: "user_123",
        actorType: "end_user",
        tenantId: "org_123",
      },
    };

    await resolveHostedKestrelExecutionProfile({
      client: {
        async resolveExecutionProfile(input, requestContext) {
          calls.push({ input, context: requestContext });
          return {
            version: 1,
            profileId: `kestrel:workspace_hosted:${"b".repeat(64)}`,
            fingerprint: "b".repeat(64),
            policy: { id: "kestrel", version: 2 },
            environmentPreset: { id: "workspace_hosted", version: 1 },
            resolvedProfile: {
              id: `kestrel:workspace_hosted:${"b".repeat(64)}`,
              label: "Kestrel One",
              agent: "reference-react",
              sessionPrefix: "kestrel",
              agentProfileId: "kestrel",
            },
          } satisfies ExecutionProfileResolvedEventPayload;
        },
      },
      context,
      route: {
        runId: "exec_123",
        environmentId: "env_123",
        effectiveCapabilities: [],
      },
      runtimeModels: [
        {
          desktopLocal: true,
          id: "desktop_local_model",
          provider: "ollama",
          model: "llama3.2",
          organizationId: "org_123",
          environmentId: "env_123",
        },
      ],
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.input.managedConfiguration, {
      label: "Kestrel One",
      additionalToolNames: [],
      kestrelOneAppApprovalModes: {},
      modelProvider: "ollama",
      model: "llama3.2",
      agentStageConfig: {
        modelByStage: {
          "agent.loop": "llama3.2",
        },
      },
      default: false,
    });
  },
);
