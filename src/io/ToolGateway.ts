import type { ValidateFunction } from "ajv";

import type {
  ModelToolContract,
  ToolGateway,
  ToolGatewayCallOptions,
} from "../kestrel/contracts/model-io.js";
import {
  JSON_VALUE_OUTPUT_SCHEMA_V1,
  TOOL_DESCRIPTOR_VERSION,
  compileToolJsonSchemaV1,
  createToolDescriptorV1,
  hashCanonical,
  parseToolDescriptorV1,
  toToolDescriptorRefV1,
  type ToolSurfaceSnapshotV1,
  type ToolCapabilityContractV1,
  type ToolDescriptorV1,
  type ToolPresentationContractV1,
} from "../kestrel/contracts/tool-contract.js";
import type {
  AgentToolResultV2,
  PreparedToolCallV1,
  ResolvedModelToolIntentV1,
} from "../kestrel/contracts/tool-invocation.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import {
  createPreparedToolCallV1,
  createPreparedToolApprovalAuthorityV2,
  createToolSurfaceForDescriptorsV1,
  executePinnedToolCallV1,
  fingerprintToolRunScopeV1,
  resolveModelToolIntentV1,
} from "./ToolInvocationSupport.js";

export type ToolHandler = (input: unknown) => Promise<unknown>;
export type ToolResultNormalizer = (
  output: unknown,
  input: unknown,
) => {
  output: unknown;
  presentation?: import("../kestrel/contracts/model-io.js").AgentToolPresentation | undefined;
  partial?: {
    normalizedFailureCode: string;
    retryable: boolean;
  } | undefined;
};

export interface RegisteredToolModuleV1 {
  descriptor: ToolDescriptorV1;
  handler: ToolHandler;
  normalizer: ToolResultNormalizer;
}

export interface EmbeddedToolModuleAuthoringV1 {
  ownerId: string;
  toolId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  runtimeOutputSchema?: Record<string, unknown> | undefined;
  modelOutputContract?: ModelToolContract | undefined;
  capability: ToolCapabilityContractV1;
  presentation: ToolPresentationContractV1;
  handlerId: string;
  resultNormalizerId: string;
  handler: ToolHandler;
}

export function createEmbeddedToolModuleV1(
  input: EmbeddedToolModuleAuthoringV1,
): RegisteredToolModuleV1 {
  return {
    descriptor: createToolDescriptorV1({
      version: TOOL_DESCRIPTOR_VERSION,
      toolId: input.toolId,
      source: {
        kind: "embedded",
        sourceId: input.ownerId,
        protocolKind: "handler",
        protocolTarget: input.toolId,
      },
      description: input.description,
      inputSchema: input.inputSchema,
      runtimeOutput: {
        schema: input.runtimeOutputSchema ?? {
          ...JSON_VALUE_OUTPUT_SCHEMA_V1,
        },
      },
      ...(input.modelOutputContract !== undefined
        ? { modelOutputContract: input.modelOutputContract }
        : {}),
      capability: input.capability,
      presentation: input.presentation,
      execution: {
        handlerId: input.handlerId,
        resultNormalizerId: input.resultNormalizerId,
      },
    }),
    handler: input.handler,
    normalizer: (output) => ({ output }),
  };
}

function validateAllowlistedToolName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw createRuntimeFailure(
      "IO_TOOL_NOT_ALLOWLISTED",
      "Tool name must be a non-empty string.",
      {
        subsystem: "runtime",
        classification: "configuration",
        recoverable: false,
        toolName: name,
      },
    );
  }
  return normalized;
}

export class AllowlistedToolGateway implements ToolGateway {
  private readonly modules = new Map<string, RegisteredToolModuleV1>();
  private readonly inputValidators = new Map<string, ValidateFunction>();
  private readonly outputValidators = new Map<string, ValidateFunction>();
  private readonly snapshots = new Map<string, ToolSurfaceSnapshotV1>();
  private readonly snapshotSessions = new Map<string, string>();
  private readonly registryGeneration: string;

