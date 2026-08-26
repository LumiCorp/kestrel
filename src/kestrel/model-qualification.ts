import type { ModelGateway } from "./contracts/model-io.js";
import {
  fingerprintModelRoutingPolicyV2,
  parseModelRegistrationV2,
  type ModelRegistrationV2,
  type ModelRequestV2,
  type ModelResponseV2,
} from "./contracts/model-registration.js";
import { hashCanonical } from "./contracts/tool-contract.js";
import { verifyModelResponseV2 } from "../io/ModelResponseVerifier.js";

/** Each probe is intentionally independent; success never implies another role. */
export const MODEL_QUALIFICATION_CAPABILITIES = [
  "json_syntax",
  "local_schema_validation",
  "provider_strict_schema",
  "native_tools",
  "required_tool_choice",
  "strict_tool_inputs",
  "parallel_tool_calls",
  "reasoning_summary",
  "reasoning_provider_visible",
  "continuation_encrypted_content",
  "continuation_signature",
  "continuation_reasoning_details",
  "streaming_terminal",
] as const;

export type ModelQualificationCapability =
  (typeof MODEL_QUALIFICATION_CAPABILITIES)[number];
export type ModelQualificationOutcome =
  | "qualified"
  | "failed"
  | "unsupported"
  | "stale";

export interface ModelQualificationBinding {
  providerId: ModelRegistrationV2["providerId"];
  modelId: string;
  apiEndpoint: string;
  endpointCodec: string;
  routingPolicyFingerprint: string;
  adapterRevision: string;
  registrationRevision: string;
  registrationFingerprint: string;
  credentialRevision?: string | undefined;
  probeRevision: string;
}

export interface ModelCapabilityQualification {
  capability: ModelQualificationCapability;
  outcome: Exclude<ModelQualificationOutcome, "stale">;
  binding: ModelQualificationBinding;
  checkedAt: string;
  requestHash: string;
  responseHash?: string | undefined;
  terminalState?: ModelResponseV2["terminal"]["state"] | undefined;
  validationOutcome: "passed" | "failed" | "not_requested";
  failureCode?: string | undefined;
  reason?: string | undefined;
}

export interface ModelQualificationProbeRequest {
  capability: ModelQualificationCapability;
  /** A V2 request is consumed by the installed provider codec and verifier. */
  request: ModelRequestV2;
}

/** Codec owners may explicitly report a contract their codec cannot encode. */
export interface ModelUnsupportedQualificationProbe {
  capability: ModelQualificationCapability;
  /** Stable local classification; arbitrary provider text is never retained. */
  unsupportedCode: string;
}

export type ModelQualificationProbe =
  | ModelQualificationProbeRequest
  | ModelUnsupportedQualificationProbe;

export interface ModelQualificationRun {
  binding: ModelQualificationBinding;
  checkedAt: string;
  results: readonly ModelCapabilityQualification[];
}

export interface ModelQualificationRead {
  capability: ModelQualificationCapability;
  outcome: ModelQualificationOutcome;
  result?: ModelCapabilityQualification | undefined;
}

export interface ModelQualificationRoleReadiness {
  ready: boolean;
  requirements: readonly ModelQualificationCapability[];
  unmet: readonly ModelQualificationRead[];
}

export interface ModelQualificationServiceOptions {
  now?: () => Date;
  freshnessMs: number;
}

/**
 * The route-owning provider factory receives the immutable registration and
 * derived binding. A generic gateway is deliberately not accepted at the
 * qualification boundary, so callers cannot label an arbitrary transport as
 * an exact route after it has been constructed.
 */
export interface ModelQualificationGatewayFactory {
  createGateway(input: {
    registration: ModelRegistrationV2;
    binding: ModelQualificationBinding;
    /** Issues an opaque receipt only for this exact registration binding. */
    attestGateway(gateway: ModelGateway): AttestedModelQualificationGateway;
  }): Promise<AttestedModelQualificationGateway> | AttestedModelQualificationGateway;
}

export interface AttestedModelQualificationGateway {
  call<T>(request: ModelRequestV2): Promise<T>;
}

/**
 * In-memory lifecycle for exact, bounded qualification. Persistence belongs to
 * Issue 08; this service deliberately retains immutable historical runs so a
 * failed refresh cannot erase the last completed evidence.
 */
export class ModelQualificationService {
  private readonly now: () => Date;
  private readonly freshnessMs: number;
  private readonly runs = new Map<string, ModelQualificationRun[]>();
  private readonly refreshes = new Map<string, Promise<ModelQualificationRun>>();

  constructor(options: ModelQualificationServiceOptions) {
    if (!Number.isSafeInteger(options.freshnessMs) || options.freshnessMs < 0) {
      throw new Error("model qualification freshnessMs must be a non-negative safe integer");
    }
    this.now = options.now ?? (() => new Date());
    this.freshnessMs = options.freshnessMs;
  }

