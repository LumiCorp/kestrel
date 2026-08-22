import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV3 } from "@ai-sdk/provider";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { environmentLifecycleLockKey } from "@/lib/environments/lifecycle-lock";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getDefaultAIModel } from "./config";
import {
  decryptGatewayCredential,
  encryptGatewayCredential,
} from "./gateway-credential-crypto";
import {
  GatewayModelSyncHttpError,
  initialGatewayCredentialStatus,
  isGatewayModelSyncAuthenticationFailure,
} from "./gateway-credential-health";
import {
  GatewayModelEconomicsProfileRequiredError,
  GatewayModelInUseError,
  GatewayModelProviderResolutionError,
} from "./gateway-lifecycle-error";
import {
  normalizeGatewayStoredCredential,
} from "./gateway-credential-source";
import {
  buildRunPodServerlessBaseUrl,
  GATEWAY_MODALITIES,
  GATEWAY_PROVIDERS,
  getGatewayLanguageProtocol,
  getProviderSupportedModalities as getSharedProviderSupportedModalities,
  isGatewayModelDefault,
  isKestrelRuntimeLanguageProvider,
  normalizeGatewayModelMetadata,
  normalizeOpenAICompatibleBaseUrl,
  selectGatewayModelSelection,
  selectPreferredGatewayModelId,
} from "./gateway-utils";
import type { ChatModel } from "./models";
import {
  getMatchingRunPodValidationEvidence,
  mergeRunPodValidationEvidence,
  preserveTrustedRunPodValidation,
  type RunPodFetch,
  validateRunPodToolRoundTrip,
} from "./runpod-connection-test";
import {
  getGatewayModelEconomicsProvider,
  readGatewayModelEconomicsProfile,
  validateOpenRouterModelDetails,
  withGatewayModelEconomicsProfile,
} from "./model-economics-profile";

export { GATEWAY_MODALITIES, GATEWAY_PROVIDERS };
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];
export type GatewayModality = (typeof GATEWAY_MODALITIES)[number];

export type GatewayRecord = typeof schema.aiGateways.$inferSelect;
export type GatewayModelRecord = typeof schema.aiGatewayModels.$inferSelect;

export type GatewayCatalogModel = ChatModel & {
  gatewayModelId: string;
  alias: string | null;
  rawModelId: string;
  modality: GatewayModality;
  gatewayId: string | null;
  gatewayProvider: GatewayProvider;
  isDefault: boolean;
  metadata: Record<string, unknown> | null;
  environmentId: string | null;
  scope: "platform" | "organization" | "environment";
};

export type GatewayModelEconomicsAdmission = {
  status: "ready" | "unapproved" | "needs_profile";
  provider: string;
  model: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  source?: string;
  canonicalSlug?: string;
};

const PROVIDER_DISPLAY_NAMES: Record<GatewayProvider, string> = {
  anthropic: "Anthropic",
  lumi: "Lumi",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  runpod: "RunPod",
  replicate: "Replicate",
};

type SyncedGatewayModel = {
  rawModelId: string;
  modality: GatewayModality;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
};

function titleCase(value: string) {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getProviderDisplayName(provider: GatewayProvider) {
  return PROVIDER_DISPLAY_NAMES[provider];
}

export function getProviderSupportedModalities(provider: GatewayProvider) {
  return getSharedProviderSupportedModalities(provider);
}

function getDefaultBaseUrl(provider: GatewayProvider) {
  switch (provider) {
    case "lumi":
      return "https://api.kestrelagents.dev";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "runpod":
      return null;
    default:
      return null;
  }
}

export function getGatewayApiKey(
  gateway: Pick<GatewayRecord, "apiKey" | "apiKeyEnvVar" | "id" | "provider">
) {
  if (gateway.apiKey?.trim()) {
    return decryptGatewayCredential({
      gatewayId: gateway.id,
      encrypted: gateway.apiKey.trim(),
    });
  }

  return null;
}

function getOpenAICompatibleBaseUrl(gateway: GatewayRecord) {
  return normalizeOpenAICompatibleBaseUrl(
    gateway.baseUrl?.trim() || getDefaultBaseUrl(gateway.provider)
  );
}

function getDefaultGatewayMetadata(provider: GatewayProvider) {
  switch (provider) {
    case "lumi":
      return {
        compatibility: {
          openaiCompatible: true,
          anthropicCompatible: true,
          azureOpenAICompatible: true,
          vertexCompatible: true,
        },
      } satisfies Record<string, unknown>;
    default:
      return null;
  }
}

function normalizeModelLabel(model: GatewayModelRecord) {
  return (
    model.alias?.trim() ||
    titleCase(model.rawModelId.split("/").pop() || model.rawModelId)
  );
}

function getGatewayModelEconomicsAdmission(
  gatewayProvider: GatewayProvider,
  model: GatewayModelRecord,
): GatewayModelEconomicsAdmission | undefined {
  if (model.modality !== "language") return undefined;
  const provider = getGatewayModelEconomicsProvider({
    gatewayProvider,
    modality: model.modality,
    metadata: model.metadata,
  });
  if (!provider) return undefined;
  const base = { provider, model: model.rawModelId };
  if (!model.approved) return { ...base, status: "unapproved" };
  const profile = readGatewayModelEconomicsProfile(model.metadata, base);
  if (!profile) return { ...base, status: "needs_profile" };
  const metadata =
    model.metadata && typeof model.metadata === "object" && !Array.isArray(model.metadata)
      ? (model.metadata as Record<string, unknown>)
      : {};
  return {
    ...base,
    status: "ready",
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
    source:
      typeof metadata.kestrelEconomicsProfileSource === "string"
        ? metadata.kestrelEconomicsProfileSource
        : "provider_catalog",
    ...(typeof metadata.kestrelOpenRouterCanonicalSlug === "string"
      ? { canonicalSlug: metadata.kestrelOpenRouterCanonicalSlug }
      : {}),
  };
}

function getComparableModelName(rawModelId: string) {
  const trimmed = rawModelId.trim().toLowerCase();
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) || trimmed;
}

function getOpenAICompatibleAuthHeaders(apiKey: string | null) {
  return apiKey
    ? ({ Authorization: `Bearer ${apiKey}` } satisfies Record<string, string>)
    : undefined;
}

async function fetchProviderJson<T>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(url, init);
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new GatewayModelSyncHttpError(response.status);
  }

  return json as T;
}

