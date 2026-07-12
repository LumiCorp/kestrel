import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseDotEnv } from "../cli/config/EnvLoader.js";

export const BENCHMARK_MODEL_PROVIDER = "openrouter" as const;
export const BENCHMARK_PROVIDER_KEY_ENV = "OPENROUTER_API_KEY";
export const BENCHMARK_MODEL_ENV = "OPENROUTER_MODEL";
export const DEFAULT_OPENROUTER_BENCHMARK_MODEL = "z-ai/glm-5.2";
export const BENCHMARK_INTERACTION_MODE = "build" as const;
export const BENCHMARK_ACT_SUBMODE = "full_auto" as const;
export const BENCHMARK_GUARDRAILS = {
  maxStepsPerRun: 2500,
  maxToolCallsPerRun: 1000,
  maxModelCallsPerRun: 500,
  maxStepVisits: 750,
} as const;
export const BENCHMARK_DOTENV_PREFER_KEYS = [
  "OPENROUTER_API_KEY",
  "KCHAT_MODEL_TIMEOUT_MS",
  "KCHAT_MODEL_RETRY_COUNT",
  "KESTREL_TBENCH_REPO_ROOT",
  "KESTREL_TBENCH_COMMAND_TIMEOUT_SEC",
  "KESTREL_TBENCH_AGENT_TIMEOUT_SEC",
  "KESTREL_TBENCH_RUN_TIMEOUT_SEC",
  "KESTREL_TBENCH_DEADLINE_RESERVE_SEC",
] as const;

const DEPRECATED_BENCHMARK_ENV: Record<string, string> = {
  KESTREL_TBENCH_MODEL_PROVIDER: "OpenRouter is the only supported Kestrel benchmark provider; remove this variable.",
  KCHAT_MODEL_PROVIDER: "OpenRouter is the only supported Kestrel benchmark provider; remove this variable.",
  KESTREL_TBENCH_MODEL: "Use OPENROUTER_MODEL instead.",
  KCHAT_MODEL: "Use OPENROUTER_MODEL instead.",
  KESTREL_SWE_MODEL_NAME: "Use OPENROUTER_MODEL instead.",
};

const NON_CANONICAL_PROVIDER_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;

export interface BenchmarkProviderConfig {
  modelProvider: typeof BENCHMARK_MODEL_PROVIDER;
  model: string;
  credentialEnv: typeof BENCHMARK_PROVIDER_KEY_ENV;
  credentialFingerprint?: string | undefined;
  warnings: string[];
}

export interface BenchmarkTurnMode {
  interactionMode: typeof BENCHMARK_INTERACTION_MODE;
  actSubmode: typeof BENCHMARK_ACT_SUBMODE;
}

export interface BenchmarkProfileMode {
  defaultInteractionMode: typeof BENCHMARK_INTERACTION_MODE;
  defaultActSubmode: typeof BENCHMARK_ACT_SUBMODE;
}

export type BenchmarkGuardrails = typeof BENCHMARK_GUARDRAILS;

export function benchmarkTurnMode(): BenchmarkTurnMode {
  return {
    interactionMode: BENCHMARK_INTERACTION_MODE,
    actSubmode: BENCHMARK_ACT_SUBMODE,
  };
}

export function benchmarkProfileMode(): BenchmarkProfileMode {
  return {
    defaultInteractionMode: BENCHMARK_INTERACTION_MODE,
    defaultActSubmode: BENCHMARK_ACT_SUBMODE,
  };
}

export function benchmarkGuardrails(): BenchmarkGuardrails {
  return { ...BENCHMARK_GUARDRAILS };
}

