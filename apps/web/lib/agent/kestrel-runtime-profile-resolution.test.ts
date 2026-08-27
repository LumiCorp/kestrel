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
  assertHostedWorkspaceExactToolPreflight,
  resolveHostedKestrelExecutionProfile,
} from "./kestrel-runtime";

const ASK_EXEC_COMMAND_DECISION: NonNullable<
  ExecutionProfileResolvedEventPayload["exactToolDecisions"]
>[string] = {
  version: "effective_tool_decision_v1",
  available: true,
  availabilityReason: "available",
  approvalDisposition: {
    mode: "ask",
    reasonCode: "environment_policy",
    authority: {
      kind: "hosted_app_policy",
      revision: "workspace-command-policy:1",
    },
  },
  rememberApprovalEligible: true,
  authorityRevision: "workspace-command-policy:1",
  evidence: {
    interactionMode: "build",
    toolClass: "external_side_effect",
    requiredCapabilities: ["shell.exec", "external.confirm"],
    actorAccess: true,
  },
};

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
            policy: { id: "kestrel", version: 3 },
            environmentPreset: { id: "workspace_hosted", version: 4 },
            hostedApprovalProducerProtocol: "v4",
            resolvedProfile: {
              id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
              label: "Kestrel One",
              agent: "reference-react",
              sessionPrefix: "kestrel",
              agentProfileId: "kestrel",
              approvalPolicyPackId: "hosted_workspace",
              toolAllowlist: ["exec_command"],
            },
          } satisfies ExecutionProfileResolvedEventPayload;
        },
      },
      context,
      route: {
        runId: "exec_123",
        environmentId: "env_123",
        rememberedToolApprovalEvidence: [{
          version: "remembered_tool_approval_evidence_v1",
          organizationId: "org_123",
          projectId: "project_123",
          environmentId: "env_123",
          threadId: "thread_123",
          actorUserId: "user_123",
          toolIdentity: {
            version: "stable_tool_approval_identity_v1",
            toolId: "internet.search",
            descriptorContractRevision: `sha256:${"d".repeat(64)}`,
            approvalAuthorityRevision: "authority-v1",
          },
          sourceInteractionId: "interaction_123",
        }],
        effectiveCapabilities: [
          "app:built_in.workspace.executeCommand:ask",
          "app:built_in.knowledge_search.searchKnowledgeDocuments:auto",
          "app:google_workspace.calendar.events.read:ask",
        ],
        reasoningPolicy: {
          request: { mode: "summary", effort: "high" },
          retention: { mode: "provider_visible", days: 7 },
        },
        approvalPolicies: [
          {
            appKey: "built_in.workspace",
            capabilityKey: "executeCommand",
            environment: "ask",
            minimum: "auto",
          },
        ],
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
          "exec_command",
          "kestrel_one.search_knowledge_documents",
          "kestrel.files.search",
          "kestrel.files.open",
        ],
        kestrelOneAppApprovalModes: {
          exec_command: "ask",
          "kestrel_one.google_calendar_list_events": "ask",
          "kestrel_one.search_knowledge_documents": "auto",
          "kestrel.files.search": "auto",
          "kestrel.files.open": "auto",
        },
        kestrelOneAppApprovalPolicies: {
          exec_command: {
            environment: "ask",
            minimum: "auto",
          },
        },
        rememberedToolApprovalEvidence: [{
          version: "remembered_tool_approval_evidence_v1",
          organizationId: "org_123",
          projectId: "project_123",
          environmentId: "env_123",
          threadId: "thread_123",
          actorUserId: "user_123",
          toolIdentity: {
            version: "stable_tool_approval_identity_v1",
            toolId: "internet.search",
            descriptorContractRevision: `sha256:${"d".repeat(64)}`,
            approvalAuthorityRevision: "authority-v1",
          },
          sourceInteractionId: "interaction_123",
        }],
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

