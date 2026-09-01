import {
  OPENAI_MODEL_MANIFEST,
  OPENAI_MODEL_MANIFEST_REVISION,
  translateOpenAiManifestModel,
} from "../../../../models/openai/OpenAiModelManifest";
import { translateAnthropicModelsApiModel } from "../../../../models/anthropic/AnthropicModelManifest";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract";
import {
  parseModelRegistrationV2,
  type ModelQualificationStateV2,
  type ModelRegistrationV2,
  type ProviderRuntimeConfigurationV1,
} from "../../../../src/kestrel/contracts/model-registration";
import {
  OPENROUTER_MODEL_DETAIL_TRANSLATOR_REVISION,
  translateOpenRouterCapabilityEvidence,
  translateOpenRouterModelDetails,
} from "./openrouter-model-resolution";
import type { OpenRouterQualifiedRouteEvidence } from "../../../../models/openrouter/OpenRouterV2Codec";
import { GMAIL_RESTRICTED_DATA_EVIDENCE_KEY } from "../integrations/gmail-restricted-data-admission";

export const HOSTED_MODEL_REGISTRATION_KEY = "kestrelModelRegistrationV2";
export const HOSTED_MODEL_REGISTRATION_EVIDENCE_KEY =
  "kestrelModelRegistrationEvidenceV1";
export const HOSTED_MODEL_QUALIFICATION_PROJECTION_KEY =
  "kestrelModelQualificationProjectionV1";

export type HostedModelRegistrationProvider =
  | "openai"
  | "openrouter"
  | "anthropic";

/** Provider responses accepted only by the hosted gateway domain. */
export type HostedModelProviderEvidence =
  | {
      provider: "openai";
      catalogRecord: Record<string, unknown>;
      endpoint?: "chat" | "responses";
    }
  | {
      provider: "openrouter";
      details: Record<string, unknown>;
      endpoint?: "chat" | "responses";
    }
  | {
      provider: "anthropic";
      modelsApiRecord: Record<string, unknown>;
    };

export type HostedModelQualificationProjection = {
  version: 1;
  state: ModelQualificationStateV2;
  registrationRevision: string;
  registrationFingerprint: string;
  credentialRevision?: string;
  checkedAt?: string;
  probeRevision?: string;
};

export type HostedModelRegistrationEvidence = {
  version: 1;
  provider: HostedModelRegistrationProvider;
  observedAt: string;
  sourceRevision: string;
  sourcePayload: Record<string, unknown>;
  sourceHash: string;
};

export function createHostedModelRegistration(input: {
  registrationId: string;
  revision: string;
  observedAt: string;
  modelId: string;
  credentialRevision: string;
  providerConfiguration: ProviderRuntimeConfigurationV1;
  providerEvidence: HostedModelProviderEvidence;
}): {
  registration: ModelRegistrationV2;
  evidence: HostedModelRegistrationEvidence;
  qualification: HostedModelQualificationProjection;
} {
  if (
    input.providerEvidence.provider !== input.providerConfiguration.providerId
  ) {
    throw new Error(
      "Hosted model provider evidence does not match gateway provider.",
    );
  }

  const registration = registrationForEvidence(input);
  const evidence = persistedEvidenceFor({ ...input, registration });
  return {
    registration,
    evidence,
    qualification: {
      version: 1,
      state: "pending",
      registrationRevision: registration.revision,
      registrationFingerprint: registration.fingerprint,
      credentialRevision: input.credentialRevision,
    },
  };
}

/**
 * The qualification run is persisted separately from the declaration it
 * proves. This preserves the exact registration fingerprint that the bounded
 * probe used and prevents a later failed refresh from rewriting that proof.
 */
