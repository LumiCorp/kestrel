import {
  AllowlistedToolGateway,
  createEmbeddedToolModuleV1,
  type ToolHandler,
} from "../../src/io/ToolGateway.js";
import type {
  AgentToolResult,
  ToolGateway,
  ToolGatewayCallOptions,
  ToolGatewayPreRunContext,
  ToolRuntimeStatus,
} from "../../src/kestrel/contracts/model-io.js";
import {
  JSON_VALUE_OUTPUT_SCHEMA_V1,
  TOOL_DESCRIPTOR_VERSION,
  compileToolJsonSchemaV1,
  createToolDescriptorV1,
  hashCanonical,
  toToolDescriptorRefV1,
  type ToolDescriptorV1,
  type ToolDescriptorRefV1,
  type ToolSurfaceSnapshotV1,
} from "../../src/kestrel/contracts/tool-contract.js";
import type {
  AgentToolResultV2,
  PreparedToolCallV1,
} from "../../src/kestrel/contracts/tool-invocation.js";
import {
  createPreparedToolCallV1,
  createToolSurfaceForDescriptorsV1,
  executePinnedToolCallV1,
  resolveModelToolIntentV1,
  RUNTIME_DEADLINE_BUDGET_ADAPTER_ID,
} from "../../src/io/ToolInvocationSupport.js";
import { isAgentToolResult } from "../../tools/toolResult.js";
import { applyExternalDeadlineToolBudget } from "../../src/engine/ExecutionEngineSupport.js";

export function createTestToolGateway(
  handlers: Readonly<Record<string, ToolHandler>>,
): AllowlistedToolGateway {
  return new AllowlistedToolGateway(
    Object.entries(handlers).map(([toolId, handler]) =>
      createEmbeddedToolModuleV1({
        ownerId: "kestrel.tests",
        toolId,
        description: `Test tool ${toolId}`,
        inputSchema: { type: "object", additionalProperties: true },
        capability: {
          freshnessClass: "static",
          latencyClass: "low",
          costClass: "free",
          executionClass: "read_only",
          capabilityClasses: [`test.${toolId}`],
        },
        presentation: {
          displayName: toolId,
          aliases: [toolId],
          keywords: ["test"],
          provider: "test",
          toolFamily: "test",
        },
        handlerId: `test:${toolId}:handler:v1`,
        resultNormalizerId: `test:${toolId}:json:v1`,
        handler,
      }),
    ),
  );
}

export interface LegacyTestToolGateway {
  call(
    name: string,
    input: unknown,
    options?: ToolGatewayCallOptions,
  ): Promise<unknown>;
  validateInput?(
    name: string,
    input: unknown,
    options?: ToolGatewayCallOptions,
  ): Promise<unknown>;
  preRun?(context: ToolGatewayPreRunContext): Promise<void>;
  getRuntimeStatus?(): Promise<ToolRuntimeStatus>;
  refreshRuntime?(): Promise<ToolRuntimeStatus>;
  close?(): Promise<void>;
}

export function createLegacyTestToolDescriptorRef(
  toolName: string,
): ToolDescriptorRefV1 {
  return toToolDescriptorRefV1(createLegacyTestToolDescriptor(toolName));
}

function createLegacyTestToolDescriptor(toolName: string): ToolDescriptorV1 {
  return createToolDescriptorV1({
    version: TOOL_DESCRIPTOR_VERSION,
    toolId: toolName,
    source: {
      kind: "embedded",
      sourceId: "kestrel.tests.legacy",
      protocolKind: "handler",
      protocolTarget: toolName,
    },
    description: `Legacy test tool ${toolName}`,
    inputSchema: { type: "object", additionalProperties: true },
    runtimeOutput: { schema: JSON_VALUE_OUTPUT_SCHEMA_V1 },
    capability: {
      freshnessClass: "static",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: [`test.${toolName}`],
    },
    presentation: {
      displayName: toolName,
      aliases: [toolName],
      keywords: ["test"],
      provider: "test",
      toolFamily: "test",
    },
    execution: {
      handlerId: `test:${toolName}:legacy-handler:v1`,
      resultNormalizerId: `test:${toolName}:legacy-json:v1`,
    },
  });
}

