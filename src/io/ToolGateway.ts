import type { ValidateFunction } from "ajv";

import type {
  AgentToolResult,
  ModelToolContract,
  ToolGateway,
  ToolGatewayCallOptions,
} from "../kestrel/contracts/model-io.js";
import {
  JSON_VALUE_OUTPUT_SCHEMA_V1,
  TOOL_DESCRIPTOR_VERSION,
  compileToolJsonSchemaV1,
  createToolDescriptorV1,
  parseToolDescriptorV1,
  type ToolCapabilityContractV1,
  type ToolDescriptorV1,
  type ToolPresentationContractV1,
} from "../kestrel/contracts/tool-contract.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { runAgentTool } from "../../tools/toolResult.js";

export type ToolHandler = (input: unknown) => Promise<unknown>;

export interface RegisteredToolModuleV1 {
  descriptor: ToolDescriptorV1;
  handler: ToolHandler;
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
  private readonly validators = new Map<string, ValidateFunction>();

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
      this.modules.set(descriptor.toolId, { descriptor, handler: module.handler });
      this.validators.set(
        descriptor.toolId,
        compileToolJsonSchemaV1(descriptor.inputSchema, { surface: "input" }),
      );
    }
  }

  listDescriptors(): ToolDescriptorV1[] {
    return [...this.modules.values()].map((module) => module.descriptor);
  }

  getDescriptor(name: string): ToolDescriptorV1 | undefined {
    return this.modules.get(name)?.descriptor;
  }

  async validateInput(name: string, input: unknown): Promise<unknown> {
    const normalizedName = validateAllowlistedToolName(name);
    const validator = this.validators.get(normalizedName);
    if (validator === undefined) {
      throw createRuntimeFailure(
        "IO_TOOL_NOT_ALLOWLISTED",
        `Tool '${normalizedName}' is not allowlisted.`,
        {
          subsystem: "runtime",
          classification: "configuration",
          recoverable: false,
          toolName: normalizedName,
        },
      );
    }
    if (validator(input) !== true) {
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
    return input;
  }

  async call(
    name: string,
    input: unknown,
    _options?: ToolGatewayCallOptions,
  ): Promise<AgentToolResult> {
    const normalizedName = validateAllowlistedToolName(name);
    const module = this.modules.get(normalizedName);
    if (module === undefined) {
      throw createRuntimeFailure(
        "IO_TOOL_NOT_ALLOWLISTED",
        `Tool '${normalizedName}' is not allowlisted.`,
        {
          subsystem: "runtime",
          classification: "configuration",
          recoverable: false,
          toolName: normalizedName,
        },
      );
    }
    const validatedInput = await this.validateInput(normalizedName, input);
    return runAgentTool({
      toolName: normalizedName,
      toolInput: validatedInput,
      handler: module.handler,
    });
  }
}
