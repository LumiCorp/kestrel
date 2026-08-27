import type { ModelGatewayCallOptions, ModelRequest } from "./contracts/model-io.js";
import {
  createModelRequestV2,
  normalizeModelRequestV2,
  parseModelRegistrationV2,
  type ModelCapabilityClaimV2,
  type ModelRegistrationV2,
  type ModelRequestV2,
} from "./contracts/model-registration.js";
import type { QualifiedModelCredentialRouteBindingV2 } from "./contracts/model-route.js";
import { hashCanonical } from "./contracts/tool-contract.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

export const EFFECTIVE_MODEL_CONTRACT_V1 =
  "effective_model_contract_v1" as const;

export type ExactModelEndpointV1 = "chat" | "responses" | "messages";

/**
 * Secret-free immutable admission evidence carried alongside a model call.
 * It is call-option state rather than request metadata, so provider codecs
 * never serialize it to an upstream provider.
 */
export interface EffectiveModelContractV1 {
  version: typeof EFFECTIVE_MODEL_CONTRACT_V1;
  status: "qualified" | "legacy_compatibility";
  providerId?: ModelRegistrationV2["providerId"] | undefined;
  modelId?: string | undefined;
  registrationId?: string | undefined;
  registrationRevision?: string | undefined;
  registrationFingerprint?: string | undefined;
  qualificationRevision?: string | undefined;
  credentialRevision?: number | undefined;
  apiEndpoint?: string | undefined;
  endpoint?: ExactModelEndpointV1 | "legacy" | undefined;
  endpointCodec: string;
  routingPolicyFingerprint?: string | undefined;
  runtimeRole: string;
  requestFingerprint: string;
  schemaHash: string;
  toolSurfaceHash: string;
  fingerprint: string;
}

export interface EffectiveModelContractAdmissionV1 {
  request: ModelRequest;
  contract: EffectiveModelContractV1;
}

/** Runtime dependencies supply immutable registration snapshots, never UI metadata. */
export interface EffectiveModelContractResolverV1 {
  admit(input: { request: ModelRequest }):
    | EffectiveModelContractAdmissionV1
    | Promise<EffectiveModelContractAdmissionV1>;
}

export interface ExactEffectiveModelContractSnapshotV1 {
  registration: ModelRegistrationV2;
  routeBinding: QualifiedModelCredentialRouteBindingV2;
  /** Chosen by the registration-owning codec, not inferred from a model name. */
  endpoint: ExactModelEndpointV1;
}

/**
 * V2 codec revisions name one concrete provider endpoint. Unknown codecs are
 * deliberately not inferred: they require a new explicit contract revision.
 */
export function resolveExactModelEndpointV1(
  endpointCodec: string,
): ExactModelEndpointV1 {
  switch (endpointCodec) {
    case "openai.chat.v2":
    case "openrouter.chat.v2":
      return "chat";
    case "openai.responses.v2":
    case "openrouter.responses.v2":
      return "responses";
    case "anthropic.messages.v2":
      return "messages";
    default:
      throw createRuntimeFailure(
        "MODEL_ENDPOINT_CODEC_UNSUPPORTED",
        "The qualified model registration declares an unsupported endpoint codec.",
        { endpointCodec },
      );
  }
}

