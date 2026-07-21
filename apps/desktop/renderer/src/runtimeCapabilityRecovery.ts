import type {
  DesktopCapabilityId,
  DesktopRendererSettings,
  DesktopRunnerEvent,
} from "../../src/contracts";

export function extractTerminalFailure(
  event: DesktopRunnerEvent,
  selectedProvider: DesktopRendererSettings["selectedProvider"] | undefined,
): { message: string; capabilityId?: DesktopCapabilityId | undefined } | undefined {
  if (event.type !== "run.failed") {
    return;
  }
  const error = asRecord(event.payload.error);
  const code = readString(error?.code);
  const details = asRecord(error?.details);
  const explicitCapabilityId = readDesktopCapabilityId(details?.capabilityId);
  return {
    message: readString(error?.message) ?? code ?? "Run failed.",
    capabilityId:
      explicitCapabilityId ?? capabilityForRuntimeFailureCode(code, selectedProvider),
  };
}

function capabilityForRuntimeFailureCode(
  code: string | undefined,
  selectedProvider: DesktopRendererSettings["selectedProvider"] | undefined,
): DesktopCapabilityId | undefined {
  if (
    code === "IO_MODEL_FAILED" ||
    code === "IO_MODEL_TIMEOUT" ||
    code === "MODEL_POLICY_INVALID"
  ) {
    return selectedProvider === undefined ? undefined : `model.${selectedProvider}`;
  }
  if (MCP_FAILURE_CODES.has(code ?? "")) return "connections.mcp";
  if (DEV_SHELL_FAILURE_CODES.has(code ?? "")) return "local.developer_shell";
  if (DATABASE_FAILURE_CODES.has(code ?? "")) return "data.database";
  if (code === "STORE_SQLITE_INIT_FAILED") return "data.database";
  return;
}

const MCP_FAILURE_CODES = new Set([
  "MCP_CLIENT_METHOD_MISSING", "MCP_ENV_VAR_REQUIRED", "MCP_HEADER_ENV_REQUIRED",
  "MCP_HTTP_TRANSPORT_UNAVAILABLE", "MCP_PRECHECK_FAILED", "MCP_SDK_CLIENT_MISSING",
  "MCP_SSE_TRANSPORT_UNAVAILABLE", "MCP_STDIO_TRANSPORT_UNAVAILABLE", "MCP_TOOL_UNAVAILABLE",
  "MCP_HOSTED_SCOPE_UNAVAILABLE", "MCP_TOOL_NAME_COLLISION",
]);

const DEV_SHELL_FAILURE_CODES = new Set([
  "DEV_SHELL_COMMAND_INVALID", "DEV_SHELL_CWD_NOT_FOUND", "DEV_SHELL_CWD_OUTSIDE_WORKSPACE",
  "DEV_SHELL_PATH_OUTSIDE_WORKSPACE", "DEV_SHELL_PROCESS_NOT_FOUND", "DEV_SHELL_PROCESS_NOT_RUNNING",
  "DEV_SHELL_SHELL_UNAVAILABLE", "DEV_SHELL_SOURCE_WRITE_AUTHORITY_DENIED", "DEV_SHELL_WORKSPACE_NOT_FOUND",
  "DEV_SHELL_SERVICE_REQUEST_FAILED", "DEV_SHELL_SERVICE_UNAVAILABLE", "DEV_SHELL_MIGRATION_FAILED",
]);

const DATABASE_FAILURE_CODES = new Set([
  "STORE_DATABASE_URL_REQUIRED", "STORE_ENSURE_SESSION_FAILED", "STORE_SCHEMA_V3_REQUIRED",
  "DATABASE_UNREACHABLE", "DATABASE_URL_INVALID", "LOCAL_CORE_DATABASE_BLOCKED",
  "LOCAL_CORE_EXTERNAL_DATABASE_INIT_FAILED", "LOCAL_CORE_EXTERNAL_DATABASE_URL_REQUIRED",
  "LOCAL_CORE_PGLITE_INIT_FAILED", "LOCAL_CORE_MIGRATIONS_BLOCKED", "LOCAL_CORE_MIGRATION_FAILED",
]);

function readDesktopCapabilityId(value: unknown): DesktopCapabilityId | undefined {
  const ids: DesktopCapabilityId[] = [
    "model.openrouter", "model.openai", "model.anthropic", "model.ollama", "model.lmstudio",
    "tools.internet.tavily", "tools.weather", "tools.network.free", "local.filesystem",
    "local.developer_shell", "local.sandbox_code", "connections.mcp", "data.workspace",
    "data.database", "permission.microphone",
  ];
  return typeof value === "string" && ids.includes(value as DesktopCapabilityId)
    ? value as DesktopCapabilityId
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
