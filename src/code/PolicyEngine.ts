import {
  DEFAULT_CODE_MODE_DISABLED_CONFIG,
  type AppliedCodeExecutionPolicy,
  type CodeExecutionRequest,
  type CodeExecutionResult,
  type CodeModeProfileConfig,
} from "./contracts.js";

interface PolicyDecisionAllowed {
  ok: true;
  request: CodeExecutionRequest;
  policy: AppliedCodeExecutionPolicy;
}

interface PolicyDecisionBlocked {
  ok: false;
  result: CodeExecutionResult;
}

export type PolicyDecision = PolicyDecisionAllowed | PolicyDecisionBlocked;

export function evaluateExecutionPolicy(
  config: CodeModeProfileConfig | undefined,
  request: CodeExecutionRequest,
): PolicyDecision {
  const effective = mergeCodeModeConfig(config);
  const language = request.language;
  const policy: AppliedCodeExecutionPolicy = {
    enabled: effective.enabled,
    approvalMode: effective.approvalMode,
    executor: effective.sandbox.executor,
    language,
    timeoutMs: boundedPositiveInt(
      request.timeoutMs,
      effective.sandbox.timeoutMs,
      effective.sandbox.timeoutMs,
    ),
    memoryMb: effective.sandbox.memoryMb,
    cpuShares: effective.sandbox.cpuShares,
    network: resolveNetworkMode(effective, request.network),
    allowDependencyInstall: effective.sandbox.allowDependencyInstall,
    maxOutputBytes: effective.sandbox.maxOutputBytes,
    maxArtifacts: effective.sandbox.maxArtifacts,
    maxArtifactBytes: effective.sandbox.maxArtifactBytes,
  };

  if (effective.enabled === false) {
    return {
      ok: false,
      result: blockedResult("code-mode is disabled for this profile", policy, effective),
    };
  }

  if (effective.languages.includes(language) === false) {
    return {
      ok: false,
      result: blockedResult(`language '${language}' is not enabled`, policy, effective),
    };
  }

  if (request.network === "on" && effective.sandbox.networkDefault === "off") {
    return {
      ok: false,
      result: blockedResult("network access is not allowed by profile policy", policy, effective),
    };
  }

  const dependencies = normalizeStringArray(request.dependencies);
  if (dependencies.length > 0 && effective.sandbox.allowDependencyInstall === false) {
    return {
      ok: false,
      result: blockedResult("dependency installation is disabled by profile policy", policy, effective),
    };
  }

  if (language === "bash" && dependencies.length > 0) {
    return {
      ok: false,
      result: blockedResult("bash execution does not support dependency installation", policy, effective),
    };
  }

  const args = normalizeStringArray(request.args);
  return {
    ok: true,
    request: {
      ...request,
      dependencies,
      args,
      timeoutMs: policy.timeoutMs,
      network: policy.network,
    },
    policy,
  };
}

export function mergeCodeModeConfig(
  config: CodeModeProfileConfig | undefined,
): CodeModeProfileConfig {
  const base = DEFAULT_CODE_MODE_DISABLED_CONFIG;
  const languages =
    Array.isArray(config?.languages) && config.languages.length > 0
      ? config.languages
      : base.languages;

  return {
    enabled: config?.enabled ?? base.enabled,
    languages,
    sandbox: {
      executor: config?.sandbox?.executor ?? base.sandbox.executor,
      timeoutMs: boundedPositiveInt(
        config?.sandbox?.timeoutMs,
        base.sandbox.timeoutMs,
        300_000,
      ),
      memoryMb: boundedPositiveInt(config?.sandbox?.memoryMb, base.sandbox.memoryMb, 8_192),
      cpuShares: boundedPositiveInt(config?.sandbox?.cpuShares, base.sandbox.cpuShares, 2_048),
      networkDefault: config?.sandbox?.networkDefault ?? base.sandbox.networkDefault,
      allowDependencyInstall:
        config?.sandbox?.allowDependencyInstall ?? base.sandbox.allowDependencyInstall,
      maxOutputBytes: boundedPositiveInt(
        config?.sandbox?.maxOutputBytes,
        base.sandbox.maxOutputBytes,
        512_000,
      ),
      maxArtifacts: boundedPositiveInt(config?.sandbox?.maxArtifacts, base.sandbox.maxArtifacts, 200),
      maxArtifactBytes: boundedPositiveInt(
        config?.sandbox?.maxArtifactBytes,
        base.sandbox.maxArtifactBytes,
        2_000_000,
      ),
    },
    retention: {
      persistSummary: config?.retention?.persistSummary ?? base.retention.persistSummary,
      persistArtifacts: config?.retention?.persistArtifacts ?? base.retention.persistArtifacts,
    },
    approvalMode: "auto",
  };
}

function resolveNetworkMode(
  config: CodeModeProfileConfig,
  requested: "off" | "on" | undefined,
): "off" | "on" {
  if (requested === "off") {
    return "off";
  }
  if (requested === "on") {
    return "on";
  }
  return config.sandbox.networkDefault;
}

function blockedResult(
  message: string,
  policy: AppliedCodeExecutionPolicy,
  config: CodeModeProfileConfig,
): CodeExecutionResult {
  return {
    status: "blocked",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    artifacts: [],
    summary: `Blocked by policy: ${message}.`,
    policy,
    retention: config.retention,
  };
}

function normalizeStringArray(value: string[] | undefined): string[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 50);
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > max ? max : normalized;
}
