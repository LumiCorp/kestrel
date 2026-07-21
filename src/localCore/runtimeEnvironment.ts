import { inspect } from "node:util";

import type { ModelProviderId } from "../profile/runtimeProfile.js";
import {
  LOCAL_CORE_CREDENTIAL_IDS,
  parseLocalCoreCredentialSecret,
  type LocalCoreCredentialId,
  type LocalCoreCredentialStore,
} from "./credentialStore.js";
import type { LocalCoreRuntimeConfigurationV1 } from "./runtimeConfiguration.js";

export const LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS = Object.freeze([
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TAVILY_API_KEY",
  "VISUAL_CROSSING_API_KEY",
] as const);

const LOCAL_CORE_RUNTIME_CREDENTIAL_IDS = LOCAL_CORE_CREDENTIAL_IDS.filter(
  (credentialId) => credentialId !== "data.database.external",
);

export type LocalCoreManagedRuntimeEnvKey =
  (typeof LOCAL_CORE_MANAGED_RUNTIME_ENV_KEYS)[number];

export const LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS = Object.freeze([
  "OPENROUTER_MODEL",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERSION",
  "OLLAMA_MODEL",
  "OLLAMA_BASE_URL",
  "LMSTUDIO_MODEL",
  "LMSTUDIO_BASE_URL",
  "TAVILY_BASE_URL",
  "TAVILY_PROJECT",
  "TAVILY_HTTP_PROXY",
  "TAVILY_HTTPS_PROXY",
  "VISUAL_CROSSING_BASE_URL",
] as const);

export type LocalCoreManagedRuntimeOptionEnvKey =
  (typeof LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS)[number];

type LocalCoreRuntimeEnvironmentOptions = Readonly<
  Partial<Record<LocalCoreManagedRuntimeOptionEnvKey, string | undefined>>
>;

export interface LocalCoreResolvedModelProfile {
  readonly modelProvider: ModelProviderId;
  readonly model: string;
}

/**
 * An immutable, in-memory runtime configuration owned by Local Core.
 *
 * Environment views are deliberately non-enumerable on the outer snapshot.
 * Credentials remain enumerable within each environment because the existing
 * runtime factories spread their supplied environment. Credential-store-backed
 * values are narrowly scoped; ambient values remain compatible until that
 * authority is activated. Secret-bearing views install JSON and Node inspection
 * redaction hooks.
 */
export interface LocalCoreRuntimeEnvironmentSnapshot {
  readonly modelProvider: ModelProviderId;
  readonly model: string;
  /** Canonical selected-provider configuration and its available credentials. */
  readonly modelEnv: Readonly<NodeJS.ProcessEnv>;
  /** Canonical Tavily configuration and its available credentials. */
  readonly internetEnv: Readonly<NodeJS.ProcessEnv>;
  /** General runtime environment without managed non-secret configuration. */
  readonly runtimeEnv: Readonly<NodeJS.ProcessEnv>;
  /** MCP/dev-shell environment without managed non-secret configuration. */
  readonly mcpEnv: Readonly<NodeJS.ProcessEnv>;
}

export interface ResolveLocalCoreRuntimeEnvironmentInput {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly resolvedProfile: LocalCoreResolvedModelProfile;
  readonly runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  readonly credentialStore?: Pick<LocalCoreCredentialStore, "get"> | undefined;
  readonly mcpCredentialBindings?: CreateLocalCoreRuntimeEnvironmentResolverInput["mcpCredentialBindings"];
  readonly mcpEnvironmentOptions?: CreateLocalCoreRuntimeEnvironmentResolverInput["mcpEnvironmentOptions"];
}