export function createHostedModelQualificationProjection(input: {
  registration: ModelRegistrationV2;
  credentialRevision: string;
  state: Exclude<ModelQualificationStateV2, "legacy_unqualified">;
  checkedAt?: string;
  probeRevision?: string;
}): HostedModelQualificationProjection {
  const registration = parseModelRegistrationV2(input.registration);
  if (registration.credentialRevision !== input.credentialRevision) {
    throw new Error(
      "Hosted qualification credential revision does not match registration.",
    );
  }
  return {
    version: 1,
    state: input.state,
    registrationRevision: registration.revision,
    registrationFingerprint: registration.fingerprint,
    credentialRevision: input.credentialRevision,
    ...(input.checkedAt !== undefined ? { checkedAt: input.checkedAt } : {}),
    ...(input.probeRevision !== undefined
      ? { probeRevision: input.probeRevision }
      : {}),
  };
}

export function withHostedModelRegistration(input: {
  metadata: unknown;
  registration: ModelRegistrationV2;
  evidence: HostedModelRegistrationEvidence;
  qualification: HostedModelQualificationProjection;
}): Record<string, unknown> {
  const metadata = removeHostedModelCapabilityMetadata(input.metadata);
  return {
    ...metadata,
    [HOSTED_MODEL_REGISTRATION_KEY]: input.registration,
    [HOSTED_MODEL_REGISTRATION_EVIDENCE_KEY]: input.evidence,
    [HOSTED_MODEL_QUALIFICATION_PROJECTION_KEY]: input.qualification,
  };
}

/** Browser-provided metadata is never allowed to author capability truth. */
export function removeHostedModelCapabilityMetadata(
  value: unknown,
): Record<string, unknown> {
  const metadata = asRecord(value);
  const {
    [HOSTED_MODEL_REGISTRATION_KEY]: _registration,
    [HOSTED_MODEL_REGISTRATION_EVIDENCE_KEY]: _evidence,
    [HOSTED_MODEL_QUALIFICATION_PROJECTION_KEY]: _qualification,
    [GMAIL_RESTRICTED_DATA_EVIDENCE_KEY]: _gmailRestrictedDataEvidence,
    kestrelOpenRouterCapabilityEvidence: _openRouterCapabilityEvidence,
    ...remaining
  } = metadata;
  return remaining;
}

/** Preserve prior server evidence during non-refresh edits without trusting a replacement payload. */
export function preserveHostedModelCapabilityMetadata(input: {
  incoming: unknown;
  stored: unknown;
}): Record<string, unknown> {
  const stored = asRecord(input.stored);
  const incoming = removeHostedModelCapabilityMetadata(input.incoming);
  return {
    ...incoming,
    ...pickHostedModelCapabilityMetadata(stored),
  };
}

export function readHostedModelRegistrationState(input: {
  metadata: unknown;
  provider: HostedModelRegistrationProvider;
  modelId: string;
  credentialRevision?: string;
}): ModelQualificationStateV2 {
  const metadata = asRecord(input.metadata);
  const candidate = metadata[HOSTED_MODEL_REGISTRATION_KEY];
  if (candidate === undefined) return "legacy_unqualified";
  try {
    const registration = parseModelRegistrationV2(candidate);
    if (
      registration.providerId !== input.provider ||
      registration.modelId !== input.modelId ||
      (input.credentialRevision !== undefined &&
        registration.credentialRevision !== input.credentialRevision)
    ) {
      return "stale";
    }
    const projection = parseQualificationProjection(
      metadata[HOSTED_MODEL_QUALIFICATION_PROJECTION_KEY],
      registration,
      input.credentialRevision,
    );
    return projection?.state ?? registration.qualification.state;
  } catch {
    return "legacy_unqualified";
  }
}

