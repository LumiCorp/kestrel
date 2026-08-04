import type { ValidateFunction } from "ajv";

import type {
  ModelMessageToolCall,
  ToolRunContext,
  AgentToolPresentation,
} from "../kestrel/contracts/model-io.js";
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
  TOOL_EXECUTION_OUTCOME_VERSION,
  parsePreparedToolCallV1,
  type AgentToolResultV2,
  type PreparedToolApprovalAuthorityV1,
  type PreparedToolCallOriginV1,
  type PreparedToolCallV1,
  type PreparedToolInputAdapterV1,
  type PreparedToolPolicyDispositionV1,
  type ResolvedModelToolIntentV1,
  type ToolExecutionOutcomeV1,
} from "../kestrel/contracts/tool-invocation.js";
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
  handler: (input: unknown) => Promise<unknown>;
  normalizer: (output: unknown, input: unknown) => {
    output: unknown;
    presentation?: AgentToolPresentation | undefined;
    partial?: {
      normalizedFailureCode: string;
      retryable: boolean;
    } | undefined;
  };
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
  const approval = input.approval === undefined
    ? undefined
    : {
        ...input.approval,
        authorityRevision: hashCanonical({
          version: "prepared-tool-approval-authority-v1",
          activation: input.activation,
          effectiveInput: input.effectiveInput,
          inputAdapters,
          policyRevision: input.policy.policyRevision,
          upstreamAuthorityRevision: input.approval.authorityRevision,
          ...(input.approval.recoveryAdapterId === undefined
            ? {}
            : { recoveryAdapterId: input.approval.recoveryAdapterId }),
        }),
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
    preparedAt: input.preparedAt ?? new Date().toISOString(),
  });
}

