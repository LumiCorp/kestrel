export const RUNNER_HEALTH_VERSION = "runner-health-v1" as const;
export const RUNNER_SERVICE_NAME = "kestrel-runner" as const;
export const RUNNER_COMMAND_CONTRACT_VERSION = "runner-command-v1" as const;
export const RUNNER_EVENT_CONTRACT_VERSION = "dotted-runtime-events-v2" as const;
export const RUNNER_WAITING_PROMPT_HISTORY_KIND = "runtime.waiting_prompt" as const;

export interface RunnerWaitingPromptHistoryDataV2 {
  kind: typeof RUNNER_WAITING_PROMPT_HISTORY_KIND;
  runId?: string | undefined;
}

export const RUNNER_RUN_STREAM_EVENT_TYPES = [
  "run.started",
  "run.cancelled",
  "run.tool.started",
  "run.tool.completed",
  "run.tool.failed",
  "run.log",
  "run.console",
  "run.progress",
  "run.reasoning",
  "run.completed",
  "run.failed",
  "runner.error",
  "task.updated",
] as const;

export type RunnerRunStreamEventType =
  (typeof RUNNER_RUN_STREAM_EVENT_TYPES)[number];

export const RUNNER_CAPABILITIES = [
  "events.subscribe",
  "mcp.refresh",
  "operator.control",
  "operator.inspect",
  "profile.read",
  "project.manage",
  "run.cancel",
  "run.resume",
  "run.stream",
  "session.read",
  "task.graph",
  "workspace.checkpoint",
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

export class RunnerProtocolContractError extends Error {
  readonly code = "RUNNER_HEALTH_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RunnerProtocolContractError";
  }
}

export interface RunnerResultV2<TOutput = unknown> {
  output: TOutput;
  assistantText: string | null;
  finalizedPayload?: unknown | undefined;
  operatorAffordance?: unknown | undefined;
}

export function parseRunnerResultV2<TOutput = unknown>(value: unknown): RunnerResultV2<TOutput> {
  const result = requireRecord(value, "runner result");
  if (Object.prototype.hasOwnProperty.call(result, "assistantText") === false) {
    throw new RunnerProtocolContractError("runner result.assistantText is required");
  }
  const assistantText = parseAssistantText(result.assistantText);
  if (Object.prototype.hasOwnProperty.call(result, "output") === false) {
    throw new RunnerProtocolContractError("runner result.output is required");
  }
  return {
    ...result,
    output: result.output as TOutput,
    assistantText,
    ...(Object.prototype.hasOwnProperty.call(result, "finalizedPayload")
      ? { finalizedPayload: result.finalizedPayload }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(result, "operatorAffordance")
      ? { operatorAffordance: result.operatorAffordance }
      : {}),
  };
}

export function parseRunnerTerminalPayloadV2(
  type: string,
  value: unknown,
): Record<string, unknown> {
  const payload = requireRecord(value, `${type} payload`);
  if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") {
    return {
      ...payload,
      result: parseRunnerResultV2(payload.result),
    };
  }
  if (type === "operator.controlled" && payload.result !== undefined) {
    return {
      ...payload,
      result: parseRunnerResultV2(payload.result),
    };
  }
  return payload;
}

export interface RunnerHealthV1 {
  version: typeof RUNNER_HEALTH_VERSION;
  ok: true;
  service: {
    name: typeof RUNNER_SERVICE_NAME;
    version: string;
  };
  contracts: {
    command: string;
    events: string;
  };
  capabilities: string[];
}

export function createRunnerHealthV1(input: {
  serviceVersion: string;
  capabilities?: readonly string[] | undefined;
}): RunnerHealthV1 {
  const serviceVersion = requireNonEmptyString(input.serviceVersion, "service.version");
  return {
    version: RUNNER_HEALTH_VERSION,
    ok: true,
    service: {
      name: RUNNER_SERVICE_NAME,
      version: serviceVersion,
    },
    contracts: {
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    capabilities: [...(input.capabilities ?? RUNNER_CAPABILITIES)],
  };
}

export function parseRunnerHealthV1(value: unknown): RunnerHealthV1 {
  const root = requireRecord(value, "runner health");
  if (root.version !== RUNNER_HEALTH_VERSION) {
    throw new RunnerProtocolContractError(`runner health.version must be '${RUNNER_HEALTH_VERSION}'`);
  }
  if (root.ok !== true) {
    throw new RunnerProtocolContractError("runner health.ok must be true");
  }

  const service = requireRecord(root.service, "runner health.service");
  if (service.name !== RUNNER_SERVICE_NAME) {
    throw new RunnerProtocolContractError(`runner health.service.name must be '${RUNNER_SERVICE_NAME}'`);
  }
  const contracts = requireRecord(root.contracts, "runner health.contracts");
  if (!Array.isArray(root.capabilities) || root.capabilities.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new RunnerProtocolContractError("runner health.capabilities must be an array of non-empty strings");
  }
  if (contracts.command !== RUNNER_COMMAND_CONTRACT_VERSION) {
    throw new RunnerProtocolContractError(
      `runner health.contracts.command must be '${RUNNER_COMMAND_CONTRACT_VERSION}'`,
    );
  }
  if (contracts.events !== RUNNER_EVENT_CONTRACT_VERSION) {
    throw new RunnerProtocolContractError(
      `runner health.contracts.events must be '${RUNNER_EVENT_CONTRACT_VERSION}'`,
    );
  }

  return {
    version: RUNNER_HEALTH_VERSION,
    ok: true,
    service: {
      name: RUNNER_SERVICE_NAME,
      version: requireNonEmptyString(service.version, "runner health.service.version"),
    },
    contracts: {
      command: requireNonEmptyString(contracts.command, "runner health.contracts.command"),
      events: requireNonEmptyString(contracts.events, "runner health.contracts.events"),
    },
    capabilities: [...root.capabilities] as string[],
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerProtocolContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseAssistantText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerProtocolContractError(
      "runner result.assistantText must be null or a non-empty string",
    );
  }
  return value.trim();
}
