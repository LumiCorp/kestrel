import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  createDefaultModelPolicy,
  parseModelPolicyV1,
  type ModelPolicyV1,
} from "../profile/modelPolicy.js";

export const LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION = 1;
export const LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME = "runtime-configuration.json";
export const LOCAL_CORE_RUNTIME_CONFIGURATION_RELATIVE_PATH = path.join(
  "settings",
  LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME,
);

const SETTINGS_DIRECTORY_MODE = 0o700;
const CONFIGURATION_FILE_MODE = 0o600;
const CONFIGURATION_STRING_MAX_LENGTH = 512;
const CONFIGURATION_URL_MAX_LENGTH = 2048;

export type LocalCoreRuntimeEnvironmentOptionsMode = "inherit" | "replace";

export interface LocalCoreRuntimeConfigurationV1 {
  readonly version: typeof LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION;
  readonly generation: number;
  readonly environmentOptionsMode: LocalCoreRuntimeEnvironmentOptionsMode;
  readonly modelPolicy: ModelPolicyV1;
  readonly providers: {
    readonly openrouter: {
      readonly baseUrl?: string | undefined;
      readonly siteUrl?: string | undefined;
      readonly appName?: string | undefined;
    };
    readonly openai: {
      readonly baseUrl?: string | undefined;
      readonly organizationId?: string | undefined;
      readonly projectId?: string | undefined;
    };
    readonly anthropic: {
      readonly baseUrl?: string | undefined;
      readonly version?: string | undefined;
    };
    readonly ollama: {
      readonly baseUrl?: string | undefined;
    };
    readonly lmstudio: {
      readonly baseUrl?: string | undefined;
    };
  };
  readonly tools: {
    readonly tavily: {
      readonly baseUrl?: string | undefined;
      readonly projectId?: string | undefined;
      readonly httpProxyUrl?: string | undefined;
      readonly httpsProxyUrl?: string | undefined;
    };
    readonly visualCrossing: {
      readonly baseUrl?: string | undefined;
    };
  };
}

export type LocalCoreRuntimeConfigurationErrorCode =
  | "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID"
  | "LOCAL_CORE_RUNTIME_CONFIGURATION_READ_FAILED"
  | "LOCAL_CORE_RUNTIME_CONFIGURATION_REPAIR_NOT_REQUIRED"
  | "LOCAL_CORE_RUNTIME_CONFIGURATION_WRITE_FAILED";

export class LocalCoreRuntimeConfigurationError extends Error {
  constructor(
    readonly code: LocalCoreRuntimeConfigurationErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "LocalCoreRuntimeConfigurationError";
  }
}

export interface LocalCoreRuntimeConfigurationStoreOptions {
  readonly fallbackModelPolicy?: (
    () => ModelPolicyV1 | Promise<ModelPolicyV1>
  ) | undefined;
  readonly syncDirectory?: ((directoryPath: string) => Promise<void>) | undefined;
}

export function resolveLocalCoreRuntimeConfigurationPath(homePath: string): string {
  if (typeof homePath !== "string" || homePath.trim().length === 0) {
    throw invalidConfiguration("Local Core home path must be a non-empty string.");
  }
  return path.join(path.resolve(homePath), LOCAL_CORE_RUNTIME_CONFIGURATION_RELATIVE_PATH);
}

export function createDefaultLocalCoreRuntimeConfiguration(
  fallbackModelPolicy: ModelPolicyV1 = createDefaultModelPolicy(),
): LocalCoreRuntimeConfigurationV1 {
  return parseLocalCoreRuntimeConfiguration({
    version: LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION,
    generation: 0,
    environmentOptionsMode: "inherit",
    modelPolicy: fallbackModelPolicy,
    providers: {
      openrouter: {},
      openai: {},
      anthropic: {},
      ollama: {},
      lmstudio: {},
    },
    tools: {
      tavily: {},
      visualCrossing: {},
    },
  });
}

