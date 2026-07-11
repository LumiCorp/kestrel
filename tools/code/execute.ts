import { CodeExecutionService } from "../../src/code/CodeExecutionService.js";
import type {
  CodeExecutionRequest,
  CodeNetworkMode,
  CodeExecutionLanguage,
} from "../../src/code/contracts.js";
import { mergeCodeModeConfig } from "../../src/code/PolicyEngine.js";
import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  parseOptionalStringArray,
  readString,
  requireStringField,
} from "../helpers.js";

export const codeExecuteTool: SharedToolModule = {
  definition: {
    name: "code.execute",
    description:
      "Execute JavaScript, Python, or Bash code in an isolated Docker sandbox and return stdout/stderr, status, and artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        language: {
          type: "string",
          enum: ["javascript", "python", "bash"],
        },
        code: {
          type: "string",
          minLength: 1,
        },
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string", minLength: 1 },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        timeoutMs: {
          type: "number",
          minimum: 1,
        },
        network: {
          type: "string",
          enum: ["off", "on"],
        },
        dependencies: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["language", "code"],
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "high",
      costClass: "metered",
      executionClass: "sandboxed_only",
      capabilityClasses: ["code.execute", "code.sandbox"],
      approvalCapabilities: ["code.execute"],
    },
    presentation: {
      displayName: "Code Execute",
      aliases: ["code execute", "sandbox execute", "run code"],
      keywords: ["code", "execute", "sandbox", "runtime"],
      provider: "kestrel",
      toolFamily: "code",
    },
  },
  createHandler(context) {
    const service = context.codeExecutionService ?? new CodeExecutionService();

    return async (input: unknown) => {
      const request = parseCodeExecutionRequest(input);
      const profileConfig = mergeCodeModeConfig(context.codeMode);
      const result = await service.execute(profileConfig, request);
      return result;
    };
  },
};

function parseCodeExecutionRequest(input: unknown): CodeExecutionRequest {
  const body = parseObjectInput("code.execute", input);
  const language = parseLanguage(readString(body, "language"));
  const code = requireStringField("code.execute", body, "code");

  if (language === undefined) {
    throw createToolInputError("code.execute", "code.execute requires language to be javascript, python, or bash.", {
      field: "language",
      receivedValue: body.language,
    });
  }

  const files = parseFiles(body?.files);
  const timeoutMs = parsePositiveNumber(body?.timeoutMs);
  const network = parseNetwork(readString(body, "network"));
  const dependencies = parseOptionalStringArray(body, "dependencies", 50);
  const args = parseOptionalStringArray(body, "args", 50);

  return {
    language,
    code,
    ...(files.length > 0 ? { files } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(args.length > 0 ? { args } : {}),
  };
}

function parseFiles(
  value: unknown,
): Array<{
  path: string;
  content: string;
}> {
  if (Array.isArray(value) === false) {
    return [];
  }

  return value
    .map((entry) =>
      typeof entry === "object" && entry !== null && Array.isArray(entry) === false
        ? (entry as Record<string, unknown>)
        : undefined,
    )
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => {
      const path = readString(entry, "path");
      const content = readString(entry, "content");
      if (path === undefined || content === undefined) {
        return undefined;
      }
      return {
        path,
        content,
      };
    })
    .filter(
      (entry): entry is { path: string; content: string } => entry !== undefined,
    )
    .slice(0, 100);
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function parseLanguage(value: string | undefined): CodeExecutionLanguage | undefined {
  if (value === "javascript" || value === "python" || value === "bash") {
    return value;
  }
  return undefined;
}

function parseNetwork(value: string | undefined): CodeNetworkMode | undefined {
  if (value === "off" || value === "on") {
    return value;
  }
  return undefined;
}
