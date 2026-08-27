import { createExactModelQualificationGateway } from "../../../../models";
import type { OpenRouterQualifiedRouteEvidence } from "../../../../models/openrouter/OpenRouterV2Codec";
import {
  createModelRequestV2,
  createModelRegistrationV2,
  type ModelCapabilityClaimV2,
  type ModelCapabilityEvidenceV2,
  type ModelRegistrationV2,
  type ModelRequestRequirementsV2,
} from "../../../../src/kestrel/contracts/model-registration";
import {
  ModelQualificationService,
  runLiveModelQualification,
  type ModelCapabilityQualification,
  type ModelQualificationCapability,
  type ModelQualificationProbe,
} from "../../../../src/kestrel/model-qualification";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract";
import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";
import { createHostedModelQualificationProjection } from "./hosted-model-registration";

/** The only automatic approval profile. Advanced capabilities stay opt-in. */
export const HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES = [
  "provider_strict_schema",
  "native_tools",
  "required_tool_choice",
  "strict_tool_inputs",
] as const satisfies readonly ModelQualificationCapability[];

export const HOSTED_AGENT_LOOP_PROBE_REVISION = "hosted-agent-loop-v1";

type HostedAgentLoopCapability =
  (typeof HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES)[number];

/**
 * Runs the explicitly approved agent-loop probe set through the installed
 * provider codec. The caller must acquire the provider evidence first and
 * persist this result only after it rechecks the gateway revision.
 */
