import type { SharedToolModule } from "../contracts.js";
import { readNumber } from "../helpers.js";
import { buildDevShellCommandOptions, parseToolInput, requireDevShellService, requireStringValue } from "./shared.js";
import { DEV_PROCESS_READ_OUTPUT_CONTRACT } from "./outputContracts.js";

export const devProcessReadTool: SharedToolModule = {
  definition: {
    name: "dev.process.read",
    description:
      "Read output from a running or completed managed process by explicit transcript cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        cursor: { type: "number", minimum: 0 },
        waitMs: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1 },
      },
      required: ["processId"],
    },
    outputContract: DEV_PROCESS_READ_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "host.shell"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Process Read",
      aliases: ["developer process read", "read process logs", "terminal read"],
      keywords: ["developer", "shell", "terminal", "logs", "transcript"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.process.read", input);
      return requireDevShellService(context).readProcess(
        {
          processId: requireStringValue("dev.process.read", body, "processId"),
          ...(typeof readNumber(body, "cursor") === "number"
            ? { cursor: readNumber(body, "cursor") }
            : {}),
          ...(typeof readNumber(body, "waitMs") === "number"
            ? { waitMs: readNumber(body, "waitMs") }
            : {}),
          ...(typeof readNumber(body, "maxBytes") === "number"
            ? { maxBytes: readNumber(body, "maxBytes") }
            : {}),
        },
        buildDevShellCommandOptions(context),
      );
    };
  },
};