/** Read retained server evidence for the OpenRouter V2 transport. */
export function readHostedOpenRouterRouteEvidence(input: {
  metadata: unknown;
  registration: ModelRegistrationV2;
}): OpenRouterQualifiedRouteEvidence | undefined {
  const registration = parseModelRegistrationV2(input.registration);
  if (registration.providerId !== "openrouter") return;
  const evidence = asRecord(asRecord(input.metadata)[HOSTED_MODEL_REGISTRATION_EVIDENCE_KEY]);
  const capability = asRecord(asRecord(evidence.sourcePayload).capability);
  const routing = asRecord(capability.routing);
  const endpoint = registration.route.endpointCodec === "openrouter.chat.v2"
    ? "chat"
    : registration.route.endpointCodec === "openrouter.responses.v2"
      ? "responses"
      : undefined;
  const providerEvidence = registration.providerEvidence.find((entry) => entry.source === "provider");
  if (
    evidence.provider !== "openrouter" ||
    endpoint === undefined ||
    capability.modelId !== registration.modelId ||
    capability.sourceHash !== providerEvidence?.retainedPayloadHash ||
    (routing.kind !== "fixed" && routing.kind !== "provider") ||
    typeof routing.policyId !== "string" ||
    !Array.isArray(routing.allowedEndpointIds) ||
    !Array.isArray(capability.supportedParameters) ||
    !Array.isArray(capability.endpoints)
  ) return;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
      ? value
      : undefined;
  const supportedParameters = strings(capability.supportedParameters);
  const allowedEndpointIds = strings(routing.allowedEndpointIds);
  const endpoints = capability.endpoints.flatMap((candidate) => {
    const record = asRecord(candidate);
    const supported = strings(record.supportedParameters);
    return typeof record.id === "string" && supported !== undefined
      ? [{ id: record.id, supportedParameters: supported }]
      : [];
  });
  if (supportedParameters === undefined || allowedEndpointIds === undefined || endpoints.length !== capability.endpoints.length) return;
  return {
    modelId: registration.modelId,
    endpoint,
    supportedParameters,
    endpoints,
    routing: { kind: routing.kind, policyId: routing.policyId, allowedEndpointIds },
    sourceHash: providerEvidence!.retainedPayloadHash,
  };
}

function registrationForEvidence(input: {
  registrationId: string;
  revision: string;
  observedAt: string;
  modelId: string;
  credentialRevision: string;
  providerConfiguration: ProviderRuntimeConfigurationV1;
  providerEvidence: HostedModelProviderEvidence;
}): ModelRegistrationV2 {
  switch (input.providerEvidence.provider) {
    case "openai": {
      assertExactCatalogIdentity(
        input.providerEvidence.catalogRecord,
        input.modelId,
        "OpenAI",
      );
      const endpoint =
        input.providerEvidence.endpoint ?? defaultOpenAiEndpoint(input.modelId);
      return translateOpenAiManifestModel({
        registrationId: input.registrationId,
        revision: input.revision,
        modelId: input.modelId,
        endpoint,
        providerConfiguration: input.providerConfiguration,
        credentialRevision: input.credentialRevision,
      });
    }
    case "openrouter":
      return translateOpenRouterModelDetails({
        registrationId: input.registrationId,
        revision: input.revision,
        observedAt: input.observedAt,
        modelId: input.modelId,
        details: input.providerEvidence.details,
        providerConfiguration: input.providerConfiguration,
        endpoint: input.providerEvidence.endpoint ?? "chat",
        credentialRevision: input.credentialRevision,
      });
    case "anthropic":
      return translateAnthropicModelsApiModel({
        registrationId: input.registrationId,
        revision: input.revision,
        observedAt: input.observedAt,
        modelId: input.modelId,
        modelsApiRecord: input.providerEvidence.modelsApiRecord,
        providerConfiguration: input.providerConfiguration,
        credentialRevision: input.credentialRevision,
      });
  }
}