export function createExactEffectiveModelContractResolverV1(
  input: ExactEffectiveModelContractSnapshotV1,
): EffectiveModelContractResolverV1 {
  const registration = parseModelRegistrationV2(input.registration);
  assertExactBinding(registration, input.routeBinding);
  const endpoint = input.endpoint;

  return Object.freeze({
    admit({ request }: { request: ModelRequest }): EffectiveModelContractAdmissionV1 {
      const normalized = normalizeModelRequestV2(request);
      if (
        normalized.model !== undefined &&
        normalized.model !== registration.modelId
      ) {
        throw routeMismatch("The request model does not match the exact registered route.");
      }
      if (
        normalized.requirements.runtimeRole !== input.routeBinding.requiredRole
      ) {
        throw routeMismatch("The request runtime role does not match the exact registered route.");
      }
      if (
        normalized.requirements.endpoint !== "any" &&
        normalized.requirements.endpoint !== endpoint
      ) {
        throw routeMismatch("The request endpoint does not match the exact registered route.");
      }
      for (const continuation of normalized.reasoning?.continuation ?? []) {
        if (continuation.provider !== registration.providerId) {
          throw createRuntimeFailure(
            "MODEL_CONTINUATION_PROVIDER_MISMATCH",
            "Reasoning continuation does not belong to the exact registered provider.",
            {
              provider: registration.providerId,
              continuationProvider: continuation.provider,
            },
          );
        }
      }

      const { fingerprints: _fingerprints, ...requestAuthoring } = normalized;
      const admittedRequest = createModelRequestV2({
        ...requestAuthoring,
        model: registration.modelId,
        requirements: { ...normalized.requirements, endpoint },
      });
      assertQualifiedRequirements(registration, admittedRequest);
      return Object.freeze({
        request: admittedRequest,
        contract: createEffectiveModelContractV1({
          status: "qualified",
          providerId: registration.providerId,
          modelId: registration.modelId,
          registrationId: registration.registrationId,
          registrationRevision: registration.revision,
          registrationFingerprint: registration.fingerprint,
          qualificationRevision: input.routeBinding.qualificationRevision,
          credentialRevision: input.routeBinding.credentialRevision,
          apiEndpoint: registration.route.apiEndpoint,
          endpoint,
          endpointCodec: registration.route.endpointCodec,
          routingPolicyFingerprint: input.routeBinding.routingPolicyFingerprint,
          runtimeRole: admittedRequest.requirements.runtimeRole,
          requestFingerprint: admittedRequest.fingerprints.request,
          schemaHash: admittedRequest.fingerprints.schema,
          toolSurfaceHash: admittedRequest.fingerprints.toolSurface,
        }),
      });
    },
  });
}

/** Explicit compatibility path for routes without exact evidence. */
export const legacyEffectiveModelContractResolverV1: EffectiveModelContractResolverV1 =
  Object.freeze({
    admit({ request }: { request: ModelRequest }): EffectiveModelContractAdmissionV1 {
      // Runtime metadata can carry established orchestration counters whose
      // field names are intentionally rejected from persisted V2 contract
      // metadata. Legacy compatibility still has to preserve that transport
      // metadata for the provider call, so exclude it only from the local
      // admission view used to derive requirements and fingerprints.
      const normalized = normalizeLegacyAdmissionRequest(request);
      assertLegacyTextOnly(normalized);
      return Object.freeze({
        request,
        contract: createEffectiveModelContractV1({
          status: "legacy_compatibility",
          endpoint: "legacy",
          endpointCodec: "legacy_unqualified",
          runtimeRole: normalized.requirements.runtimeRole,
          requestFingerprint: normalized.fingerprints.request,
          schemaHash: normalized.fingerprints.schema,
          toolSurfaceHash: normalized.fingerprints.toolSurface,
        }),
      });
    },
  });

function normalizeLegacyAdmissionRequest(request: ModelRequest): ModelRequestV2 {
  const { metadata: _metadata, ...contractView } = request;
  return normalizeModelRequestV2(contractView);
}

export function createEffectiveModelContractV1(
  value: Omit<EffectiveModelContractV1, "version" | "fingerprint">,
): EffectiveModelContractV1 {
  const contract = {
    version: EFFECTIVE_MODEL_CONTRACT_V1,
    ...value,
  } as Omit<EffectiveModelContractV1, "fingerprint">;
  return Object.freeze({
    ...contract,
    fingerprint: hashCanonical(contract),
  });
}

