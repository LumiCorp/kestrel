import { createHash } from "node:crypto";

import type { RuntimeId } from "./contracts.js";
import type { RuntimeEnvironmentMap } from "./contracts.js";

type ForeignRuntimeId = Exclude<RuntimeId, "kestrel">;

const PASSTHROUGH_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const CODEX_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "CODEX_HOME",
] as const;

const CLAUDE_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
] as const;

export interface RuntimeChildEnvironmentInput {
  runtimeId: ForeignRuntimeId;
  baseEnvironment?: RuntimeEnvironmentMap | undefined;
  runtimeEnvironment?: RuntimeEnvironmentMap | undefined;
  configurationDirectory?: string | undefined;
}

/**
 * Projects the minimum process environment needed by a foreign Runtime.
 * Application and provider secrets are denied unless they belong to the
 * selected Runtime and were explicitly supplied by its environment resolver.
 */
export function buildRuntimeChildEnvironment(
  input: RuntimeChildEnvironmentInput,
): RuntimeEnvironmentMap {
  const environment: RuntimeEnvironmentMap = {};
  copyKeys(environment, input.baseEnvironment ?? {}, PASSTHROUGH_KEYS);
  copyLocaleKeys(environment, input.baseEnvironment ?? {});

  const runtimeEnvironment = input.runtimeEnvironment ?? {};
  copyKeys(environment, runtimeEnvironment, PASSTHROUGH_KEYS);
  copyLocaleKeys(environment, runtimeEnvironment);
  copyKeys(
    environment,
    runtimeEnvironment,
    input.runtimeId === "codex" ? CODEX_KEYS : CLAUDE_KEYS,
  );

  if (input.configurationDirectory !== undefined) {
    environment[
      input.runtimeId === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"
    ] = input.configurationDirectory;
  }
  return environment;
}

export function fingerprintRuntimeEnvironment(input: {
  runtimeId: ForeignRuntimeId;
  environment: RuntimeEnvironmentMap;
  scope: readonly string[];
}): string {
  const keys = input.runtimeId === "codex" ? CODEX_KEYS : CLAUDE_KEYS;
  const values = keys.map((key) => input.environment[key] ?? "");
  return createHash("sha256")
    .update([input.runtimeId, ...input.scope, ...values].join("\0"))
    .digest("hex");
}

function copyKeys(
  target: RuntimeEnvironmentMap,
  source: RuntimeEnvironmentMap,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) target[key] = value;
  }
}

function copyLocaleKeys(
  target: RuntimeEnvironmentMap,
  source: RuntimeEnvironmentMap,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (/^LC_[A-Z_]+$/u.test(key) && typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}