export interface CreateLocalCoreRuntimeEnvironmentResolverInput {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  readonly credentialStore?: Pick<LocalCoreCredentialStore, "get"> | undefined;
  readonly mcpCredentialBindings?: readonly {
    readonly credentialId: LocalCoreCredentialId;
    readonly envKey: string;
  }[] | undefined;
  readonly mcpEnvironmentOptions?: Readonly<Partial<Record<"SHELL" | "PATH", string>>> | undefined;
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

const MANAGED_RUNTIME_OPTION_ENV_KEY_SET = new Set<string>(
  LOCAL_CORE_MANAGED_RUNTIME_OPTION_ENV_KEYS,
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
const VISUAL_CROSSING_CREDENTIAL_ID: LocalCoreCredentialId =
  "tool.visual-crossing.default";

/**
 * Resolve the exact model/tool environment for one Core-owned runtime.
 *
 * When a credential store is supplied, it is authoritative: managed secrets
 * inherited through `baseEnv` are removed before scoped credentials are read
 * from the store. Without a store, inherited secrets remain ambient so merely
 * adopting typed non-secret configuration does not activate new credential
 * authority. The configuration's explicit environment option mode decides
 * whether inherited non-secret options remain available or the canonical
 * allowlist replaces them.
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
  const credentialStoreIsAuthoritative = input.credentialStore !== undefined;
  const runtimeOptionsAreAuthoritative =
    input.runtimeConfiguration.environmentOptionsMode === "replace";
  const baseEnv = Object.freeze(
    copyBaseEnvironment(
      input.baseEnv,
      credentialStoreIsAuthoritative,
      runtimeOptionsAreAuthoritative,
      input.mcpCredentialBindings?.map((binding) => binding.envKey) ?? [],
    ),
  );
  const runtimeConfiguration = input.runtimeConfiguration;
  const credentials = Object.create(null) as Partial<
    Record<LocalCoreCredentialId, string>
  >;
  const credentialStore = input.credentialStore;
  if (credentialStore !== undefined) {
    const credentialIds = [...new Set<LocalCoreCredentialId>([
      ...LOCAL_CORE_RUNTIME_CREDENTIAL_IDS,
      ...(input.mcpCredentialBindings?.map((binding) => binding.credentialId) ?? []),
    ])];
    const entries = await Promise.all(
      credentialIds.map(
        async (credentialId) =>
          [
            credentialId,
            await readCredential(credentialStore, credentialId),
          ] as const,
      ),
    );
    for (const [credentialId, value] of entries) {
      if (value !== undefined) {
        credentials[credentialId] = value;
      }
    }
  }
  Object.freeze(credentials);

  const resolve = Object.freeze(
    (resolvedProfile: LocalCoreResolvedModelProfile) =>
      buildLocalCoreRuntimeEnvironmentSnapshot({
        baseEnv,
        resolvedProfile,
        credentials,
        credentialStoreIsAuthoritative,
        runtimeConfiguration,
        mcpCredentialBindings: input.mcpCredentialBindings ?? [],
        mcpEnvironmentOptions: input.mcpEnvironmentOptions ?? {},
      }),
  );
  return Object.freeze({ resolve });
}

function buildLocalCoreRuntimeEnvironmentSnapshot(input: {
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly resolvedProfile: LocalCoreResolvedModelProfile;
  readonly credentials: Readonly<
    Partial<Record<LocalCoreCredentialId, string>>
  >;
  readonly credentialStoreIsAuthoritative: boolean;
  readonly runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  readonly mcpCredentialBindings: readonly {
    readonly credentialId: LocalCoreCredentialId;
    readonly envKey: string;
  }[];
  readonly mcpEnvironmentOptions: Readonly<Partial<Record<"SHELL" | "PATH", string>>>;
}): LocalCoreRuntimeEnvironmentSnapshot {
  const modelProvider = parseModelProvider(input.resolvedProfile.modelProvider);
  const model = requireNonEmpty(
    input.resolvedProfile.model,
    "Local Core runtime model",
  );
  const providerBinding = PROVIDER_CREDENTIAL_BINDINGS[modelProvider];
  const providerCredential =
    providerBinding === undefined
      ? undefined
      : input.credentials[providerBinding.credentialId];
  const tavilyCredential = input.credentials[TAVILY_CREDENTIAL_ID];
  const visualCrossingCredential =
    input.credentials[VISUAL_CROSSING_CREDENTIAL_ID];

  const modelOptions = createModelEnvironmentOptions({
    modelProvider,
    model,
    runtimeConfiguration: input.runtimeConfiguration,
  });
  const internetOptions = createInternetEnvironmentOptions(
    input.runtimeConfiguration,
  );

  const modelEnv = createSecretBearingEnvironmentView(
    input.baseEnv,
    modelOptions,
    providerBinding !== undefined && providerCredential !== undefined
      ? [{ key: providerBinding.envKey, value: providerCredential }]
      : [],
  );
  const internetEnv = createSecretBearingEnvironmentView(
    input.baseEnv,
    internetOptions,
    [
      ...(tavilyCredential !== undefined
        ? [{ key: "TAVILY_API_KEY" as const, value: tavilyCredential }]
        : []),
      ...(visualCrossingCredential !== undefined
        ? [
            {
              key: "VISUAL_CROSSING_API_KEY" as const,
              value: visualCrossingCredential,
            },
          ]
        : []),
    ],
  );
  const runtimeEnv = createRuntimeEnvironmentView(
    input.baseEnv,
    !input.credentialStoreIsAuthoritative,
  );
  const mcpBaseEnv = copyEnvironment(input.baseEnv);
  for (const [key, value] of Object.entries(input.mcpEnvironmentOptions)) {
    if (value !== undefined) mcpBaseEnv[key] = value;
  }
  const mcpCredentials = input.mcpCredentialBindings.flatMap((binding) => {
    const value = input.credentials[binding.credentialId];
    return value === undefined ? [] : [{ key: binding.envKey, value }];
  });
  const mcpEnv = mcpCredentials.length > 0
    ? createArbitrarySecretBearingEnvironmentView(mcpBaseEnv, mcpCredentials)
    : createRuntimeEnvironmentView(mcpBaseEnv, !input.credentialStoreIsAuthoritative);

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
  options: LocalCoreRuntimeEnvironmentOptions,
  credentials: readonly {
    readonly key: LocalCoreManagedRuntimeEnvKey;
    readonly value: string;
  }[],
): Readonly<NodeJS.ProcessEnv> {
  const env = copyEnvironment(baseEnv);
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const credential of credentials) {
    env[credential.key] = credential.value;
  }
  installEnvironmentRedactionHooks(env);
  return Object.freeze(env);
}

function createArbitrarySecretBearingEnvironmentView(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  credentials: readonly { readonly key: string; readonly value: string }[],
): Readonly<NodeJS.ProcessEnv> {
  const env = copyEnvironment(baseEnv);
  for (const credential of credentials) env[credential.key] = credential.value;
  installEnvironmentRedactionHooks(env);
  return Object.freeze(env);
}

function createRuntimeEnvironmentView(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  mayContainManagedSecrets: boolean,
): Readonly<NodeJS.ProcessEnv> {
  const env = copyEnvironment(baseEnv);
  if (mayContainManagedSecrets) {
    installEnvironmentRedactionHooks(env);
  }
  return Object.freeze(env);
}

function copyBaseEnvironment(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  scrubManagedSecrets: boolean,
  scrubManagedOptions: boolean,
  additionalSecretKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const additionalSecretKeySet = new Set(additionalSecretKeys);
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(baseEnv).sort()) {
    if (
      additionalSecretKeySet.has(key) ||
      (scrubManagedOptions && MANAGED_RUNTIME_OPTION_ENV_KEY_SET.has(key)) ||
      (scrubManagedSecrets && MANAGED_RUNTIME_ENV_KEY_SET.has(key))
    ) {
      continue;
    }
    const value = baseEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function copyEnvironment(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of Object.keys(baseEnv)) {
    const value = baseEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function createModelEnvironmentOptions(input: {
  readonly modelProvider: ModelProviderId;
  readonly model: string;
  readonly runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
}): LocalCoreRuntimeEnvironmentOptions {
  const providers = input.runtimeConfiguration.providers;
  switch (input.modelProvider) {
    case "openrouter":
      return Object.freeze({
        OPENROUTER_MODEL: input.model,
        OPENROUTER_BASE_URL: providers.openrouter.baseUrl,
        OPENROUTER_SITE_URL: providers.openrouter.siteUrl,
        OPENROUTER_APP_NAME: providers.openrouter.appName,
      });
    case "openai":
      return Object.freeze({
        OPENAI_MODEL: input.model,
        OPENAI_BASE_URL: providers.openai.baseUrl,
        OPENAI_ORG_ID: providers.openai.organizationId,
        OPENAI_PROJECT_ID: providers.openai.projectId,
      });
    case "anthropic":
      return Object.freeze({
        ANTHROPIC_MODEL: input.model,
        ANTHROPIC_BASE_URL: providers.anthropic.baseUrl,
        ANTHROPIC_VERSION: providers.anthropic.version,
      });
    case "ollama":
      return Object.freeze({
        OLLAMA_MODEL: input.model,
        OLLAMA_BASE_URL: providers.ollama.baseUrl,
      });
    case "lmstudio":
      return Object.freeze({
        LMSTUDIO_MODEL: input.model,
        LMSTUDIO_BASE_URL: providers.lmstudio.baseUrl,
      });
  }
}

function createInternetEnvironmentOptions(
  runtimeConfiguration: LocalCoreRuntimeConfigurationV1,
): LocalCoreRuntimeEnvironmentOptions {
  const tavily = runtimeConfiguration.tools.tavily;
  const visualCrossing = runtimeConfiguration.tools.visualCrossing;
  return Object.freeze({
    TAVILY_BASE_URL: tavily.baseUrl,
    TAVILY_PROJECT: tavily.projectId,
    TAVILY_HTTP_PROXY: tavily.httpProxyUrl,
    TAVILY_HTTPS_PROXY: tavily.httpsProxyUrl,
    VISUAL_CROSSING_BASE_URL: visualCrossing.baseUrl,
  });
}

function installEnvironmentRedactionHooks(env: NodeJS.ProcessEnv): void {
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
>(snapshot: T, key: K, env: Readonly<NodeJS.ProcessEnv>): void {
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
    value === "openrouter" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "ollama" ||
    value === "lmstudio"
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