/** Strict parser for the broker's defense-in-depth boundary. */
export function parseEffectiveModelContractV1(
  value: unknown,
): EffectiveModelContractV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("effective model contract must be an object");
  }
  const record = value as Record<string, unknown>;
  const fields = new Set([
    "version", "status", "providerId", "modelId", "registrationId",
    "registrationRevision", "registrationFingerprint", "qualificationRevision",
    "credentialRevision", "apiEndpoint", "endpoint", "endpointCodec",
    "routingPolicyFingerprint", "runtimeRole", "requestFingerprint", "schemaHash",
    "toolSurfaceHash", "fingerprint",
  ]);
  for (const field of Object.keys(record)) {
    if (!fields.has(field)) throw new Error(`effective model contract contains unsupported field '${field}'`);
  }
  if (record.version !== EFFECTIVE_MODEL_CONTRACT_V1) {
    throw new Error("effective model contract version is invalid");
  }
  const status = requireEnum(record.status, ["qualified", "legacy_compatibility"] as const, "status");
  const required = (field: string) => requireString(record[field], field);
  const optional = (field: string) => record[field] === undefined ? undefined : requireString(record[field], field);
  const credentialRevision = record.credentialRevision;
  if (
    credentialRevision !== undefined &&
    (typeof credentialRevision !== "number" ||
      !Number.isSafeInteger(credentialRevision) ||
      credentialRevision <= 0)
  ) {
    throw new Error("effective model contract credentialRevision is invalid");
  }
  const endpoint = record.endpoint === undefined
    ? undefined
    : requireEnum(record.endpoint, ["chat", "responses", "messages", "legacy"] as const, "endpoint");
  const contract = createEffectiveModelContractV1({
    status,
    ...(optional("providerId") !== undefined ? { providerId: optional("providerId") as ModelRegistrationV2["providerId"] } : {}),
    ...(optional("modelId") !== undefined ? { modelId: optional("modelId") } : {}),
    ...(optional("registrationId") !== undefined ? { registrationId: optional("registrationId") } : {}),
    ...(optional("registrationRevision") !== undefined ? { registrationRevision: optional("registrationRevision") } : {}),
    ...(optional("registrationFingerprint") !== undefined ? { registrationFingerprint: optional("registrationFingerprint") } : {}),
    ...(optional("qualificationRevision") !== undefined ? { qualificationRevision: optional("qualificationRevision") } : {}),
    ...(credentialRevision !== undefined ? { credentialRevision } : {}),
    ...(optional("apiEndpoint") !== undefined ? { apiEndpoint: optional("apiEndpoint") } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    endpointCodec: required("endpointCodec"),
    ...(optional("routingPolicyFingerprint") !== undefined ? { routingPolicyFingerprint: optional("routingPolicyFingerprint") } : {}),
    runtimeRole: required("runtimeRole"),
    requestFingerprint: requireHash(record.requestFingerprint, "requestFingerprint"),
    schemaHash: requireHash(record.schemaHash, "schemaHash"),
    toolSurfaceHash: requireHash(record.toolSurfaceHash, "toolSurfaceHash"),
  });
  if (requireHash(record.fingerprint, "fingerprint") !== contract.fingerprint) {
    throw new Error("effective model contract fingerprint does not match canonical content");
  }
  if (status === "qualified") {
    for (const field of ["providerId", "modelId", "registrationId", "registrationRevision", "registrationFingerprint", "qualificationRevision", "apiEndpoint", "endpoint", "routingPolicyFingerprint"] as const) {
      if (contract[field] === undefined) throw new Error(`qualified effective model contract requires ${field}`);
    }
  }
  return contract;
}

function assertExactBinding(
  registration: ModelRegistrationV2,
  binding: QualifiedModelCredentialRouteBindingV2,
): void {
  if (
    binding.provider !== registration.providerId ||
    binding.rawModelId !== registration.modelId ||
    binding.registrationId !== registration.registrationId ||
    binding.registrationRevision !== registration.revision ||
    binding.registrationFingerprint !== registration.fingerprint ||
    binding.qualificationRevision !== registration.qualification.revision ||
    registration.credentialRevision !== String(binding.credentialRevision) ||
    binding.apiEndpoint !== registration.route.apiEndpoint ||
    binding.endpointCodec !== registration.route.endpointCodec ||
    binding.routingPolicyFingerprint !== hashCanonical(registration.route.routing)
  ) {
    throw routeMismatch("The qualified route binding does not match its exact registration.");
  }
  if (registration.qualification.state !== "qualified") {
    throw capabilityFailure("qualification", registration.qualification.state);
  }
}

