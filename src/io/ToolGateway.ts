import type {
  AgentToolResult,
  ToolGateway,
  ToolGatewayCallOptions,
} from "../kestrel/contracts/model-io.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { runAgentTool } from "../../tools/toolResult.js";

export type ToolHandler = (input: unknown) => Promise<unknown>;

function validateAllowlistedToolName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw createRuntimeFailure("IO_TOOL_NOT_ALLOWLISTED", "Tool name must be a non-empty string.", {
      subsystem: "runtime",
      classification: "configuration",
      recoverable: false,
      toolName: name,
    });
  }
  return normalized;
}

export class AllowlistedToolGateway implements ToolGateway {
  private readonly handlers: Map<string, ToolHandler>;

  constructor(handlers: Record<string, ToolHandler>) {
    this.handlers = new Map<string, ToolHandler>(Object.entries(handlers));
  }

  async call(
    name: string,
    input: unknown,
    _options?: ToolGatewayCallOptions,
  ): Promise<AgentToolResult> {
    const normalizedName = validateAllowlistedToolName(name);
    const handler = this.handlers.get(normalizedName);
    if (handler === undefined) {
      throw createRuntimeFailure("IO_TOOL_NOT_ALLOWLISTED", `Tool '${normalizedName}' is not allowlisted.`, {
        subsystem: "runtime",
        classification: "configuration",
        recoverable: false,
        toolName: normalizedName,
      });
    }

    return runAgentTool({
      toolName: normalizedName,
      toolInput: input,
      handler,
    });
  }
}
