import type { ValidateFunction } from "ajv";

import type {
  ModelMessageToolCall,
  ToolRunContext,
  AgentToolPresentation,
} from "../kestrel/contracts/model-io.js";
import {
  STABLE_TOOL_APPROVAL_IDENTITY_VERSION,
  parseStableToolApprovalIdentityV1,
  type RunnerApprovalActorAuthorityV1,
  type StableToolApprovalIdentityV1,
} from "@kestrel-agents/protocol";
import {
  createToolActivationRefV1,
  createToolSurfaceSnapshotV1,
  fingerprintToolScopeV1,
  hashCanonical,
  parseToolActivationRefV1,
  parseToolSurfaceSnapshotV1,
  toToolDescriptorRefV1,
  type ToolActivationRefV1,
  type ToolDescriptorV1,
  type ToolSurfaceSnapshotV1,
} from "../kestrel/contracts/tool-contract.js";
import {
  AGENT_TOOL_RESULT_VERSION,
  PREPARED_TOOL_CALL_VERSION,
  PREPARED_TOOL_EXECUTION_REQUIREMENTS_VERSION,
  PREPARED_TOOL_STABLE_AUTHORITY_V2_VERSION,
  TOOL_EXECUTION_OUTCOME_VERSION,
  parsePreparedToolCallV1,
  type AgentToolResultV2,
  type PreparedToolApprovalAuthorityV1,
  type PreparedToolCallOriginV1,
  type PreparedToolCallV1,
  type PreparedToolExecutionRequirementsV1,
  type PreparedToolInputAdapterV1,
  type PreparedToolPolicyDispositionV1,
  type PreparedToolStableAuthority,
  type PreparedToolStableAuthorityV2,
  type ResolvedModelToolIntentV1,
  type ToolExecutionOutcomeV1,
} from "../kestrel/contracts/tool-invocation.js";
import type { ToolExecutionClass } from "../mode/contracts.js";
import {
  RunCancelledError,
  RuntimeFailure,
  createRuntimeFailure,
} from "../runtime/RuntimeFailure.js";
import {
  buildAgentToolFailureResult,
  buildAgentToolSuccessResult,
  isAgentToolResult,
} from "../../tools/toolResult.js";

export const RUNTIME_DEADLINE_BUDGET_ADAPTER_ID =
  "runtime.deadline-budget:v1" as const;

export interface PinnedToolExecutionV1 {
  descriptor: ToolDescriptorV1;
  activation: ToolActivationRefV1;
  validator: ValidateFunction;
  handler: (
    input: unknown,
    lifecycle?: {
      persistCompletedCapabilityResult: (rawOutput: unknown) => Promise<void>;
      acknowledgeExternalEffect: () => void;
    },
  ) => Promise<unknown>;
  normalizer: (
    output: unknown,
    input: unknown,
  ) => {
    output: unknown;
    presentation?: AgentToolPresentation | undefined;
    partial?:
      | {
          normalizedFailureCode: string;
          retryable: boolean;
        }
      | undefined;
  };
  resolveExecutionClass?: ((input: Record<string, unknown>) => ToolExecutionClass) | undefined;
}

export function createToolSurfaceForDescriptorsV1(input: {
  descriptors: readonly ToolDescriptorV1[];
  registryGeneration: string;
  runContext?: ToolRunContext | undefined;
}): ToolSurfaceSnapshotV1 {
  const scopeFingerprint = fingerprintToolRunScopeV1(input.runContext);
  return createToolSurfaceSnapshotV1({
    registryGeneration: input.registryGeneration,
    scopeFingerprint,
    tools: input.descriptors.map((descriptor) =>
      createToolActivationRefV1({
        descriptor: toToolDescriptorRefV1(descriptor),
        registryGeneration: input.registryGeneration,
        scopeFingerprint,
      }),
    ),
  });
}