export function loadBenchmarkDotEnv(cwd: string, env: NodeJS.ProcessEnv): void {
  if (env.KESTREL_DISABLE_DOTENV === "1") {
    return;
  }
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) {
    return;
  }
  const parsed = parseDotEnv(readFileSync(envPath, "utf8"));
  for (const key of BENCHMARK_DOTENV_PREFER_KEYS) {
    const value = parsed[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
}

export function assertBenchmarkTurnMode(
  turn: Record<string, unknown>,
  label = "benchmark job turn",
): void {
  if (turn.interactionMode !== BENCHMARK_INTERACTION_MODE) {
    throw new Error(`${label} must use canonical build interactionMode.`);
  }
  if (turn.actSubmode !== BENCHMARK_ACT_SUBMODE) {
    throw new Error(`${label} must use full_auto actSubmode.`);
  }
}

export function resolveBenchmarkProviderConfig(env: NodeJS.ProcessEnv): BenchmarkProviderConfig {
  return {
    modelProvider: BENCHMARK_MODEL_PROVIDER,
    model: readEnv(env, BENCHMARK_MODEL_ENV) ?? DEFAULT_OPENROUTER_BENCHMARK_MODEL,
    credentialEnv: BENCHMARK_PROVIDER_KEY_ENV,
    ...credentialFingerprintPayload(env),
    warnings: benchmarkProviderWarnings(env),
  };
}

export function benchmarkProviderIssues(env: NodeJS.ProcessEnv): string[] {
  const issues: string[] = [];
  for (const [name, replacement] of Object.entries(DEPRECATED_BENCHMARK_ENV)) {
    if (readEnv(env, name) !== undefined) {
      issues.push(`Deprecated benchmark env ${name} is not supported. ${replacement}`);
    }
  }
  if (readEnv(env, BENCHMARK_PROVIDER_KEY_ENV) === undefined) {
    const configuredProviderKeys = NON_CANONICAL_PROVIDER_KEYS.filter((key) => readEnv(env, key) !== undefined);
    issues.push(
      configuredProviderKeys.length > 0
        ? `Kestrel benchmarks require ${BENCHMARK_PROVIDER_KEY_ENV}; ignoring non-OpenRouter provider key(s): ${configuredProviderKeys.join(", ")}.`
        : `Kestrel benchmarks require ${BENCHMARK_PROVIDER_KEY_ENV}.`,
    );
  }
  return issues;
}

export function benchmarkProviderWarnings(env: NodeJS.ProcessEnv): string[] {
  if (readEnv(env, BENCHMARK_PROVIDER_KEY_ENV) === undefined) {
    return [];
  }
  const configuredProviderKeys = NON_CANONICAL_PROVIDER_KEYS.filter((key) => readEnv(env, key) !== undefined);
  return configuredProviderKeys.length === 0
    ? []
    : [`Ignoring non-OpenRouter provider key(s) for Kestrel benchmarks: ${configuredProviderKeys.join(", ")}.`];
}

export function benchmarkProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const config = resolveBenchmarkProviderConfig(env);
  const next: NodeJS.ProcessEnv = {
    ...env,
    KESTREL_BENCHMARK_MODEL_PROVIDER: config.modelProvider,
    KESTREL_BENCHMARK_MODEL: config.model,
    KESTREL_BENCHMARK_CREDENTIAL_ENV: config.credentialEnv,
    ...(config.credentialFingerprint !== undefined
      ? { KESTREL_BENCHMARK_CREDENTIAL_FINGERPRINT: config.credentialFingerprint }
      : {}),
  };
  for (const name of Object.keys(DEPRECATED_BENCHMARK_ENV)) {
    delete next[name];
  }
  for (const name of NON_CANONICAL_PROVIDER_KEYS) {
    delete next[name];
  }
  return next;
}

export function credentialFingerprintPayload(env: NodeJS.ProcessEnv): {
  credentialFingerprint?: string | undefined;
} {
  const key = readEnv(env, BENCHMARK_PROVIDER_KEY_ENV);
  return key === undefined
    ? {}
    : { credentialFingerprint: createHash("sha256").update(key).digest("hex").slice(0, 12) };
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
