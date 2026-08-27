import type { ModelGateway } from "../src/kestrel/contracts/model-io.js";
import {
  fingerprintModelRoutingPolicyV2,
  parseModelRegistrationV2,
  type ModelRegistrationV2,
} from "../src/kestrel/contracts/model-registration.js";
import type { ModelQualificationBinding } from "../src/kestrel/model-qualification.js";
import { createAnthropicModelGatewayFromEnv } from "./anthropic/createAnthropicModelGateway.js";
import { createLmStudioModelGatewayFromEnv } from "./lmstudio/createLmStudioModelGateway.js";
import { createOllamaModelGatewayFromEnv } from "./ollama/createOllamaModelGateway.js";
import { createOpenAiModelGatewayFromEnv } from "./openai/createOpenAiModelGateway.js";
import { createOpenRouterModelGatewayFromEnv } from "./openrouter/createOpenRouterModelGateway.js";
import type { OpenRouterQualifiedRouteEvidence } from "./openrouter/OpenRouterV2Codec.js";

type ExactQualificationEndpoint = "chat" | "responses" | "messages";

const EXACT_QUALIFICATION_GATEWAYS = new WeakMap<
  object,
  Readonly<{
    providerId: ModelRegistrationV2["providerId"];
    modelId: string;
    apiEndpoint: string;
    endpointCodec: string;
    routingPolicyFingerprint: string;
    adapterRevision: string;
    registrationRevision: string;
    registrationFingerprint: string;
    credentialRevision?: string | undefined;
    endpoint: ExactQualificationEndpoint;
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
  credential?: { revision: string; apiKey?: string | undefined } | undefined;
  fetchImpl?: typeof fetch | undefined;
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
}): ExactModelQualificationGateway {
  const registration = parseModelRegistrationV2(input.registration);
  if (registration.credentialRevision !== input.credential?.revision) {
    throw new Error("model qualification credential revision does not match registration");
  }
  if (registration.providerConfiguration.endpoint !== registration.route.apiEndpoint) {
    throw new Error("model qualification provider endpoint does not match registration route");
  }
  const endpoint = endpointForRegistration(registration);
  const gateway = createRegisteredGateway({ ...input, registration, endpoint });
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
      registrationRevision: registration.revision,
      registrationFingerprint: registration.fingerprint,
      ...(registration.credentialRevision !== undefined
        ? { credentialRevision: registration.credentialRevision }
        : {}),
      endpoint,
    }),
  );
  return exact;
}

export function assertExactModelQualificationGateway(input: {
  gateway: ExactModelQualificationGateway;
  binding: ModelQualificationBinding;
}): ExactQualificationEndpoint {
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
    receipt.registrationRevision !== input.binding.registrationRevision ||
    receipt.registrationFingerprint !== input.binding.registrationFingerprint ||
    receipt.credentialRevision !== input.binding.credentialRevision
  ) {
    throw new Error("model live qualification gateway does not match exact registration binding");
  }
  return receipt.endpoint;
}

function createRegisteredGateway(input: {
  registration: ModelRegistrationV2;
  credential?: { revision: string; apiKey?: string | undefined } | undefined;
  fetchImpl?: typeof fetch | undefined;
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
  endpoint: ExactQualificationEndpoint;
}): ModelGateway {
  const { registration } = input;
  switch (registration.providerId) {
    case "openai":
      return createOpenAiModelGatewayFromEnv({
        envConfig: {
          apiKey: input.credential!.apiKey!,
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
          apiKey: input.credential!.apiKey!,
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
        },
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    case "openrouter":
      if (input.openRouterRouteEvidence === undefined) {
        throw new Error("OpenRouter live qualification requires exact route evidence");
      }
      if (input.openRouterRouteEvidence.endpoint !== input.endpoint) {
        throw new Error("OpenRouter live qualification evidence does not match endpoint codec");
      }
      assertOpenRouterRouteEvidence(registration, input.openRouterRouteEvidence);
      return createOpenRouterModelGatewayFromEnv({
        envConfig: {
          apiKey: input.credential!.apiKey!,
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
        },
        routeEvidence: input.openRouterRouteEvidence,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    case "ollama":
      return createOllamaModelGatewayFromEnv({
        envConfig: {
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
          ...(input.credential?.apiKey === undefined
            ? {}
            : { apiKey: input.credential.apiKey }),
        },
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    case "lmstudio":
      return createLmStudioModelGatewayFromEnv({
        envConfig: {
          model: registration.modelId,
          baseUrl: registration.route.apiEndpoint,
          ...(input.credential?.apiKey === undefined
            ? {}
            : { apiKey: input.credential.apiKey }),
        },
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
    default:
      throw new Error(`model live qualification provider '${registration.providerId}' is unsupported`);
  }
}

function assertOpenRouterRouteEvidence(
  registration: ModelRegistrationV2,
  evidence: OpenRouterQualifiedRouteEvidence,
): void {
  const expected = registration.route.routing;
  if (
    evidence.modelId !== registration.modelId ||
    evidence.routing.kind !== expected.kind ||
    evidence.routing.policyId !== expected.policyId ||
    expected.allowedEndpointIds === undefined ||
    !sameStrings(evidence.routing.allowedEndpointIds, expected.allowedEndpointIds)
  ) {
    throw new Error("OpenRouter live qualification evidence does not match exact routing policy");
  }
  if (expected.kind === "fixed" && evidence.routing.allowedEndpointIds.length !== 1) {
    throw new Error("OpenRouter fixed live qualification route must name one provider endpoint");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    [...left].sort().every((entry, index) => entry === [...right].sort()[index]);
}

function endpointForRegistration(
  registration: ModelRegistrationV2,
): ExactQualificationEndpoint {
  const codec = registration.route.endpointCodec;
  const matches = (
    providerId: ModelRegistrationV2["providerId"],
    values: readonly string[],
    endpoint: ExactQualificationEndpoint,
  ) => {
    if (registration.providerId === providerId && values.includes(codec)) {
      return endpoint;
    }
    return undefined;
  };
  return (
    matches("openai", ["openai.chat.v2", "openai_chat_v2"], "chat") ??
    matches("openai", ["openai.responses.v2", "openai_responses_v2"], "responses") ??
    matches("anthropic", ["anthropic.messages.v2", "anthropic_messages_v2"], "messages") ??
    matches("openrouter", ["openrouter.chat.v2", "openrouter_chat_v2"], "chat") ??
    matches("openrouter", ["openrouter.responses.v2", "openrouter_responses_v2"], "responses") ??
    matches("ollama", ["ollama.openai-compatible.v1"], "chat") ??
    matches("lmstudio", ["lmstudio.openai-compatible.v1"], "chat") ??
    unsupportedCodec(registration)
  );
}

function unsupportedCodec(registration: ModelRegistrationV2): never {
  throw new Error(
    `model live qualification endpoint codec '${registration.route.endpointCodec}' is unsupported for provider '${registration.providerId}'`,
  );
}
