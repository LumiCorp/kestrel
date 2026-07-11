import { tool } from "ai";
import type { ToolRuntimeConfiguration } from "./types";

export function applyToolRuntimeConfigurations(
  tools: Record<string, any>,
  runtimeToolConfigurations?: Record<string, ToolRuntimeConfiguration>
) {
  if (!runtimeToolConfigurations) {
    return tools;
  }

  return Object.fromEntries(
    Object.entries(tools).flatMap(([name, definition]) => {
      const runtimeConfiguration = runtimeToolConfigurations[name];

      if (!runtimeConfiguration) {
        return [];
      }

      return [
        [
          name,
          tool({
            description: definition.description,
            title: definition.title,
            providerOptions: definition.providerOptions,
            inputSchema: definition.inputSchema,
            inputExamples: definition.inputExamples,
            needsApproval: runtimeConfiguration.approvalMode === "ask",
            strict: definition.strict,
            onInputStart: definition.onInputStart,
            onInputDelta: definition.onInputDelta,
            onInputAvailable: definition.onInputAvailable,
            execute: definition.execute,
          }),
        ],
      ];
    })
  );
}