export function resolveModelToolIntentV1(input: {
  snapshot: ToolSurfaceSnapshotV1;
  toolCall: ModelMessageToolCall;
}): ResolvedModelToolIntentV1 {
  const snapshot = parseToolSurfaceSnapshotV1(input.snapshot);
  const activation = snapshot.tools.find(
    (candidate) => candidate.descriptor.toolId === input.toolCall.name,
  );
  if (activation === undefined) {
    throw createRuntimeFailure(
      "TOOL_SNAPSHOT_LOOKUP_FAILED",
      `Tool '${input.toolCall.name}' was not exposed in model snapshot '${snapshot.snapshotId}'.`,
      {
        subsystem: "tooling",
        classification: "policy",
        recoverable: false,
        toolName: input.toolCall.name,
        snapshotId: snapshot.snapshotId,
      },
    );
  }
  return Object.freeze({
    version: "v1",
    modelToolCallId: requireNonEmpty(input.toolCall.id, "model tool call id"),
    snapshotId: snapshot.snapshotId,
    activation,
    rawInput: cloneRecord(input.toolCall.input),
  });
}

export function createPreparedToolCallV1(input: {
  runId: string;
  sessionId: string;
  callId: string;
  activation: ToolActivationRefV1;
  origin: PreparedToolCallOriginV1;
  effectiveInput: Record<string, unknown>;
  inputAdapters?: PreparedToolInputAdapterV1[] | undefined;
  policy: PreparedToolPolicyDispositionV1;
  approval?: PreparedToolApprovalAuthorityV1 | undefined;
  stableAuthority?: PreparedToolStableAuthority | undefined;
  stableToolIdentity?: StableToolApprovalIdentityV1 | undefined;
  executionRequirements?: PreparedToolExecutionRequirementsV1 | undefined;
  preparedAt?: string | undefined;
}): PreparedToolCallV1 {
  if (input.policy.decision === "deny") {
    throw createRuntimeFailure(
      "TOOL_POLICY_DENIED",
      `Prepared tool call '${input.callId}' was denied by runtime policy.`,
      {
        subsystem: "tooling",
        classification: "policy",
        recoverable: false,
        reasonCode: input.policy.reasonCode,
      },
    );
  }
  if (
    input.policy.decision === "approval_required" &&
    input.approval === undefined
  ) {
    throw createRuntimeFailure(
      "TOOL_APPROVAL_BINDING_REQUIRED",
      `Prepared tool call '${input.callId}' requires exact approval authority.`,
      {
        subsystem: "tooling",
        classification: "policy",
        recoverable: false,
      },
    );
  }
  const inputAdapters = input.inputAdapters ?? [];
  const approval =
    input.approval === undefined
      ? undefined
      : {
          ...(input.approval.approvalId === undefined
            ? {}
            : { approvalId: input.approval.approvalId }),
          authorityRevision: hashCanonical({
            version: "prepared-tool-approval-authority-v1",
            activation: input.activation,
            effectiveInput: input.effectiveInput,
            inputAdapters,
            policyRevision: input.policy.policyRevision,
            upstreamAuthorityRevision: input.approval.authorityRevision,
          }),
          ...(input.approval.externalApprovalBinding === undefined
            ? {}
            : { externalApprovalBinding: input.approval.externalApprovalBinding }),
        };
  return parsePreparedToolCallV1({
    version: PREPARED_TOOL_CALL_VERSION,
    runId: input.runId,
    sessionId: input.sessionId,
    callId: input.callId,
    activation: parseToolActivationRefV1(input.activation),
    origin: input.origin,
    effectiveInput: cloneRecord(input.effectiveInput),
    inputAdapters,
    policy: input.policy,
    ...(approval === undefined ? {} : { approval }),
    ...(input.stableAuthority === undefined
      ? {}
      : { stableAuthority: input.stableAuthority }),
    ...(input.stableToolIdentity === undefined
      ? {}
      : { stableToolIdentity: input.stableToolIdentity }),
    ...(input.executionRequirements === undefined
      ? {}
      : { executionRequirements: input.executionRequirements }),
    preparedAt: input.preparedAt ?? new Date().toISOString(),
  });
}

export function createStableToolApprovalIdentityV1(input: {
  toolId: string;
  descriptorContractRevision: string;
  approvalAuthorityRevision: string;
}): StableToolApprovalIdentityV1 {
  return parseStableToolApprovalIdentityV1({
    version: STABLE_TOOL_APPROVAL_IDENTITY_VERSION,
    ...input,
  });
}

