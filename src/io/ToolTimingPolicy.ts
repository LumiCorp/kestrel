import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

const UNBOUNDED_RUNTIME_BUDGET_MS = Number.MAX_SAFE_INTEGER;

export interface ToolTimingPolicyConfig {
  defaultShellRunTimeoutMs: number;
  closeoutReserveMs: number;
  minDispatchMs: number;
}

export const DEFAULT_TOOL_TIMING_POLICY: ToolTimingPolicyConfig = {
  defaultShellRunTimeoutMs: 30_000,
  closeoutReserveMs: 60_000,
  minDispatchMs: 2500,
};

export type ShellRunTimeoutDecision =
  | {
      kind: "unchanged";
      timeoutMs: number;
      requestedTimeoutMs?: number | undefined;
    }
  | {
      kind: "clamped";
      timeoutMs: number;
      requestedTimeoutMs: number;
      deadlineAdjustedTimeoutMs: number;
      remainingMs: number;
      closeoutReserveMs: number;
    }
  | {
      kind: "deadline_exhausted";
      requestedTimeoutMs?: number | undefined;
      remainingMs: number;
      closeoutReserveMs: number;
      minDispatchMs: number;
      failureReason: string;
    };

export function deriveShellRunTimeoutDecision(input: {
  requestedTimeoutMs?: number | undefined;
  remainingMs: number;
  config?: ToolTimingPolicyConfig | undefined;
}): ShellRunTimeoutDecision {
  const config = input.config ?? DEFAULT_TOOL_TIMING_POLICY;
  validateToolTimingPolicyConfig(config);
  const requestedTimeoutMs = normalizePositiveInt(
    input.requestedTimeoutMs,
    config.defaultShellRunTimeoutMs,
  );
  if (
    Number.isFinite(input.remainingMs) === false ||
    input.remainingMs >= UNBOUNDED_RUNTIME_BUDGET_MS / 2
  ) {
    return {
      kind: "unchanged",
      timeoutMs: requestedTimeoutMs,
      ...(input.requestedTimeoutMs !== undefined ? { requestedTimeoutMs } : {}),
    };
  }

  const remainingMs = Math.max(0, Math.floor(input.remainingMs));
  const availableForToolMs = Math.max(0, remainingMs - config.closeoutReserveMs);
  if (availableForToolMs < config.minDispatchMs) {
    return {
      kind: "deadline_exhausted",
      ...(input.requestedTimeoutMs !== undefined ? { requestedTimeoutMs } : {}),
      remainingMs,
      closeoutReserveMs: config.closeoutReserveMs,
      minDispatchMs: config.minDispatchMs,
      failureReason:
        "Not enough external runtime budget remains to start dev.shell.run " +
        `(${remainingMs}ms remaining, ${config.closeoutReserveMs}ms reserved for closeout).`,
    };
  }

  if (availableForToolMs < requestedTimeoutMs) {
    return {
      kind: "clamped",
      timeoutMs: availableForToolMs,
      requestedTimeoutMs,
      deadlineAdjustedTimeoutMs: availableForToolMs,
      remainingMs,
      closeoutReserveMs: config.closeoutReserveMs,
    };
  }

  return {
    kind: "unchanged",
    timeoutMs: requestedTimeoutMs,
    ...(input.requestedTimeoutMs !== undefined ? { requestedTimeoutMs } : {}),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function validateToolTimingPolicyConfig(config: ToolTimingPolicyConfig): void {
  if (
    Number.isFinite(config.defaultShellRunTimeoutMs) === false ||
    Number.isFinite(config.closeoutReserveMs) === false ||
    Number.isFinite(config.minDispatchMs) === false ||
    config.defaultShellRunTimeoutMs <= 0 ||
    config.closeoutReserveMs < 0 ||
    config.minDispatchMs <= 0
  ) {
    throw createRuntimeFailure("IO_POLICY_INVALID", "Tool timing policy must use finite positive numeric fields.", {
      subsystem: "runtime",
      classification: "configuration",
      recoverable: false,
      config,
    });
  }
}
