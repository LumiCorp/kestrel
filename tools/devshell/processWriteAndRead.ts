import type { SharedToolModule } from "../contracts.js";
import { readNumber, readString } from "../helpers.js";
import { buildDevShellCommandOptions, parseToolInput, requireDevShellService, requireStringValue } from "./shared.js";
import { DEV_PROCESS_WRITE_AND_READ_OUTPUT_CONTRACT } from "./outputContracts.js";

export const devProcessWriteAndReadTool: SharedToolModule = {
  definition: {
    name: "dev.process.write_and_read",
    description:
      "Send one stdin message to an existing managed live process, wait briefly, and return new output. Use for command-response interactions with an active process.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        data: { type: "string" },
        cursor: { type: "number", minimum: 0 },
        waitMs: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1 },
      },
      required: ["processId", "data"],
    },
    outputContract: DEV_PROCESS_WRITE_AND_READ_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "host.shell", "terminal.input"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Process Write And Read",
      aliases: ["developer process write and read", "send stdin and read", "terminal command response"],
      keywords: ["developer", "shell", "terminal", "stdin", "process", "read"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.process.write_and_read", input);
      return requireDevShellService(context).writeAndReadProcess(
        {
          processId: requireStringValue("dev.process.write_and_read", body, "processId"),
          data: readString(body, "data") ?? "",
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
