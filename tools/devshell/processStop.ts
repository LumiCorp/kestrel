import type { SharedToolModule } from "../contracts.js";
import { readNumber, readString } from "../helpers.js";
import { buildDevShellCommandOptions, parseToolInput, requireDevShellService, requireStringValue } from "./shared.js";
import { DEV_PROCESS_STOP_OUTPUT_CONTRACT } from "./outputContracts.js";

export const devProcessStopTool: SharedToolModule = {
  definition: {
    name: "dev.process.stop",
    description:
      "Terminate a running managed process and return output from the requested transcript cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        processId: { type: "string", minLength: 1 },
        signal: {
          type: "string",
          enum: ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"],
        },
        cursor: { type: "number", minimum: 0 },
        waitMs: { type: "number", minimum: 0 },
        maxBytes: { type: "number", minimum: 1 },
      },
      required: ["processId"],
    },
    outputContract: DEV_PROCESS_STOP_OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "medium",
      costClass: "metered",
      executionClass: "external_side_effect",
      capabilityClasses: ["dev.shell", "host.shell"],
      approvalCapabilities: ["shell.exec"],
    },
    presentation: {
      displayName: "Dev Process Stop",
      aliases: ["developer process stop", "stop process", "interrupt command"],
      keywords: ["developer", "shell", "terminal", "stop", "interrupt"],
      provider: "kestrel",
      toolFamily: "dev-shell",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const body = parseToolInput("dev.process.stop", input);
      return requireDevShellService(context).stopProcess(
        {
          processId: requireStringValue("dev.process.stop", body, "processId"),
          ...(readString(body, "signal") !== undefined
            ? { signal: readString(body, "signal") as "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGKILL" }
            : {}),
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