export async function qualifyHostedAgentLoopModel(input: {
  registration: ModelRegistrationV2;
  credential: { revision: string; apiKey: string };
  openRouterRouteEvidence?: OpenRouterQualifiedRouteEvidence | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}): Promise<{
  registration: ModelRegistrationV2;
  qualification: ReturnType<typeof createHostedModelQualificationProjection>;
  results: readonly ModelCapabilityQualification[];
}> {
  const gateway = createExactModelQualificationGateway({
    registration: input.registration,
    credential: input.credential,
    ...(input.openRouterRouteEvidence === undefined
      ? {}
      : { openRouterRouteEvidence: input.openRouterRouteEvidence }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const service = new ModelQualificationService({
    freshnessMs: 0,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const run = await runLiveModelQualification({
    service,
    registration: input.registration,
    credentialRevision: input.credential.revision,
    probeRevision: HOSTED_AGENT_LOOP_PROBE_REVISION,
    probes: hostedAgentLoopProbes(input.registration),
    gateway,
    maxProbes: HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES.length,
    force: true,
  });
  const unprovenFailure = run.results.find(
    (result) => result.outcome === "failed" && result.responseHash === undefined,
  );
  if (unprovenFailure !== undefined) {
    throw qualificationTransportError(unprovenFailure.failureCode);
  }
  const registration = applyHostedQualificationResults({
    registration: input.registration,
    results: run.results,
    checkedAt: run.checkedAt,
  });
  return {
    registration,
    qualification: createHostedModelQualificationProjection({
      registration,
      credentialRevision: input.credential.revision,
      state: registration.qualification.state === "qualified" ? "qualified" : "failed",
      checkedAt: run.checkedAt,
      probeRevision: HOSTED_AGENT_LOOP_PROBE_REVISION,
    }),
    results: run.results,
  };
}

/**
 * A capability result needs a verified model response. Transport, credential,
 * and codec failures are actionable approval failures—not evidence that the
 * model lacks a capability—so they must not be committed as a new proof.
 */
function qualificationTransportError(
  failureCode: string | undefined,
): GatewayModelProviderResolutionError {
  switch (failureCode) {
    case "MODEL_AUTH_ERROR":
      return new GatewayModelProviderResolutionError({
        message: "The provider rejected the gateway credential while qualifying the model.",
        status: 422,
        retryable: false,
      });
    case "MODEL_TIMEOUT":
      return new GatewayModelProviderResolutionError({
        message: "The provider timed out while qualifying the model. Try again.",
        status: 503,
        retryable: true,
      });
    case "MODEL_RATE_LIMITED":
      return new GatewayModelProviderResolutionError({
        message: "The provider rate-limited model qualification. Try again shortly.",
        status: 503,
        retryable: true,
      });
    case "MODEL_PROVIDER_ERROR":
    case "MODEL_NETWORK_DNS":
    case "MODEL_NETWORK_ERROR":
      return new GatewayModelProviderResolutionError({
        message: "The provider was unavailable while qualifying the model. Try again.",
        status: 503,
        retryable: true,
      });
    default:
      return new GatewayModelProviderResolutionError({
        message: "The provider returned no verified qualification response. Refresh the provider configuration and try again.",
        status: 422,
        retryable: false,
      });
  }
}

function hostedAgentLoopProbes(
  registration: ModelRegistrationV2,
): readonly ModelQualificationProbe[] {
  const endpoint = endpointForRegistration(registration);
  return HOSTED_AGENT_LOOP_QUALIFICATION_CAPABILITIES.map((capability) => {
    const requirements = requirementsFor(capability, endpoint);
    return {
      capability,
      request: createModelRequestV2({
        version: "model_request_v2",
        model: registration.modelId,
        input:
          requirements.tools.choice === "none"
            ? "Return exactly the JSON object {\"ok\":true}."
            : "Call probe_tool with an empty object and do not return prose.",
        responseFormat: requirements.output.kind === "text" ? "text" : "json",
        ...(requirements.output.kind === "json_schema"
          ? {
              responseSchema: {
                type: "object",
                properties: { ok: { type: "boolean" } },
                required: ["ok"],
                additionalProperties: false,
              },
            }
          : {}),
        ...(requirements.tools.choice === "none"
          ? {}
          : {
              tools: [{
                name: "probe_tool",
                description: "Qualification probe. Call with an empty object.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              }],
            }),
        requirements,
      }),
    };
  });
}

function requirementsFor(
  capability: HostedAgentLoopCapability,
  endpoint: ModelRequestRequirementsV2["endpoint"],
): ModelRequestRequirementsV2 {
  const tools: ModelRequestRequirementsV2["tools"] = {
    choice: "none",
    strictArguments: false,
    parallelism: "forbidden" as const,
  };
  if (capability === "native_tools") tools.choice = "auto";
  if (capability === "required_tool_choice") tools.choice = "required";
  if (capability === "strict_tool_inputs") {
    tools.choice = "required";
    tools.strictArguments = true;
  }
  return {
    runtimeRole: `qualification.${capability}`,
    output:
      capability === "provider_strict_schema"
        ? {
            kind: "json_schema",
            assurance: "provider_strict_schema",
            schemaName: "qualification_probe",
          }
        : { kind: "text", assurance: "none" },
    tools,
    reasoning: { mode: "off", continuationKinds: [] },
    streaming: { required: false, terminalBehavior: "not_required" },
    inputModalities: ["text"],
    endpoint,
  };
}

function endpointForRegistration(
  registration: ModelRegistrationV2,
): ModelRequestRequirementsV2["endpoint"] {
  const codec = registration.route.endpointCodec;
  if (codec === "openai.chat.v2" || codec === "openrouter.chat.v2") return "chat";
  if (codec === "openai.responses.v2" || codec === "openrouter.responses.v2") return "responses";
  if (codec === "anthropic.messages.v2") return "messages";
  throw new Error(`Hosted qualification has no probe endpoint for codec '${codec}'.`);
}

function applyHostedQualificationResults(input: {
  registration: ModelRegistrationV2;
  results: readonly ModelCapabilityQualification[];
  checkedAt: string;
}): ModelRegistrationV2 {
  const { fingerprint: _fingerprint, ...authoring } = input.registration;
  const byCapability = new Map(input.results.map((result) => [result.capability, result]));
  const qualificationRevision = HOSTED_AGENT_LOOP_PROBE_REVISION;
  const evidenceFor = (result: ModelCapabilityQualification): ModelCapabilityEvidenceV2 => ({
    source: "qualification",
    observedRevision: input.registration.revision,
    observedAt: input.checkedAt,
    adapterRevision: input.registration.adapterRevision,
    ...(input.registration.credentialRevision === undefined
      ? {}
      : { credentialRevision: input.registration.credentialRevision }),
    qualificationRevision,
    retainedPayloadHash: hashCanonical({
      capability: result.capability,
      outcome: result.outcome,
      requestHash: result.requestHash,
      responseHash: result.responseHash ?? null,
      terminalState: result.terminalState ?? null,
      validationOutcome: result.validationOutcome,
      failureCode: result.failureCode ?? null,
      binding: result.binding,
    }),
  });
  const apply = (
    capability: HostedAgentLoopCapability,
    claim: ModelCapabilityClaimV2,
  ): ModelCapabilityClaimV2 => {
    const result = byCapability.get(capability);
    // Provider evidence is a lower-bound contract. A successful response must
    // not upgrade a capability the exact provider route declared unsupported.
    if (result === undefined || claim.state === "unsupported") return claim;
    return {
      state:
        result.outcome === "qualified"
          ? "qualified"
          : result.outcome === "unsupported"
            ? "unsupported"
            : "failed",
      evidence: [...claim.evidence, evidenceFor(result)],
    };
  };
  const hasQualifiedCapability = input.results.some(
    (result) => result.outcome === "qualified",
  );
  return createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: hasQualifiedCapability ? "qualified" : "failed",
      revision: qualificationRevision,
      checkedAt: input.checkedAt,
      probeHash: hashCanonical(
        input.results.map((result) => ({
          capability: result.capability,
          requestHash: result.requestHash,
          responseHash: result.responseHash ?? null,
          outcome: result.outcome,
        })),
      ),
    },
    capabilities: {
      ...authoring.capabilities,
      providerStrictSchema: apply(
        "provider_strict_schema",
        authoring.capabilities.providerStrictSchema,
      ),
      nativeTools: apply("native_tools", authoring.capabilities.nativeTools),
      requiredToolChoice: apply(
        "required_tool_choice",
        authoring.capabilities.requiredToolChoice,
      ),
      strictToolInputs: apply(
        "strict_tool_inputs",
        authoring.capabilities.strictToolInputs,
      ),
    },
  });
}