/**
 * Keeps pre-PR2 fixture behavior behind a test-only adapter while production
 * code exercises the atomic ToolGateway contract.
 */
export function adaptLegacyTestToolGateway(
  legacy: LegacyTestToolGateway,
): ToolGateway {
  const snapshots = new Map<string, ToolSurfaceSnapshotV1>();
  const descriptors = new Map<string, ToolDescriptorV1>();
  const preparedNames = new Map<string, string>();
  const shortCircuitOutputs = new Map<string, unknown>();
  const registryGeneration = hashCanonical({
    source: "legacy-test-gateway",
    revision: "v1",
  });

  const descriptorFor = (toolName: string): ToolDescriptorV1 => {
    const existing = descriptors.get(toolName);
    if (existing !== undefined) return existing;
    const descriptor = createLegacyTestToolDescriptor(toolName);
    descriptors.set(toolName, descriptor);
    return descriptor;
  };

  return {
    async createToolSurfaceSnapshot(options = {}) {
      const toolNames = [...new Set(options.toolNames ?? [...descriptors.keys()])];
      const snapshot = createToolSurfaceForDescriptorsV1({
        descriptors: toolNames.map(descriptorFor),
        registryGeneration,
        runContext: options.runContext,
      });
      snapshots.set(snapshot.snapshotId, snapshot);
      return snapshot;
    },
    resolveModelToolIntent(input) {
      const snapshot = snapshots.get(input.snapshot.snapshotId);
      if (snapshot === undefined) {
        throw new Error(`Unknown test tool snapshot '${input.snapshot.snapshotId}'.`);
      }
      return resolveModelToolIntentV1({ snapshot, toolCall: input.toolCall });
    },
    async prepareToolCall(input, options = {}) {
      const descriptor = descriptorFor(input.activation.descriptor.toolId);
      const descriptorRef = toToolDescriptorRefV1(descriptor);
      if (
        input.activation.registryGeneration !== registryGeneration ||
        input.activation.descriptor.contractRevision !== descriptorRef.contractRevision
      ) {
        throw new Error(`Stale test activation for '${descriptor.toolId}'.`);
      }
      const validatedInput = legacy.validateInput === undefined
        ? input.rawInput
        : await legacy.validateInput(descriptor.toolId, input.rawInput, options);
      const budgeted = options.runtimeBudgetRemainingMs === undefined
        ? { input: validatedInput, metadata: {}, shortCircuitResult: undefined }
        : applyExternalDeadlineToolBudget({
            toolName: descriptor.toolId,
            input: validatedInput,
            runtimeBudgetRemainingMs: options.runtimeBudgetRemainingMs,
          });
      const effectiveInput = budgeted.input;
      if (
        typeof effectiveInput !== "object" ||
        effectiveInput === null ||
        Array.isArray(effectiveInput)
      ) {
        throw new Error(`Test tool '${descriptor.toolId}' input must be an object.`);
      }
      const prepared = createPreparedToolCallV1({
        ...input,
        effectiveInput: effectiveInput as Record<string, unknown>,
        inputAdapters:
          descriptor.toolId === "dev.shell.run" || descriptor.toolId === "exec_command"
            ? [{
                adapterId: RUNTIME_DEADLINE_BUDGET_ADAPTER_ID,
                metadata: budgeted.metadata,
              }]
            : [],
      });
      preparedNames.set(preparedKey(prepared), descriptor.toolId);
      if (budgeted.shortCircuitResult !== undefined) {
        shortCircuitOutputs.set(preparedKey(prepared), budgeted.shortCircuitResult);
      }
      return prepared;
    },
    async executePreparedToolCall(prepared, options = {}) {
      const toolName = preparedNames.get(preparedKey(prepared));
      if (toolName === undefined) {
        throw new Error(`Unknown prepared test call '${prepared.callId}'.`);
      }
      const descriptor = descriptorFor(toolName);
      return executePinnedToolCallV1({
        prepared,
        pinned: {
          descriptor,
          activation: prepared.activation,
          validator: compileToolJsonSchemaV1(JSON_VALUE_OUTPUT_SCHEMA_V1, {
            surface: "output",
          }),
          normalizer: (output) => ({ output }),
          handler: async (toolInput) => {
            if (shortCircuitOutputs.has(preparedKey(prepared))) {
              return shortCircuitOutputs.get(preparedKey(prepared));
            }
            const value = await legacy.call(toolName, toolInput, options);
            return isAgentToolResult(value)
              ? unwrapLegacyTestResult(value)
              : value;
          },
        },
        signal: options.signal,
      });
    },
    releaseToolSurfaceSnapshot(snapshotId) {
      snapshots.delete(snapshotId);
    },
    ...(legacy.preRun === undefined
      ? {}
      : { preRun: (context) => legacy.preRun!(context) }),
    ...(legacy.getRuntimeStatus === undefined
      ? {}
      : { getRuntimeStatus: () => legacy.getRuntimeStatus!() }),
    ...(legacy.refreshRuntime === undefined
      ? {}
      : { refreshRuntime: () => legacy.refreshRuntime!() }),
    ...(legacy.close === undefined ? {} : { close: () => legacy.close!() }),
  };
}

