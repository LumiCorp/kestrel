export type HarnessEconomicsPolicyMode = "observe" | "enforce";

export type TokenCountMethod =
  | "provider_reported"
  | "model_tokenizer"
  | "conservative_estimate";
export type TokenCountConfidence = "provider_exact" | "model_compatible" | "conservative";

export interface TokenCountV1 {
  version: 1;
  tokens: number;
  bytes: number;
  method: TokenCountMethod;
  confidence: TokenCountConfidence;
  counter: string;
  counterVersion: string;
}

export type ContextSectionPriority = "required" | "optional";

export interface ContextSectionPolicyV1 {
  id: string;
  priority: ContextSectionPriority;
}

export interface HarnessEconomicsPolicyV1 {
  version: 1;
  policyId: string;
  mode: HarnessEconomicsPolicyMode;
  counting: {
    estimatorVersion: string;
    allowEstimatedEnforcement: boolean;
  };
  context: {
    outputReserveTokens: number;
    safetyReserveTokens: number;
    sections: ContextSectionPolicyV1[];
  };
  compaction: {
    requireStructuredAnchors: true;
    maxSummaryAttempts: 1;
  };
  tools: {
    exposure: "assembly_allowlist" | "phase_scoped";
    modelContextMaxTokens: number;
    allowedFamiliesByPhase: Record<string, string[]>;
  };
  cache: {
    mode: "provider_default" | "stable_prefix";
  };
}

export interface ModelEconomicsPriceV1 {
  version: 1;
  priceVersion: string;
  currency: "USD";
  effectiveAt: string;
  retrievedAt: string;
  sourceUrl: string;
  perMillionTokens: {
    input: number;
    output: number;
    cachedInput?: number | undefined;
    cacheWrite?: number | undefined;
    reasoning?: number | undefined;
  };
}

export interface ModelEconomicsProfileV1 {
  version: 1;
  profileId: string;
  provider: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  counting: {
    counter: string;
    counterVersion: string;
    method: TokenCountMethod;
    confidence: TokenCountConfidence;
  };
  cache: {
    behavior: "none" | "provider_automatic" | "anthropic_ephemeral";
  };
  price?: ModelEconomicsPriceV1 | undefined;
}

export interface HarnessEconomicsControlV1 {
  version: 1;
  policy: HarnessEconomicsPolicyV1;
  modelProfiles: ModelEconomicsProfileV1[];
}

export interface ContextSectionCandidateV1 {
  id: string;
  origin: string;
  revision?: string | undefined;
  contentHash: string;
  count: TokenCountV1;
  duplicateOf?: string[] | undefined;
}

export type ContextAdmission = "admitted" | "dropped" | "blocked";

export type ContextAdmissionReason =
  | "within_budget"
  | "optional_budget_exhausted"
  | "required_budget_exhausted"
  | "estimated_count_not_enforceable";

export interface ContextSectionManifestV1 {
  id: string;
  origin: string;
  revision?: string | undefined;
  contentHash: string;
  priority?: ContextSectionPriority | undefined;
  proposed: TokenCountV1;
  policyAdmission: ContextAdmission;
  policyReason: ContextAdmissionReason;
  policyTokens: number;
  effectiveAdmission: ContextAdmission;
  effectiveTokens: number;
  duplicateOf: string[];
}

export interface ContextManifestV1 {
  version: 1;
  policyId: string;
  policyMode: HarnessEconomicsPolicyMode;
  provider: string;
  model: string;
  modelProfileId: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  toolSchema: TokenCountV1;
  providerOverhead: TokenCountV1;
  availableContextTokens: number;
  proposedContextTokens: number;
  policyContextTokens: number;
  effectiveContextTokens: number;
  countMethods: TokenCountMethod[];
  enforceable: boolean;
  wouldBlock: boolean;
  sections: ContextSectionManifestV1[];
}

export interface HarnessEconomicsDecisionV1 {
  version: 1;
  manifest: ContextManifestV1;
  admittedSectionIds: string[];
  droppedSectionIds: string[];
  blockedSectionIds: string[];
}

export interface HarnessEconomicsDecisionInputV1 {
  policy: HarnessEconomicsPolicyV1;
  modelProfile: ModelEconomicsProfileV1;
  sections: ContextSectionCandidateV1[];
  toolSchema: TokenCountV1;
  providerOverhead: TokenCountV1;
}

export interface ToolSurfaceEntryManifestV1 {
  name: string;
  schemaHash: string;
  count: TokenCountV1;
}

export interface ToolSurfaceManifestV1 {
  version: 1;
  surfaceHash: string;
  count: TokenCountV1;
  tools: ToolSurfaceEntryManifestV1[];
}

