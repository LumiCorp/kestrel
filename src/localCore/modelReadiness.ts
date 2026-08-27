import { DEFAULT_ANTHROPIC_BASE_URL } from "../../models/anthropic/AnthropicEnv.js";
import { DEFAULT_LMSTUDIO_BASE_URL } from "../../models/lmstudio/LmStudioEnv.js";
import { DEFAULT_OPENAI_BASE_URL } from "../../models/openai/OpenAiEnv.js";
import { DEFAULT_OPENROUTER_BASE_URL } from "../../models/openrouter/OpenRouterEnv.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../models/ollama/OllamaEnv.js";
import { getModelProviderAdapterV1 } from "../../models/ProviderRegistry.js";
import { createExactModelQualificationGateway } from "../../models/ExactModelQualificationGateway.js";
import {
  MODEL_REGISTRATION_V2_VERSION,
  createModelRequestV2,
  createModelRegistrationV2,
  parseModelRegistrationV2,
  type ModelCapabilityClaimV2,
  type ModelCapabilityEvidenceV2,
  type ModelRegistrationV2,
  type ProviderRuntimeConfigurationV1,
} from "../kestrel/contracts/model-registration.js";
import {
  ModelQualificationService,
  runLiveModelQualification,
  type ModelCapabilityQualification,
  type ModelQualificationProbe,
} from "../kestrel/model-qualification.js";
import { hashCanonical } from "../kestrel/contracts/tool-contract.js";
import type { LocalCoreDesktopProfileSnapshot } from "./contracts.js";
import type { LocalCoreRuntimeConfigurationV1 } from "./runtimeConfiguration.js";

export const LOCAL_CORE_MODEL_READINESS_VERSION = 1;

/**
 * This is the Local Core-owned projection sent to Desktop and then to a
 * hosted Desktop Environment. It deliberately contains a V2 registration,
 * not a client-authored capability summary.
 */
export interface LocalCoreModelReadiness {
  version: typeof LOCAL_CORE_MODEL_READINESS_VERSION;
  registration: ModelRegistrationV2;
  reachability: "unknown" | "reachable" | "unreachable";
  qualification: "pending" | "qualified" | "failed" | "stale";
  eligibleRoles: string[];
  unavailableRoles: Array<{
    role: string;
    reason: string;
  }>;
}

type StoredLocalCoreModelReadiness = {
  version: 1;
  registrations: ModelRegistrationV2[];
};

/**
 * Qualification history is local, secret-free, and append-only. A new route
 * identity never overwrites the registration that proved an earlier run.
 */
export class LocalCoreModelReadinessStore {
  readonly #filePath: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(homePath: string) {
    this.#filePath = path.join(homePath, "settings", "model-readiness-v1.json");
  }

  async readCurrent(
    current: ModelRegistrationV2,
  ): Promise<LocalCoreModelReadiness | undefined> {
    return await this.#withLock(async () => {
      const stored = await this.#read();
      const match = [...stored.registrations]
        .reverse()
        .find((candidate) => sameRouteIdentity(candidate, current));
      return match === undefined ? undefined : readinessForRegistration(match);
    });
  }

  async append(registration: ModelRegistrationV2): Promise<void> {
    await this.#withLock(async () => {
      const stored = await this.#read();
      const parsed = parseModelRegistrationV2(registration);
      if (stored.registrations.some((entry) => entry.fingerprint === parsed.fingerprint)) {
        return;
      }
      await this.#write({
        version: 1,
        registrations: [...stored.registrations, parsed],
      });
    });
  }

  async #read(): Promise<StoredLocalCoreModelReadiness> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        (value as { version?: unknown }).version !== 1 ||
        !Array.isArray((value as { registrations?: unknown }).registrations)
      ) {
        throw new Error("Local Core model readiness history is invalid.");
      }
      return {
        version: 1,
        registrations: (value as { registrations: unknown[] }).registrations.map(
          parseModelRegistrationV2,
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, registrations: [] };
      }
      throw error;
    }
  }

  async #write(value: StoredLocalCoreModelReadiness): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