async function fetchOpenRouterModelDetails(
  gateway: GatewayRecord,
  rawModelId: string,
): Promise<Record<string, unknown>> {
  const parts = rawModelId.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new GatewayModelProviderResolutionError({
      message: `OpenRouter model ID '${rawModelId}' must use the exact author/slug form.`,
    });
  }
  const apiKey = getGatewayApiKey(gateway);
  const baseUrl = getOpenAICompatibleBaseUrl(gateway);
  if (!apiKey || !baseUrl) {
    throw new GatewayModelProviderResolutionError({
      message: "OpenRouter gateway credentials are required to resolve a model.",
    });
  }
  let response: Response;
  try {
    const signal = AbortSignal.timeout(15_000);
    response = await fetch(
      `${baseUrl}/model/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
      { headers: getOpenAICompatibleAuthHeaders(apiKey), signal },
    );
  } catch (error) {
    throw new GatewayModelProviderResolutionError({
      message:
        error instanceof DOMException && error.name === "TimeoutError"
          ? `OpenRouter model resolution timed out for ${rawModelId}. Try again.`
          : `OpenRouter model resolution failed for ${rawModelId}. Try again.`,
      status: 503,
      retryable: true,
    });
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const isAuthFailure = response.status === 401 || response.status === 403;
    throw new GatewayModelProviderResolutionError({
      message:
        response.status === 404
          ? `OpenRouter model '${rawModelId}' was not found.`
          : isAuthFailure
            ? `OpenRouter rejected the gateway credential while resolving ${rawModelId}. Update the credential and try again.`
          : `OpenRouter model resolution failed for ${rawModelId}.`,
      status: response.status === 404 ? 422 : isAuthFailure ? response.status : 503,
      retryable: response.status >= 500,
    });
  }
  return validateOpenRouterModelDetails({
    requestedModelId: rawModelId,
    response: json,
  });
}

function inferOpenAICompatibleModality(rawModelId: string): GatewayModality {
  const value = rawModelId.trim().toLowerCase();

  if (value.includes("embedding")) {
    return "embedding";
  }

  if (value.includes("sora") || value.includes("video")) {
    return "video";
  }

  if (
    value.includes("gpt-image") ||
    value.includes("image-preview") ||
    value.includes("-image")
  ) {
    return "image";
  }

  if (
    value.includes("tts") ||
    value.includes("audio") ||
    value.includes("voice")
  ) {
    return "speech";
  }

  return "language";
}

function inferOpenRouterModality(model: {
  id: string;
  architecture?: {
    modality?: string | null;
    output_modalities?: string[] | null;
  } | null;
}): GatewayModality {
  const outputModalities =
    model.architecture?.output_modalities?.map((value) =>
      value.toLowerCase()
    ) ?? [];

  if (outputModalities.includes("video")) {
    return "video";
  }

  if (outputModalities.includes("image")) {
    return "image";
  }

  if (outputModalities.includes("audio")) {
    return "speech";
  }

  if (
    (model.architecture?.modality || "").toLowerCase().includes("embedding")
  ) {
    return "embedding";
  }

  return inferOpenAICompatibleModality(model.id);
}

function inferOllamaModality(rawModelId: string): GatewayModality {
  return rawModelId.toLowerCase().includes("embed") ? "embedding" : "language";
}

function inferReplicateModality(rawModelId: string): GatewayModality {
  const value = rawModelId.toLowerCase();

  if (
    value.includes("video") ||
    value.includes("wan-") ||
    value.includes("kling") ||
    value.includes("minimax") ||
    value.includes("ltx")
  ) {
    return "video";
  }

  return "image";
}

async function fetchOpenAICompatibleModels(
  gateway: GatewayRecord
): Promise<SyncedGatewayModel[]> {
  const apiKey = getGatewayApiKey(gateway);
  if (!apiKey && gateway.provider !== "ollama") {
    throw new Error(
      `${getProviderDisplayName(gateway.provider)} API key is required.`
    );
  }

  const baseUrl = getOpenAICompatibleBaseUrl(gateway);
  if (!baseUrl) {
    throw new Error(
      `${getProviderDisplayName(gateway.provider)} base URL is missing.`
    );
  }

  const json = await fetchProviderJson<{
    data?: Array<Record<string, unknown>>;
  }>(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: getOpenAICompatibleAuthHeaders(apiKey),
  });

  return (json.data ?? []).flatMap((model) => {
    const rawModelId = typeof model.id === "string" ? model.id.trim() : "";
    if (!rawModelId) {
      return [];
    }

    const modality =
      gateway.provider === "openrouter"
        ? inferOpenRouterModality(model as never)
        : inferOpenAICompatibleModality(rawModelId);

    return [
      {
        rawModelId,
        modality,
        description:
          (typeof model.name === "string" && model.name) ||
          (typeof model.description === "string" && model.description) ||
          null,
        metadata: model,
      } satisfies SyncedGatewayModel,
    ];
  });
}

async function fetchAnthropicModels(
  gateway: GatewayRecord
): Promise<SyncedGatewayModel[]> {
  const apiKey = getGatewayApiKey(gateway);
  if (!apiKey) {
    throw new Error("Anthropic API key is required.");
  }

  const baseUrl = gateway.baseUrl?.trim() || "https://api.anthropic.com/v1";
  const json = await fetchProviderJson<{
    data?: Array<Record<string, unknown>>;
  }>(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  return (json.data ?? []).flatMap((model) => {
    const rawModelId = typeof model.id === "string" ? model.id.trim() : "";
    if (!rawModelId) {
      return [];
    }

    return [
      {
        rawModelId,
        modality: "language",
        description:
          (typeof model.display_name === "string" && model.display_name) ||
          (typeof model.description === "string" && model.description) ||
          null,
        metadata: model,
      } satisfies SyncedGatewayModel,
    ];
  });
}

async function fetchOllamaModels(
  gateway: GatewayRecord
): Promise<SyncedGatewayModel[]> {
  const baseUrl = gateway.baseUrl?.trim() || getDefaultBaseUrl("ollama")!;
  const url = new URL(baseUrl);
  url.pathname = "/api/tags";
  url.search = "";

  const json = await fetchProviderJson<{
    models?: Array<Record<string, unknown>>;
  }>(url.toString());

  return (json.models ?? []).flatMap((model) => {
    const rawModelId =
      (typeof model.model === "string" && model.model.trim()) ||
      (typeof model.name === "string" && model.name.trim()) ||
      "";
    if (!rawModelId) {
      return [];
    }

    return [
      {
        rawModelId,
        modality: inferOllamaModality(rawModelId),
        description: (typeof model.name === "string" && model.name) || null,
        metadata: model,
      } satisfies SyncedGatewayModel,
    ];
  });
}

async function fetchReplicateModels(
  gateway: GatewayRecord
): Promise<SyncedGatewayModel[]> {
  const apiKey = getGatewayApiKey(gateway);
  if (!apiKey) {
    throw new Error("Replicate API token is required.");
  }

  const baseUrl = gateway.baseUrl?.trim() || "https://api.replicate.com";
  const json = await fetchProviderJson<{
    results?: Array<Record<string, unknown>>;
  }>(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return (json.results ?? []).flatMap((model) => {
    const owner = typeof model.owner === "string" ? model.owner.trim() : "";
    const name = typeof model.name === "string" ? model.name.trim() : "";
    const rawModelId = owner && name ? `${owner}/${name}` : "";

    if (!rawModelId) {
      return [];
    }

    return [
      {
        rawModelId,
        modality: inferReplicateModality(rawModelId),
        description:
          (typeof model.description === "string" && model.description) || null,
        metadata: model,
      } satisfies SyncedGatewayModel,
    ];
  });
}

async function fetchGatewayModels(gateway: GatewayRecord) {
  switch (gateway.provider) {
    case "lumi":
    case "openai":
    case "openrouter":
    case "runpod":
      return fetchOpenAICompatibleModels(gateway);
    case "anthropic":
      return fetchAnthropicModels(gateway);
    case "ollama":
      return fetchOllamaModels(gateway);
    case "replicate":
      return fetchReplicateModels(gateway);
  }
}

function sanitizeGateway(gateway: GatewayRecord) {
  return {
    ...gateway,
    apiKey: null,
    apiKeyEnvVar: null,
    hasApiKey: Boolean(gateway.apiKey?.trim()),
  };
}

async function markGatewayCredentialInvalidIfCurrent(input: {
  organizationId: string;
  gatewayId: string;
  credentialRevision: number;
}) {
  const [invalidated] = await knowledgeDb
    .update(schema.aiGateways)
    .set({
      credentialStatus: "invalid",
      credentialValidatedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.aiGateways.id, input.gatewayId),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.credentialRevision, input.credentialRevision)
      )
    )
    .returning({ id: schema.aiGateways.id });
  if (invalidated) {
    console.warn("AI gateway credential invalidated.", {
      organizationId: input.organizationId,
      gatewayId: invalidated.id,
      credentialRevision: input.credentialRevision,
      reason: "provider_auth_rejection",
    });
  }
}

async function markGatewayCredentialReadyIfCurrent(input: {
  organizationId: string;
  gatewayId: string;
  credentialRevision: number;
  supportedModalities?: GatewayModality[];
}) {
  const now = new Date();
  const [gateway] = await knowledgeDb
    .update(schema.aiGateways)
    .set({
      credentialStatus: "ready",
      credentialValidatedAt: now,
      ...(input.supportedModalities
        ? { supportedModalities: input.supportedModalities }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.aiGateways.id, input.gatewayId),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGateways.credentialRevision, input.credentialRevision)
      )
    )
    .returning();
  return gateway ?? null;
}

export async function listAIGatewaysWithModels(organizationId: string) {
  const [gateways, models] = await Promise.all([
    knowledgeDb
      .select()
      .from(schema.aiGateways)
      .where(eq(schema.aiGateways.organizationId, organizationId))
      .orderBy(
        asc(schema.aiGateways.provider),
        asc(schema.aiGateways.displayName)
      ),
    knowledgeDb
      .select()
      .from(schema.aiGatewayModels)
      .where(eq(schema.aiGatewayModels.organizationId, organizationId))
      .orderBy(
        asc(schema.aiGatewayModels.modality),
        asc(schema.aiGatewayModels.alias),
        asc(schema.aiGatewayModels.rawModelId)
      ),
  ]);

  const modelsByGateway = models.reduce<Record<string, GatewayModelRecord[]>>(
    (accumulator, model) => {
      if (!accumulator[model.gatewayId]) {
        accumulator[model.gatewayId] = [];
      }
      accumulator[model.gatewayId].push(model);
      return accumulator;
    },
    {}
  );

  return gateways.map((gateway) => ({
    gateway: sanitizeGateway(gateway),
    models: (modelsByGateway[gateway.id] ?? []).map((model) => ({
      ...model,
      economicsAdmission: getGatewayModelEconomicsAdmission(
        gateway.provider as GatewayProvider,
        model,
      ),
    })),
  }));
}

export async function listApprovedModels(
  modality: GatewayModality,
  organizationId: string,
  environmentId?: string
) {
  const [rows, environmentDefault] = await Promise.all([
    knowledgeDb
      .select({
        gateway: schema.aiGateways,
        model: schema.aiGatewayModels,
      })
      .from(schema.aiGatewayModels)
      .innerJoin(
        schema.aiGateways,
        eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId)
      )
      .where(
        and(
          eq(schema.aiGatewayModels.approved, true),
          eq(schema.aiGatewayModels.modality, modality),
          eq(schema.aiGateways.enabled, true),
          eq(schema.aiGateways.organizationId, organizationId),
          environmentId
            ? or(
                isNull(schema.aiGateways.environmentId),
                eq(schema.aiGateways.environmentId, environmentId)
              )
            : isNull(schema.aiGateways.environmentId)
        )
      )
      .orderBy(
        desc(schema.aiGatewayModels.isDefault),
        asc(schema.aiGateways.displayName),
        asc(schema.aiGatewayModels.alias),
        asc(schema.aiGatewayModels.rawModelId)
      ),
    environmentId
      ? knowledgeDb.query.environmentAiModelDefaults.findFirst({
          where: and(
            eq(schema.environmentAiModelDefaults.environmentId, environmentId),
            eq(schema.environmentAiModelDefaults.organizationId, organizationId),
            eq(schema.environmentAiModelDefaults.modality, modality)
          ),
          columns: { modelId: true },
        })
      : Promise.resolve(undefined),
  ]);

  return rows.map(({ gateway, model }) => ({
    gatewayModelId: model.id,
    id: model.alias?.trim() || `${gateway.provider}/${model.rawModelId}`,
    name: normalizeModelLabel(model),
    provider: gateway.provider,
    description:
      model.description || `${gateway.displayName} ${modality} model`,
    alias: model.alias,
    rawModelId: model.rawModelId,
    modality: model.modality as GatewayModality,
    gatewayId: gateway.id,
    gatewayProvider: gateway.provider as GatewayProvider,
    isDefault: isGatewayModelDefault({
      environmentDefaultModelId: environmentDefault?.modelId,
      modelId: model.id,
      modelIsDefault: model.isDefault,
    }),
    environmentId: gateway.environmentId,
    scope: gateway.environmentId
      ? "environment"
      : gateway.organizationId
        ? "organization"
        : "platform",
    metadata: normalizeGatewayModelMetadata({
      gatewayProvider: gateway.provider as GatewayProvider,
      modality: model.modality as GatewayModality,
      metadata: model.metadata,
    }),
  })) as GatewayCatalogModel[];
}

export async function getApprovedLanguageModels(
  organizationId: string,
  environmentId?: string
) {
  return listApprovedModels("language", organizationId, environmentId);
}

export async function getApprovedKestrelRuntimeLanguageModels(
  organizationId: string,
  environmentId?: string
) {
  const models = await getApprovedLanguageModels(organizationId, environmentId);
  return models.filter((model) =>
    isKestrelRuntimeLanguageProvider(model.gatewayProvider)
  );
}

export async function resolvePreferredLanguageModelId(
  selectedModelId: string | null | undefined,
  fallbackModelId: string | null | undefined,
  organizationId: string,
  environmentId?: string
) {
  const languageModels = await getApprovedKestrelRuntimeLanguageModels(
    organizationId,
    environmentId
  );
  return (
    selectPreferredGatewayModelId(
      languageModels,
      selectedModelId,
      fallbackModelId
    ) || getDefaultAIModel()
  );
}

export async function getSpeechModelForLanguageSelection(
  languageModelId: string | null | undefined,
  organizationId: string,
  environmentId?: string
) {
  const languageModels = await getApprovedLanguageModels(
    organizationId,
    environmentId
  );
  const speechModels = await listApprovedModels(
    "speech",
    organizationId,
    environmentId
  );

  if (speechModels.length === 0) {
    return null;
  }

  const selectedLanguageModel = languageModelId
    ? languageModels.find(
        (model) =>
          model.id === languageModelId ||
          model.alias === languageModelId ||
          `${model.gatewayProvider}/${model.rawModelId}` === languageModelId
      )
    : null;
  const provider = selectedLanguageModel?.gatewayProvider;

  return (
    speechModels.find((model) => model.gatewayProvider === provider) ||
    speechModels.find((model) => model.isDefault) ||
    speechModels[0]
  );
}

export async function getGenerationModelsByKind(
  kind: "image" | "video",
  organizationId: string
) {
  return listApprovedModels(kind, organizationId);
}

export async function resolveGatewayModelSelection(input: {
  selection?: string | null;
  modality: GatewayModality;
  organizationId: string;
  environmentId?: string;
}) {
  const models = await listApprovedModels(
    input.modality,
    input.organizationId,
    input.environmentId
  );

  return selectGatewayModelSelection(models, input.selection);
}

export async function createGateway(input: {
  organizationId: string;
  provider: GatewayProvider;
  endpointId?: string;
  displayName?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  supportedModalities?: GatewayModality[];
  metadata?: Record<string, unknown> | null;
  environmentId?: string | null;
  deploymentId?: string | null;
  providerConnectionId?: string | null;
}) {
  const gatewayId = crypto.randomUUID();
  const environmentId = input.environmentId;
  const apiKey = normalizeGatewayStoredCredential(input.apiKey);
  const baseUrl =
    input.provider === "runpod"
      ? buildRunPodServerlessBaseUrl(input.endpointId)
      : input.baseUrl || getDefaultBaseUrl(input.provider);
  const values = {
    id: gatewayId,
    organizationId: input.organizationId,
    environmentId: input.environmentId ?? null,
    deploymentId: input.deploymentId ?? null,
    providerConnectionId: input.providerConnectionId ?? null,
    provider: input.provider,
    displayName: input.displayName || getProviderDisplayName(input.provider),
    baseUrl,
    apiKeyEnvVar: null,
    apiKey: apiKey
      ? encryptGatewayCredential({
          gatewayId,
          plaintext: apiKey,
        })
      : null,
    credentialStatus: initialGatewayCredentialStatus(input.provider),
    credentialValidatedAt: null,
    credentialRevision: 1,
    enabled: input.enabled ?? true,
    supportedModalities:
      input.supportedModalities || getProviderSupportedModalities(input.provider),
    metadata: input.metadata ?? getDefaultGatewayMetadata(input.provider),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as const;
  const gateway = environmentId
    ? await knowledgeDb.transaction(async (transaction) => {
        await transaction.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${environmentLifecycleLockKey(environmentId)}, 0))`
        );
        const environment = await transaction.query.environments.findFirst({
          where: (table, { and, eq, isNull, notInArray }) =>
            and(
              eq(table.id, environmentId),
              eq(table.organizationId, input.organizationId),
              isNull(table.archivedAt),
              notInArray(table.status, ["deleting", "deleted"])
            ),
          columns: { id: true },
        });
        if (!environment) {
          throw new Error("Environment is not available for gateway configuration.");
        }
        const [created] = await transaction
          .insert(schema.aiGateways)
          .values(values)
          .returning();
        return created;
      })
    : (
        await knowledgeDb
          .insert(schema.aiGateways)
          .values(values)
          .returning()
      )[0];

  return sanitizeGateway(gateway);
}