export type ToolExposureAdmission = "admitted" | "blocked";

export interface ToolExposureSelectionEntryV1 {
  name: string;
  toolFamily?: string | undefined;
  policyAdmission: ToolExposureAdmission;
  effectiveAdmission: ToolExposureAdmission;
  reason: "assembly_allowlisted" | "phase_filter_inactive" | "family_allowed" | "family_not_allowed" | "tool_family_missing";
}

/**
 * Assembly-owned decision over tools that are eligible before model request
 * shaping adds required control tools or removes context-ineligible tools.
 */
export interface ToolExposureSelectionV1 {
  version: 1;
  policyId: string;
  policyMode: HarnessEconomicsPolicyMode;
  exposure: HarnessEconomicsPolicyV1["tools"]["exposure"];
  phase: string;
  scope: "assembly_tools";
  allowedFamilies: string[];
  entries: ToolExposureSelectionEntryV1[];
  selectedToolNames: string[];
  excludedToolNames: string[];
}

/** Exact provider-boundary result joined to the assembly selection above. */
export interface ToolExposureDecisionV1 {
  version: 1;
  policyId: string;
  policyMode: HarnessEconomicsPolicyMode;
  exposure: HarnessEconomicsPolicyV1["tools"]["exposure"];
  phase: string;
  selectionStatus: "provided" | "not_required" | "missing";
  selection?: ToolExposureSelectionV1 | undefined;
  modelVisibleToolNames: string[];
  modelVisibleSurfaceHash: string;
  modelVisibleSchema: TokenCountV1;
  modelContextMaxTokens: number;
  schemaBudgetEnforceable: boolean;
  schemaBudgetExceeded: boolean;
  wouldBlock: boolean;
  blockReasons: Array<"selection_missing" | "tool_schema_budget_exceeded">;
}

export interface ModelRequestEconomicsManifestV1 {
  version: 1;
  requestCount: TokenCountV1;
  contextSections: ContextSectionCandidateV1[];
  toolSurface: ToolSurfaceManifestV1;
  toolExposure?: ToolExposureDecisionV1 | undefined;
  providerOverhead: TokenCountV1;
  unattributedContextTokens: number;
  reconciliation: {
    componentSumToCanonicalRequestTokens: number;
    canonicalRequestToProviderPayloadTokens: number;
  };
  decision?: HarnessEconomicsDecisionV1 | undefined;
}

export interface ToolResultEconomicsManifestV1 {
  version: 1;
  rawReceivedHash: string;
  rawReceived: TokenCountV1;
  durableRawArtifactRef?: string | undefined;
  persistedOutputHash: string;
  persistedOutput: TokenCountV1;
  verificationVisibleHash: string;
  verificationVisible: TokenCountV1;
  modelVisibleHash: string;
  modelVisible: TokenCountV1;
  reductions: {
    rawToPersistedTokens: number;
    persistedToModelVisibleTokens: number;
    rawToModelVisibleTokens: number;
  };
  truncated: boolean;
}

export interface EconomicsUsageV1 {
  version: 1;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  reasoningTokens: number;
}

export type EconomicsPricingAttributionV1 =
  | {
      version: 1;
      status: "priced";
      currency: "USD";
      priceVersion: string;
      sourceUrl: string;
      totalCostUsd: number;
      components: Array<{
        category: "input" | "output" | "cached_input" | "cache_write" | "reasoning";
        tokens: number;
        ratePerMillionTokens: number;
        costUsd: number;
      }>;
    }
  | {
      version: 1;
      status: "unpriced";
      reason: "model_profile_unavailable" | "model_profile_mismatch" | "price_unavailable";
    };

export type EconomicsOutcomeAcceptance = "accepted" | "rejected" | "not_evaluated";

interface EconomicsLedgerEventBaseV1 {
  version: 1;
  eventId: string;
  payloadHash: string;
  callId: string;
}

interface EconomicsRunLedgerEventBaseV1 {
  version: 1;
  eventId: string;
  payloadHash: string;
  runId: string;
}

export interface EconomicsModelCallRequestedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_call.requested";
  providerPayloadHash: string;
  componentHash: string;
  toolManifestHash?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  modelBudgetClass: "action" | "maintenance";
  phase: string;
  assemblyId?: string | undefined;
  contextPolicyId?: string | undefined;
  modelProfileId?: string | undefined;
  economicsControlHash?: string | undefined;
  economicsControl?: HarnessEconomicsControlV1 | undefined;
  cache: {
    mode: "provider_default" | "stable_prefix";
    stablePrefixHash: string;
    stablePrefixTokens: number;
    prefixChanged: boolean;
  };
  requestManifest: ModelRequestEconomicsManifestV1;
}

export interface EconomicsModelAttemptStartedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_attempt.started";
  attempt: number;
  maxAttempts: number;
  provider?: string | undefined;
  model?: string | undefined;
}

export interface EconomicsModelAttemptCompletedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_attempt.completed";
  attempt: number;
  latencyMs: number;
}

export interface EconomicsModelAttemptFailedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_attempt.failed";
  attempt: number;
  latencyMs: number;
  failureCode?: string | undefined;
  failureClass: string;
  retryable: boolean;
  willRetry: boolean;
  visibleOutputStarted: boolean;
  retryDelayMs?: number | undefined;
}

export interface EconomicsModelCallCompletedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_call.completed";
  provider?: string | undefined;
  model?: string | undefined;
  latencyMs: number;
  usage: EconomicsUsageV1;
  pricing: EconomicsPricingAttributionV1;
  providerReportedInputDeltaTokens: number;
}

export interface EconomicsModelCallFailedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "model_call.failed";
  latencyMs: number;
  failureCode: string;
  failureClass: string;
}

export interface EconomicsOutcomeEvaluatedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "outcome.evaluated";
  evaluatorId: string;
  evaluatorVersion: string;
  acceptance: EconomicsOutcomeAcceptance;
  independentlyEvaluated: boolean;
  failureClass?: string | undefined;
}

export interface EconomicsRunOutcomeEvaluatedV1 extends EconomicsRunLedgerEventBaseV1 {
  kind: "run_outcome.evaluated";
  evaluatorId: string;
  evaluatorVersion: string;
  acceptance: EconomicsOutcomeAcceptance;
  independentlyEvaluated: boolean;
  failureClass: string;
}

export interface EconomicsToolResultRecordedV1 extends EconomicsLedgerEventBaseV1 {
  kind: "tool_result.recorded";
  toolCallId: string;
  toolName: string;
  status: "OK" | "FAILED";
  latencyMs: number;
  resultManifest: ToolResultEconomicsManifestV1;
}

export type EconomicsLedgerEventV1 =
  | EconomicsModelCallRequestedV1
  | EconomicsModelAttemptStartedV1
  | EconomicsModelAttemptCompletedV1
  | EconomicsModelAttemptFailedV1
  | EconomicsModelCallCompletedV1
  | EconomicsModelCallFailedV1
  | EconomicsToolResultRecordedV1
  | EconomicsOutcomeEvaluatedV1
  | EconomicsRunOutcomeEvaluatedV1;

export interface EconomicsToolResultProjectionV1 {
  toolCallId: string;
  recordedAt: string;
  event: EconomicsToolResultRecordedV1;
}

export interface EconomicsAttemptProjectionV1 {
  attempt: number;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  failedAt?: string | undefined;
  latencyMs?: number | undefined;
  failureCode?: string | undefined;
  failureClass?: string | undefined;
  retryable?: boolean | undefined;
  willRetry?: boolean | undefined;
  retryDelayMs?: number | undefined;
}

export interface EconomicsCallProjectionV1 {
  callId: string;
  requestedAt?: string | undefined;
  completedAt?: string | undefined;
  failedAt?: string | undefined;
  request?: EconomicsModelCallRequestedV1 | undefined;
  attempts: EconomicsAttemptProjectionV1[];
  completion?: EconomicsModelCallCompletedV1 | undefined;
  failure?: EconomicsModelCallFailedV1 | undefined;
  outcomes: EconomicsOutcomeEvaluatedV1[];
}

export interface EconomicsLedgerProjectionV1 {
  version: 1;
  calls: EconomicsCallProjectionV1[];
  toolResults: EconomicsToolResultProjectionV1[];
  runOutcomes: Array<{
    recordedAt: string;
    event: EconomicsRunOutcomeEvaluatedV1;
  }>;
  totals: {
    calls: number;
    completedCalls: number;
    failedCalls: number;
    attempts: number;
    retries: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    cacheHitRatio: number;
    cacheWriteAmplification: number;
    reasoningTokens: number;
    pricedCostUsd: number;
    unpricedCalls: number;
    toolResults: number;
    rawToolResultTokens: number;
    persistedToolResultTokens: number;
    verificationVisibleToolResultTokens: number;
    modelVisibleToolResultTokens: number;
    rawToPersistedReductionTokens: number;
    persistedToModelVisibleReductionTokens: number;
    rawToModelVisibleReductionTokens: number;
  };
  invalidEvents: Array<{
    eventId?: string | undefined;
    type: string;
    reason: string;
  }>;
  complete: boolean;
  incompleteReasons: string[];
}
