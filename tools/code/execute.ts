import {
  CodeExecutionService,
  DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY,
} from "../../src/code/CodeExecutionService.js";
import type {
  CodeExecutionRequest,
  CodeNetworkMode,
  CodeExecutionLanguage,
} from "../../src/code/contracts.js";
import { mergeCodeModeConfig } from "../../src/code/PolicyEngine.js";
import {
  normalizeSandboxCapabilitySelectionV2,
} from "../../src/kestrel/contracts/sandbox-capability.js";
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
        capability: {
          type: "object",
          additionalProperties: false,
          properties: {
            capabilityId: { type: "string", enum: ["tavily.search.read"] },
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                query: { type: "string", minLength: 1, maxLength: 400 },
                maxResults: { type: "integer", minimum: 1, maximum: 20 },
              },
              required: ["query"],
            },
          },
          required: ["capabilityId", "input"],
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
      const selectedProfile = request.capability === undefined
        ? undefined
        : profileConfig.capabilities?.find((item) => item.capabilityId === request.capability?.capabilityId);
      const capabilityRuntime = request.capability === undefined
        ? undefined
        : await (async () => {
            if (selectedProfile === undefined || context.sandboxCapabilityRuntime === undefined || context.runtime?.toolCallId === undefined) {
              throw createToolInputError("code.execute", "Selected capability is unavailable in the trusted runtime context.");
            }
            const parentAuthorization = context.sandboxCapabilityRuntime.resolveParentAuthorization === undefined
              ? undefined
              : await context.sandboxCapabilityRuntime.resolveParentAuthorization({
                  sessionId: context.runtime.sessionId,
                  runId: context.runtime.runId,
                  toolCallId: context.runtime.toolCallId,
                });
            const preparedContext = context.sandboxCapabilityRuntime as typeof context.sandboxCapabilityRuntime & {
              preparedPolicy?: import("../../src/kestrel/contracts/tool-invocation.js").PreparedToolPolicyDispositionV1;
              preparedApproval?: import("../../src/kestrel/contracts/tool-invocation.js").PreparedToolApprovalAuthorityV1;
            };
            if (preparedContext.preparedPolicy === undefined) {
              throw createToolInputError("code.execute", "Selected capability is missing its prepared policy authority.");
            }
            return {
              ...context.sandboxCapabilityRuntime,
              sessionId: context.runtime.sessionId,
              runId: context.runtime.runId,
              toolCallId: context.runtime.toolCallId,
              ...(context.runtime.threadId === undefined ? {} : { threadId: context.runtime.threadId }),
              profileFingerprint: context.sandboxCapabilityRuntime.profileFingerprint,
              policy: preparedContext.preparedPolicy,
              ...(preparedContext.preparedApproval === undefined ? {} : { approval: preparedContext.preparedApproval }),
              ...(parentAuthorization === undefined ? {} : { parentAuthorization }),
            };
          })();
      const result = await service.execute(profileConfig, request, {
        signal: context.signal,
        ...(capabilityRuntime === undefined ? {} : { capabilityRuntime }),
        ...(context.persistCompletedCapabilityResult === undefined
          ? {}
          : { persistCompletedCapabilityResult: context.persistCompletedCapabilityResult }),
      });
      return result;
    };
  },
};

export function codeExecuteDefinitionForProfile(codeMode: import("../../src/code/contracts.js").CodeModeProfileConfig | undefined) {
  const definition = structuredClone(codeExecuteTool.definition);
  const properties = definition.inputSchema.properties as Record<string, unknown>;
  const authoredIds = [...new Set((codeMode?.capabilities ?? []).map((item) => item.capabilityId))];
  if (authoredIds.length === 0) {
    delete properties.capability;
  } else {
    const branches = authoredIds.map((capabilityId) => {
      const adapter = DEFAULT_SANDBOX_CAPABILITY_ADAPTER_REGISTRY.requireExact({ capabilityId });
      return {
        type: "object",
        additionalProperties: false,
        description: `${adapter.modelContract.description} ${adapter.modelContract.usage}`,
        properties: {
          version: { const: 2 },
          capabilityId: { const: adapter.capabilityId },
          operation: { const: adapter.operation },
          input: structuredClone(adapter.modelContract.selectionInputSchema),
        },
        required: ["version", "capabilityId", "operation", "input"],
      };
    });
    properties.capability = {
      description: "Optional trusted host capability. Omit it for ordinary isolated computation; the workload has no direct network access.",
      oneOf: branches,
    };
    definition.description += " The workload has no direct network access. Select an advertised optional capability only when its fixed host operation is required.";
  }
  return definition;
}

function parseCodeExecutionRequest(input: unknown): CodeExecutionRequest {
  const body = parseObjectInput("code.execute", input);
  const allowed = new Set(["language", "code", "files", "timeoutMs", "network", "dependencies", "args", "capability"]);
  const unknown = Object.keys(body).find((key) => allowed.has(key) === false);
  if (unknown !== undefined) {
    throw createToolInputError("code.execute", `code.execute contains unknown field '${unknown}'.`, { field: unknown });
  }
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
  const capability = body.capability === undefined
    ? undefined
    : normalizeSandboxCapabilitySelectionV2(body.capability);

  return {
    language,
    code,
    ...(files.length > 0 ? { files } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(capability === undefined ? {} : { capability }),
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
        return ;
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
    return ;
  }
  return Math.floor(value);
}

function parseLanguage(value: string | undefined): CodeExecutionLanguage | undefined {
  if (value === "javascript" || value === "python" || value === "bash") {
    return value;
  }
  return ;
}

function parseNetwork(value: string | undefined): CodeNetworkMode | undefined {
  if (value === "off" || value === "on") {
    return value;
  }
  return ;
}