export function createPreparedToolApprovalAuthorityV2(input: {
  activation: ToolActivationRefV1;
  executionClass: ToolExecutionClass;
  effectiveInput: Record<string, unknown>;
  policyRevision: string;
  approvalAuthorityRevision: string;
  capabilities: readonly string[];
  runContext: ToolRunContext;
}): {
  stableAuthority: PreparedToolStableAuthorityV2;
  stableToolIdentity: StableToolApprovalIdentityV1;
  executionRequirements: PreparedToolExecutionRequirementsV1;
} | undefined {
  const context = readHostedStableApprovalContext(input.runContext);
  if (context === undefined) return;
  const capabilities = [...new Set(input.capabilities)]
    .filter((entry) => entry.trim().length > 0)
    .sort();
  const normalizedActionHash = hashCanonical({
    toolId: input.activation.descriptor.toolId,
    effectiveInput: input.effectiveInput,
  });
  const stableToolIdentity = createStableToolApprovalIdentityV1({
    toolId: input.activation.descriptor.toolId,
    descriptorContractRevision: input.activation.descriptor.contractRevision,
    approvalAuthorityRevision: input.approvalAuthorityRevision,
  });
  const authorityPayload = {
    version: PREPARED_TOOL_STABLE_AUTHORITY_V2_VERSION,
    actor: context.actor,
    organizationId: context.organizationId,
    environmentId: context.environmentId,
    projectId: context.projectId,
    threadId: context.threadId,
    resourceAuthority: {
      ...context.resourceAuthority,
      toolSourceKind: input.activation.descriptor.sourceKind,
      toolSourceId: input.activation.descriptor.sourceId,
    },
    policyRevision: input.policyRevision,
    capabilities,
    descriptorContractRevision: input.activation.descriptor.contractRevision,
    approvalAuthorityRevision: input.approvalAuthorityRevision,
    normalizedActionHash,
    executionClass: input.executionClass,
  };
  return {
    stableAuthority: {
      ...authorityPayload,
      fingerprint: hashCanonical(authorityPayload),
    },
    stableToolIdentity,
    executionRequirements: {
      version: PREPARED_TOOL_EXECUTION_REQUIREMENTS_VERSION,
      credentials: ([
        "continuation_run_segment",
        ...(context.hasMcpGrant ? ["mcp_access_grant" as const] : []),
        ...(context.hasProjectContextGrant
          ? ["project_context_grant" as const]
          : []),
        ...(context.hasWorkspaceLease ? ["workspace_lease" as const] : []),
        ...(context.hasSourceWriteGrant ? ["source_write_grant" as const] : []),
        ...(context.hasProviderExecutionTicket
          ? ["provider_execution_ticket" as const]
          : []),
        "live_handler_capability",
      ] satisfies import("../kestrel/contracts/tool-invocation.js").RenewableToolExecutionCredentialV1[]).sort(),
    },
  };
}

export async function executePinnedToolCallV1(input: {
  prepared: PreparedToolCallV1;
  pinned: PinnedToolExecutionV1;
  signal?: AbortSignal | undefined;
  persistCompletedCapabilityResult?: ((result: AgentToolResultV2) => Promise<void>) | undefined;
}): Promise<AgentToolResultV2> {
  const prepared = parsePreparedToolCallV1(input.prepared);
  const executionClass = input.pinned.resolveExecutionClass?.(prepared.effectiveInput) ??
    input.pinned.descriptor.capability.executionClass;
  assertPreparedActivationMatches(prepared.activation, input.pinned.activation);
  if (
    prepared.stableAuthority?.version ===
      PREPARED_TOOL_STABLE_AUTHORITY_V2_VERSION &&
    prepared.stableAuthority.executionClass !== executionClass
  ) {
    throw createRuntimeFailure(
      "TOOL_ACTIVATION_STALE",
      "Prepared tool authority no longer matches its pinned execution class.",
      {
        subsystem: "tooling",
        classification: "policy",
        recoverable: false,
        toolName: prepared.activation.descriptor.toolId,
      },
    );
  }
  throwIfAborted(input.signal);
  const startedAt = new Date().toISOString();
  let rawOutput: unknown;
  let preCleanupResult: AgentToolResultV2 | undefined;
  let preCleanupRawOutputDigest: string | undefined;
  let externalEffectAcknowledged = false;
  try {
    rawOutput = await input.pinned.handler(prepared.effectiveInput, {
      acknowledgeExternalEffect: () => {
        externalEffectAcknowledged = true;
      },
      persistCompletedCapabilityResult: async (completedRawOutput) => {
        const result = buildCompletedToolResult({
          prepared,
          pinned: input.pinned,
          rawOutput: completedRawOutput,
          startedAt,
        });
        if (result.outcome.kind === "failure") {
          throw createRuntimeFailure(
            "TOOL_RESULT_NOT_REPLAYABLE_BEFORE_CLEANUP",
            `Tool '${input.pinned.descriptor.toolId}' did not produce a replayable exact result before capability cleanup.`,
            { subsystem: "tooling", classification: "contract", recoverable: false, toolName: input.pinned.descriptor.toolId },
          );
        }
        await input.persistCompletedCapabilityResult?.(result);
        preCleanupResult = result;
        preCleanupRawOutputDigest = hashCanonical(completedRawOutput);
      },
    });
  } catch (error) {
    if (error instanceof RunCancelledError || input.signal?.aborted === true) {
      throw error;
    }
    const effectState = executionClass === "external_side_effect" && externalEffectAcknowledged
      ? "unknown"
      : "not_started";
    return buildFailureResult({
      prepared,
      descriptor: input.pinned.descriptor,
      error,
      startedAt,
      effectState,
    });
  }

  if (preCleanupResult !== undefined) {
    if (hashCanonical(rawOutput) !== preCleanupRawOutputDigest) {
      throw createRuntimeFailure(
        "TOOL_RESULT_CHANGED_AFTER_PERSISTENCE",
        `Tool '${input.pinned.descriptor.toolId}' changed its output after durable persistence.`,
        { subsystem: "tooling", classification: "contract", recoverable: false, toolName: input.pinned.descriptor.toolId },
      );
    }
    return preCleanupResult;
  }

  return buildCompletedToolResult({ prepared, pinned: input.pinned, rawOutput, startedAt, executionClass });
}