export function parseLocalCoreRuntimeConfiguration(
  value: unknown,
): LocalCoreRuntimeConfigurationV1 {
  const record = requireRecord(value, "Runtime configuration");
  rejectFields(record, TOP_LEVEL_FIELDS, "Runtime configuration");

  if (record.version !== LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION) {
    throw invalidConfiguration(
      `Runtime configuration version must be ${LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION}.`,
    );
  }
  if (
    typeof record.generation !== "number"
    || Number.isSafeInteger(record.generation) === false
    || record.generation < 0
  ) {
    throw invalidConfiguration(
      "Runtime configuration generation must be a nonnegative safe integer.",
    );
  }
  if (
    record.environmentOptionsMode !== "inherit"
    && record.environmentOptionsMode !== "replace"
  ) {
    throw invalidConfiguration(
      "Runtime configuration environmentOptionsMode must be 'inherit' or 'replace'.",
    );
  }

  let modelPolicy: ModelPolicyV1;
  try {
    modelPolicy = parseModelPolicyV1(record.modelPolicy);
  } catch (error) {
    throw invalidConfiguration("Runtime configuration modelPolicy is invalid.", error);
  }

  const providers = requireRecord(record.providers, "Runtime configuration providers");
  rejectFields(providers, PROVIDER_FIELDS, "Runtime configuration providers");
  const openrouter = parseOpenRouterConfiguration(providers.openrouter);
  const openai = parseOpenAiConfiguration(providers.openai);
  const anthropic = parseAnthropicConfiguration(providers.anthropic);
  const ollama = parseBaseUrlConfiguration(
    providers.ollama,
    "Runtime configuration providers.ollama",
  );
  const lmstudio = parseBaseUrlConfiguration(
    providers.lmstudio,
    "Runtime configuration providers.lmstudio",
  );

  const tools = requireRecord(record.tools, "Runtime configuration tools");
  rejectFields(tools, TOOL_FIELDS, "Runtime configuration tools");
  const tavily = parseTavilyConfiguration(tools.tavily);
  const visualCrossing = parseBaseUrlConfiguration(
    tools.visualCrossing ?? {},
    "Runtime configuration tools.visualCrossing",
  );

  return deepFreeze({
    version: LOCAL_CORE_RUNTIME_CONFIGURATION_VERSION,
    generation: record.generation,
    environmentOptionsMode: record.environmentOptionsMode,
    modelPolicy,
    providers: {
      openrouter,
      openai,
      anthropic,
      ollama,
      lmstudio,
    },
    tools: {
      tavily,
      visualCrossing,
    },
  });
}

export class LocalCoreRuntimeConfigurationStore {
  readonly homePath: string;
  readonly settingsPath: string;
  readonly filePath: string;

  readonly #fallbackModelPolicy:
    | (() => ModelPolicyV1 | Promise<ModelPolicyV1>)
    | undefined;
  readonly #syncDirectory: (directoryPath: string) => Promise<void>;
  #operation: Promise<void> = Promise.resolve();

  constructor(
    homePath: string,
    options: LocalCoreRuntimeConfigurationStoreOptions = {},
  ) {
    this.filePath = resolveLocalCoreRuntimeConfigurationPath(homePath);
    this.settingsPath = path.dirname(this.filePath);
    this.homePath = path.dirname(this.settingsPath);
    this.#fallbackModelPolicy = options.fallbackModelPolicy;
    this.#syncDirectory = options.syncDirectory ?? syncDirectoryEntry;
  }

  async read(): Promise<LocalCoreRuntimeConfigurationV1> {
    return await this.#runExclusive(async () => await this.#readUnlocked());
  }