export async function updateGateway(
  organizationId: string,
  gatewayId: string,
  input: Partial<{
    displayName: string;
    baseUrl: string | null;
    apiKey: string | null;
    enabled: boolean;
    supportedModalities: GatewayModality[];
    metadata: Record<string, unknown> | null;
  }>
) {
  const apiKey = normalizeGatewayStoredCredential(input.apiKey);
  const [gateway] = await knowledgeDb
    .update(schema.aiGateways)
    .set({
      ...(input.displayName !== undefined
        ? { displayName: input.displayName }
        : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      apiKeyEnvVar: null,
      ...(apiKey !== undefined
          ? {
              apiKey: apiKey
                ? encryptGatewayCredential({
                    gatewayId,
                    plaintext: apiKey,
                  })
                : null,
              credentialStatus:
                sql`CASE WHEN ${schema.aiGateways.provider} = 'ollama' THEN 'not_required' ELSE 'unverified' END`,
              credentialValidatedAt: null,
              credentialRevision:
                sql`${schema.aiGateways.credentialRevision} + 1`,
            }
          : input.baseUrl !== undefined
            ? {
                credentialRevision:
                  sql`${schema.aiGateways.credentialRevision} + 1`,
              }
            : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.supportedModalities !== undefined
        ? { supportedModalities: input.supportedModalities }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.aiGateways.id, gatewayId),
        eq(schema.aiGateways.organizationId, organizationId)
      )
    )
    .returning();

  return gateway ? sanitizeGateway(gateway) : null;
}

export async function syncGatewayModels(
  organizationId: string,
  gatewayId: string
) {
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, gatewayId),
        operators.eq(table.organizationId, organizationId)
      ),
  });

  if (!gateway) {
    throw new Error("Gateway not found");
  }

  let syncedModels: SyncedGatewayModel[];
  let existingModels: GatewayModelRecord[];
  try {
    [syncedModels, existingModels] = await Promise.all([
      fetchGatewayModels(gateway),
      listModelsForGateway(organizationId, gatewayId),
    ]);
  } catch (error) {
    if (isGatewayModelSyncAuthenticationFailure(error)) {
      await markGatewayCredentialInvalidIfCurrent({
        organizationId,
        gatewayId,
        credentialRevision: gateway.credentialRevision,
      });
    }
    throw error;
  }

  const existingByRawModelId = new Map(
    existingModels.map((model) => [model.rawModelId, model] as const)
  );

  const uniqueSyncedModels = new Map<string, SyncedGatewayModel>();
  for (const model of syncedModels) {
    uniqueSyncedModels.set(model.rawModelId, model);
  }

  const savedModels: GatewayModelRecord[] = [];
  for (const syncedModel of uniqueSyncedModels.values()) {
    const existing = existingByRawModelId.get(syncedModel.rawModelId);
    const savedModel = await saveGatewayModel({
      id: existing?.id,
      organizationId,
      gatewayId,
      rawModelId: syncedModel.rawModelId,
      alias: existing?.alias ?? null,
      modality: existing?.modality ?? syncedModel.modality,
      approved: existing?.approved ?? false,
      isDefault: existing?.isDefault ?? false,
      description: syncedModel.description ?? existing?.description ?? null,
      metadata: normalizeGatewayModelMetadata({
        gatewayProvider: gateway.provider,
        modality: (existing?.modality ??
          syncedModel.modality) as GatewayModality,
        metadata:
          syncedModel.metadata ??
          (existing?.metadata as Record<string, unknown> | null) ??
          null,
      }),
      gatewayProvider: gateway.provider,
      gatewayBaseUrl: gateway.baseUrl,
      requireEconomicsProfile: false,
    });
    savedModels.push(savedModel);
  }

  const discoveredModalities = Array.from(
    new Set(savedModels.map((model) => model.modality as GatewayModality))
  );

  const supportedModalities =
    discoveredModalities.length > 0
      ? discoveredModalities
      : getProviderSupportedModalities(gateway.provider);
  const updatedGateway =
    gateway.provider === "ollama"
      ? (
          await knowledgeDb
            .update(schema.aiGateways)
            .set({
              credentialStatus: "not_required",
              credentialValidatedAt: null,
              supportedModalities,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.aiGateways.id, gatewayId),
                eq(schema.aiGateways.organizationId, organizationId),
                eq(
                  schema.aiGateways.credentialRevision,
                  gateway.credentialRevision
                )
              )
            )
            .returning()
        )[0]
      : await markGatewayCredentialReadyIfCurrent({
          organizationId,
          gatewayId,
          credentialRevision: gateway.credentialRevision,
          supportedModalities,
        });
  if (!updatedGateway) {
    throw new Error("Gateway credential changed during model sync. Retry sync.");
  }

  return {
    gateway: sanitizeGateway(updatedGateway),
    models: savedModels,
    syncedCount: savedModels.length,
  };
}