function assertQualifiedRequirements(
  registration: ModelRegistrationV2,
  request: ModelRequestV2,
): void {
  const { capabilities } = registration;
  const requiredCapabilities = requirementsFor(request);
  if (requiredCapabilities.has("json_syntax")) requireQualified("json_syntax", capabilities.jsonSyntax);
  if (requiredCapabilities.has("local_schema_validation")) requireQualified("local_schema_validation", capabilities.localSchemaValidation);
  if (requiredCapabilities.has("provider_strict_schema")) requireQualified("provider_strict_schema", capabilities.providerStrictSchema);
  if (requiredCapabilities.has("native_tools")) requireQualified("native_tools", capabilities.nativeTools);
  if (requiredCapabilities.has("required_tool_choice")) requireQualified("required_tool_choice", capabilities.requiredToolChoice);
  if (requiredCapabilities.has("strict_tool_inputs")) requireQualified("strict_tool_inputs", capabilities.strictToolInputs);
  if (requiredCapabilities.has("parallel_tool_calls")) requireQualified("parallel_tool_calls", capabilities.parallelToolCalls);
  if (request.requirements.reasoning.mode !== "off") {
    requireQualified("reasoning", capabilities.reasoning);
    if (!capabilities.reasoning.modes.includes(request.requirements.reasoning.mode)) {
      throw capabilityFailure("reasoning_mode", capabilities.reasoning.state);
    }
  }
  if (request.requirements.reasoning.continuationKinds.length > 0) {
    requireQualified("continuation", capabilities.continuation);
    for (const kind of request.requirements.reasoning.continuationKinds) {
      if (!capabilities.continuation.kinds.includes(kind)) {
        throw capabilityFailure("continuation_kind", capabilities.continuation.state);
      }
    }
  }
  if (request.requirements.streaming.required) requireQualified("streaming_terminal", capabilities.streaming);
  for (const modality of request.requirements.inputModalities) {
    const claim = capabilities.inputModalities[modality];
    if (claim.state !== "declared" && claim.state !== "qualified") {
      throw capabilityFailure(`input_${modality}`, claim.state);
    }
  }
}

function requirementsFor(request: ModelRequestV2): Set<string> {
  const requirements = new Set<string>();
  if (request.requirements.output.assurance === "json_syntax") requirements.add("json_syntax");
  if (request.requirements.output.assurance === "local_schema_validation") requirements.add("local_schema_validation");
  if (request.requirements.output.assurance === "provider_strict_schema") requirements.add("provider_strict_schema");
  if (request.requirements.tools.choice !== "none") requirements.add("native_tools");
  if (request.requirements.tools.choice === "required" || request.requirements.tools.choice === "named") requirements.add("required_tool_choice");
  if (request.requirements.tools.strictArguments) requirements.add("strict_tool_inputs");
  if (request.requirements.tools.parallelism === "required") requirements.add("parallel_tool_calls");
  return requirements;
}

function requireQualified(capability: string, claim: ModelCapabilityClaimV2): void {
  if (claim.state !== "qualified") throw capabilityFailure(capability, claim.state);
}

function assertLegacyTextOnly(request: ModelRequestV2): void {
  const { requirements } = request;
  if (
    requirements.output.kind !== "text" ||
    requirements.tools.choice !== "none" ||
    requirements.tools.strictArguments ||
    requirements.tools.parallelism !== "forbidden" ||
    requirements.reasoning.mode !== "off" ||
    requirements.reasoning.continuationKinds.length > 0 ||
    requirements.streaming.required ||
    requirements.inputModalities.some((modality) => modality !== "text")
  ) {
    throw createRuntimeFailure(
      "MODEL_LEGACY_CONTRACT_UNSUPPORTED",
      "Legacy model routes may execute plain-text calls only until exact capabilities are qualified.",
      { evidenceState: "legacy_unqualified" },
    );
  }
}

function capabilityFailure(capability: string, state: string): ReturnType<typeof createRuntimeFailure> {
  const code = state === "stale"
    ? "MODEL_QUALIFICATION_STALE"
    : state === "failed"
      ? "MODEL_CAPABILITY_FAILED"
      : state === "unsupported"
        ? "MODEL_CAPABILITY_UNSUPPORTED"
        : "MODEL_CAPABILITY_UNQUALIFIED";
  return createRuntimeFailure(code, `Model capability '${capability}' is ${state}.`, { capability, evidenceState: state });
}

function routeMismatch(message: string): ReturnType<typeof createRuntimeFailure> {
  return createRuntimeFailure("MODEL_ROUTE_MISMATCH", message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`effective model contract ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new Error(`effective model contract ${field} must be a sha256 hash`);
  }
  return hash;
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`effective model contract ${field} is invalid`);
  }
  return value as T;
}

declare module "./contracts/model-io.js" {
  interface ModelGatewayCallOptions {
    /** Runtime-only admission evidence; adapters must not serialize this. */
    effectiveModelContract?: EffectiveModelContractV1 | undefined;
  }
}
