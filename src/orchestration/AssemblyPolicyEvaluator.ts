import type {
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  ThreadRecord,
} from "./contracts.js";
import { readAssemblyCompatibilityMetadata } from "./AssemblyCompatibility.js";

export class AssemblyPolicyEvaluator {
  evaluate(input: {
    thread: ThreadRecord;
    currentBundle?: AssemblyBundleRecord | undefined;
    requestedBundle?: AssemblyBundleRecord | undefined;
    proposal: AssemblyChangeProposalRecord;
  }): AssemblyChangeDecisionRecord {
    const now = new Date().toISOString();
    const requestedToolAllowlist =
      input.proposal.requestedToolAllowlist ??
      input.requestedBundle?.toolAllowlist ??
      input.currentBundle?.toolAllowlist ??
      [];
    const currentToolAllowlist = input.currentBundle?.toolAllowlist ?? [];
    const isNarrowing = requestedToolAllowlist.every((name) => currentToolAllowlist.includes(name));
    const currentCompatibility = readAssemblyCompatibilityMetadata(asRecord(input.currentBundle?.metadata));
    const requestedCompatibility = readAssemblyCompatibilityMetadata(asRecord(input.requestedBundle?.metadata));
    const providerChanged =
      requestedCompatibility.modelProvider !== undefined &&
      currentCompatibility.modelProvider !== undefined &&
      requestedCompatibility.modelProvider !== currentCompatibility.modelProvider;
    const modelChanged =
      requestedCompatibility.model !== undefined &&
      currentCompatibility.model !== undefined &&
      requestedCompatibility.model !== currentCompatibility.model;
    const promptVariantChanged =
      requestedCompatibility.promptVariant !== undefined &&
      currentCompatibility.promptVariant !== undefined &&
      requestedCompatibility.promptVariant !== currentCompatibility.promptVariant;
    const compatibilityDowngraded =
      requestedCompatibility.compatibilityStatus === "downgraded" ||
      requestedCompatibility.compatibilityStatus === "incompatible";

    if (input.proposal.requestedBundleId !== undefined && input.requestedBundle === undefined) {
      return {
        decisionId: `assembly-decision:${input.proposal.proposalId}`,
        threadId: input.thread.threadId,
        proposalId: input.proposal.proposalId,
        result: "REJECTED",
        decidedBy: "policy",
        reason: `Unknown assembly bundle '${input.proposal.requestedBundleId}'.`,
        metadata: {
          requestedBundleId: input.proposal.requestedBundleId,
        },
        createdAt: now,
      };
    }

    if (requestedCompatibility.compatibilityStatus === "incompatible") {
      return {
        decisionId: `assembly-decision:${input.proposal.proposalId}`,
        threadId: input.thread.threadId,
        proposalId: input.proposal.proposalId,
        result: "REJECTED",
        decidedBy: "policy",
        reason: requestedCompatibility.downgradeReason ?? "Requested runtime composition is incompatible.",
        ...(input.requestedBundle?.bundleId !== undefined
          ? { resultingBundleId: input.requestedBundle.bundleId }
          : {}),
        metadata: {
          currentToolAllowlist,
          requestedToolAllowlist,
          currentProvider: currentCompatibility.modelProvider,
          requestedProvider: requestedCompatibility.modelProvider,
          currentModel: currentCompatibility.model,
          requestedModel: requestedCompatibility.model,
          currentPromptVariant: currentCompatibility.promptVariant,
          requestedPromptVariant: requestedCompatibility.promptVariant,
        },
        createdAt: now,
      };
    }

    if (
      input.proposal.proposedBy === "model" &&
      (isNarrowing === false || providerChanged || modelChanged || promptVariantChanged || compatibilityDowngraded)
    ) {
      return {
        decisionId: `assembly-decision:${input.proposal.proposalId}`,
        threadId: input.thread.threadId,
        proposalId: input.proposal.proposalId,
        result: "APPROVAL_REQUIRED",
        decidedBy: "policy",
        reason: buildApprovalReason({
          isNarrowing,
          providerChanged,
          modelChanged,
          promptVariantChanged,
          compatibilityDowngraded,
        }),
        ...(input.requestedBundle?.bundleId !== undefined
          ? { resultingBundleId: input.requestedBundle.bundleId }
          : {}),
        metadata: {
          currentToolAllowlist,
          requestedToolAllowlist,
          currentProvider: currentCompatibility.modelProvider,
          requestedProvider: requestedCompatibility.modelProvider,
          currentModel: currentCompatibility.model,
          requestedModel: requestedCompatibility.model,
          currentPromptVariant: currentCompatibility.promptVariant,
          requestedPromptVariant: requestedCompatibility.promptVariant,
          requestedCompatibilityStatus: requestedCompatibility.compatibilityStatus,
        },
        createdAt: now,
      };
    }

    return {
      decisionId: `assembly-decision:${input.proposal.proposalId}`,
      threadId: input.thread.threadId,
      proposalId: input.proposal.proposalId,
      result: "ALLOWED",
      decidedBy: "policy",
      reason: isNarrowing
        ? "Runtime assembly narrowed within the active policy envelope."
        : "Runtime assembly change allowed by current policy.",
      ...(input.requestedBundle?.bundleId !== undefined
        ? { resultingBundleId: input.requestedBundle.bundleId }
        : {}),
      metadata: {
        currentToolAllowlist,
        requestedToolAllowlist,
        currentProvider: currentCompatibility.modelProvider,
        requestedProvider: requestedCompatibility.modelProvider,
        currentModel: currentCompatibility.model,
        requestedModel: requestedCompatibility.model,
        currentPromptVariant: currentCompatibility.promptVariant,
        requestedPromptVariant: requestedCompatibility.promptVariant,
        requestedCompatibilityStatus: requestedCompatibility.compatibilityStatus,
      },
      createdAt: now,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function buildApprovalReason(input: {
  isNarrowing: boolean;
  providerChanged: boolean;
  modelChanged: boolean;
  promptVariantChanged: boolean;
  compatibilityDowngraded: boolean;
}): string {
  if (input.providerChanged) {
    return "Model-originated provider changes require operator approval.";
  }
  if (input.modelChanged) {
    return "Model-originated model changes require operator approval.";
  }
  if (input.promptVariantChanged) {
    return "Model-originated prompt variant changes require operator approval.";
  }
  if (input.compatibilityDowngraded) {
    return "Model-originated compatibility downgrades require operator approval.";
  }
  if (input.isNarrowing === false) {
    return "Model-originated runtime widening requires operator approval.";
  }
  return "Model-originated runtime composition changes require operator approval.";
}