export async function saveGatewayModel(input: {
  organizationId: string;
  id?: string;
  gatewayId: string;
  gatewayProvider?: GatewayProvider;
  gatewayBaseUrl?: string | null;
  rawModelId: string;
  alias?: string | null;
  modality: GatewayModality;
  approved?: boolean;
  isDefault?: boolean;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  requireEconomicsProfile?: boolean;
  resolveOpenRouterModel?: boolean;
}) {
  const [gateway, storedModel] = await Promise.all([
    input.gatewayProvider
      ? Promise.resolve({
          provider: input.gatewayProvider,
          baseUrl: input.gatewayBaseUrl ?? null,
        })
      : knowledgeDb.query.aiGateways.findFirst({
          where: (table, operators) =>
            operators.and(
              operators.eq(table.id, input.gatewayId),
              operators.eq(table.organizationId, input.organizationId)
            ),
        }),
    input.id
      ? knowledgeDb.query.aiGatewayModels.findFirst({
          columns: {
            metadata: true,
            rawModelId: true,
            modality: true,
          },
          where: (table, operators) =>
            operators.and(
              operators.eq(table.id, input.id!),
              operators.eq(table.gatewayId, input.gatewayId),
              operators.eq(table.organizationId, input.organizationId)
            ),
        })
      : Promise.resolve(undefined),
  ]);
  const gatewayProvider = gateway?.provider;
  const approved = input.approved ?? true;
  const runPodBaseUrl =
    gatewayProvider === "runpod" && gateway?.baseUrl
      ? normalizeOpenAICompatibleBaseUrl(gateway.baseUrl)
      : null;
  const resolvedOpenRouterMetadata =
    input.resolveOpenRouterModel &&
    gatewayProvider === "openrouter" &&
    approved &&
    input.modality === "language" &&
    gateway && "credentialRevision" in gateway
      ? await fetchOpenRouterModelDetails(gateway, input.rawModelId)
      : undefined;
  const inputMetadata =
    resolvedOpenRouterMetadata ??
    (gatewayProvider === "runpod" && storedModel && runPodBaseUrl
      ? preserveTrustedRunPodValidation({
          incomingMetadata: input.metadata,
          storedMetadata: storedModel.metadata,
          storedRawModelId: storedModel.rawModelId,
          storedModality: storedModel.modality,
          nextRawModelId: input.rawModelId,
          nextModality: input.modality,
          baseUrl: runPodBaseUrl,
        })
      : gatewayProvider === "runpod"
        ? preserveTrustedRunPodValidation({
            incomingMetadata: input.metadata,
            storedMetadata: null,
            storedRawModelId: "",
            storedModality: "",
            nextRawModelId: input.rawModelId,
            nextModality: input.modality,
            baseUrl: runPodBaseUrl ?? "",
          })
        : input.metadata);

  const normalizedMetadata =
    gatewayProvider != null
      ? normalizeGatewayModelMetadata({
          gatewayProvider: gatewayProvider as GatewayProvider,
          modality: input.modality,
          metadata: inputMetadata,
      })
      : (inputMetadata ?? null);
  const metadata =
    resolvedOpenRouterMetadata && normalizedMetadata
      ? {
          ...normalizedMetadata,
          kestrelEconomicsProfileSource: "provider_detail",
          ...(typeof resolvedOpenRouterMetadata.canonical_slug === "string"
            ? {
                kestrelOpenRouterCanonicalSlug:
                  resolvedOpenRouterMetadata.canonical_slug,
              }
            : {}),
        }
      : normalizedMetadata;

  const economicsProvider =
    gatewayProvider === undefined
      ? undefined
      : getGatewayModelEconomicsProvider({
          gatewayProvider,
          modality: input.modality,
          metadata,
        });
  const economicsMetadata =
    economicsProvider != null &&
    isKestrelRuntimeLanguageProvider(gatewayProvider as GatewayProvider)
      ? withGatewayModelEconomicsProfile({
          metadata,
          provider: economicsProvider,
          model: input.rawModelId,
          approved,
          modality: input.modality,
        })
      : metadata;
  if (
    approved &&
    input.modality === "language" &&
    economicsProvider != null &&
    isKestrelRuntimeLanguageProvider(gatewayProvider as GatewayProvider) &&
    readGatewayModelEconomicsProfile(economicsMetadata, {
      provider: economicsProvider,
      model: input.rawModelId,
    }) === undefined &&
    input.requireEconomicsProfile !== false
  ) {
    throw new GatewayModelEconomicsProfileRequiredError({
      provider: economicsProvider,
      model: input.rawModelId,
    });
  }

  if (
    gatewayProvider === "runpod" &&
    approved &&
    !(
      runPodBaseUrl &&
      getMatchingRunPodValidationEvidence({
        metadata,
        rawModelId: input.rawModelId,
        baseUrl: runPodBaseUrl,
      })
    )
  ) {
    throw new Error("RunPod model validation is required before approval.");
  }

  return knowledgeDb.transaction(async (transaction) => {
    if (
      input.resolveOpenRouterModel &&
      gatewayProvider === "openrouter" &&
      gateway && "credentialRevision" in gateway
    ) {
      const [currentGateway] = await transaction
        .select({
          credentialRevision: schema.aiGateways.credentialRevision,
          baseUrl: schema.aiGateways.baseUrl,
        })
        .from(schema.aiGateways)
        .where(
          and(
            eq(schema.aiGateways.id, input.gatewayId),
            eq(schema.aiGateways.organizationId, input.organizationId),
            eq(
              schema.aiGateways.credentialRevision,
              gateway.credentialRevision,
            ),
          ),
        )
        .limit(1);
      if (
        !currentGateway ||
        normalizeOpenAICompatibleBaseUrl(
          currentGateway.baseUrl?.trim() || getDefaultBaseUrl("openrouter")
        ) !== getOpenAICompatibleBaseUrl(gateway)
      ) {
        throw new GatewayModelProviderResolutionError({
          message:
            "OpenRouter gateway configuration changed while the model was resolving. Try again.",
          status: 409,
          retryable: true,
        });
      }
    }
    if (input.isDefault) {
      const lockKey = `kestrel:ai-model-default:${input.organizationId}:${input.modality}`;
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`
      );
      await transaction
        .update(schema.aiGatewayModels)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.aiGatewayModels.organizationId, input.organizationId),
            eq(schema.aiGatewayModels.modality, input.modality)
          )
        );
    }

    if (input.id) {
      const [updated] = await transaction
        .update(schema.aiGatewayModels)
        .set({
          rawModelId: input.rawModelId,
          alias: input.alias ?? null,
          modality: input.modality,
          approved,
          isDefault: input.isDefault ?? false,
          description: input.description ?? null,
          metadata: economicsMetadata,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.aiGatewayModels.id, input.id),
            eq(schema.aiGatewayModels.gatewayId, input.gatewayId),
            eq(schema.aiGatewayModels.organizationId, input.organizationId)
          )
        )
        .returning();

      if (!updated) {
        throw new Error("Gateway model not found");
      }
      return updated;
    }

    const [created] = await transaction
      .insert(schema.aiGatewayModels)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        gatewayId: input.gatewayId,
        rawModelId: input.rawModelId,
        alias: input.alias ?? null,
        modality: input.modality,
        approved,
        isDefault: input.isDefault ?? false,
        description: input.description ?? null,
        metadata: economicsMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return created;
  });
}

export async function validateRunPodGatewayModel(input: {
  organizationId: string;
  gatewayId: string;
  modelId: string;
  timeoutMs?: number;
  fetchImpl?: RunPodFetch;
  now?: Date;
}) {
  const row = await knowledgeDb
    .select({ gateway: schema.aiGateways, model: schema.aiGatewayModels })
    .from(schema.aiGatewayModels)
    .innerJoin(
      schema.aiGateways,
      eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId)
    )
    .where(
      and(
        eq(schema.aiGateways.id, input.gatewayId),
        eq(schema.aiGateways.organizationId, input.organizationId),
        eq(schema.aiGatewayModels.id, input.modelId)
      )
    )
    .limit(1);
  const selected = row[0];
  if (!selected) {
    throw new Error("Gateway model not found");
  }
  if (
    selected.gateway.provider !== "runpod" ||
    selected.model.modality !== "language"
  ) {
    throw new Error("RunPod language model validation is required.");
  }
  const apiKey = getGatewayApiKey(selected.gateway);
  const baseUrl = getOpenAICompatibleBaseUrl(selected.gateway);
  if (!(apiKey && baseUrl)) {
    throw new Error("RunPod gateway credential or endpoint is missing.");
  }
  const evidence = await validateRunPodToolRoundTrip({
    apiKey,
    baseUrl,
    model: selected.model.rawModelId,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const [updated] = await knowledgeDb
    .update(schema.aiGatewayModels)
    .set({
      metadata: mergeRunPodValidationEvidence({
        metadata: selected.model.metadata,
        evidence,
      }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.aiGatewayModels.id, input.modelId),
        eq(schema.aiGatewayModels.organizationId, input.organizationId),
        eq(schema.aiGatewayModels.gatewayId, input.gatewayId),
        eq(schema.aiGatewayModels.rawModelId, selected.model.rawModelId),
        eq(schema.aiGatewayModels.modality, selected.model.modality)
      )
    )
    .returning();
  if (!updated) {
    throw new Error("Gateway model changed during RunPod validation.");
  }
  const credential = await markGatewayCredentialReadyIfCurrent({
    organizationId: input.organizationId,
    gatewayId: input.gatewayId,
    credentialRevision: selected.gateway.credentialRevision,
  });
  if (!credential) {
    throw new Error("Gateway credential changed during RunPod validation.");
  }
  return { model: updated, validation: evidence };
}

export async function validateRunPodGatewayModelByRawId(input: {
  organizationId: string;
  gatewayId: string;
  rawModelId: string;
  isDefault?: boolean;
  timeoutMs?: number;
  fetchImpl?: RunPodFetch;
  now?: Date;
}) {
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, input.gatewayId),
        operators.eq(table.organizationId, input.organizationId)
      ),
  });
  if (gateway?.provider !== "runpod") {
    throw new Error("RunPod gateway not found.");
  }
  const apiKey = getGatewayApiKey(gateway);
  const baseUrl = getOpenAICompatibleBaseUrl(gateway);
  if (!(apiKey && baseUrl)) {
    throw new Error("RunPod gateway credential or endpoint is missing.");
  }

  const rawModelId = input.rawModelId.trim();
  if (!rawModelId) {
    throw new Error("Served model ID is required.");
  }
  const existing = await knowledgeDb.query.aiGatewayModels.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.gatewayId, gateway.id),
        operators.eq(table.organizationId, input.organizationId),
        operators.eq(table.rawModelId, rawModelId)
      ),
  });
  const candidate =
    existing ??
    (await saveGatewayModel({
      gatewayId: gateway.id,
      organizationId: input.organizationId,
      gatewayProvider: "runpod",
      gatewayBaseUrl: gateway.baseUrl,
      rawModelId,
      modality: "language",
      approved: false,
      isDefault: false,
      metadata: null,
    }));
  const validation = await validateRunPodGatewayModel({
    gatewayId: gateway.id,
    organizationId: input.organizationId,
    modelId: candidate.id,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const model = await saveGatewayModel({
    id: validation.model.id,
    organizationId: input.organizationId,
    gatewayId: gateway.id,
    gatewayProvider: "runpod",
    gatewayBaseUrl: gateway.baseUrl,
    rawModelId,
    alias: validation.model.alias,
    modality: "language",
    approved: true,
    isDefault: input.isDefault ?? validation.model.isDefault,
    description: validation.model.description,
    metadata: validation.model.metadata as Record<string, unknown> | null,
  });

  return { model, validation: validation.validation };
}

type ResolvedGatewayModel = {
  gateway: GatewayRecord;
  model: GatewayCatalogModel;
};

async function getResolvedGatewayModel(input: {
  selection?: string | null;
  modality: GatewayModality;
  organizationId: string;
  environmentId?: string;
}): Promise<ResolvedGatewayModel | null> {
  const selection = await resolveGatewayModelSelection(input);

  return hydrateResolvedGatewayModel(selection);
}

async function hydrateResolvedGatewayModel(
  selection: GatewayCatalogModel | null | undefined
): Promise<ResolvedGatewayModel | null> {
  if (!selection?.gatewayId) {
    return null;
  }

  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: (table, operators) => operators.eq(table.id, selection.gatewayId!),
  });

  if (!gateway) {
    return null;
  }

  return {
    gateway,
    model: selection,
  };
}

export async function getResolvedGatewayExecutionModel(input: {
  selection?: string | null;
  modality: GatewayModality;
  organizationId: string;
  environmentId?: string;
}) {
  return getResolvedGatewayModel(input);
}

export async function getResolvedKestrelRuntimeExecutionModel(input: {
  selection?: string | null;
  organizationId: string;
  environmentId?: string;
}) {
  const models = await getApprovedKestrelRuntimeLanguageModels(
    input.organizationId,
    input.environmentId
  );
  return hydrateResolvedGatewayModel(
    input.selection
      ? selectGatewayModelSelection(models, input.selection)
      : (models.find((model) => model.isDefault) ?? null)
  );
}

function createOpenAICompatibleProvider(gateway: GatewayRecord): ProviderV3 {
  const apiKey = getGatewayApiKey(gateway);
  const baseURL = getOpenAICompatibleBaseUrl(gateway);

  if (!apiKey && gateway.provider !== "ollama") {
    throw new Error(`Gateway ${gateway.displayName} is missing an API key.`);
  }

  return createOpenAI({
    apiKey: apiKey || "ollama",
    baseURL: baseURL || undefined,
    headers:
      gateway.provider === "openrouter"
        ? {
            "HTTP-Referer":
              process.env.AI_AGENT_SITE_URL?.trim() || "http://127.0.0.1:43103",
            "X-Title": process.env.AI_AGENT_SITE_NAME?.trim() || "Kestrel One",
          }
        : undefined,
    name: gateway.provider,
  });
}

function createGatewayProvider(input: {
  gateway: GatewayRecord;
  model: Pick<GatewayCatalogModel, "metadata" | "modality">;
}): ProviderV3 {
  if (
    input.gateway.provider === "lumi" &&
    getGatewayLanguageProtocol({
      gatewayProvider: "lumi",
      modality: input.model.modality,
      metadata: input.model.metadata,
    }) === "anthropic"
  ) {
    return createAnthropic({
      apiKey: getGatewayApiKey(input.gateway) || undefined,
      baseURL: input.gateway.baseUrl?.trim() || undefined,
      name: input.gateway.provider,
    });
  }

  switch (input.gateway.provider) {
    case "lumi":
    case "openai":
    case "openrouter":
    case "ollama":
    case "runpod":
      return createOpenAICompatibleProvider(input.gateway);
    case "anthropic":
      return createAnthropic({
        apiKey: getGatewayApiKey(input.gateway) || undefined,
        baseURL: input.gateway.baseUrl?.trim() || undefined,
        name: input.gateway.provider,
      });
    case "replicate":
      throw new Error(
        "Replicate gateways are used through the media adapter, not the language/image/speech provider registry."
      );
  }
}

export async function resolveLanguageModelHandle(input: {
  selection?: string | null;
  usage?: "default" | "tool-loop";
  organizationId: string;
  environmentId?: string;
}) {
  const resolved = await getResolvedGatewayModel({
    selection: input.selection,
    modality: "language",
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });

  if (!resolved) {
    return null;
  }

  const provider = createGatewayProvider(resolved);
  const modelId = resolved.model.rawModelId;

  if (
    input.usage === "tool-loop" &&
    resolved.gateway.provider === "openrouter" &&
    "chat" in provider &&
    typeof provider.chat === "function"
  ) {
    return {
      model: provider.chat(modelId),
      resolvedModelId: resolved.model.id,
      provider: resolved.gateway.provider,
    };
  }

  return {
    model: provider.languageModel(modelId),
    resolvedModelId: resolved.model.id,
    provider: resolved.gateway.provider,
  };
}

export async function resolveLanguageModelRetryFallback(
  selection: string | null | undefined,
  organizationId: string,
  environmentId?: string
) {
  const resolved = await getResolvedGatewayModel({
    selection,
    modality: "language",
    organizationId,
    environmentId,
  });

  if (!resolved || resolved.gateway.provider !== "openrouter") {
    return null;
  }

  const currentAlias = resolved.model.alias?.trim().toLowerCase() || null;
  const comparableCurrentModel = getComparableModelName(
    resolved.model.rawModelId
  );

  const languageModels = await getApprovedLanguageModels(organizationId, environmentId);
  const candidates = languageModels.filter(
    (model) =>
      model.gatewayId !== resolved.gateway.id &&
      model.gatewayProvider !== "openrouter"
  );

  return (
    candidates.find(
      (model) => model.alias?.trim().toLowerCase() === currentAlias
    ) ||
    candidates.find(
      (model) =>
        getComparableModelName(model.rawModelId) === comparableCurrentModel
    ) ||
    null
  );
}

export async function resolveSpeechModelHandle(input: { selection?: string | null; organizationId: string; environmentId?: string }) {
  const resolved = await getResolvedGatewayModel({
    selection: input.selection,
    modality: "speech",
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });

  if (!resolved) {
    return null;
  }

  const provider = createGatewayProvider(resolved);
  if (!provider.speechModel) {
    throw new Error(
      `${resolved.gateway.displayName} does not expose speech models in this runtime.`
    );
  }

  return {
    model: provider.speechModel(resolved.model.rawModelId),
    resolvedModelId: resolved.model.id,
    provider: resolved.gateway.provider,
  };
}

export async function resolveImageModelHandle(input: { selection?: string | null; organizationId: string; environmentId?: string }) {
  const resolved = await getResolvedGatewayModel({
    selection: input.selection,
    modality: "image",
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });

  if (!resolved) {
    return null;
  }

  const provider = createGatewayProvider(resolved);

  return {
    model: provider.imageModel(resolved.model.rawModelId),
    resolvedModelId: resolved.model.id,
    provider: resolved.gateway.provider,
  };
}

export async function getGatewayById(
  organizationId: string,
  gatewayId: string
) {
  const gateway = await knowledgeDb.query.aiGateways.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.id, gatewayId),
        operators.eq(table.organizationId, organizationId)
      ),
  });

  return gateway ? sanitizeGateway(gateway) : null;
}

export async function listModelsForGateway(
  organizationId: string,
  gatewayId: string
) {
  return knowledgeDb
    .select()
    .from(schema.aiGatewayModels)
    .where(
      and(
        eq(schema.aiGatewayModels.organizationId, organizationId),
        eq(schema.aiGatewayModels.gatewayId, gatewayId)
      )
    )
    .orderBy(
      asc(schema.aiGatewayModels.modality),
      asc(schema.aiGatewayModels.alias),
      asc(schema.aiGatewayModels.rawModelId)
    );
}

export async function deleteGateway(
  organizationId: string,
  gatewayId: string
) {
  return knowledgeDb.transaction(async (transaction) => {
    const [gateway] = await transaction
      .select({ id: schema.aiGateways.id })
      .from(schema.aiGateways)
      .where(
        and(
          eq(schema.aiGateways.id, gatewayId),
          eq(schema.aiGateways.organizationId, organizationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!gateway) return null;
    const [activeGrant] = await transaction
      .select({ runId: schema.environmentModelGrants.runId })
      .from(schema.environmentModelGrants)
      .innerJoin(
        schema.aiGatewayModels,
        eq(
          schema.aiGatewayModels.id,
          schema.environmentModelGrants.gatewayModelId,
        ),
      )
      .where(
        and(
          eq(schema.aiGatewayModels.organizationId, organizationId),
          eq(schema.aiGatewayModels.gatewayId, gatewayId),
          eq(schema.environmentModelGrants.status, "active"),
        ),
      )
      .limit(1);
    if (activeGrant) throw new GatewayModelInUseError();
    const [deleted] = await transaction
      .delete(schema.aiGateways)
      .where(eq(schema.aiGateways.id, gatewayId))
      .returning();
    return deleted ? sanitizeGateway(deleted) : null;
  });
}

export async function deleteGatewayModel(
  organizationId: string,
  gatewayId: string,
  modelId: string
) {
  return knowledgeDb.transaction(async (transaction) => {
    const [model] = await transaction
      .select({ id: schema.aiGatewayModels.id })
      .from(schema.aiGatewayModels)
      .where(
        and(
          eq(schema.aiGatewayModels.id, modelId),
          eq(schema.aiGatewayModels.organizationId, organizationId),
          eq(schema.aiGatewayModels.gatewayId, gatewayId),
        ),
      )
      .limit(1)
      .for("update");
    if (!model) return null;
    const activeGrant =
      await transaction.query.environmentModelGrants.findFirst({
        where: and(
          eq(schema.environmentModelGrants.gatewayModelId, modelId),
          eq(schema.environmentModelGrants.organizationId, organizationId),
          eq(schema.environmentModelGrants.status, "active"),
        ),
        columns: { runId: true },
      });
    if (activeGrant) throw new GatewayModelInUseError();
    const [deleted] = await transaction
      .delete(schema.aiGatewayModels)
      .where(eq(schema.aiGatewayModels.id, modelId))
      .returning();
    return deleted ?? null;
  });
}

export async function hasApprovedModelsForModalities(
  modalities: GatewayModality[]
) {
  const rows = await knowledgeDb
    .select({ modality: schema.aiGatewayModels.modality })
    .from(schema.aiGatewayModels)
    .where(
      and(
        inArray(schema.aiGatewayModels.modality, modalities),
        eq(schema.aiGatewayModels.approved, true)
      )
    );

  return new Set(rows.map((row) => row.modality as GatewayModality));
}
