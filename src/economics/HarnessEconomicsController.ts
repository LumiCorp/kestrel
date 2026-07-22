import type {
  ContextAdmission,
  ContextAdmissionReason,
  ContextSectionCandidateV1,
  ContextSectionManifestV1,
  ContextSectionPolicyV1,
  HarnessEconomicsDecisionInputV1,
  HarnessEconomicsDecisionV1,
  TokenCountMethod,
} from "./contracts.js";

const PROTECTED_SECTION_IDS = new Set([
  "systemPrompt",
  "task",
  "correction",
  "activeWait",
]);

export class HarnessEconomicsController {
  decide(input: HarnessEconomicsDecisionInputV1): HarnessEconomicsDecisionV1 {
    const sectionPolicyById = new Map(input.policy.context.sections.map((section) => [section.id, section]));
    if (new Set(input.sections.map((section) => section.id)).size !== input.sections.length) {
      throw new Error("Harness economics context contains duplicate section ids.");
    }

    const availableContextTokens = Math.max(
      0,
      input.modelProfile.contextWindowTokens
        - input.policy.context.outputReserveTokens
        - input.policy.context.safetyReserveTokens
        - input.toolSchema.tokens
        - input.providerOverhead.tokens,
    );
    const countMethods = uniqueCountMethods(input);
    const estimated = countMethods.includes("conservative_estimate");
    const enforceable = estimated === false || input.policy.counting.allowEstimatedEnforcement;
    let remaining = availableContextTokens;
    const manifestsById = new Map<string, ContextSectionManifestV1>();
    const resolvedSections = input.sections.map((candidate) => ({
      candidate,
      policy: resolveSectionPolicy(candidate, sectionPolicyById.get(candidate.id)),
    }));

    // Reserve room for every required section before considering optional
    // context. Generic layers never slice semantic content.
    for (const optional of [false, true]) {
      for (const { candidate, policy } of resolvedSections) {
        if ((policy.priority === "optional") !== optional) continue;
        const decision = decideSection(candidate, policy, remaining);
        remaining = Math.max(0, remaining - decision.policyTokens);
        manifestsById.set(candidate.id, toManifest({
          candidate,
          sectionPolicy: policy,
          decision,
          policyMode: input.policy.mode,
          enforceable,
        }));
      }
    }

    const sections = input.sections.map((section) => manifestsById.get(section.id) as ContextSectionManifestV1);
    const wouldBlock = sections.some((section) => section.policyAdmission === "blocked");
    const proposedContextTokens = sections.reduce((total, section) => total + section.proposed.tokens, 0);
    const policyContextTokens = sections.reduce((total, section) => total + section.policyTokens, 0);
    const effectiveContextTokens = sections.reduce((total, section) => total + section.effectiveTokens, 0);

    return {
      version: 1,
      manifest: {
        version: 1,
        policyId: input.policy.policyId,
        policyMode: input.policy.mode,
        provider: input.modelProfile.provider,
        model: input.modelProfile.model,
        modelProfileId: input.modelProfile.profileId,
        contextWindowTokens: input.modelProfile.contextWindowTokens,
        outputReserveTokens: input.policy.context.outputReserveTokens,
        safetyReserveTokens: input.policy.context.safetyReserveTokens,
        toolSchema: input.toolSchema,
        providerOverhead: input.providerOverhead,
        availableContextTokens,
        proposedContextTokens,
        policyContextTokens,
        effectiveContextTokens,
        countMethods,
        enforceable,
        wouldBlock,
        sections,
      },
      admittedSectionIds: sections
        .filter((section) => section.effectiveAdmission === "admitted")
        .map((section) => section.id),
      droppedSectionIds: sections
        .filter((section) => section.effectiveAdmission === "dropped")
        .map((section) => section.id),
      blockedSectionIds: sections
        .filter((section) => section.effectiveAdmission === "blocked")
        .map((section) => section.id),
    };
  }
}

function decideSection(
  candidate: ContextSectionCandidateV1,
  policy: ContextSectionPolicyV1,
  remaining: number,
): { admission: ContextAdmission; reason: ContextAdmissionReason; policyTokens: number } {
  if (policy.priority !== "optional" && candidate.count.tokens > remaining) {
    return {
      admission: "blocked",
      reason: "required_budget_exhausted",
      policyTokens: 0,
    };
  }
  if (policy.priority === "optional" && candidate.count.tokens > remaining) {
    return {
      admission: "dropped",
      reason: "optional_budget_exhausted",
      policyTokens: 0,
    };
  }
  return {
    admission: "admitted",
    reason: "within_budget",
    policyTokens: candidate.count.tokens,
  };
}

function resolveSectionPolicy(
  candidate: ContextSectionCandidateV1,
  configured: ContextSectionPolicyV1 | undefined,
): ContextSectionPolicyV1 {
  if (isProtectedSection(candidate) || configured === undefined) {
    return { id: candidate.id, priority: "required" };
  }
  return configured;
}

function isProtectedSection(candidate: ContextSectionCandidateV1): boolean {
  return PROTECTED_SECTION_IDS.has(candidate.id) ||
    candidate.id.startsWith("transcript:") ||
    candidate.origin === "system-prompt" ||
    candidate.origin.startsWith("model-transcript:");
}

function toManifest(input: {
  candidate: ContextSectionCandidateV1;
  sectionPolicy?: ContextSectionPolicyV1 | undefined;
  decision: { admission: ContextAdmission; reason: ContextAdmissionReason; policyTokens: number };
  policyMode: "observe" | "enforce";
  enforceable: boolean;
}): ContextSectionManifestV1 {
  const enforcing = input.policyMode === "enforce" && input.enforceable;
  const effectiveAdmission = enforcing ? input.decision.admission : "admitted";
  const effectiveTokens = enforcing ? input.decision.policyTokens : input.candidate.count.tokens;
  const policyReason = input.policyMode === "enforce" && input.enforceable === false
    ? "estimated_count_not_enforceable"
    : input.decision.reason;
  return {
    id: input.candidate.id,
    origin: input.candidate.origin,
    ...(input.candidate.revision !== undefined ? { revision: input.candidate.revision } : {}),
    contentHash: input.candidate.contentHash,
    ...(input.sectionPolicy !== undefined ? { priority: input.sectionPolicy.priority } : {}),
    proposed: input.candidate.count,
    policyAdmission: input.decision.admission,
    policyReason,
    policyTokens: input.decision.policyTokens,
    effectiveAdmission,
    effectiveTokens,
    duplicateOf: [...new Set(input.candidate.duplicateOf ?? [])],
  };
}

function uniqueCountMethods(input: HarnessEconomicsDecisionInputV1): TokenCountMethod[] {
  const methods = new Set<TokenCountMethod>([
    input.toolSchema.method,
    input.providerOverhead.method,
    ...input.sections.map((section) => section.count.method),
  ]);
  return [...methods].sort();
}
