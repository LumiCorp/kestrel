import { inspect } from "node:util";

import type { ModelProviderId } from "../profile/runtimeProfile.js";
import {
  LOCAL_CORE_CREDENTIAL_IDS,
  parseLocalCoreCredentialSecret,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";

export const LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS = Object.freeze([
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TAVILY_API_KEY",
] as const);

export type LocalCoreManagedRuntimeEnvKey =
  (typeof LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS)[number];

export interface LocalCoreResolvedModelProfile {
  readonly modelProvider: ModelProviderId;
  readonly model: string;
}

/**
 * An immutable, in-memory runtime configuration owned by Local Core.
 *
 * Environment views are deliberately non-enumerable on the outer snapshot.
 * Credentials remain enumerable within their narrowly scoped view because the
 * existing model and internet factories spread their supplied environment.
 * Secret-bearing views install JSON and Node inspection redaction hooks.
 */
export interface LocalCoreRuntimeEnvironmentSnapshot {
  readonly modelProvider: ModelProviderId;
  readonly model: string;
  /** Selected model-provider credential; never includes Tavily. */
  readonly modelEnv: Readonly<NodeJS.ProcessEnv>;
  /** Tavily credential; never includes model-provider credentials. */
  readonly internetEnv: Readonly<NodeJS.ProcessEnv>;
  /** General runtime environment with every Core-managed credential scrubbed. */
  readonly runtimeEnv: Readonly<NodeJS.ProcessEnv>;
  /** MCP/dev-shell environment with every Core-managed credential scrubbed. */
  readonly mcpEnv: Readonly<NodeJS.ProcessEnv>;
}

export interface ResolveLocalCoreRuntimeEnvironmentInput {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly resolvedProfile: LocalCoreResolvedModelProfile;
  readonly credentialStore: Pick<LocalCoreCredentialStore, "get">;
}

export interface CreateLocalCoreRuntimeEnvironmentResolverInput {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly credentialStore: Pick<LocalCoreCredentialStore, "get">;
}

export interface LocalCoreRuntimeEnvironmentResolver {
  readonly resolve: (
    resolvedProfile: LocalCoreResolvedModelProfile,
  ) => LocalCoreRuntimeEnvironmentSnapshot;
}

interface ProviderCredentialBinding {
  readonly credentialId: LocalCoreCredentialId;
  readonly envKey: Exclude<LocalCoreManagedRuntimeEnvKey, "TAVILY_API_KEY">;
}

const MANAGED_RUNTIME_ENV_KEY_SET = new Set<string>(
  LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS,
);

const PROVIDER_CREDENTIAL_BINDINGS: Readonly<
  Partial<Record<ModelProviderId, ProviderCredentialBinding>>
> = Object.freeze({
  openrouter: Object.freeze({
    credentialId: "provider.openrouter.default",
    envKey: "OPENROUTER_API_KEY",
  }),
  openai: Object.freeze({
    credentialId: "provider.openai.default",
    envKey: "OPENAI_API_KEY",
  }),
  anthropic: Object.freeze({
    credentialId: "provider.anthropic.default",
    envKey: "ANTHROPIC_API_KEY",
  }),
});

const TAVILY_CREDENTIAL_ID: LocalCoreCredentialId = "tool.tavily.default";

/**
 * Resolve the exact model/tool environment for one Core-owned runtime.
 *
 * The credential store is authoritative. Managed values inherited through
 * `baseEnv` are always removed before the selected provider and Tavily values
 * are read from the store. Missing store values remain absent.
 */
export async function resolveLocalCoreRuntimeEnvironment(
  input: ResolveLocalCoreRuntimeEnvironmentInput,
): Promise<LocalCoreRuntimeEnvironmentSnapshot> {
  const resolver = await createLocalCoreRuntimeEnvironmentResolver(input);
  return resolver.resolve(input.resolvedProfile);
}

/**
 * Capture Core credentials and the inherited environment once for a runner
 * bundle, then resolve per-profile runtime views synchronously.
 */
export async function createLocalCoreRuntimeEnvironmentResolver(
  input: CreateLocalCoreRuntimeEnvironmentResolverInput,
): Promise<LocalCoreRuntimeEnvironmentResolver> {
  const baseEnv = Object.freeze(copyUnmanagedEnvironment(input.baseEnv));
  const credentials = Object.create(null) as Partial<
    Record<LocalCoreCredentialId, string>
  >;
  const entries = await Promise.all(
    LOCAL_CORE_CREDENTIAL_IDS.map(async (credentialId) => [
      credentialId,
      await readCredential(input.credentialStore, credentialId),
    ] as const),
  );
  for (const [credentialId, value] of entries) {
    if (value !== undefined) {
      credentials[credentialId] = value;
    }
  }
  Object.freeze(credentials);

  const resolve = Object.freeze(
    (resolvedProfile: LocalCoreResolvedModelProfile) =>
      buildLocalCoreRuntimeEnvironmentSnapshot({
        baseEnv,
        resolvedProfile,
        credentials,
      }),
  );
  return Object.freeze({ resolve });
}

function buildLocalCoreRuntimeEnvironmentSnapshot(input: {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly resolvedProfile: LocalCoreResolvedModelProfile;
  readonly credentials: Readonly<Partial<Record<LocalCoreCredentialId, string>>>;
}): LocalCoreRuntimeEnvironmentSnapshot {
  const modelProvider = parseModelProvider(input.resolvedProfile.modelProvider);
  const model = requireNonEmpty(input.resolvedProfile.model, "Local Core runtime model");
  const providerBinding = PROVIDER_CREDENTIAL_BINDINGS[modelProvider];
  const providerCredential = providerBinding === undefined
    ? undefined
    : input.credentials[providerBinding.credentialId];
  const tavilyCredential = input.credentials[TAVILY_CREDENTIAL_ID];

  const modelEnv = createSecretBearingEnvironmentView(
    input.baseEnv,
    providerBinding !== undefined && providerCredential !== undefined
      ? { key: providerBinding.envKey, value: providerCredential }
      : undefined,
  );
  const internetEnv = createSecretBearingEnvironmentView(
    input.baseEnv,
    tavilyCredential !== undefined
      ? { key: "TAVILY_API_KEY", value: tavilyCredential }
      : undefined,
  );
  const runtimeEnv = createScrubbedEnvironmentView(input.baseEnv);
  const mcpEnv = createScrubbedEnvironmentView(input.baseEnv);

  const snapshot = {
    modelProvider,
    model,
  } as {
    readonly modelProvider: ModelProviderId;
    readonly model: string;
    readonly modelEnv: Readonly<NodeJS.ProcessEnv>;
    readonly internetEnv: Readonly<NodeJS.ProcessEnv>;
    readonly runtimeEnv: Readonly<NodeJS.ProcessEnv>;
    readonly mcpEnv: Readonly<NodeJS.ProcessEnv>;
  };
  defineEnvironmentView(snapshot, "modelEnv", modelEnv);
  defineEnvironmentView(snapshot, "internetEnv", internetEnv);
  defineEnvironmentView(snapshot, "runtimeEnv", runtimeEnv);
  defineEnvironmentView(snapshot, "mcpEnv", mcpEnv);
  Object.defineProperty(snapshot, "toJSON", {
    value: () => ({ modelProvider, model }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(snapshot);
}

function createSecretBearingEnvironmentView(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  credential: {
    readonly key: LocalCoreManagedRuntimeEnvKey;
    readonly value: string;
  } | undefined,
): Readonly<NodeJS.ProcessEnv> {
  const env = copyUnmanagedEnvironment(baseEnv);
  if (credential !== undefined) {
    env[credential.key] = credential.value;
  }
  Object.defineProperty(env, "toJSON", {
    value: () => redactEnvironmentForInspection(env),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(env, inspect.custom, {
    value: () => redactEnvironmentForInspection(env),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(env);
}

function createScrubbedEnvironmentView(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze(copyUnmanagedEnvironment(baseEnv));
}

function copyUnmanagedEnvironment(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(baseEnv).sort()) {
    if (MANAGED_RUNTIME_ENV_KEY_SET.has(key)) {
      continue;
    }
    const value = baseEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function readCredential(
  credentialStore: Pick<LocalCoreCredentialStore, "get">,
  credentialId: LocalCoreCredentialId,
): Promise<string | undefined> {
  const value = await credentialStore.get(credentialId);
  return value === undefined
    ? undefined
    : parseLocalCoreCredentialSecret(value);
}

function defineEnvironmentView<
  T extends object,
  K extends keyof LocalCoreRuntimeEnvironmentSnapshot,
>(
  snapshot: T,
  key: K,
  env: Readonly<NodeJS.ProcessEnv>,
): void {
  Object.defineProperty(snapshot, key, {
    value: env,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function redactEnvironmentForInspection(
  env: Readonly<NodeJS.ProcessEnv>,
): Readonly<NodeJS.ProcessEnv> {
  const redacted = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value !== undefined) {
      redacted[key] = MANAGED_RUNTIME_ENV_KEY_SET.has(key)
        ? "[REDACTED]"
        : value;
    }
  }
  return Object.freeze(redacted);
}

function parseModelProvider(value: unknown): ModelProviderId {
  if (
    value === "openrouter"
    || value === "openai"
    || value === "anthropic"
    || value === "ollama"
    || value === "lmstudio"
  ) {
    return value;
  }
  throw new Error(
    "Local Core runtime modelProvider must be one of: openrouter, openai, anthropic, ollama, lmstudio.",
  );
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