/**
 * Build a route-specific registration from the same configuration snapshot
 * the runner will use. Catalog membership is intentionally not an input: a
 * selected route is visible while its strict capabilities remain unproved.
 */
export function createLocalCoreModelReadiness(input: {
  runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  profile: Pick<LocalCoreDesktopProfileSnapshot, "modelProvider" | "model">;
  credentialRevision?: string | undefined;
  baseEnv?: Readonly<NodeJS.ProcessEnv> | undefined;
  observedAt?: string | undefined;
  now?: (() => Date) | undefined;
}): LocalCoreModelReadiness {
  const { runtimeConfiguration, profile } = input;
  const providerConfiguration = providerConfigurationFor({
    runtimeConfiguration,
    provider: profile.modelProvider,
    baseEnv: input.baseEnv,
  });
  const adapter = getModelProviderAdapterV1(profile.modelProvider);
  const revision = `local-core-${hashCanonical({
    generation: runtimeConfiguration.generation,
    profile: {
      provider: profile.modelProvider,
      model: profile.model,
    },
    providerConfiguration,
  }).slice("sha256:".length)}`;
  const evidence: ModelCapabilityEvidenceV2 = {
    source: "adapter_manifest",
    observedRevision: revision,
    observedAt: input.observedAt ?? (input.now ?? (() => new Date()))().toISOString(),
    adapterRevision: adapter.factoryId,
    ...(input.credentialRevision === undefined
      ? {}
      : { credentialRevision: input.credentialRevision }),
    retainedPayloadHash: hashCanonical({
      runtimeConfigurationGeneration: runtimeConfiguration.generation,
      provider: profile.modelProvider,
      model: profile.model,
      endpoint: providerConfiguration.endpoint,
      adapter: adapter.factoryId,
    }),
  };
  const unsupported = (): ModelCapabilityClaimV2 => ({
    state: "unsupported",
    evidence: [evidence],
  });
  const declared = (): ModelCapabilityClaimV2 => ({
    state: "declared",
    evidence: [evidence],
  });
  const supportsLocalSchemaQualification =
    profile.modelProvider === "ollama" || profile.modelProvider === "lmstudio";
  const registration = createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: `local-core-${hashCanonical({
      provider: profile.modelProvider,
      model: profile.model,
      endpoint: providerConfiguration.endpoint,
    }).slice("sha256:".length)}`,
    providerId: profile.modelProvider,
    modelId: profile.model,
    providerConfiguration,
    route: {
      apiEndpoint: providerConfiguration.endpoint,
      endpointCodec: resolveLocalCoreModelRoute({
        runtimeConfiguration,
        provider: profile.modelProvider,
        baseEnv: input.baseEnv,
      }).endpointCodec,
      routing: {
        kind: "fixed",
        policyId: `local-core-${profile.modelProvider}-fixed-v1`,
        requireParameters: true,
      },
    },
    revision,
    adapterRevision: adapter.factoryId,
    ...(input.credentialRevision === undefined
      ? {}
      : { credentialRevision: input.credentialRevision }),
    providerEvidence: [evidence],
    qualification: { state: "pending" },
    capabilities: {
      jsonSyntax: supportsLocalSchemaQualification ? declared() : unsupported(),
      localSchemaValidation: supportsLocalSchemaQualification
        ? declared()
        : unsupported(),
      providerStrictSchema: unsupported(),
      nativeTools: unsupported(),
      requiredToolChoice: unsupported(),
      strictToolInputs: unsupported(),
      parallelToolCalls: unsupported(),
      reasoning: { ...unsupported(), modes: ["off"] },
      continuation: { ...unsupported(), kinds: [] },
      streaming: { ...unsupported(), terminalEvents: [] },
      inputModalities: {
        text: unsupported(),
        image: unsupported(),
      },
      limits: {
        context: { kind: "model_specific" },
        output: { kind: "model_specific" },
        evidence: [evidence],
      },
      cache: { ...unsupported(), read: false, write: false, scope: "none" },
    },
  });
  return {
    version: LOCAL_CORE_MODEL_READINESS_VERSION,
    registration,
    reachability: "unknown",
    qualification: "pending",
    eligibleRoles: [],
    unavailableRoles: [
      {
        role: "agent.loop",
        reason:
          "This exact local route needs a current capability qualification before it can run agent work.",
      },
    ],
  };
}