export async function prepareTestToolCall(input: {
  gateway: ToolGateway;
  toolName: string;
  toolInput: Record<string, unknown>;
  runId?: string | undefined;
  sessionId?: string | undefined;
  callId?: string | undefined;
  options?: ToolGatewayCallOptions | undefined;
}): Promise<PreparedToolCallV1> {
  const runId = input.runId ?? "test-run";
  const sessionId = input.sessionId ?? "test-session";
  const callId = input.callId ?? `test-call:${input.toolName}:${nextTestCallId++}`;
  const snapshot = await input.gateway.createToolSurfaceSnapshot({
    ...input.options,
    toolNames: [input.toolName],
  });
  const activation = snapshot.tools.find(
    (candidate) => candidate.descriptor.toolId === input.toolName,
  );
  if (activation === undefined) {
    throw new Error(`Test tool '${input.toolName}' is not available.`);
  }
  return input.gateway.prepareToolCall(
    {
      runId,
      sessionId,
      callId,
      activation,
      origin: {
        kind: "trusted_runtime",
        producerId: "kestrel.tests:v1",
        adapterId: "kestrel.tests.direct:v1",
      },
      rawInput: input.toolInput,
      policy: {
        decision: "allow",
        policyRevision: hashCanonical({
          source: "kestrel.tests",
          activation,
          payload: input.toolInput,
        }),
      },
    },
    input.options,
  );
}

let nextTestCallId = 1;

export async function executeTestToolCall(input: {
  gateway: ToolGateway;
  toolName: string;
  toolInput: Record<string, unknown>;
  runId?: string | undefined;
  sessionId?: string | undefined;
  callId?: string | undefined;
  options?: ToolGatewayCallOptions | undefined;
}): Promise<AgentToolResultV2> {
  const prepared = await prepareTestToolCall(input);
  return input.gateway.executePreparedToolCall(prepared, input.options);
}

function preparedKey(prepared: PreparedToolCallV1): string {
  return `${prepared.runId}\0${prepared.sessionId}\0${prepared.callId}`;
}

function unwrapLegacyTestResult(result: AgentToolResult): unknown {
  if (result.status === "FAILED") {
    const legacyError = typeof result.auditRecord.error === "object" &&
      result.auditRecord.error !== null &&
      Array.isArray(result.auditRecord.error) === false
      ? result.auditRecord.error as Record<string, unknown>
      : undefined;
    const error = new Error(
      typeof legacyError?.message === "string"
        ? legacyError.message
        : "Legacy test tool failed",
    ) as Error & {
      code?: string | undefined;
    };
    if (typeof legacyError?.code === "string") error.code = legacyError.code;
    throw error;
  }
  return result.auditRecord.output;
}