test("hosted exact-tool preflight rejects an unavailable required tool before model execution", () => {
  assert.throws(
    () => assertHostedWorkspaceExactToolPreflight({
      version: 1,
      profileId: `kestrel:workspace_hosted:${"f".repeat(64)}`,
      fingerprint: "f".repeat(64),
      policy: { id: "kestrel", version: 4 },
      environmentPreset: { id: "workspace_hosted", version: 4 },
      hostedApprovalProducerProtocol: "v4",
      exactToolDecisions: {
        exec_command: {
          ...ASK_EXEC_COMMAND_DECISION,
          available: false,
          availabilityReason: "actor_access",
          rememberApprovalEligible: false,
          evidence: {
            ...ASK_EXEC_COMMAND_DECISION.evidence,
            actorAccess: false,
          },
        },
      },
      resolvedProfile: {
        id: `kestrel:workspace_hosted:${"f".repeat(64)}`,
        label: "Kestrel",
        agent: "reference-react",
        sessionPrefix: "kestrel",
        approvalPolicyPackId: "hosted_workspace",
        toolAllowlist: ["exec_command"],
      },
    }, "exec_command"),
    (error: unknown) =>
      (error as { code?: unknown }).code === "HOSTED_REQUIRED_TOOL_UNAVAILABLE",
  );
});