/**
 * Explicit, bounded Local Core qualification. It exercises the installed
 * local adapter and shared response verifier; it never upgrades strict model
 * capabilities from OpenAI-compatible transport syntax.
 */
export async function qualifyLocalCoreModelReadiness(input: {
  readiness: LocalCoreModelReadiness;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
}): Promise<LocalCoreModelReadiness> {
  const registration = input.readiness.registration;
  if (
    registration.providerId !== "ollama" &&
    registration.providerId !== "lmstudio"
  ) {
    throw new Error(
      "Local Core qualification requires a local provider route with an exact local codec.",
    );
  }
  const gateway = createExactModelQualificationGateway({
    registration,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  const service = new ModelQualificationService({
    freshnessMs: 0,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const run = await runLiveModelQualification({
    service,
    registration,
    probeRevision: "local-core-schema-validation-v1",
    probes: localSchemaValidationProbes(registration),
    gateway,
    maxProbes: 1,
    force: true,
  });
  const failedWithoutProof = run.results.find(
    (result) => result.outcome === "failed" && result.responseHash === undefined,
  );
  if (failedWithoutProof !== undefined) {
    throw new Error(
      `Local Core qualification could not verify this route (${failedWithoutProof.failureCode ?? "MODEL_QUALIFICATION_FAILED"}).`,
    );
  }
  const qualified = applyLocalSchemaQualification({
    registration,
    result: run.results[0]!,
    checkedAt: run.checkedAt,
  });
  return readinessForRegistration(qualified);
}

export function isLocalCoreModelRoleReady(
  readiness: Pick<LocalCoreModelReadiness, "eligibleRoles">,
  role: string = "agent.loop",
): boolean {
  return readiness.eligibleRoles.includes(role);
}

/** The local and hosted agent loop share these strict contract requirements. */
export function deriveLocalCoreEligibleRoles(
  registration: ModelRegistrationV2,
): string[] {
  const strictAgentLoopReady =
    registration.qualification.state === "qualified" &&
    registration.capabilities.providerStrictSchema.state === "qualified" &&
    registration.capabilities.nativeTools.state === "qualified" &&
    registration.capabilities.requiredToolChoice.state === "qualified" &&
    registration.capabilities.strictToolInputs.state === "qualified";
  return strictAgentLoopReady ? ["agent.loop"] : [];
}

function localSchemaValidationProbes(
  registration: ModelRegistrationV2,
): readonly ModelQualificationProbe[] {
  return [{
    capability: "local_schema_validation",
    request: createModelRequestV2({
      version: "model_request_v2",
      model: registration.modelId,
      input: "Return exactly the JSON object {\"ok\":true}.",
      responseFormat: "json",
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      requirements: {
        runtimeRole: "qualification.local_schema_validation",
        output: {
          kind: "json_schema",
          assurance: "local_schema_validation",
          schemaName: "qualification_probe",
        },
        tools: {
          choice: "none",
          strictArguments: false,
          parallelism: "forbidden",
        },
        reasoning: { mode: "off", continuationKinds: [] },
        streaming: { required: false, terminalBehavior: "not_required" },
        inputModalities: ["text"],
        endpoint: "chat",
      },
    }),
  }];
}

function applyLocalSchemaQualification(input: {
  registration: ModelRegistrationV2;
  result: ModelCapabilityQualification;
  checkedAt: string;
}): ModelRegistrationV2 {
  const { fingerprint: _fingerprint, ...authoring } = input.registration;
  const qualificationRevision = "local-core-schema-validation-v1";
  const evidence: ModelCapabilityEvidenceV2 = {
    source: "qualification",
    observedRevision: authoring.revision,
    observedAt: input.checkedAt,
    adapterRevision: authoring.adapterRevision,
    ...(authoring.credentialRevision === undefined
      ? {}
      : { credentialRevision: authoring.credentialRevision }),
    qualificationRevision,
    retainedPayloadHash: hashCanonical({
      capability: input.result.capability,
      outcome: input.result.outcome,
      requestHash: input.result.requestHash,
      responseHash: input.result.responseHash ?? null,
      terminalState: input.result.terminalState ?? null,
      validationOutcome: input.result.validationOutcome,
      failureCode: input.result.failureCode ?? null,
      binding: input.result.binding,
    }),
  };
  const qualified = input.result.outcome === "qualified";
  const localSchemaValidation = {
    state: qualified ? "qualified" : "failed",
    evidence: [...authoring.capabilities.localSchemaValidation.evidence, evidence],
  } as ModelCapabilityClaimV2;
  return createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: qualified ? "qualified" : "failed",
      revision: qualificationRevision,
      checkedAt: input.checkedAt,
      probeHash: hashCanonical([{
        capability: input.result.capability,
        requestHash: input.result.requestHash,
        responseHash: input.result.responseHash ?? null,
        outcome: input.result.outcome,
      }]),
    },
    capabilities: {
      ...authoring.capabilities,
      localSchemaValidation,
    },
  });
}

function readinessForRegistration(
  registration: ModelRegistrationV2,
): LocalCoreModelReadiness {
  const eligibleRoles = deriveLocalCoreEligibleRoles(registration);
  return {
    version: LOCAL_CORE_MODEL_READINESS_VERSION,
    registration,
    reachability: "unknown",
    qualification:
      registration.qualification.state === "legacy_unqualified"
        ? "stale"
        : registration.qualification.state,
    eligibleRoles,
    unavailableRoles: eligibleRoles.includes("agent.loop")
      ? []
      : [{
          role: "agent.loop",
          reason:
            "This exact local route has no current qualification for strict schema and required tool work.",
        }],
  };
}

function sameRouteIdentity(
  left: ModelRegistrationV2,
  right: ModelRegistrationV2,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.revision === right.revision &&
    left.adapterRevision === right.adapterRevision &&
    left.credentialRevision === right.credentialRevision &&
    left.route.apiEndpoint === right.route.apiEndpoint &&
    left.route.endpointCodec === right.route.endpointCodec &&
    hashCanonical(left.route.routing) === hashCanonical(right.route.routing)
  );
}