export function buildUnknownPreparedToolCallResultV1(input: {
  prepared: PreparedToolCallV1;
  error: { code: string; message: string; details?: Record<string, unknown> | undefined };
  startedAt: string;
}): AgentToolResultV2 {
  const prepared = parsePreparedToolCallV1(input.prepared);
  const completedAt = new Date().toISOString();
  const legacyError = Object.assign(new Error(input.error.message), {
    ...(input.error.details === undefined ? {} : { details: input.error.details }),
  });
  const legacy = buildAgentToolFailureResult({
    toolName: prepared.activation.descriptor.toolId,
    input: prepared.effectiveInput,
    error: legacyError,
    startedAt: input.startedAt,
    completedAt,
  });
  const outcome: ToolExecutionOutcomeV1 = {
    version: TOOL_EXECUTION_OUTCOME_VERSION,
    callId: prepared.callId,
    activation: prepared.activation,
    kind: "failure",
    startedAt: input.startedAt,
    completedAt,
    effectState: "unknown",
    normalizedFailureCode: input.error.code,
    retryable: false,
    error: {
      message: input.error.message,
      ...(input.error.details === undefined ? {} : { details: input.error.details }),
    },
  };
  return Object.freeze({
    ...legacy,
    version: AGENT_TOOL_RESULT_VERSION,
    toolCallId: prepared.callId,
    activation: prepared.activation,
    outcome,
  });
}

