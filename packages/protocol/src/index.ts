export const RUNNER_HEALTH_VERSION = "runner-health-v1" as const;
export const RUNNER_SERVICE_NAME = "kestrel-runner" as const;
export const RUNNER_COMMAND_CONTRACT_VERSION = "runner-command-v1" as const;
export const RUNNER_EVENT_CONTRACT_VERSION = "dotted-runtime-events-v1" as const;

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