/**
 * The runner and the published readiness snapshot both use this resolver.
 * In inherit mode, an explicit environment endpoint is effective; in replace
 * mode, only Local Core's persisted configuration can override the adapter
 * default.
 */
export function resolveLocalCoreModelRoute(input: {
  runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  provider: LocalCoreDesktopProfileSnapshot["modelProvider"];
  baseEnv?: Readonly<NodeJS.ProcessEnv> | undefined;
}): {
  endpoint: string;
  endpointCodec: string;
  protocol: ProviderRuntimeConfigurationV1["protocol"];
} {
  const { providers } = input.runtimeConfiguration;
  const inherited =
    input.runtimeConfiguration.environmentOptionsMode === "inherit"
      ? input.baseEnv
      : undefined;
  switch (input.provider) {
    case "openrouter":
      return {
        endpoint:
          providers.openrouter.baseUrl ??
          inherited?.OPENROUTER_BASE_URL ??
          DEFAULT_OPENROUTER_BASE_URL,
        endpointCodec: "openrouter.chat.v2",
        protocol: "openrouter",
      };
    case "openai":
      return {
        endpoint:
          providers.openai.baseUrl ??
          inherited?.OPENAI_BASE_URL ??
          DEFAULT_OPENAI_BASE_URL,
        endpointCodec: "openai.chat.v2",
        protocol: "openai",
      };
    case "anthropic":
      return {
        endpoint:
          providers.anthropic.baseUrl ??
          inherited?.ANTHROPIC_BASE_URL ??
          DEFAULT_ANTHROPIC_BASE_URL,
        endpointCodec: "anthropic.messages.v2",
        protocol: "anthropic",
      };
    case "ollama":
      return {
        endpoint:
          providers.ollama.baseUrl ??
          inherited?.OLLAMA_BASE_URL ??
          DEFAULT_OLLAMA_BASE_URL,
        endpointCodec: "ollama.openai-compatible.v1",
        protocol: "openai",
      };
    case "lmstudio":
      return {
        endpoint:
          providers.lmstudio.baseUrl ??
          inherited?.LMSTUDIO_BASE_URL ??
          DEFAULT_LMSTUDIO_BASE_URL,
        endpointCodec: "lmstudio.openai-compatible.v1",
        protocol: "openai",
      };
  }
}

