import { RunnerProtocolContractError } from "./errors.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_EVENT_CONTRACT_VERSION,
} from "./execution.js";

export {
  RunnerProtocolContractError,
  type RunnerProtocolContractErrorCode,
} from "./errors.js";
export * from "./execution.js";
export { parseRunnerProjectAction } from "./projectActions.js";

export const RUNNER_HEALTH_VERSION = "runner-health-v1" as const;
export const RUNNER_SERVICE_NAME = "kestrel-runner" as const;

export const RUNNER_CAPABILITIES = [
  "events.subscribe",
  "events.cursor",
  "job.run",
  "mcp.refresh",
  "operator.control",
  "operator.inspect",
  "profile.read",
  "project.manage",
  "run.cancel",
  "run.continue_on_disconnect",
  "run.resume",
  "run.stream",
  "session.read",
  "task.graph",
  "workspace.checkpoint",
  "workspace.promotion",
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

export interface RunnerHealthV1 {
  version: typeof RUNNER_HEALTH_VERSION;
  ok: true;
  service: {
    name: typeof RUNNER_SERVICE_NAME;
    version: string;
  };
  contracts: {
    execution: typeof EXECUTION_PROTOCOL_VERSION;
    command: typeof RUNNER_COMMAND_CONTRACT_VERSION;
    events: typeof RUNNER_EVENT_CONTRACT_VERSION;
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
      execution: EXECUTION_PROTOCOL_VERSION,
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    capabilities: [...(input.capabilities ?? RUNNER_CAPABILITIES)],
  };
}

export function parseRunnerHealthV1(value: unknown): RunnerHealthV1 {
  const root = requireRecord(value, "runner health");
  if (root.version !== RUNNER_HEALTH_VERSION) {
    throw runnerHealthContractError(`runner health.version must be '${RUNNER_HEALTH_VERSION}'`);
  }
  if (root.ok !== true) {
    throw runnerHealthContractError("runner health.ok must be true");
  }

  const service = requireRecord(root.service, "runner health.service");
  if (service.name !== RUNNER_SERVICE_NAME) {
    throw runnerHealthContractError(`runner health.service.name must be '${RUNNER_SERVICE_NAME}'`);
  }
  const contracts = requireRecord(root.contracts, "runner health.contracts");
  if (!Array.isArray(root.capabilities) || root.capabilities.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw runnerHealthContractError("runner health.capabilities must be an array of non-empty strings");
  }
  if (contracts.execution !== EXECUTION_PROTOCOL_VERSION) {
    throw runnerHealthContractError(
      `runner health.contracts.execution must be '${EXECUTION_PROTOCOL_VERSION}'`,
    );
  }
  if (contracts.command !== RUNNER_COMMAND_CONTRACT_VERSION) {
    throw runnerHealthContractError(
      `runner health.contracts.command must be '${RUNNER_COMMAND_CONTRACT_VERSION}'`,
    );
  }
  if (contracts.events !== RUNNER_EVENT_CONTRACT_VERSION) {
    throw runnerHealthContractError(
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
      execution: EXECUTION_PROTOCOL_VERSION,
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    capabilities: [...root.capabilities] as string[],
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw runnerHealthContractError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw runnerHealthContractError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function runnerHealthContractError(message: string): RunnerProtocolContractError {
  return new RunnerProtocolContractError(message, "RUNNER_HEALTH_INVALID");
}
