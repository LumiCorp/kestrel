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

  constructor(provider: DesktopModelProvider, detail: string) {
    super(`${providerLabel(provider)} credential verification failed. ${detail}`);
    this.name = "DesktopModelProviderVerificationError";
  }
}

export async function verifyDesktopModelProviderCredential(input: {
  provider: DesktopCredentialedModelProvider;
  apiKey: string;
  settings: DesktopSettings;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  const request = buildVerificationRequest(input.provider, input.apiKey, input.settings);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? VERIFICATION_TIMEOUT_MS);
  try {
    const response = await (input.fetchImpl ?? fetch)(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    if (response.ok === false) {
      throw new DesktopModelProviderVerificationError(
        input.provider,
        `The provider returned HTTP ${response.status}. Check the key and endpoint, then try again.`,
      );
    }
  } catch (error) {
    if (error instanceof DesktopModelProviderVerificationError) throw error;
    throw new DesktopModelProviderVerificationError(
      input.provider,
      error instanceof Error && error.name === "AbortError"
        ? "The provider did not respond before the verification timeout."
        : "The provider endpoint could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyDesktopModelCapability(input: {
  provider: DesktopModelProvider;
  settings: DesktopSettings;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  if (
    input.provider === "openrouter"
    || input.provider === "openai"
    || input.provider === "anthropic"
  ) {
    if (input.apiKey === undefined) {
      throw new DesktopModelProviderVerificationError(input.provider, "Re-enter the API key to verify this configuration.");
    }
    return await verifyDesktopModelProviderCredential({
      provider: input.provider,
      apiKey: input.apiKey,
      settings: input.settings,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
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
      throw new DesktopModelProviderVerificationError(input.provider, `The local endpoint returned HTTP ${response.status}.`);
    }
    const models = readLocalModelIds(input.provider, await response.json());
    if (model === undefined || models.includes(model) === false) {
      throw new DesktopModelProviderVerificationError(
        input.provider,
        model === undefined
          ? "Select a model before applying this provider."
          : `The configured model '${model}' is not available from the local endpoint.`,
      );
    }
  } catch (error) {
    if (error instanceof DesktopModelProviderVerificationError) throw error;
    throw new DesktopModelProviderVerificationError(
      input.provider,
      error instanceof Error && error.name === "AbortError"
        ? "The local endpoint did not respond before the verification timeout."
        : "The local endpoint could not be reached.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildVerificationRequest(
  provider: DesktopCredentialedModelProvider,
  apiKey: string,
  settings: DesktopSettings,
): { url: string; headers: Record<string, string> } {
  if (provider === "openrouter") {
    return {
      url: appendProviderPath(settings.openrouterBaseUrl ?? DEFAULT_OPENROUTER_BASE_URL, "/api/v1/models", "/api/v1"),
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    };
  }
  if (provider === "openai") {
    return {
      url: appendProviderPath(settings.openaiBaseUrl ?? DEFAULT_OPENAI_BASE_URL, "/v1/models", "/v1"),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(settings.openaiOrgId !== undefined ? { "OpenAI-Organization": settings.openaiOrgId } : {}),
        ...(settings.openaiProjectId !== undefined ? { "OpenAI-Project": settings.openaiProjectId } : {}),
      },
    };
  }
  return {
    url: appendProviderPath(settings.anthropicBaseUrl ?? DEFAULT_ANTHROPIC_BASE_URL, "/v1/models", "/v1"),
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
      "anthropic-version": settings.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
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
