import type { SharedToolModule } from "../contracts.js";
import { readString } from "../helpers.js";
import { parseToolInput, requireDevShellService, requireStringValue } from "./shared.js";
import { DEV_PROCESS_WRITE_OUTPUT_CONTRACT } from "./outputContracts.js";

export const devProcessWriteTool: SharedToolModule = {
  definition: {
    name: "dev.process.write",
    description:
      "Send stdin to an existing managed live process. This does not run shell commands, create files, or read output; use dev.process.read to observe the response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        data: { type: "string" },
      },
      required: ["processId", "data"],
    },
    outputContract: DEV_PROCESS_WRITE_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "host.shell"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Process Write",
      aliases: ["developer process write", "write stdin", "terminal stdin", "process stdin"],
      keywords: ["developer", "shell", "terminal", "stdin", "process"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.process.write", input);
      return requireDevShellService(context).writeProcess({
        processId: requireStringValue("dev.process.write", body, "processId"),
        data: readString(body, "data") ?? "",
      });
    };
  },
};