  async refresh(input: {
    registration: ModelRegistrationV2;
    credentialRevision?: string | undefined;
    probeRevision: string;
    probes: readonly ModelQualificationProbe[];
    gatewayFactory: ModelQualificationGatewayFactory;
    /** An operator-requested requalification never erases retained proof. */
    force?: boolean | undefined;
  }): Promise<ModelQualificationRun> {
    const registration = parseModelRegistrationV2(input.registration);
    const binding = createModelQualificationBinding({
      registration,
      credentialRevision: input.credentialRevision,
      probeRevision: input.probeRevision,
    });
    const probes = validateProbes(input.probes, binding);
    const key = qualificationRunKey(binding, probes);
    const current = this.currentRun(key);
    if (input.force !== true && current !== undefined && this.isFresh(current)) return current;
    const active = this.refreshes.get(key);
    if (active !== undefined) return active;

    const run = this.execute({
      registration,
      binding,
      probes,
      gatewayFactory: input.gatewayFactory,
    });
    this.refreshes.set(key, run);
    try {
      const completed = await run;
      const history = this.runs.get(key) ?? [];
      this.runs.set(key, [...history, completed]);
      return completed;
    } finally {
      this.refreshes.delete(key);
    }
  }

  read(input: {
    registration: ModelRegistrationV2;
    credentialRevision?: string | undefined;
    probeRevision: string;
    capability: ModelQualificationCapability;
  }): ModelQualificationRead {
    const binding = createModelQualificationBinding(input);
    const run = this.currentCapabilityRun(binding, input.capability);
    const result = run?.results.find((entry) => entry.capability === input.capability);
    if (result === undefined) {
      return { capability: input.capability, outcome: "stale" };
    }
    return this.isFresh(run!)
      ? { capability: input.capability, outcome: result.outcome, result }
      : { capability: input.capability, outcome: "stale", result };
  }

  roleReadiness(input: {
    registration: ModelRegistrationV2;
    credentialRevision?: string | undefined;
    probeRevision: string;
    requirements: readonly ModelQualificationCapability[];
  }): ModelQualificationRoleReadiness {
    const requirements = uniqueCapabilities(input.requirements);
    const unmet = requirements
      .map((capability) => this.read({ ...input, capability }))
      .filter((entry) => entry.outcome !== "qualified");
    return { ready: unmet.length === 0, requirements, unmet };
  }

  private currentRun(key: string): ModelQualificationRun | undefined {
    const history = this.runs.get(key);
    return history?.at(-1);
  }

  private currentCapabilityRun(
    binding: ModelQualificationBinding,
    capability: ModelQualificationCapability,
  ): ModelQualificationRun | undefined {
    const identity = bindingKey(binding);
    const matching = [...this.runs.values()]
      .flat()
      .filter(
        (run) =>
          bindingKey(run.binding) === identity &&
          run.results.some((result) => result.capability === capability),
      )
      .sort((left, right) =>
        Date.parse(right.checkedAt) - Date.parse(left.checkedAt),
      );
    // A transport/protocol failure has no response evidence and must not
    // replace a still-valid observed capability during a forced refresh.
    return (
      matching.find((run) =>
        run.results.some((result) =>
          result.capability === capability && result.outcome === "qualified",
        ),
      ) ?? matching[0]
    );
  }

  private isFresh(run: ModelQualificationRun): boolean {
    return this.now().getTime() - Date.parse(run.checkedAt) <= this.freshnessMs;
  }

  private async execute(input: {
    registration: ModelRegistrationV2;
    binding: ModelQualificationBinding;
    probes: readonly ModelQualificationProbe[];
    gatewayFactory: ModelQualificationGatewayFactory;
  }): Promise<ModelQualificationRun> {
    const checkedAt = this.now().toISOString();
    const issuedGateways = new WeakSet<object>();
    const gateway = await input.gatewayFactory.createGateway({
      registration: input.registration,
      binding: input.binding,
      attestGateway: (candidate) => {
        const attested = Object.freeze({
          call: <T>(request: ModelRequestV2) => candidate.call<T>(request),
        });
        issuedGateways.add(attested);
        return attested;
      },
    });
    if (!issuedGateways.has(gateway)) {
      throw new Error("model qualification gateway lacks an exact route attestation");
    }
    const results = await Promise.all(
      input.probes.map(async (probe) =>
        executeProbe({ ...input, gateway, checkedAt, probe }),
      ),
    );
    return Object.freeze({ binding: input.binding, checkedAt, results });
  }
}

