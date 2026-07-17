import { inspect } from "node:util";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

export interface ToolProviderRuntimeConfiguration {
  readonly providerKey: string;
  readonly baseUrl?: string | undefined;
  readonly settings: Readonly<Record<string, string>>;
  readonly hasCredential: boolean;
  readCredential(): string | undefined;
}

export interface ToolProviderConfigurationResolver {
  resolve(providerKey: string): ToolProviderRuntimeConfiguration | undefined;
  list(): Array<{
    providerKey: string;
    configured: boolean;
    baseUrlConfigured: boolean;
    settings: string[];
  }>;
}

export interface CreateToolProviderRuntimeConfigurationInput {
  providerKey: string;
  credential?: string | undefined;
  baseUrl?: string | undefined;
  settings?: Readonly<Record<string, string | undefined>> | undefined;
}

/**
 * Create a provider-scoped runtime configuration without placing its secret in
 * an enumerable field. Tool adapters can read the credential at the execution
 * boundary, while JSON and diagnostic inspection expose configuration metadata
 * only.
 */
export function createToolProviderRuntimeConfiguration(
  input: CreateToolProviderRuntimeConfigurationInput,
): ToolProviderRuntimeConfiguration {
  const providerKey = requireNonEmpty(input.providerKey, "providerKey");
  const credential = normalizeOptional(input.credential);
  const baseUrl = normalizeOptional(input.baseUrl);
  const settings = Object.freeze(normalizeSettings(input.settings));
  const configuration = {
    providerKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    settings,
    hasCredential: credential !== undefined,
    readCredential: () => credential,
  } as ToolProviderRuntimeConfiguration & {
    toJSON?: () => unknown;
    [inspect.custom]?: () => unknown;
  };
  Object.defineProperty(configuration, "toJSON", {
    value: () => ({
      providerKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      settings,
      hasCredential: credential !== undefined,
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(configuration, inspect.custom, {
    value: () => configuration.toJSON?.(),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(configuration);
}

export function createToolProviderConfigurationResolver(
  configurations: readonly ToolProviderRuntimeConfiguration[],
): ToolProviderConfigurationResolver {
  const byProvider = new Map<string, ToolProviderRuntimeConfiguration>();
  for (const configuration of configurations) {
    const providerKey = requireNonEmpty(
      configuration.providerKey,
      "configuration.providerKey",
    );
    if (byProvider.has(providerKey)) {
      throw createRuntimeFailure(
        "TOOL_PROVIDER_CONFIGURATION_DUPLICATE",
        `Duplicate tool provider configuration '${providerKey}'.`,
        {
          subsystem: "tooling",
          provider: providerKey,
          classification: "configuration",
          recoverable: false,
        },
      );
    }
    byProvider.set(providerKey, configuration);
  }
  return Object.freeze({
    resolve(providerKey: string) {
      return byProvider.get(requireNonEmpty(providerKey, "providerKey"));
    },
    list() {
      return [...byProvider.values()]
        .map((configuration) => ({
          providerKey: configuration.providerKey,
          configured: configuration.hasCredential,
          baseUrlConfigured: configuration.baseUrl !== undefined,
          settings: Object.keys(configuration.settings).sort(),
        }))
        .sort((left, right) =>
          left.providerKey.localeCompare(right.providerKey),
        );
    },
  });
}

function normalizeSettings(
  value: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(value ?? {})) {
    const settingKey = requireNonEmpty(key, "settings key");
    const settingValue = normalizeOptional(candidate);
    if (settingValue !== undefined) {
      normalized[settingKey] = settingValue;
    }
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return ;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw createRuntimeFailure(
      "TOOL_PROVIDER_CONFIGURATION_INVALID",
      `${label} must be a non-empty string.`,
      {
        subsystem: "tooling",
        field: label,
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  return normalized;
}