function buildCompletedToolResult(input: {
  prepared: PreparedToolCallV1;
  pinned: PinnedToolExecutionV1;
  rawOutput: unknown;
  startedAt: string;
  executionClass?: ToolExecutionClass | undefined;
}): AgentToolResultV2 {
  const { prepared, pinned, rawOutput, startedAt } = input;

  const effectState =
    (input.executionClass ?? pinned.resolveExecutionClass?.(prepared.effectiveInput) ??
      pinned.descriptor.capability.executionClass) === "external_side_effect"
      ? "committed"
      : "not_applicable";
  if (isAgentToolResult(rawOutput)) {
    return buildFailureResult({
      prepared,
      descriptor: pinned.descriptor,
      error: createRuntimeFailure(
        "TOOL_RESULT_ENVELOPE_FORBIDDEN",
        `Tool handler '${pinned.descriptor.execution.handlerId}' returned a gateway-owned result envelope.`,
        {
          subsystem: "tooling",
          classification: "contract",
          recoverable: false,
          toolName: pinned.descriptor.toolId,
        },
      ),
      startedAt,
      effectState,
    });
  }
  let normalized;
  try {
    normalized = pinned.normalizer(rawOutput, prepared.effectiveInput);
  } catch (error) {
    return buildFailureResult({
      prepared,
      descriptor: pinned.descriptor,
      error,
      startedAt,
      effectState,
    });
  }
  if (pinned.validator(normalized.output) !== true) {
    return buildFailureResult({
      prepared,
      descriptor: pinned.descriptor,
      error: createRuntimeFailure(
        "TOOL_RESULT_CONTRACT_FAILED",
        `Tool '${pinned.descriptor.toolId}' output failed its runtime contract.`,
        {
          subsystem: "tooling",
          classification: "schema",
          recoverable: false,
          toolName: pinned.descriptor.toolId,
          validationErrors: pinned.validator.errors ?? [],
          effectState,
        },
      ),
      startedAt,
      effectState,
    });
  }
  const completedAt = new Date().toISOString();
  const legacy = buildAgentToolSuccessResult({
    toolName: pinned.descriptor.toolId,
    input: prepared.effectiveInput,
    output: normalized.output,
    startedAt,
    completedAt,
    ...(normalized.presentation === undefined
      ? {}
      : { presentation: normalized.presentation }),
  });
  const outcome: ToolExecutionOutcomeV1 =
    normalized.partial === undefined
      ? {
          version: TOOL_EXECUTION_OUTCOME_VERSION,
          callId: prepared.callId,
          activation: prepared.activation,
          kind: "success",
          startedAt,
          completedAt,
          effectState,
          rawOutput: normalized.output,
        }
      : {
          version: TOOL_EXECUTION_OUTCOME_VERSION,
          callId: prepared.callId,
          activation: prepared.activation,
          kind: "partial",
          startedAt,
          completedAt,
          effectState,
          rawOutput: normalized.output,
          normalizedFailureCode: normalized.partial.normalizedFailureCode,
          retryable:
            effectState === "committed" ? false : normalized.partial.retryable,
        };
  return Object.freeze({
    ...legacy,
    version: AGENT_TOOL_RESULT_VERSION,
    toolCallId: prepared.callId,
    activation: prepared.activation,
    outcome,
  });
}

export function fingerprintToolRunScopeV1(
  runContext: ToolRunContext | undefined,
): string {
  const payload = asRecord(runContext?.payload);
  const hosted = asRecord(payload?.mcpContext);
  const orchestration = asRecord(payload?.orchestration);
  const metadata = asRecord(payload?.metadata);
  const workspace = asRecord(payload?.workspace);
  const runtimeAssembly = asRecord(orchestration?.runtimeAssembly);
  const clientCapabilities = asRecord(payload?.clientCapabilities);
  const kestrelOne = asRecord(clientCapabilities?.kestrelOne);
  const projectContext =
    asRecord(payload?.projectContext) ?? asRecord(metadata?.projectContext);
  const organizationId = readString(hosted?.organizationId);
  const environmentId = readString(hosted?.environmentId);
  const gatewayUrl = sanitizeGatewayUrl(readString(hosted?.gatewayUrl));
  const projectId =
    readString(hosted?.projectId) ?? readString(projectContext?.projectId);
  const threadId =
    readString(hosted?.threadId) ??
    readString(orchestration?.threadId) ??
    readString(metadata?.threadId);
  const toolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
    ? runtimeAssembly.toolAllowlist
        .filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
        .map((value) => value.trim())
        .sort()
    : undefined;
  const appApprovalModes = asRecord(kestrelOne?.appApprovalModes);
  const appApprovalPolicies = asRecord(kestrelOne?.appApprovalPolicies);
  const sourceWriteGrants = Array.isArray(
    orchestration?.devShellSourceWriteApprovalGrants,
  )
    ? orchestration.devShellSourceWriteApprovalGrants
        .flatMap((value) => {
          const grant = asRecord(value);
          if (readString(grant?.grantId) === undefined) return [];
          return [
            {
              ...(readString(grant?.command) === undefined
                ? {}
                : { command: readString(grant?.command) }),
              ...(readString(grant?.cwd) === undefined
                ? {}
                : { cwd: readString(grant?.cwd) }),
              writablePaths: Array.isArray(grant?.writablePaths)
                ? grant.writablePaths
                    .filter(
                      (path): path is string =>
                        typeof path === "string" && path.trim().length > 0,
                    )
                    .map((path) => path.trim())
                    .sort()
                : [],
            },
          ];
        })
        .sort((left, right) =>
          hashCanonical(left).localeCompare(hashCanonical(right)),
        )
    : [];
  return fingerprintToolScopeV1({
    version: "v1",
    // The continuation proves its relationship to this run separately while
    // execution credentials themselves remain renewable.
    runId: runContext?.runId ?? "unscoped",
    sessionId: runContext?.sessionId ?? "unscoped",
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(readString(kestrelOne?.tenantId ?? kestrelOne?.organizationId) ===
    undefined
      ? {}
      : {
          tenantId: readString(
            kestrelOne?.tenantId ?? kestrelOne?.organizationId,
          ),
        }),
    ...(appApprovalModes === undefined ? {} : { appApprovalModes }),
    ...(appApprovalPolicies === undefined ? {} : { appApprovalPolicies }),
    ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
    assembly: {
      ...(readString(runtimeAssembly?.effectiveAssemblyId) === undefined
        ? {}
        : {
            effectiveAssemblyId: readString(
              runtimeAssembly?.effectiveAssemblyId,
            ),
          }),
      ...(readString(runtimeAssembly?.bundleId) === undefined
        ? {}
        : { bundleId: readString(runtimeAssembly?.bundleId) }),
      ...(readString(runtimeAssembly?.contextPolicyId) === undefined
        ? {}
        : { contextPolicyId: readString(runtimeAssembly?.contextPolicyId) }),
    },
    workspace: {
      ...(readString(workspace?.workspaceRoot) === undefined
        ? {}
        : { workspaceRoot: readString(workspace?.workspaceRoot) }),
      ...(readString(workspace?.sourceWorkspaceRoot) === undefined
        ? {}
        : { sourceWorkspaceRoot: readString(workspace?.sourceWorkspaceRoot) }),
      ...(workspace?.managedWorktree === true ? { managedWorktree: true } : {}),
      ...(workspace?.managedWorktreeRequired === false
        ? { managedWorktreeRequired: false }
        : {}),
    },
    authorization: {
      ...(sourceWriteGrants.length === 0 ? {} : { sourceWriteGrants }),
    },
    ...(readString(
      payload?.interactionMode ??
        metadata?.interactionMode ??
        orchestration?.interactionMode,
    ) === undefined
      ? {}
      : {
          interactionMode: readString(
            payload?.interactionMode ??
              metadata?.interactionMode ??
              orchestration?.interactionMode,
          ),
        }),
  });
}