  constructor(modules: readonly RegisteredToolModuleV1[]) {
    for (const module of modules) {
      const descriptor = parseToolDescriptorV1(module.descriptor);
      if (descriptor.source.kind === "mcp") {
        throw createRuntimeFailure(
          "IO_TOOL_DESCRIPTOR_INVALID",
          `Allowlisted tool '${descriptor.toolId}' cannot use an MCP descriptor.`,
          { toolName: descriptor.toolId, recoverable: false },
        );
      }
      if (this.modules.has(descriptor.toolId)) {
        throw createRuntimeFailure(
          "IO_TOOL_DESCRIPTOR_COLLISION",
          `Allowlisted tool '${descriptor.toolId}' is registered more than once.`,
          { toolName: descriptor.toolId, recoverable: false },
        );
      }
      if (typeof module.handler !== "function") {
        throw createRuntimeFailure(
          "IO_TOOL_HANDLER_MISSING",
          `Allowlisted tool '${descriptor.toolId}' is missing its handler.`,
          { toolName: descriptor.toolId, recoverable: false },
        );
      }
      if (typeof module.normalizer !== "function") {
        throw createRuntimeFailure(
          "IO_TOOL_RESULT_NORMALIZER_MISSING",
          `Allowlisted tool '${descriptor.toolId}' is missing its result normalizer.`,
          { toolName: descriptor.toolId, recoverable: false },
        );
      }
      this.modules.set(descriptor.toolId, {
        descriptor,
        handler: module.handler,
        normalizer: module.normalizer,
      });
      this.inputValidators.set(
        descriptor.toolId,
        compileToolJsonSchemaV1(descriptor.inputSchema, { surface: "input" }),
      );
      this.outputValidators.set(
        descriptor.toolId,
        compileToolJsonSchemaV1(descriptor.runtimeOutput.schema, {
          surface: "output",
        }),
      );
    }
    this.registryGeneration = hashCanonical({
      source: "allowlisted",
      descriptors: this.listDescriptors().map(toToolDescriptorRefV1),
    });
  }

  listDescriptors(): ToolDescriptorV1[] {
    return [...this.modules.values()].map((module) => module.descriptor);
  }

  getDescriptor(name: string): ToolDescriptorV1 | undefined {
    return this.modules.get(name)?.descriptor;
  }

  async createToolSurfaceSnapshot(
    options: ToolGatewayCallOptions = {},
  ): Promise<ToolSurfaceSnapshotV1> {
    const requestedNames = options.toolNames === undefined
      ? undefined
      : new Set(options.toolNames);
    const snapshot = createToolSurfaceForDescriptorsV1({
      descriptors: this.listDescriptors().filter(
        (descriptor) => requestedNames?.has(descriptor.toolId) ?? true,
      ),
      registryGeneration: this.registryGeneration,
      runContext: options.runContext,
    });
    this.snapshots.set(snapshot.snapshotId, snapshot);
    if (options.runContext !== undefined) {
      this.snapshotSessions.set(
        snapshot.snapshotId,
        options.runContext.sessionId,
      );
    }
    return snapshot;
  }

  resolveModelToolIntent(input: {
    snapshot: ToolSurfaceSnapshotV1;
    toolCall: { id: string; name: string; input: Record<string, unknown> };
  }): ResolvedModelToolIntentV1 {
    const known = this.snapshots.get(input.snapshot.snapshotId);
    if (known === undefined) {
      throw createRuntimeFailure(
        "TOOL_SNAPSHOT_STALE",
        `Tool surface snapshot '${input.snapshot.snapshotId}' is not active.`,
        { recoverable: false },
      );
    }
    return resolveModelToolIntentV1({ snapshot: known, toolCall: input.toolCall });
  }

