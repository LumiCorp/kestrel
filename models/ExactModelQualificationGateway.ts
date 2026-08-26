import type { ModelGateway } from "../src/kestrel/contracts/model-io.js";
import {
  fingerprintModelRoutingPolicyV2,
  parseModelRegistrationV2,
  type ModelRegistrationV2,
} from "../src/kestrel/contracts/model-registration.js";
import type { ModelQualificationBinding } from "../src/kestrel/model-qualification.js";
import { createAnthropicModelGatewayFromEnv } from "./anthropic/createAnthropicModelGateway.js";
import { createOpenAiModelGatewayFromEnv } from "./openai/createOpenAiModelGateway.js";
import { createOpenRouterModelGatewayFromEnv } from "./openrouter/createOpenRouterModelGateway.js";
import type { OpenRouterQualifiedRouteEvidence } from "./openrouter/OpenRouterV2Codec.js";

const EXACT_QUALIFICATION_GATEWAYS = new WeakMap<
  object,
  Readonly<{
    providerId: ModelRegistrationV2["providerId"];
    modelId: string;
    apiEndpoint: string;
    endpointCodec: string;
    routingPolicyFingerprint: string;
    adapterRevision: string;
    credentialRevision?: string | undefined;
  }>
>();

/** A live qualification transport minted only by the installed adapter registry. */
export interface ExactModelQualificationGateway extends ModelGateway {}

/**
 * Creates a real, exact adapter transport from registration-owned route data.
 * The credential is consumed only to configure transport and is never retained
 * in the gateway receipt or qualification evidence.
 */
export function createExactModelQualificationGateway(input: {
  registration: ModelRegistrationV2;
  credential: { revision: string; apiKey: string };
  fetchImpl?: typeof fetch | undefined;
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
}): ExactModelQualificationGateway {
  const registration = parseModelRegistrationV2(input.registration);
  if (registration.credentialRevision !== input.credential.revision) {
    throw new Error("model qualification credential revision does not match registration");
  }
  if (registration.providerConfiguration.endpoint !== registration.route.apiEndpoint) {
    throw new Error("model qualification provider endpoint does not match registration route");
  }
  const gateway = createRegisteredGateway({ ...input, registration });
  const exact = Object.freeze({
    call: <T>(request: Parameters<ModelGateway["call"]>[0]) => gateway.call<T>(request),
  });
  EXACT_QUALIFICATION_GATEWAYS.set(
    exact,
    Object.freeze({
      providerId: registration.providerId,
      modelId: registration.modelId,
      apiEndpoint: registration.route.apiEndpoint,
      endpointCodec: registration.route.endpointCodec,
      routingPolicyFingerprint: fingerprintModelRoutingPolicyV2(
        registration.route.routing,
      ),
      adapterRevision: registration.adapterRevision,
      ...(registration.credentialRevision !== undefined
        ? { credentialRevision: registration.credentialRevision }
        : {}),
    }),
  );
  return exact;
}

export function assertExactModelQualificationGateway(input: {
  gateway: ExactModelQualificationGateway;
  binding: ModelQualificationBinding;
}): void {
  const receipt = EXACT_QUALIFICATION_GATEWAYS.get(input.gateway);
  if (receipt === undefined) {
    throw new Error("model live qualification gateway was not minted by the adapter registry");
  }
  if (
    receipt.providerId !== input.binding.providerId ||
    receipt.modelId !== input.binding.modelId ||
    receipt.apiEndpoint !== input.binding.apiEndpoint ||
    receipt.endpointCodec !== input.binding.endpointCodec ||
    receipt.routingPolicyFingerprint !== input.binding.routingPolicyFingerprint ||
    receipt.adapterRevision !== input.binding.adapterRevision ||
    receipt.credentialRevision !== input.binding.credentialRevision
  ) {
    throw new Error("model live qualification gateway does not match exact registration binding");
  }
}

function createRegisteredGateway(input: {
  registration: ModelRegistrationV2;
  credential: { revision: string; apiKey: string };
  fetchImpl?: typeof fetch | undefined;
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
}): ModelGateway {
  const { registration, credential } = input;
  switch (registration.providerId) {
    case "openai":
      return createOpenAiModelGatewayFromEnv({
        envConfig: {
          apiKey: credential.apiKey,
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
          providerName: "openai",
          providerLabel: "OpenAI",
        },
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    case "anthropic":
      return createAnthropicModelGatewayFromEnv({
        envConfig: {
          apiKey: credential.apiKey,
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
        },
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    case "openrouter":
      if (input.openRouterRouteEvidence === undefined) {
        throw new Error("OpenRouter live qualification requires exact route evidence");
      }
      return createOpenRouterModelGatewayFromEnv({
        envConfig: {
          apiKey: credential.apiKey,
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
        },
        routeEvidence: input.openRouterRouteEvidence,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    default:
      throw new Error(`model live qualification provider '${registration.providerId}' is unsupported`);
  }
}