export function readHostedStableApprovalContext(runContext: ToolRunContext):
  | {
      actor: RunnerApprovalActorAuthorityV1;
      organizationId: string;
      environmentId: string;
      projectId: string;
      threadId: string;
      resourceAuthority: Record<string, unknown>;
      hasMcpGrant: boolean;
      hasProjectContextGrant: boolean;
      hasWorkspaceLease: boolean;
      hasSourceWriteGrant: boolean;
      hasProviderExecutionTicket: boolean;
    }
  | undefined {
  const payload = asRecord(runContext.payload);
  const metadata = asRecord(payload?.metadata);
  const hostedAuthority = asRecord(payload?.hostedApprovalAuthority);
  const mcpContext = asRecord(payload?.mcpContext);
  const projectContext =
    asRecord(payload?.projectContext) ?? asRecord(metadata?.projectContext);
  const orchestration = asRecord(payload?.orchestration);
  const workspace = asRecord(payload?.workspace);
  const actorInput = asRecord(payload?.actor);
  const organizationId =
    readString(hostedAuthority?.organizationId) ??
    readString(mcpContext?.organizationId) ??
    readString(actorInput?.tenantId);
  const environmentId =
    readString(hostedAuthority?.environmentId) ??
    readString(mcpContext?.environmentId);
  const projectId =
    readString(hostedAuthority?.projectId) ??
    readString(mcpContext?.projectId) ??
    readString(projectContext?.projectId);
  const threadId =
    readString(hostedAuthority?.threadId) ??
    readString(mcpContext?.threadId) ??
    readString(orchestration?.threadId) ??
    readString(metadata?.threadId);
  const actorType = readString(actorInput?.actorType);
  const actorId = readString(actorInput?.actorId);
  if (
    organizationId === undefined ||
    environmentId === undefined ||
    projectId === undefined ||
    threadId === undefined ||
    actorId === undefined ||
    (actorType !== "end_user" &&
      actorType !== "operator" &&
      actorType !== "service")
  ) {
    return;
  }
  const sourceWriteGrants = Array.isArray(
    orchestration?.devShellSourceWriteApprovalGrants,
  )
    ? orchestration.devShellSourceWriteApprovalGrants
    : [];
  return {
    actor: {
      actorType,
      actorId,
      ...(readString(actorInput?.tenantId) === undefined
        ? {}
        : { tenantId: readString(actorInput?.tenantId) }),
    },
    organizationId,
    environmentId,
    projectId,
    threadId,
    resourceAuthority: {
      ...(sanitizeGatewayUrl(readString(mcpContext?.gatewayUrl)) === undefined
        ? {}
        : { gatewayUrl: sanitizeGatewayUrl(readString(mcpContext?.gatewayUrl)) }),
      ...(readString(workspace?.workspaceRoot) === undefined
        ? {}
        : { workspaceRoot: readString(workspace?.workspaceRoot) }),
      ...(readString(workspace?.sourceWorkspaceRoot) === undefined
        ? {}
        : { sourceWorkspaceRoot: readString(workspace?.sourceWorkspaceRoot) }),
      ...(workspace?.managedWorktree === true ? { managedWorktree: true } : {}),
    },
    hasMcpGrant: readString(mcpContext?.grantId) !== undefined,
    hasProjectContextGrant:
      readString(
        asRecord(payload?.clientCapabilities)?.kestrelOne &&
          asRecord(asRecord(payload?.clientCapabilities)?.kestrelOne)
            ?.contextGrantId,
      ) !== undefined,
    hasWorkspaceLease: readString(workspace?.leaseId) !== undefined,
    hasSourceWriteGrant: sourceWriteGrants.length > 0,
    hasProviderExecutionTicket:
      readString(
        asRecord(asRecord(payload?.clientCapabilities)?.kestrelOne)
          ?.executionTicket,
      ) !== undefined || readString(asRecord(payload?.mcpAuthorization)?.executionTicket) !== undefined,
  };
}