  async write(value: unknown): Promise<LocalCoreRuntimeConfigurationV1> {
    return await this.#runExclusive(async () => {
      const configuration = parseLocalCoreRuntimeConfiguration(value);
      await this.#writeUnlocked(configuration);
      return configuration;
    });
  }

  async update(
    mutator: (
      current: LocalCoreRuntimeConfigurationV1,
    ) => unknown | Promise<unknown>,
  ): Promise<LocalCoreRuntimeConfigurationV1> {
    if (typeof mutator !== "function") {
      throw invalidConfiguration("Runtime configuration update requires a mutator function.");
    }
    return await this.#runExclusive(async () => {
      const current = await this.#readUnlocked();
      if (current.generation === Number.MAX_SAFE_INTEGER) {
        throw invalidConfiguration("Runtime configuration generation cannot be incremented.");
      }
      const proposed = parseLocalCoreRuntimeConfiguration(await mutator(current));
      const next = parseLocalCoreRuntimeConfiguration({
        ...proposed,
        generation: current.generation + 1,
      });
      await this.#writeUnlocked(next);
      return next;
    });
  }

  /**
   * Replace a malformed persisted snapshot without weakening normal reads.
   * A healthy or missing configuration must continue through update() so its
   * generation remains monotonic.
   */
  async repairInvalid(
    value: unknown,
    options: { readonly lastKnownGeneration?: number | undefined } = {},
  ): Promise<LocalCoreRuntimeConfigurationV1> {
    return await this.#runExclusive(async () => {
      const proposed = parseLocalCoreRuntimeConfiguration(value);
      const lastKnownGeneration = options.lastKnownGeneration ?? -1;
      if (
        Number.isSafeInteger(lastKnownGeneration) === false
        || lastKnownGeneration < -1
        || lastKnownGeneration >= Number.MAX_SAFE_INTEGER
      ) {
        throw invalidConfiguration(
          "Runtime configuration repair requires a valid last-known generation.",
        );
      }
      const configuration = parseLocalCoreRuntimeConfiguration({
        ...proposed,
        generation: lastKnownGeneration + 1,
      });
      try {
        await this.#readUnlocked();
      } catch (error) {
        if (
          error instanceof LocalCoreRuntimeConfigurationError
          && error.code === "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID"
        ) {
          await this.#writeUnlocked(configuration);
          return configuration;
        }
        throw error;
      }
      throw new LocalCoreRuntimeConfigurationError(
        "LOCAL_CORE_RUNTIME_CONFIGURATION_REPAIR_NOT_REQUIRED",
        "Local Core runtime configuration is valid and does not require repair.",
      );
    });
  }

  async #readUnlocked(): Promise<LocalCoreRuntimeConfigurationV1> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        const defaults = await this.#createDefaults();
        await this.#writeUnlocked(defaults);
        return defaults;
      }
      throw new LocalCoreRuntimeConfigurationError(
        "LOCAL_CORE_RUNTIME_CONFIGURATION_READ_FAILED",
        "Local Core runtime configuration could not be read.",
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw invalidConfiguration(
        "Persisted Local Core runtime configuration is not valid JSON.",
        error,
      );
    }
    return parseLocalCoreRuntimeConfiguration(parsed);
  }

  async #createDefaults(): Promise<LocalCoreRuntimeConfigurationV1> {
    if (this.#fallbackModelPolicy === undefined) {
      return createDefaultLocalCoreRuntimeConfiguration();
    }
    try {
      return createDefaultLocalCoreRuntimeConfiguration(
        await this.#fallbackModelPolicy(),
      );
    } catch (error) {
      if (error instanceof LocalCoreRuntimeConfigurationError) {
        throw error;
      }
      throw invalidConfiguration(
        "The fallback model policy for Local Core runtime configuration is invalid.",
        error,
      );
    }
  }

  async #writeUnlocked(
    configuration: LocalCoreRuntimeConfigurationV1,
  ): Promise<void> {
    const tempPath = path.join(
      this.settingsPath,
      `.${LOCAL_CORE_RUNTIME_CONFIGURATION_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let tempCreated = false;
    try {
      await mkdir(this.settingsPath, {
        recursive: true,
        mode: SETTINGS_DIRECTORY_MODE,
      });
      await chmod(this.settingsPath, SETTINGS_DIRECTORY_MODE);
      const file = await open(tempPath, "wx", CONFIGURATION_FILE_MODE);
      tempCreated = true;
      try {
        await file.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempPath, this.filePath);
      tempCreated = false;
      await this.#syncDirectory(this.settingsPath);
    } catch (error) {
      throw new LocalCoreRuntimeConfigurationError(
        "LOCAL_CORE_RUNTIME_CONFIGURATION_WRITE_FAILED",
        "Local Core runtime configuration could not be persisted.",
        { cause: error },
      );
    } finally {
      if (tempCreated) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
    }
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation);
    this.#operation = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

async function syncDirectoryEntry(directoryPath: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(directoryPath, "r");
    await directory.sync();
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) {
      return;
    }
    throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EISDIR"
    || code === "EINVAL"
    || code === "ENOTSUP"
    || code === "EPERM";
}

const TOP_LEVEL_FIELDS = new Set([
  "version",
  "generation",
  "environmentOptionsMode",
  "modelPolicy",
  "providers",
  "tools",
]);
const PROVIDER_FIELDS = new Set([
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
]);
const TOOL_FIELDS = new Set(["tavily", "visualCrossing"]);
const OPENROUTER_FIELDS = new Set(["baseUrl", "siteUrl", "appName"]);
const OPENAI_FIELDS = new Set(["baseUrl", "organizationId", "projectId"]);
const ANTHROPIC_FIELDS = new Set(["baseUrl", "version"]);
const BASE_URL_FIELDS = new Set(["baseUrl"]);
const TAVILY_FIELDS = new Set([
  "baseUrl",
  "projectId",
  "httpProxyUrl",
  "httpsProxyUrl",
]);

function parseOpenRouterConfiguration(value: unknown) {
  const record = requireRecord(value, "Runtime configuration providers.openrouter");
  rejectFields(record, OPENROUTER_FIELDS, "Runtime configuration providers.openrouter");
  return {
    ...readOptionalUrlField(record, "baseUrl", "providers.openrouter.baseUrl"),
    ...readOptionalUrlField(record, "siteUrl", "providers.openrouter.siteUrl"),
    ...readOptionalStringField(record, "appName", "providers.openrouter.appName"),
  };
}

function parseOpenAiConfiguration(value: unknown) {
  const record = requireRecord(value, "Runtime configuration providers.openai");
  rejectFields(record, OPENAI_FIELDS, "Runtime configuration providers.openai");
  return {
    ...readOptionalUrlField(record, "baseUrl", "providers.openai.baseUrl"),
    ...readOptionalStringField(record, "organizationId", "providers.openai.organizationId"),
    ...readOptionalStringField(record, "projectId", "providers.openai.projectId"),
  };
}

function parseAnthropicConfiguration(value: unknown) {
  const record = requireRecord(value, "Runtime configuration providers.anthropic");
  rejectFields(record, ANTHROPIC_FIELDS, "Runtime configuration providers.anthropic");
  return {
    ...readOptionalUrlField(record, "baseUrl", "providers.anthropic.baseUrl"),
    ...readOptionalStringField(record, "version", "providers.anthropic.version"),
  };
}

function parseBaseUrlConfiguration(value: unknown, label: string) {
  const record = requireRecord(value, label);
  rejectFields(record, BASE_URL_FIELDS, label);
  return {
    ...readOptionalUrlField(record, "baseUrl", `${label}.baseUrl`),
  };
}

function parseTavilyConfiguration(value: unknown) {
  const record = requireRecord(value, "Runtime configuration tools.tavily");
  rejectFields(record, TAVILY_FIELDS, "Runtime configuration tools.tavily");
  return {
    ...readOptionalUrlField(record, "baseUrl", "tools.tavily.baseUrl"),
    ...readOptionalStringField(record, "projectId", "tools.tavily.projectId"),
    ...readOptionalUrlField(record, "httpProxyUrl", "tools.tavily.httpProxyUrl"),
    ...readOptionalUrlField(record, "httpsProxyUrl", "tools.tavily.httpsProxyUrl"),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidConfiguration(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(record)) {
    if (isCredentialShapedField(field)) {
      throw invalidConfiguration(`${label} must not contain credential fields.`);
    }
    if (allowed.has(field) === false) {
      throw invalidConfiguration(`${label} contains an unsupported field.`);
    }
  }
}

function isCredentialShapedField(field: string): boolean {
  const normalized = field.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "key"
    || normalized.includes("apikey")
    || normalized.includes("accesskey")
    || normalized.includes("privatekey")
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("credential")
    || normalized.includes("authorization")
    || normalized.includes("bearer");
}

function readOptionalStringField<K extends string>(
  record: Record<string, unknown>,
  field: K,
  label: string,
): { [P in K]?: string } {
  const value = record[field];
  if (value === undefined) {
    return {};
  }
  return { [field]: parseConfigurationString(value, label) } as { [P in K]?: string };
}

function readOptionalUrlField<K extends string>(
  record: Record<string, unknown>,
  field: K,
  label: string,
): { [P in K]?: string } {
  const value = record[field];
  if (value === undefined) {
    return {};
  }
  return { [field]: parseConfigurationUrl(value, label) } as { [P in K]?: string };
}

function parseConfigurationString(value: unknown, label: string): string {
  return parseBoundedConfigurationString(
    value,
    label,
    CONFIGURATION_STRING_MAX_LENGTH,
  );
}

function parseBoundedConfigurationString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidConfiguration(
      `${label} must be a non-empty string without control characters.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw invalidConfiguration(`${label} is too long.`);
  }
  return trimmed;
}

function parseConfigurationUrl(value: unknown, label: string): string {
  const source = parseBoundedConfigurationString(
    value,
    label,
    CONFIGURATION_URL_MAX_LENGTH,
  );
  let url: URL;
  try {
    url = new URL(source);
  } catch (error) {
    throw invalidConfiguration(`${label} must be an absolute HTTP(S) URL.`, error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfiguration(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalidConfiguration(`${label} must not include credentials.`);
  }
  if (
    url.search.length > 0
    || url.hash.length > 0
    || source.includes("?")
    || source.includes("#")
  ) {
    throw invalidConfiguration(`${label} must not include a query or fragment.`);
  }
  return url.toString();
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function invalidConfiguration(
  message: string,
  cause?: unknown,
): LocalCoreRuntimeConfigurationError {
  return new LocalCoreRuntimeConfigurationError(
    "LOCAL_CORE_RUNTIME_CONFIGURATION_INVALID",
    message,
    cause === undefined ? {} : { cause },
  );
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