  async prepareToolCall(
    input: Parameters<ToolGateway["prepareToolCall"]>[0],
    options: ToolGatewayCallOptions = {},
  ): Promise<PreparedToolCallV1> {
    const normalizedName = validateAllowlistedToolName(
      input.activation.descriptor.toolId,
    );
    const module = this.modules.get(normalizedName);
    const validator = this.inputValidators.get(normalizedName);
    if (module === undefined || validator === undefined) {
      throw createRuntimeFailure(
        "IO_TOOL_NOT_ALLOWLISTED",
        `Tool '${normalizedName}' is not allowlisted.`,
        { recoverable: false, toolName: normalizedName },
      );
    }
    const expectedRef = toToolDescriptorRefV1(module.descriptor);
    if (
      input.activation.registryGeneration !== this.registryGeneration ||
      hashCanonical(input.activation.descriptor) !== hashCanonical(expectedRef) ||
      input.activation.scopeFingerprint !==
        fingerprintToolRunScopeV1(options.runContext)
    ) {
      throw createRuntimeFailure(
        "TOOL_ACTIVATION_STALE",
        `Tool '${normalizedName}' activation is stale or divergent.`,
        { recoverable: false, toolName: normalizedName },
      );
    }
    if (input.origin.kind === "model") {
      const snapshot = this.snapshots.get(input.origin.snapshotId);
      const exposed = snapshot?.tools.find(
        (candidate) => candidate.descriptor.toolId === normalizedName,
      );
      if (
        exposed === undefined ||
        hashCanonical(exposed) !== hashCanonical(input.activation)
      ) {
        throw createRuntimeFailure(
          "TOOL_SNAPSHOT_LOOKUP_FAILED",
          `Tool '${normalizedName}' was not exposed by the referenced model snapshot.`,
          { recoverable: false, toolName: normalizedName },
        );
      }
    }
    if (validator(input.rawInput) !== true) {
      throw createRuntimeFailure(
        "TOOL_INPUT_SCHEMA_FAILED",
        `Tool '${normalizedName}' input failed schema validation.`,
        {
          subsystem: "tooling",
          classification: "schema",
          recoverable: true,
          toolName: normalizedName,
          validationErrors: validator.errors ?? [],
        },
      );
    }
    const stableApproval =
      input.policy.decision === "approval_required" &&
      input.approval !== undefined &&
      options.runContext !== undefined
        ? createPreparedToolApprovalAuthorityV2({
            activation: input.activation,
            executionClass: module.descriptor.capability.executionClass,
            effectiveInput: input.rawInput,
            policyRevision: input.policy.policyRevision,
            approvalAuthorityRevision: input.approval.authorityRevision,
            capabilities: input.approvalCapabilities ?? [],
            runContext: options.runContext,
          })
        : undefined;
    return createPreparedToolCallV1({
      runId: input.runId,
      sessionId: input.sessionId,
      callId: input.callId,
      activation: input.activation,
      origin: input.origin,
      effectiveInput: input.rawInput,
      policy: input.policy,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
      ...(stableApproval ?? {}),
    });
  }

  async executePreparedToolCall(
    prepared: PreparedToolCallV1,
    options: ToolGatewayCallOptions = {},
  ): Promise<AgentToolResultV2> {
    const toolName = prepared.activation.descriptor.toolId;
    const module = this.modules.get(toolName);
    const validator = this.outputValidators.get(toolName);
    if (module === undefined || validator === undefined) {
      throw createRuntimeFailure(
        "TOOL_PINNED_HANDLER_UNAVAILABLE",
        `Pinned handler for tool '${toolName}' is unavailable.`,
        { recoverable: false, toolName },
      );
    }
    return executePinnedToolCallV1({
      prepared,
      pinned: {
        descriptor: module.descriptor,
        activation: prepared.activation,
        validator,
        handler: module.handler,
        normalizer: module.normalizer,
      },
      signal: options.signal,
    });
  }

  releaseToolSurfaceSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    this.snapshotSessions.delete(snapshotId);
  }

  releaseToolRun(_runId: string, sessionId: string): void {
    for (const [snapshotId, ownerSessionId] of this.snapshotSessions) {
      if (ownerSessionId === sessionId) {
        this.releaseToolSurfaceSnapshot(snapshotId);
      }
    }
  }

}