export function createModelQualificationBinding(input: {
  registration: ModelRegistrationV2;
  credentialRevision?: string | undefined;
  probeRevision: string;
}): ModelQualificationBinding {
  const registration = parseModelRegistrationV2(input.registration);
  if (!input.probeRevision.trim()) {
    throw new Error("model qualification probeRevision must be non-empty");
  }
  if (
    input.credentialRevision !== undefined &&
    input.credentialRevision !== registration.credentialRevision
  ) {
    throw new Error("model qualification credential revision does not match registration");
  }
  return Object.freeze({
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
    probeRevision: input.probeRevision,
  });
}

async function executeProbe(input: {
  binding: ModelQualificationBinding;
  checkedAt: string;
  probe: ModelQualificationProbe;
  gateway: ModelGateway;
}): Promise<ModelCapabilityQualification> {
  if ("unsupportedCode" in input.probe) {
    return Object.freeze({
      capability: input.probe.capability,
      outcome: "unsupported",
      binding: input.binding,
      checkedAt: input.checkedAt,
      requestHash: hashCanonical({
        capability: input.probe.capability,
        unsupportedCode: input.probe.unsupportedCode,
      }),
      validationOutcome: "not_requested",
      failureCode: input.probe.unsupportedCode,
    });
  }
  const requestHash = input.probe.request.fingerprints.request;
  try {
    assertProbeMatchesBinding(input.probe.request, input.binding);
    const response = verifyModelResponseV2(
      input.probe.request,
      await input.gateway.call<ModelResponseV2>(input.probe.request),
    );
    const outcome = responseProvesCapability(
      input.probe.capability,
      input.probe.request,
      response,
      input.binding,
    )
      ? "qualified"
      : "failed";
    return Object.freeze({
      capability: input.probe.capability,
      outcome,
      binding: input.binding,
      checkedAt: input.checkedAt,
      requestHash,
      responseHash: hashCanonical(secretFreeResponse(response)),
      terminalState: response.terminal.state,
      validationOutcome: response.validation.state,
      ...(outcome === "failed"
        ? { failureCode: response.validation.failureCode ?? "MODEL_QUALIFICATION_FAILED" }
        : {}),
    });
  } catch (error) {
    return Object.freeze({
      capability: input.probe.capability,
      outcome: "failed",
      binding: input.binding,
      checkedAt: input.checkedAt,
      requestHash,
      validationOutcome: "failed",
      failureCode: qualificationFailureCode(error),
    });
  }
}

/**
 * Explicit, bounded opt-in entry point for a real provider transport. Callers
 * construct the gateway from their provider factory; this module never
 * discovers credentials or performs background provider calls.
 */
export async function runLiveModelQualification(input: {
  service: ModelQualificationService;
  registration: ModelRegistrationV2;
  credentialRevision?: string | undefined;
  probeRevision: string;
  probes: readonly ModelQualificationProbe[];
  gatewayFactory: ModelQualificationGatewayFactory;
  maxProbes: number;
  force?: boolean | undefined;
}): Promise<ModelQualificationRun> {
  if (!Number.isSafeInteger(input.maxProbes) || input.maxProbes <= 0) {
    throw new Error("model live qualification maxProbes must be a positive safe integer");
  }
  if (input.probes.length > input.maxProbes) {
    throw new Error("model live qualification probe limit exceeded");
  }
  return input.service.refresh(input);
}

function responseProvesCapability(
  capability: ModelQualificationCapability,
  request: ModelRequestV2,
  response: ModelResponseV2,
  binding: ModelQualificationBinding,
): boolean {
  if (
    response.terminal.state !== "completed" ||
    response.validation.state === "failed" ||
    response.provider.name !== binding.providerId ||
    response.provider.model !== binding.modelId ||
    (request.requirements.endpoint !== "any" &&
      response.provider.endpoint !== request.requirements.endpoint)
  ) {
    return false;
  }
  const continuationKinds = new Set(
    response.reasoning?.continuation?.map((entry) => entry.kind) ?? [],
  );
  const visibleFormats = new Set(
    response.reasoning?.visible?.map((entry) => entry.format) ?? [],
  );
  switch (capability) {
    case "native_tools":
    case "required_tool_choice":
    case "strict_tool_inputs":
    case "parallel_tool_calls":
      return response.toolIntents.length > 0;
    case "reasoning_summary":
      return visibleFormats.has("summary");
    case "reasoning_provider_visible":
      return (
        visibleFormats.has("provider_thinking") ||
        visibleFormats.has("provider_reasoning_text")
      );
    case "continuation_encrypted_content":
      return continuationKinds.has("encrypted_content");
    case "continuation_signature":
      return continuationKinds.has("signature");
    case "continuation_reasoning_details":
      return continuationKinds.has("reasoning_details");
    case "streaming_terminal":
      return response.terminal.providerTerminalEvent !== undefined;
    default:
      return true;
  }
}