function buildFailureResult(input: {
  prepared: PreparedToolCallV1;
  descriptor: ToolDescriptorV1;
  error: unknown;
  startedAt: string;
  effectState: "not_applicable" | "not_started" | "committed" | "unknown";
}): AgentToolResultV2 {
  const completedAt = new Date().toISOString();
  const legacy = buildAgentToolFailureResult({
    toolName: input.descriptor.toolId,
    input: input.prepared.effectiveInput,
    error: input.error,
    startedAt: input.startedAt,
    completedAt,
  });
  const runtimeFailure =
    input.error instanceof RuntimeFailure ? input.error : undefined;
  const genericFailureDetails =
    input.error instanceof Error
      ? asRecord((input.error as Error & { details?: unknown }).details)
      : undefined;
  const failureDetails = runtimeFailure?.details ?? genericFailureDetails;
  const retryable =
    input.effectState !== "committed" &&
    input.effectState !== "unknown" &&
    runtimeFailure?.details?.recoverable === true;
  const normalizedFailureCode = runtimeFailure?.code ?? "TOOL_EXECUTION_FAILED";
  const outcome: ToolExecutionOutcomeV1 = {
    version: TOOL_EXECUTION_OUTCOME_VERSION,
    callId: input.prepared.callId,
    activation: input.prepared.activation,
    kind: "failure",
    startedAt: input.startedAt,
    completedAt,
    effectState: input.effectState,
    normalizedFailureCode,
    retryable,
    error: {
      message:
        input.error instanceof Error
          ? input.error.message
          : String(input.error),
      ...(failureDetails === undefined ? {} : { details: failureDetails }),
    },
  };
  return Object.freeze({
    ...legacy,
    version: AGENT_TOOL_RESULT_VERSION,
    toolCallId: input.prepared.callId,
    activation: input.prepared.activation,
    outcome,
  });
}

function assertPreparedActivationMatches(
  prepared: ToolActivationRefV1,
  pinned: ToolActivationRefV1,
): void {
  if (hashCanonical(prepared) !== hashCanonical(pinned)) {
    throw createRuntimeFailure(
      "TOOL_ACTIVATION_STALE",
      `Prepared tool call activation no longer matches its pinned handler.`,
      {
        subsystem: "tooling",
        classification: "policy",
        recoverable: false,
        toolName: prepared.descriptor.toolId,
      },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RunCancelledError({ subsystem: "tooling" });
  }
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function sanitizeGatewayUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}