test("ordinary hosted turns remain rolling-compatible without exact shell preflight", async () => {
  const calls: ExecutionProfileResolveCommandPayload[] = [];
  await resolveHostedKestrelExecutionProfile({
    client: {
      async resolveExecutionProfile(input) {
        calls.push(input);
        return {
          version: 1,
          profileId: `kestrel:workspace_hosted:${"e".repeat(64)}`,
          fingerprint: "e".repeat(64),
          policy: { id: "kestrel", version: 3 },
          environmentPreset: { id: "workspace_hosted", version: 4 },
          hostedApprovalProducerProtocol: "v4",
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"e".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react",
            sessionPrefix: "kestrel",
            approvalPolicyPackId: "hosted_workspace",
            toolAllowlist: ["kestrel_one.search_knowledge_documents"],
          },
        } satisfies ExecutionProfileResolvedEventPayload;
      },
    },
    context: {
      tenantId: "org_123",
      actor: {
        actorId: "user_123",
        actorType: "end_user",
        tenantId: "org_123",
      },
    },
    route: {
      runId: "exec_ordinary",
      environmentId: "env_123",
      effectiveCapabilities: [
        "app:built_in.knowledge_search.searchKnowledgeDocuments:auto",
      ],
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.exactToolNames, undefined);
});

test("bridge Web accepts the exact legacy preset-3 hosted profile", async () => {
  await assert.doesNotReject(
    () => resolveHostedKestrelExecutionProfile({
      client: {
        async resolveExecutionProfile() {
          return {
            version: 1,
            profileId: `kestrel:workspace_hosted:${"b".repeat(64)}`,
            fingerprint: "b".repeat(64),
            policy: { id: "kestrel", version: 4 },
            environmentPreset: { id: "workspace_hosted", version: 3 },
            resolvedProfile: {
              id: `kestrel:workspace_hosted:${"b".repeat(64)}`,
              label: "Kestrel One",
              agent: "reference-react",
              sessionPrefix: "kestrel",
              approvalPolicyPackId: "hosted_workspace",
              toolAllowlist: ["exec_command"],
            },
          } satisfies ExecutionProfileResolvedEventPayload;
        },
      },
      context: {
        tenantId: "org_123",
        actor: {
          actorId: "user_123",
          actorType: "end_user",
          tenantId: "org_123",
        },
      },
      route: {
        runId: "exec_old_runner",
        environmentId: "env_123",
        effectiveCapabilities: [],
      },
    }),
  );
});

test("bridge Web accepts explicit preset-4 compatibility and activation producers", async () => {
  for (const hostedApprovalProducerProtocol of ["v2", "v4"] as const) {
    await assert.doesNotReject(() => resolveHostedKestrelExecutionProfile({
      client: {
        async resolveExecutionProfile() {
          return {
            version: 1,
            profileId: `kestrel:workspace_hosted:${"b".repeat(64)}`,
            fingerprint: "b".repeat(64),
            policy: { id: "kestrel", version: 4 },
            environmentPreset: { id: "workspace_hosted", version: 4 },
            hostedApprovalProducerProtocol,
            resolvedProfile: {
              id: `kestrel:workspace_hosted:${"b".repeat(64)}`,
              label: "Kestrel One",
              agent: "reference-react",
              sessionPrefix: "kestrel",
              approvalPolicyPackId: "hosted_workspace",
              toolAllowlist: ["exec_command"],
            },
          } satisfies ExecutionProfileResolvedEventPayload;
        },
      },
      context: {
        tenantId: "org_123",
        actor: {
          actorId: "user_123",
          actorType: "end_user",
          tenantId: "org_123",
        },
      },
      route: {
        runId: `exec_${hostedApprovalProducerProtocol}`,
        environmentId: "env_123",
        effectiveCapabilities: [],
      },
    }));
  }
});

test("bridge Web fails closed for unsupported or ambiguous hosted profiles", async () => {
  const unsupported: ReadonlyArray<{
    environmentPreset: { id: "workspace_hosted"; version: number };
    hostedApprovalProducerProtocol?: "v2" | "v3" | "v4" | undefined;
    approvalPolicyPackId: "hosted_workspace" | "ci_bot";
  }> = [
    {
      environmentPreset: { id: "workspace_hosted", version: 2 },
      approvalPolicyPackId: "hosted_workspace",
    },
    {
      environmentPreset: { id: "workspace_hosted", version: 4 },
      approvalPolicyPackId: "hosted_workspace",
    },
    {
      environmentPreset: { id: "workspace_hosted", version: 4 },
      hostedApprovalProducerProtocol: "v3" as const,
      approvalPolicyPackId: "hosted_workspace",
    },
    {
      environmentPreset: { id: "workspace_hosted", version: 4 },
      hostedApprovalProducerProtocol: "v4" as const,
      approvalPolicyPackId: "ci_bot",
    },
  ];
  for (const [index, candidate] of unsupported.entries()) {
    await assert.rejects(
      () => resolveHostedKestrelExecutionProfile({
        client: {
          async resolveExecutionProfile() {
            return {
              version: 1,
              profileId: `kestrel:workspace_hosted:${"b".repeat(64)}`,
              fingerprint: "b".repeat(64),
              policy: { id: "kestrel", version: 4 },
              environmentPreset: candidate.environmentPreset,
              ...(candidate.hostedApprovalProducerProtocol
                ? { hostedApprovalProducerProtocol: candidate.hostedApprovalProducerProtocol }
                : {}),
              resolvedProfile: {
                id: `kestrel:workspace_hosted:${"b".repeat(64)}`,
                label: "Kestrel One",
                agent: "reference-react",
                sessionPrefix: "kestrel",
                approvalPolicyPackId: candidate.approvalPolicyPackId,
                toolAllowlist: ["exec_command"],
              },
            } satisfies ExecutionProfileResolvedEventPayload;
          },
        },
        context: {
          tenantId: "org_123",
          actor: {
            actorId: "user_123",
            actorType: "end_user",
            tenantId: "org_123",
          },
        },
        route: {
          runId: `exec_unsupported_${index}`,
          environmentId: "env_123",
          effectiveCapabilities: [],
        },
      }),
      (error: unknown) =>
        (error as { code?: unknown }).code ===
        "HOSTED_PROFILE_CONTRACT_INCOMPATIBLE",
    );
  }
});

test("the command canary requests and validates exact shell availability without model execution", async () => {
  const calls: ExecutionProfileResolveCommandPayload[] = [];
  await resolveHostedKestrelExecutionProfile({
    client: {
      async resolveExecutionProfile(input) {
        calls.push(input);
        return {
          version: 1,
          profileId: `kestrel:workspace_hosted:${"d".repeat(64)}`,
          fingerprint: "d".repeat(64),
          policy: { id: "kestrel", version: 4 },
          environmentPreset: { id: "workspace_hosted", version: 4 },
          hostedApprovalProducerProtocol: "v4",
          exactToolDecisions: { exec_command: ASK_EXEC_COMMAND_DECISION },
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"d".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react",
            sessionPrefix: "kestrel",
            approvalPolicyPackId: "hosted_workspace",
            toolAllowlist: ["exec_command"],
          },
        } satisfies ExecutionProfileResolvedEventPayload;
      },
    },
    context: {
      tenantId: "org_123",
      actor: {
        actorId: "user_123",
        actorType: "end_user",
        tenantId: "org_123",
      },
    },
    route: {
      runId: "exec_canary",
      environmentId: "env_123",
      effectiveCapabilities: ["app:built_in.workspace.executeCommand:ask"],
      approvalPolicies: [{
        appKey: "built_in.workspace",
        capabilityKey: "executeCommand",
        environment: "ask",
        minimum: "auto",
      }],
    },
    exactToolName: "exec_command",
  });

  assert.deepEqual(calls[0]?.exactToolNames, ["exec_command"]);
});

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
            profileId: `kestrel:cli_dev_local:${"b".repeat(64)}`,
            fingerprint: "b".repeat(64),
            policy: { id: "kestrel", version: 3 },
            environmentPreset: { id: "cli_dev_local", version: 1 },
            resolvedProfile: {
              id: `kestrel:cli_dev_local:${"b".repeat(64)}`,
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
    assert.equal(calls[0]?.input.environmentPresetId, "cli_dev_local");
    assert.deepEqual(calls[0]?.input.managedConfiguration, {
      label: "Kestrel One",
      additionalToolNames: [],
      kestrelOneAppApprovalModes: {},
      kestrelOneAppApprovalPolicies: {},
      rememberedToolApprovalEvidence: [],
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

test("hosted Desktop and web routes carry the exact approved economics profile", async () => {
  const calls: ExecutionProfileResolveCommandPayload[] = [];
  const economicsProfile = {
    version: 1 as const,
    profileId: "openrouter:z-ai/glm-5.2:free:v1",
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    contextWindowTokens: 202_752,
    maxOutputTokens: 65_536,
    counting: {
      counter: "utf8-byte-upper-bound",
      counterVersion: "1",
      method: "conservative_estimate" as const,
      confidence: "conservative" as const,
    },
    cache: { behavior: "none" as const },
  };

  await resolveHostedKestrelExecutionProfile({
    client: {
      async resolveExecutionProfile(input) {
        calls.push(input);
        return {
          version: 1,
          profileId: `kestrel:workspace_hosted:${"c".repeat(64)}`,
          fingerprint: "c".repeat(64),
          policy: { id: "kestrel", version: 3 },
          environmentPreset: { id: "workspace_hosted", version: 4 },
          hostedApprovalProducerProtocol: "v4",
          resolvedProfile: {
            id: `kestrel:workspace_hosted:${"c".repeat(64)}`,
            label: "Kestrel One",
            agent: "reference-react",
            sessionPrefix: "kestrel",
            approvalPolicyPackId: "hosted_workspace",
            agentProfileId: "kestrel",
          },
        } satisfies ExecutionProfileResolvedEventPayload;
      },
    },
    context: {
      tenantId: "org_123",
      actor: {
        actorId: "user_123",
        actorType: "end_user",
        tenantId: "org_123",
      },
    },
    route: {
      runId: "exec_456",
      environmentId: "env_123",
      effectiveCapabilities: [],
    },
    runtimeModels: [
      {
        id: "gateway_model_glm",
        provider: "openrouter",
        model: "z-ai/glm-5.2:free",
        economicsProfile,
        gatewayId: "gateway_123",
        organizationId: "org_123",
        environmentId: "env_123",
      },
    ],
  });

  assert.equal(calls[0]?.managedConfiguration?.modelEconomicsProfile, economicsProfile);
});

test(
  "hosted Kestrel maps economics admission into a clear preflight failure",
  async () => {
    const serviceFailure = Object.assign(
      new Error("runtime economics profile missing"),
      {
        code: "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
        details: {
          runtimeCode: "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
          provider: "openrouter",
          model: "openai/gpt-5.6-luna-alias",
          preset: "workspace_hosted",
          reason: "model_profile_not_found",
        },
      },
    );

    await assert.rejects(
      () =>
        resolveHostedKestrelExecutionProfile({
          client: {
            async resolveExecutionProfile() {
              throw serviceFailure;
            },
          },
          context: {
            tenantId: "org_123",
            actor: {
              actorId: "user_123",
              actorType: "end_user",
              tenantId: "org_123",
            },
          },
          route: {
            runId: "exec_123",
            environmentId: "env_123",
            effectiveCapabilities: [],
          },
          runtimeModels: [
            {
              id: "gateway_model_123",
              provider: "openrouter",
              model: "openai/gpt-5.6-luna-alias",
              gatewayId: "gateway_123",
              organizationId: "org_123",
              environmentId: "env_123",
            },
          ],
        }),
      (error: unknown) => {
        const mapped = error as Error & {
          code?: string;
          details?: Record<string, unknown>;
        };
        assert.equal(
          mapped.code,
          "HARNESS_ECONOMICS_MODEL_PROFILE_REQUIRED",
        );
        assert.equal(mapped.details, serviceFailure.details);
        assert.match(
          mapped.message,
          /openrouter\/openai\/gpt-5\.6-luna-alias.*exact hosted model.*economics profile/iu,
        );
        return true;
      },
    );
  },
);