function assertProbeMatchesBinding(
  request: ModelRequestV2,
  binding: ModelQualificationBinding,
): void {
  if (request.model !== binding.modelId) {
    throw new Error("model qualification probe model does not match its registration");
  }
}

function secretFreeResponse(response: ModelResponseV2): Record<string, unknown> {
  return {
    version: response.version,
    provider: {
      name: response.provider.name,
      model: response.provider.model,
      endpoint: response.provider.endpoint,
    },
    terminal: {
      state: response.terminal.state,
      visibleOutputStarted: response.terminal.visibleOutputStarted,
      ...(response.terminal.providerTerminalEvent !== undefined
        ? { providerTerminalEvent: response.terminal.providerTerminalEvent }
        : {}),
    },
    validation: response.validation,
    toolIntents: response.toolIntents.map(({ name }) => ({ name })),
    reasoning: {
      visibleFormats: response.reasoning?.visible?.map(({ format }) => format) ?? [],
      continuationKinds:
        response.reasoning?.continuation?.map(({ kind }) => kind) ?? [],
    },
  };
}

function qualificationFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return "MODEL_QUALIFICATION_FAILED";
}

function validateProbes(
  probes: readonly ModelQualificationProbe[],
  binding: ModelQualificationBinding,
): readonly ModelQualificationProbe[] {
  const seen = new Set<ModelQualificationCapability>();
  return probes.map((probe) => {
    if (!MODEL_QUALIFICATION_CAPABILITIES.includes(probe.capability)) {
      throw new Error("model qualification probe capability is unsupported");
    }
    if (seen.has(probe.capability)) {
      throw new Error(`model qualification duplicate probe '${probe.capability}'`);
    }
    seen.add(probe.capability);
    if ("unsupportedCode" in probe) {
      if (!isQualificationCode(probe.unsupportedCode)) {
        throw new Error("model qualification unsupportedCode must be a stable MODEL_* code");
      }
    } else {
      assertProbeCarriesCapability(probe);
      assertProbeMatchesBinding(probe.request, binding);
    }
    return Object.freeze({ ...probe });
  });
}

function isQualificationCode(value: string): boolean {
  return /^MODEL_[A-Z0-9_]{3,120}$/.test(value);
}

function assertProbeCarriesCapability(
  probe: ModelQualificationProbeRequest,
): void {
  const requirements = probe.request.requirements;
  const toolChoice = requirements.tools.choice;
  const continuationKind = (kind: string) =>
    requirements.reasoning.continuationKinds.includes(
      kind as (typeof requirements.reasoning.continuationKinds)[number],
    );
  const matches = {
    json_syntax:
      requirements.output.kind === "json_object" &&
      requirements.output.assurance === "json_syntax",
    local_schema_validation:
      requirements.output.kind === "json_schema" &&
      requirements.output.assurance === "local_schema_validation",
    provider_strict_schema:
      requirements.output.kind === "json_schema" &&
      requirements.output.assurance === "provider_strict_schema",
    native_tools: toolChoice === "auto",
    required_tool_choice: toolChoice === "required" || toolChoice === "named",
    strict_tool_inputs:
      requirements.tools.strictArguments && toolChoice !== "none",
    parallel_tool_calls:
      requirements.tools.parallelism === "required" && toolChoice !== "none",
    reasoning_summary: requirements.reasoning.mode === "summary",
    reasoning_provider_visible:
      requirements.reasoning.mode === "provider_visible",
    continuation_encrypted_content: continuationKind("encrypted_content"),
    continuation_signature: continuationKind("signature"),
    continuation_reasoning_details: continuationKind("reasoning_details"),
    streaming_terminal:
      requirements.streaming.required &&
      requirements.streaming.terminalBehavior === "required",
  } satisfies Record<ModelQualificationCapability, boolean>;
  if (!matches[probe.capability]) {
    throw new Error(
      `model qualification probe '${probe.capability}' does not carry its required V2 contract`,
    );
  }
}

function uniqueCapabilities(
  capabilities: readonly ModelQualificationCapability[],
): readonly ModelQualificationCapability[] {
  const result: ModelQualificationCapability[] = [];
  for (const capability of capabilities) {
    if (!MODEL_QUALIFICATION_CAPABILITIES.includes(capability)) {
      throw new Error("model qualification capability is unsupported");
    }
    if (!result.includes(capability)) result.push(capability);
  }
  return result;
}

function bindingKey(binding: ModelQualificationBinding): string {
  return hashCanonical(binding);
}

function qualificationRunKey(
  binding: ModelQualificationBinding,
  probes: readonly ModelQualificationProbe[],
): string {
  return hashCanonical({
    binding,
    capabilities: probes.map((probe) => probe.capability).sort(),
  });
}