export async function executePinnedToolCallV1(input: {
  prepared: PreparedToolCallV1;
  pinned: PinnedToolExecutionV1;
  signal?: AbortSignal | undefined;
}): Promise<AgentToolResultV2> {
  const prepared = parsePreparedToolCallV1(input.prepared);
  assertPreparedActivationMatches(prepared.activation, input.pinned.activation);
  throwIfAborted(input.signal);
  const startedAt = new Date().toISOString();
  let rawOutput: unknown;
  try {
    rawOutput = await input.pinned.handler(prepared.effectiveInput);
  } catch (error) {
    if (error instanceof RunCancelledError || input.signal?.aborted === true) {
      throw error;
    }
    const effectState =
      input.pinned.descriptor.capability.executionClass === "external_side_effect"
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

  const effectState =
    input.pinned.descriptor.capability.executionClass === "external_side_effect"
      ? "committed"
      : "not_applicable";
  if (isAgentToolResult(rawOutput)) {
    return buildFailureResult({
      prepared,
      descriptor: input.pinned.descriptor,
      error: createRuntimeFailure(
        "TOOL_RESULT_ENVELOPE_FORBIDDEN",
        `Tool handler '${input.pinned.descriptor.execution.handlerId}' returned a gateway-owned result envelope.`,
        {
          subsystem: "tooling",
          classification: "contract",
          recoverable: false,
          toolName: input.pinned.descriptor.toolId,
        },
      ),
      startedAt,
      effectState,
    });
  }
  let normalized;
  try {
    normalized = input.pinned.normalizer(rawOutput, prepared.effectiveInput);
  } catch (error) {
    return buildFailureResult({
      prepared,
      descriptor: input.pinned.descriptor,
      error,
      startedAt,
      effectState,
    });
  }
  if (input.pinned.validator(normalized.output) !== true) {
    return buildFailureResult({
      prepared,
      descriptor: input.pinned.descriptor,
      error: createRuntimeFailure(
        "TOOL_RESULT_CONTRACT_FAILED",
        `Tool '${input.pinned.descriptor.toolId}' output failed its runtime contract.`,
        {
          subsystem: "tooling",
          classification: "schema",
          recoverable: false,
          toolName: input.pinned.descriptor.toolId,
          validationErrors: input.pinned.validator.errors ?? [],
          effectState,
        },
      ),
      startedAt,
      effectState,
    });
  }
  const completedAt = new Date().toISOString();
  const legacy = buildAgentToolSuccessResult({
    toolName: input.pinned.descriptor.toolId,
    input: prepared.effectiveInput,
    output: normalized.output,
    startedAt,
    completedAt,
    ...(normalized.presentation === undefined
      ? {}
      : { presentation: normalized.presentation }),
  });
  const outcome: ToolExecutionOutcomeV1 = normalized.partial === undefined ? {
    version: TOOL_EXECUTION_OUTCOME_VERSION,
    callId: prepared.callId,
    activation: prepared.activation,
    kind: "success",
    startedAt,
    completedAt,
    effectState,
    rawOutput: normalized.output,
  } : {
    version: TOOL_EXECUTION_OUTCOME_VERSION,
    callId: prepared.callId,
    activation: prepared.activation,
    kind: "partial",
    startedAt,
    completedAt,
    effectState,
    rawOutput: normalized.output,
    normalizedFailureCode: normalized.partial.normalizedFailureCode,
    retryable: effectState === "committed"
      ? false
      : normalized.partial.retryable,
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
  const grantId = readString(hosted?.grantId);
  const projectId =
    readString(hosted?.projectId) ?? readString(projectContext?.projectId);
  const threadId =
    readString(hosted?.threadId) ??
    readString(orchestration?.threadId) ??
    readString(metadata?.threadId);
  const toolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
    ? runtimeAssembly.toolAllowlist
        .filter((value): value is string =>
          typeof value === "string" && value.trim().length > 0
        )
        .map((value) => value.trim())
        .sort()
    : undefined;
  const appApprovalModes = asRecord(kestrelOne?.appApprovalModes);
  const sourceWriteGrants = Array.isArray(
    orchestration?.devShellSourceWriteApprovalGrants,
  )
    ? orchestration.devShellSourceWriteApprovalGrants.flatMap((value) => {
        const grant = asRecord(value);
        const grantId = readString(grant?.grantId);
        if (grantId === undefined) return [];
        return [{
          grantId,
          ...(readString(grant?.command) === undefined
            ? {}
            : { command: readString(grant?.command) }),
          ...(readString(grant?.cwd) === undefined
            ? {}
            : { cwd: readString(grant?.cwd) }),
          ...(readString(grant?.expiresAt) === undefined
            ? {}
            : { expiresAt: readString(grant?.expiresAt) }),
          writablePaths: Array.isArray(grant?.writablePaths)
            ? grant.writablePaths
                .filter((path): path is string =>
                  typeof path === "string" && path.trim().length > 0
                )
                .map((path) => path.trim())
                .sort()
            : [],
        }];
      }).sort((left, right) => left.grantId.localeCompare(right.grantId))
    : [];
  return fingerprintToolScopeV1({
    version: "v1",
    runId: runContext?.runId ?? "unscoped",
    sessionId: runContext?.sessionId ?? "unscoped",
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    ...(grantId === undefined ? {} : { grantId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(readString(kestrelOne?.tenantId ?? kestrelOne?.organizationId) === undefined
      ? {}
      : { tenantId: readString(kestrelOne?.tenantId ?? kestrelOne?.organizationId) }),
    ...(readString(kestrelOne?.contextGrantId) === undefined
      ? {}
      : { contextGrantId: readString(kestrelOne?.contextGrantId) }),
    ...(appApprovalModes === undefined ? {} : { appApprovalModes }),
    ...(toolAllowlist === undefined ? {} : { toolAllowlist }),
    assembly: {
      ...(readString(runtimeAssembly?.effectiveAssemblyId) === undefined
        ? {}
        : { effectiveAssemblyId: readString(runtimeAssembly?.effectiveAssemblyId) }),
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
      ...(readString(workspace?.leaseId) === undefined
        ? {}
        : { leaseId: readString(workspace?.leaseId) }),
      ...(workspace?.managedWorktree === true ? { managedWorktree: true } : {}),
      ...(workspace?.managedWorktreeRequired === false
        ? { managedWorktreeRequired: false }
        : {}),
    },
    authorization: {
      ...(sourceWriteGrants.length === 0
        ? {}
        : { sourceWriteGrants }),
    },
    ...(readString(payload?.interactionMode ?? metadata?.interactionMode ?? orchestration?.interactionMode) === undefined
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
  const runtimeFailure = input.error instanceof RuntimeFailure
    ? input.error
    : undefined;
  const retryable =
    input.effectState !== "committed" &&
    input.effectState !== "unknown" &&
    runtimeFailure?.details?.recoverable === true;
  const normalizedFailureCode =
    runtimeFailure?.code ?? "TOOL_EXECUTION_FAILED";
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
        input.error instanceof Error ? input.error.message : String(input.error),
      ...(runtimeFailure?.details === undefined
        ? {}
        : { details: runtimeFailure.details }),
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
