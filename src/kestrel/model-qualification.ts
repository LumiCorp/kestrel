import type { ModelGateway } from "./contracts/model-io.js";
import {
  fingerprintModelRoutingPolicyV2,
  parseModelRegistrationV2,
  parseModelResponseV2,
  type ModelRegistrationV2,
  type ModelRequestV2,
  type ModelResponseV2,
} from "./contracts/model-registration.js";
import { hashCanonical } from "./contracts/tool-contract.js";

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
  unsupportedReason: string;
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
    gateway: ModelGateway;
  }): Promise<ModelQualificationRun> {
    const registration = parseModelRegistrationV2(input.registration);
    const binding = createModelQualificationBinding({
      registration,
      credentialRevision: input.credentialRevision,
      probeRevision: input.probeRevision,
    });
    const probes = validateProbes(input.probes);
    const key = bindingKey(binding);
    const current = this.currentRun(key);
    if (current !== undefined && this.isFresh(current)) return current;
    const active = this.refreshes.get(key);
    if (active !== undefined) return active;

    const run = this.execute({ binding, probes, gateway: input.gateway });
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
    const run = this.currentRun(bindingKey(binding));
    const result = run?.results.find(
      (entry) => entry.capability === input.capability,
    );
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

  private isFresh(run: ModelQualificationRun): boolean {
    return this.now().getTime() - Date.parse(run.checkedAt) <= this.freshnessMs;
  }

  private async execute(input: {
    binding: ModelQualificationBinding;
    probes: readonly ModelQualificationProbe[];
    gateway: ModelGateway;
  }): Promise<ModelQualificationRun> {
    const checkedAt = this.now().toISOString();
    const results = await Promise.all(
      input.probes.map(async (probe) =>
        executeProbe({ ...input, checkedAt, probe }),
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
  if ("unsupportedReason" in input.probe) {
    return Object.freeze({
      capability: input.probe.capability,
      outcome: "unsupported",
      binding: input.binding,
      checkedAt: input.checkedAt,
      requestHash: hashCanonical({
        capability: input.probe.capability,
        unsupportedReason: input.probe.unsupportedReason,
      }),
      validationOutcome: "not_requested",
      failureCode: "MODEL_QUALIFICATION_UNSUPPORTED",
      reason: input.probe.unsupportedReason,
    });
  }
  const requestHash = hashCanonical(input.probe.request);
  try {
    const response = parseModelResponseV2(
      await input.gateway.call<ModelResponseV2>(input.probe.request),
    );
    const outcome = responseIsQualified(response) ? "qualified" : "failed";
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

function responseIsQualified(response: ModelResponseV2): boolean {
  return (
    response.terminal.state === "completed" &&
    response.validation.state !== "failed"
  );
}

function secretFreeResponse(response: ModelResponseV2): Record<string, unknown> {
  return {
    version: response.version,
    provider: response.provider,
    terminal: response.terminal,
    validation: response.validation,
    toolIntents: response.toolIntents.map(({ id, name, input }) => ({
      ...(id !== undefined ? { id } : {}),
      name,
      input,
    })),
    ...(response.output !== undefined ? { output: response.output } : {}),
    ...(response.text !== undefined ? { text: response.text } : {}),
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
    if ("unsupportedReason" in probe) {
      if (!probe.unsupportedReason.trim()) {
        throw new Error("model qualification unsupportedReason must be non-empty");
      }
    } else {
      assertProbeCarriesCapability(probe);
    }
    return Object.freeze({ ...probe });
  });
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
