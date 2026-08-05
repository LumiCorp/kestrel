import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_ANTHROPIC_VERSION } from "../../../models/anthropic/AnthropicEnv.js";
import { DEFAULT_OPENAI_BASE_URL } from "../../../models/openai/OpenAiEnv.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../../../models/openrouter/OpenRouterEnv.js";
import type {
  DesktopCredentialedModelProvider,
  DesktopModelProvider,
  DesktopSettings,
} from "./contracts.js";

const VERIFICATION_TIMEOUT_MS = 5000;

export class DesktopModelProviderVerificationError extends Error {
  readonly code = "DESKTOP_MODEL_PROVIDER_VERIFICATION_FAILED";
  readonly kind:
    | "invalid_credential"
    | "provider_rejected"
    | "timeout"
    | "unreachable"
    | "model_unavailable";

  constructor(
    provider: DesktopModelProvider,
    detail: string,
    kind: DesktopModelProviderVerificationError["kind"] = "provider_rejected",
  ) {
    super(`${providerLabel(provider)} credential verification failed. ${detail}`);
    this.name = "DesktopModelProviderVerificationError";
    this.kind = kind;
  }
}

export interface DesktopModelProviderVerificationResult {
  models: string[];
}

export async function verifyDesktopModelProviderCredential(input: {
  provider: DesktopCredentialedModelProvider;
  apiKey: string;
  settings: DesktopSettings;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<DesktopModelProviderVerificationResult> {
  const requests = buildVerificationRequests(
    input.provider,
    input.apiKey,
    input.settings,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
  try {
    if (requests.authentication !== undefined) {
      const authenticationResponse = await (input.fetchImpl ?? fetch)(
        requests.authentication.url,
        {
          method: "GET",
          headers: requests.authentication.headers,
          signal: controller.signal,
        },
      );
      assertSuccessfulProviderResponse(input.provider, authenticationResponse);
      // Authentication payloads can contain account or key metadata. Kestrel
      // intentionally does not parse, retain, or expose them.
      await authenticationResponse.body?.cancel();
    }
    const response = await (input.fetchImpl ?? fetch)(requests.catalog.url, {
      method: "GET",
      headers: requests.catalog.headers,
      signal: controller.signal,
    });
    assertSuccessfulProviderResponse(input.provider, response);
    return { models: readHostedModelIds(await response.json()) };
  } catch (error) {
    if (error instanceof DesktopModelProviderVerificationError) throw error;
    throw new DesktopModelProviderVerificationError(
      input.provider,
      error instanceof Error && error.name === "AbortError"
        ? "The provider did not respond before the verification timeout."
        : "The provider endpoint could not be reached.",
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function assertSuccessfulProviderResponse(
  provider: DesktopCredentialedModelProvider,
  response: Response,
): void {
  if (response.ok) return;
  throw new DesktopModelProviderVerificationError(
    provider,
    `The provider returned HTTP ${response.status}. Check the key and endpoint, then try again.`,
    response.status === 401 || response.status === 403
      ? "invalid_credential"
      : "provider_rejected",
  );
}

export async function verifyDesktopModelCapability(input: {
  provider: DesktopModelProvider;
  settings: DesktopSettings;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<DesktopModelProviderVerificationResult> {
  if (
    input.provider === "openrouter"
    || input.provider === "openai"
    || input.provider === "anthropic"
  ) {
    if (input.apiKey === undefined) {
      throw new DesktopModelProviderVerificationError(input.provider, "Re-enter the API key to verify this configuration.");
    }
    const result = await verifyDesktopModelProviderCredential({
      provider: input.provider,
      apiKey: input.apiKey,
      settings: input.settings,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const model = providerModel(input.provider, input.settings);
    if (model === undefined || result.models.includes(model) === false) {
      throw new DesktopModelProviderVerificationError(
        input.provider,
        model === undefined
          ? "Select a model before applying this provider."
          : `The configured model '${model}' is not available from the provider.`,
        "model_unavailable",
      );
    }
    return result;
  }
  const baseUrl = input.provider === "ollama"
    ? input.settings.ollamaBaseUrl ?? "http://127.0.0.1:11434"
    : input.settings.lmstudioBaseUrl ?? "http://127.0.0.1:1234";
  const model = input.provider === "ollama"
    ? input.settings.ollamaModel
    : input.settings.lmstudioModel;
  const endpoint = appendProviderPath(
    baseUrl,
    input.provider === "ollama" ? "/api/tags" : "/v1/models",
    input.provider === "ollama" ? "/api" : "/v1",
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
  try {
    const response = await (input.fetchImpl ?? fetch)(endpoint, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.ok === false) {
      throw new DesktopModelProviderVerificationError(input.provider, `The local endpoint returned HTTP ${response.status}.`, "provider_rejected");
    }
    const models = readLocalModelIds(input.provider, await response.json());
    if (model === undefined || models.includes(model) === false) {
      throw new DesktopModelProviderVerificationError(
        input.provider,
        model === undefined
          ? "Select a model before applying this provider."
          : `The configured model '${model}' is not available from the local endpoint.`,
        "model_unavailable",
      );
    }
    return { models };
  } catch (error) {
    if (error instanceof DesktopModelProviderVerificationError) throw error;
    throw new DesktopModelProviderVerificationError(
      input.provider,
      error instanceof Error && error.name === "AbortError"
        ? "The local endpoint did not respond before the verification timeout."
        : "The local endpoint could not be reached.",
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function providerModel(
  provider: DesktopCredentialedModelProvider,
  settings: DesktopSettings,
): string | undefined {
  if (provider === "openrouter") return settings.openrouterModel;
  if (provider === "openai") return settings.openaiModel;
  return settings.anthropicModel;
}

function readHostedModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const data = (value as { data?: unknown }).data;
  if (Array.isArray(data) === false) return [];
  return data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.trim().length > 0 ? [id.trim()] : [];
  });
}

function buildVerificationRequests(
  provider: DesktopCredentialedModelProvider,
  apiKey: string,
  settings: DesktopSettings,
): {
  authentication?: { url: string; headers: Record<string, string> } | undefined;
  catalog: { url: string; headers: Record<string, string> };
} {
  if (provider === "openrouter") {
    const headers = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
    const baseUrl = settings.openrouterBaseUrl ?? DEFAULT_OPENROUTER_BASE_URL;
    return {
      authentication: {
        url: appendProviderPath(baseUrl, "/api/v1/key", "/api/v1"),
        headers,
      },
      catalog: {
        url: appendProviderPath(baseUrl, "/api/v1/models", "/api/v1"),
        headers,
      },
    };
  }
  if (provider === "openai") {
    return {
      catalog: {
        url: appendProviderPath(settings.openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL, "/v1/models", "/v1"),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(settings.openaiOrgId !== undefined ? { "OpenAI-Organization": settings.openaiOrgId } : {}),
          ...(settings.openaiProjectId !== undefined ? { "OpenAI-Project": settings.openaiProjectId } : {}),
        },
      },
    };
  }
  return {
    catalog: {
      url: appendProviderPath(settings.anthropicBaseUrl ?? DEFAULT_ANTHROPIC_BASE_URL, "/v1/models", "/v1"),
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
        "anthropic-version": settings.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      },
    },
  };
}

function appendProviderPath(baseUrl: string, path: string, versionPath: string): string {
  const url = new URL(baseUrl);
  const normalized = url.pathname.replace(/\/+$/u, "");
  url.pathname = normalized.endsWith(versionPath)
    ? `${normalized}${path.slice(versionPath.length)}`
    : `${normalized}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function providerLabel(provider: DesktopModelProvider): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return provider === "ollama" ? "Ollama" : "LM Studio";
}

function readLocalModelIds(provider: "ollama" | "lmstudio", value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const entries = provider === "ollama"
    ? (value as { models?: unknown }).models
    : (value as { data?: unknown }).data;
  if (Array.isArray(entries) === false) return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const candidate = provider === "ollama" ? record.model ?? record.name : record.id;
    return typeof candidate === "string" && candidate.trim().length > 0 ? [candidate.trim()] : [];
  });
}