function providerConfigurationFor(input: {
  runtimeConfiguration: LocalCoreRuntimeConfigurationV1;
  provider: LocalCoreDesktopProfileSnapshot["modelProvider"];
  baseEnv?: Readonly<NodeJS.ProcessEnv> | undefined;
}): ProviderRuntimeConfigurationV1 {
  const route = resolveLocalCoreModelRoute(input);
  switch (input.provider) {
    case "openrouter":
      return {
        version: "provider_runtime_configuration_v1",
        providerId: "openrouter",
        protocol: route.protocol,
        authentication: {
          mode: "required",
          credentialReference: {
            source: "local-core",
            id: "provider.openrouter.default",
          },
        },
        endpoint: route.endpoint,
        timeoutMs: 30_000,
        allowedHeaders: ["authorization", "http-referer", "x-title"],
        dataHandling: "provider_managed",
      };
    case "openai":
      return openAiConfiguration({
        providerId: "openai",
        endpoint: route.endpoint,
        authentication: "required",
      });
    case "anthropic":
      return {
        version: "provider_runtime_configuration_v1",
        providerId: "anthropic",
        protocol: route.protocol,
        authentication: {
          mode: "required",
          credentialReference: {
            source: "local-core",
            id: "provider.anthropic.default",
          },
        },
        endpoint: route.endpoint,
        timeoutMs: 30_000,
        allowedHeaders: ["anthropic-version", "content-type", "x-api-key"],
        dataHandling: "provider_managed",
      };
    case "ollama":
      return openAiConfiguration({
        providerId: "ollama",
        endpoint: route.endpoint,
        authentication: "none",
      });
    case "lmstudio":
      return openAiConfiguration({
        providerId: "lmstudio",
        endpoint: route.endpoint,
        authentication: "optional",
      });
  }
}

function openAiConfiguration(input: {
  providerId: "openai" | "ollama" | "lmstudio";
  endpoint: string;
  authentication: "required" | "optional" | "none";
}): ProviderRuntimeConfigurationV1 {
  return {
    version: "provider_runtime_configuration_v1",
    providerId: input.providerId,
    protocol: "openai",
    authentication:
      input.authentication === "none"
        ? { mode: "none" }
        : {
            mode: input.authentication,
            ...(input.providerId === "openai"
              ? {
                  credentialReference: {
                    source: "local-core",
                    id: "provider.openai.default",
                  },
                }
              : {}),
          },
    endpoint: input.endpoint,
    timeoutMs: 30_000,
    allowedHeaders: ["authorization", "content-type"],
    dataHandling:
      input.providerId === "openai" ? "provider_managed" : "local_only",
  };
}
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