function persistedEvidenceFor(input: {
  observedAt: string;
  modelId: string;
  providerEvidence: HostedModelProviderEvidence;
  registration: ModelRegistrationV2;
}): HostedModelRegistrationEvidence {
  const sourcePayload = sourcePayloadFor(input.providerEvidence, input.modelId);
  const sourceHash = hashCanonical(sourcePayload);
  return {
    version: 1,
    provider: input.providerEvidence.provider,
    observedAt: input.observedAt,
    sourceRevision: `${input.registration.adapterRevision}:${sourceHash}`,
    sourcePayload,
    sourceHash,
  };
}

function sourcePayloadFor(
  evidence: HostedModelProviderEvidence,
  modelId: string,
): Record<string, unknown> {
  switch (evidence.provider) {
    case "openai":
      return { id: exactId(evidence.catalogRecord, "OpenAI"), modelId };
    case "anthropic":
      return { id: exactId(evidence.modelsApiRecord, "Anthropic"), modelId };
    case "openrouter": {
      const capability = translateOpenRouterCapabilityEvidence({
        modelId,
        details: evidence.details,
      });
      return {
        id: exactId(evidence.details, "OpenRouter"),
        ...(typeof evidence.details.canonical_slug === "string"
          ? { canonicalSlug: evidence.details.canonical_slug }
          : {}),
        capability,
      };
    }
  }
}

function defaultOpenAiEndpoint(modelId: string): "chat" | "responses" {
  const entries = OPENAI_MODEL_MANIFEST.filter(
    (entry) => entry.modelId === modelId,
  );
  if (entries.some((entry) => entry.endpoint === "responses"))
    return "responses";
  if (entries.length === 1) return entries[0]!.endpoint;
  throw new Error(
    `OpenAI model manifest has no default exact endpoint for '${modelId}'.`,
  );
}

function assertExactCatalogIdentity(
  record: Record<string, unknown>,
  modelId: string,
  provider: string,
): void {
  if (exactId(record, provider) !== modelId) {
    throw new Error(
      `${provider} catalog evidence does not match the requested exact model identity.`,
    );
  }
}

function exactId(record: Record<string, unknown>, provider: string): string {
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new Error(
      `${provider} model evidence must include an exact model ID.`,
    );
  }
  return record.id;
}

function parseQualificationProjection(
  value: unknown,
  registration: ModelRegistrationV2,
  credentialRevision: string | undefined,
): HostedModelQualificationProjection | undefined {
  const record = asRecord(value);
  const state = record.state;
  if (
    record.version !== 1 ||
    typeof state !== "string" ||
    !["pending", "qualified", "failed", "stale"].includes(state) ||
    record.registrationRevision !== registration.revision ||
    record.registrationFingerprint !== registration.fingerprint ||
    (credentialRevision !== undefined &&
      record.credentialRevision !== credentialRevision)
  ) {
    return;
  }
  return record as HostedModelQualificationProjection;
}

function pickHostedModelCapabilityMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    [
      HOSTED_MODEL_REGISTRATION_KEY,
      HOSTED_MODEL_REGISTRATION_EVIDENCE_KEY,
      HOSTED_MODEL_QUALIFICATION_PROJECTION_KEY,
      GMAIL_RESTRICTED_DATA_EVIDENCE_KEY,
    ].flatMap((key) =>
      metadata[key] === undefined ? [] : [[key, metadata[key]]],
    ),
  );
}

export function hostedModelRegistrationRevision(input: {
  providerEvidence: HostedModelProviderEvidence;
  modelId: string;
  credentialRevision: string;
}): string {
  const sourcePayload = sourcePayloadFor(input.providerEvidence, input.modelId);
  return `hosted:${hashCanonical({
    provider: input.providerEvidence.provider,
    credentialRevision: input.credentialRevision,
    sourcePayload,
    openAiManifestRevision:
      input.providerEvidence.provider === "openai"
        ? OPENAI_MODEL_MANIFEST_REVISION
        : undefined,
    openRouterTranslatorRevision:
      input.providerEvidence.provider === "openrouter"
        ? OPENROUTER_MODEL_DETAIL_TRANSLATOR_REVISION
        : undefined,
  })}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
