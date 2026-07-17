import { randomUUID } from "node:crypto";

import type {
  AssemblyBundleRecord,
  AssemblyChangeDecisionRecord,
  AssemblyChangeProposalRecord,
  OrchestrationStore,
  ThreadAssemblyRecord,
  ThreadRecord,
} from "./contracts.js";
import type { AssemblyChangeCause } from "../kestrel/contracts/orchestration.js";

import type { AssemblyCatalog } from "./AssemblyCatalog.js";
import {
  buildCompatibilityDecision,
  mergeAssemblyCompatibilityMetadata,
  readAssemblyCompatibilityMetadata,
} from "./AssemblyCompatibility.js";
import type { AssemblyPolicyEvaluator } from "./AssemblyPolicyEvaluator.js";
import { assemblyProposalNotFoundFailure } from "../runtime/RuntimeFailure.js";

export class RuntimeComposer {
  private readonly store: OrchestrationStore;
  private readonly catalog: AssemblyCatalog;
  private readonly policyEvaluator: AssemblyPolicyEvaluator;

  constructor(options: {
    store: OrchestrationStore;
    catalog: AssemblyCatalog;
    policyEvaluator: AssemblyPolicyEvaluator;
  }) {
    this.store = options.store;
    this.catalog = options.catalog;
    this.policyEvaluator = options.policyEvaluator;
  }

  async composeThreadAssembly(input: {
    thread: ThreadRecord;
    cause: AssemblyChangeCause;
  }): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  }> {
    const existing = await this.getActiveAssembly(input.thread.threadId);
    if (existing !== null && input.cause === "turn_start") {
      return existing;
    }

    const { defaultBundle } = await this.catalog.ensureDefaults();
    let bundle = await this.resolveBundleFromThreadMetadata(input.thread);
    let authority: ThreadAssemblyRecord["authority"] = "profile";
    if (bundle === undefined && input.thread.parentThreadId !== undefined) {
      const parent = await this.getActiveAssembly(input.thread.parentThreadId);
      if (parent?.bundle !== undefined) {
        bundle = await this.createInheritedBundle({
          thread: input.thread,
          base: parent.bundle,
        });
        authority = "policy";
      }
    }
    if (bundle === undefined) {
      bundle = defaultBundle;
    }

    const record: ThreadAssemblyRecord = {
      recordId: `assembly-record-${randomUUID()}`,
      threadId: input.thread.threadId,
      bundleId: bundle?.bundleId ?? "implicit/legacy",
      cause: input.cause,
      authority,
      metadata: {
        implicitLegacy: bundle === undefined,
      },
      createdAt: new Date().toISOString(),
    };
    await this.store.appendThreadAssemblyRecord(record);
    return {
      record,
      ...(bundle !== undefined ? { bundle } : {}),
    };
  }

  async getActiveAssembly(threadId: string): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  } | null> {
    const records = await this.store.listThreadAssemblyRecords(threadId);
    const record = selectLatestAssemblyRecord(records);
    if (record === undefined) {
      return null;
    }
    const bundle = await this.store.getAssemblyBundle(record.bundleId);
    return {
      record,
      ...(bundle !== null ? { bundle } : {}),
    };
  }

  async proposeAssemblyChange(input: {
    thread: ThreadRecord;
    requestedBundleId?: string | undefined;
    requestedToolAllowlist?: string[] | undefined;
    requestedProvider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    requestedModel?: string | undefined;
    requestedPromptVariant?: string | undefined;
    requestedSpecialistIds?: string[] | undefined;
    requestedContextPolicyId?: string | undefined;
    requestedApprovalPolicyId?: string | undefined;
    proposedBy: "operator" | "model" | "policy";
    reason?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<{
    proposal: AssemblyChangeProposalRecord;
    decision: AssemblyChangeDecisionRecord;
    activeAssembly?: ThreadAssemblyRecord | undefined;
    bundle?: AssemblyBundleRecord | undefined;
  }> {
    await this.catalog.ensureDefaults();
    const current = await this.getActiveAssembly(input.thread.threadId);
    const proposalId = `assembly-proposal-${randomUUID()}`;
    let requestedBundle = input.requestedBundleId !== undefined
      ? await this.store.getAssemblyBundle(input.requestedBundleId)
      : undefined;
    if (requestedBundle === null) {
      requestedBundle = undefined;
    }
    if (requestedBundle === undefined && input.requestedBundleId === undefined) {
      requestedBundle = await this.createProposedBundle({
        thread: input.thread,
        currentBundle: current?.bundle,
        requestedToolAllowlist: input.requestedToolAllowlist,
        requestedProvider: input.requestedProvider,
        requestedModel: input.requestedModel,
        requestedPromptVariant: input.requestedPromptVariant,
        requestedSpecialistIds: input.requestedSpecialistIds,
        requestedContextPolicyId: input.requestedContextPolicyId,
        requestedApprovalPolicyId: input.requestedApprovalPolicyId,
      });
    }

    const draftProposal: AssemblyChangeProposalRecord = {
      proposalId,
      threadId: input.thread.threadId,
      ...(input.requestedBundleId !== undefined ? { requestedBundleId: input.requestedBundleId } : {}),
      ...(input.requestedToolAllowlist !== undefined ? { requestedToolAllowlist: input.requestedToolAllowlist } : {}),
      ...(input.requestedProvider !== undefined ? { requestedProvider: input.requestedProvider } : {}),
      ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
      ...(input.requestedPromptVariant !== undefined ? { requestedPromptVariant: input.requestedPromptVariant } : {}),
      ...(input.requestedSpecialistIds !== undefined ? { requestedSpecialistIds: input.requestedSpecialistIds } : {}),
      ...(input.requestedContextPolicyId !== undefined ? { requestedContextPolicyId: input.requestedContextPolicyId } : {}),
      ...(input.requestedApprovalPolicyId !== undefined ? { requestedApprovalPolicyId: input.requestedApprovalPolicyId } : {}),
      proposedBy: input.proposedBy,
      status: "PENDING",
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: new Date().toISOString(),
    };

    const decision = this.policyEvaluator.evaluate({
      thread: input.thread,
      currentBundle: current?.bundle,
      requestedBundle,
      proposal: draftProposal,
    });
    const proposal: AssemblyChangeProposalRecord = {
      ...draftProposal,
      status:
        decision.result === "ALLOWED"
          ? "APPROVED"
          : decision.result === "REJECTED"
            ? "REJECTED"
            : "PENDING",
      ...(decision.result !== "APPROVAL_REQUIRED" ? { resolvedAt: decision.createdAt } : {}),
    };
    await this.store.upsertAssemblyChangeProposal(proposal);
    await this.store.appendAssemblyChangeDecision(decision);

    if (decision.result !== "ALLOWED" || requestedBundle === undefined) {
      return {
        proposal,
        decision,
      };
    }

    const active = await this.applyAssemblyBundle({
      threadId: input.thread.threadId,
      bundle: requestedBundle,
      cause: "proposal",
      authority: input.proposedBy === "model" ? "policy" : input.proposedBy,
      metadata: {
        proposalId,
      },
    });

    return {
      proposal,
      decision,
      activeAssembly: active.record,
      bundle: active.bundle,
    };
  }

  async applyApprovedProposal(input: {
    threadId: string;
    proposalId: string;
  }): Promise<{
    proposal: AssemblyChangeProposalRecord;
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  }> {
    const proposal = await this.store.getAssemblyChangeProposal(input.proposalId);
    if (proposal === null) {
      throw assemblyProposalNotFoundFailure(input.proposalId);
    }
    const current = await this.getActiveAssembly(input.threadId);
    const bundle =
      proposal.requestedBundleId !== undefined
        ? await this.store.getAssemblyBundle(proposal.requestedBundleId)
        : await this.createProposedBundle({
            thread: {
              threadId: input.threadId,
              sessionId: input.threadId,
              title: input.threadId,
              status: "IDLE",
              createdAt: proposal.createdAt,
              updatedAt: proposal.createdAt,
            },
            currentBundle: current?.bundle,
            requestedToolAllowlist: proposal.requestedToolAllowlist,
            requestedProvider: proposal.requestedProvider,
            requestedModel: proposal.requestedModel,
            requestedPromptVariant: proposal.requestedPromptVariant,
            requestedSpecialistIds: proposal.requestedSpecialistIds,
            requestedContextPolicyId: proposal.requestedContextPolicyId,
            requestedApprovalPolicyId: proposal.requestedApprovalPolicyId,
          });
    const approvedProposal: AssemblyChangeProposalRecord = {
      ...proposal,
      status: "APPROVED",
      resolvedAt: new Date().toISOString(),
    };
    await this.store.upsertAssemblyChangeProposal(approvedProposal);
    const applied: {
      record: ThreadAssemblyRecord;
      bundle?: AssemblyBundleRecord | undefined;
    } = bundle === null || bundle === undefined
      ? {
          record: {
            recordId: `assembly-record-${randomUUID()}`,
            threadId: input.threadId,
            bundleId: "implicit/legacy",
            cause: "proposal",
            authority: "operator" as const,
            createdAt: new Date().toISOString(),
          },
          bundle: undefined,
        }
      : await this.applyAssemblyBundle({
          threadId: input.threadId,
          bundle,
          cause: "proposal",
          authority: "operator",
          metadata: {
            proposalId: input.proposalId,
          },
        });
    return {
      proposal: approvedProposal,
      record: applied.record,
      ...(applied.bundle !== undefined ? { bundle: applied.bundle } : {}),
    };
  }

  async recomposeForCapabilityLoss(input: {
    threadId: string;
    availableToolNames: string[];
  }): Promise<{
    record: ThreadAssemblyRecord;
    bundle?: AssemblyBundleRecord | undefined;
  } | null> {
    const current = await this.getActiveAssembly(input.threadId);
    if (current === null) {
      return null;
    }
    if (current.bundle === undefined) {
      return current;
    }

    const available = new Set(input.availableToolNames);
    const narrowedTools = current.bundle.toolAllowlist.filter((name) => available.has(name));
    if (sameStrings(current.bundle.toolAllowlist, narrowedTools)) {
      return current;
    }

    const now = new Date().toISOString();
    const unavailableTools = current.bundle.toolAllowlist.filter((name) => available.has(name) === false);
    const compatibility = buildCompatibilityDecision({
      agent: resolveAgent(current.bundle.metadata),
      interactionMode: resolveInteractionMode(current.bundle.metadata),
      provider: readAssemblyCompatibilityMetadata(asRecord(current.bundle.metadata)).modelProvider,
      model: readAssemblyCompatibilityMetadata(asRecord(current.bundle.metadata)).model,
      currentPromptVariant: readAssemblyCompatibilityMetadata(asRecord(current.bundle.metadata)).promptVariant,
      decisionSource: "runtime",
      capabilityLossReason:
        unavailableTools.length > 0
          ? `Capabilities narrowed after tool loss: ${unavailableTools.join(", ")}`
          : "Capabilities narrowed after tool loss.",
    });
    const bundle: AssemblyBundleRecord = {
      ...current.bundle,
      bundleId: `bundle:${input.threadId}:capability-loss:${randomUUID()}`,
      label: `${current.bundle.label} narrowed runtime`,
      source: "runtime_derived",
      toolAllowlist: narrowedTools,
      metadata: mergeAssemblyCompatibilityMetadata(
        {
          ...(current.bundle.metadata ?? {}),
          derivedFromBundleId: current.bundle.bundleId,
          unavailableTools,
        },
        compatibility,
      ),
      updatedAt: now,
    };
    await this.store.upsertAssemblyBundle(bundle);
    return this.applyAssemblyBundle({
      threadId: input.threadId,
      bundle,
      cause: "capability_loss",
      authority: "policy",
      metadata: {
        derivedFromBundleId: current.bundle.bundleId,
        unavailableTools,
      },
    });
  }

  private async resolveBundleFromThreadMetadata(thread: ThreadRecord): Promise<AssemblyBundleRecord | undefined> {
    const runtimeAssembly = asRecord(thread.metadata?.runtimeAssembly);
    const bundleId = typeof runtimeAssembly?.bundleId === "string" ? runtimeAssembly.bundleId : undefined;
    if (bundleId === undefined) {
      return ;
    }
    const bundle = await this.store.getAssemblyBundle(bundleId);
    return bundle === null ? undefined : bundle;
  }

  private async createInheritedBundle(input: {
    thread: ThreadRecord;
    base: AssemblyBundleRecord;
  }): Promise<AssemblyBundleRecord> {
    const runtimeAssembly = asRecord(input.thread.metadata?.runtimeAssembly);
    const requestedToolAllowlist = Array.isArray(runtimeAssembly?.toolAllowlist)
      ? runtimeAssembly.toolAllowlist.filter((value): value is string => typeof value === "string")
      : undefined;
    const toolAllowlist =
      requestedToolAllowlist !== undefined
        ? input.base.toolAllowlist.filter((name) => requestedToolAllowlist.includes(name))
        : input.base.toolAllowlist;
    const baseCompatibility = readAssemblyCompatibilityMetadata(asRecord(input.base.metadata));
    const compatibility = buildCompatibilityDecision({
      agent: resolveAgent(input.base.metadata),
      interactionMode: resolveInteractionMode(input.base.metadata),
      provider: readProviderOverride(runtimeAssembly) ?? baseCompatibility.modelProvider,
      model: readModelOverride(runtimeAssembly) ?? baseCompatibility.model,
      requestedPromptVariant: readPromptVariantOverride(runtimeAssembly),
      currentPromptVariant: baseCompatibility.promptVariant,
      decisionSource: "policy",
    });
    const bundle: AssemblyBundleRecord = {
      ...input.base,
      bundleId: `bundle:${input.thread.threadId}:inherited`,
      label: `${input.thread.title} inherited runtime`,
      source: "thread_inherited",
      toolAllowlist: [...toolAllowlist],
      metadata: mergeAssemblyCompatibilityMetadata(
        {
          ...(input.base.metadata ?? {}),
          inheritedFromBundleId: input.base.bundleId,
        },
        compatibility,
      ),
      updatedAt: new Date().toISOString(),
    };
    await this.store.upsertAssemblyBundle(bundle);
    return bundle;
  }

  private async createProposedBundle(input: {
    thread: ThreadRecord;
    currentBundle?: AssemblyBundleRecord | undefined;
    requestedToolAllowlist?: string[] | undefined;
    requestedProvider?: "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined;
    requestedModel?: string | undefined;
    requestedPromptVariant?: string | undefined;
    requestedSpecialistIds?: string[] | undefined;
    requestedContextPolicyId?: string | undefined;
    requestedApprovalPolicyId?: string | undefined;
  }): Promise<AssemblyBundleRecord | undefined> {
    const base = input.currentBundle;
    if (
      base === undefined &&
      input.requestedToolAllowlist === undefined &&
      input.requestedProvider === undefined &&
      input.requestedModel === undefined &&
      input.requestedPromptVariant === undefined
    ) {
      return ;
    }
    const now = new Date().toISOString();
    const toolAllowlist =
      input.requestedToolAllowlist !== undefined
        ? [...new Set(input.requestedToolAllowlist)]
        : [...new Set(base?.toolAllowlist ?? [])];
    const baseCompatibility = readAssemblyCompatibilityMetadata(asRecord(base?.metadata));
    const compatibility = buildCompatibilityDecision({
      agent: resolveAgent(base?.metadata),
      interactionMode: resolveInteractionMode(base?.metadata),
      provider: input.requestedProvider ?? baseCompatibility.modelProvider,
      model: input.requestedModel ?? baseCompatibility.model,
      requestedPromptVariant: input.requestedPromptVariant,
      currentPromptVariant: baseCompatibility.promptVariant,
      decisionSource: "policy",
    });
    const bundle: AssemblyBundleRecord = {
      bundleId: `bundle:${input.thread.threadId}:proposal:${randomUUID()}`,
      label: `${input.thread.title} proposed runtime`,
      source: "proposal",
      toolAllowlist,
      specialistIds: input.requestedSpecialistIds ?? base?.specialistIds ?? [],
      contextPolicyId: input.requestedContextPolicyId ?? base?.contextPolicyId,
      approvalPolicyId: input.requestedApprovalPolicyId ?? base?.approvalPolicyId,
      metadata: mergeAssemblyCompatibilityMetadata(
        {
          ...(base?.metadata ?? {}),
          baseBundleId: base?.bundleId,
        },
        compatibility,
      ),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertAssemblyBundle(bundle);
    return bundle;
  }

  private async applyAssemblyBundle(input: {
    threadId: string;
    bundle: AssemblyBundleRecord;
    cause: AssemblyChangeCause;
    authority: ThreadAssemblyRecord["authority"];
    metadata?: Record<string, unknown> | undefined;
  }): Promise<{
    record: ThreadAssemblyRecord;
    bundle: AssemblyBundleRecord;
  }> {
    const record: ThreadAssemblyRecord = {
      recordId: `assembly-record-${randomUUID()}`,
      threadId: input.threadId,
      bundleId: input.bundle.bundleId,
      cause: input.cause,
      authority: input.authority,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.store.appendThreadAssemblyRecord(record);
    return {
      record,
      bundle: input.bundle,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function resolveAgent(metadata: unknown): "reference-react" {
  const record = asRecord(metadata);
  return record?.agent === "reference-react" ? record.agent : "reference-react";
}

function resolveInteractionMode(metadata: unknown): "chat" | "plan" | "build" {
  const record = asRecord(metadata);
  if (
    record?.defaultInteractionMode === "plan" ||
    record?.defaultInteractionMode === "build"
  ) {
    return record.defaultInteractionMode;
  }
  // Legacy input normalization only; composed runtime metadata must emit "build".
  if (record?.defaultInteractionMode === "act") {
    return "build";
  }
  return "chat";
}

function readProviderOverride(
  runtimeAssembly: Record<string, unknown> | undefined,
): "openrouter" | "openai" | "anthropic" | "ollama" | "lmstudio" | undefined {
  return runtimeAssembly?.modelProvider === "openrouter" ||
    runtimeAssembly?.modelProvider === "openai" ||
    runtimeAssembly?.modelProvider === "anthropic" ||
    runtimeAssembly?.modelProvider === "ollama" ||
    runtimeAssembly?.modelProvider === "lmstudio"
    ? runtimeAssembly.modelProvider
    : undefined;
}

function readModelOverride(runtimeAssembly: Record<string, unknown> | undefined): string | undefined {
  return typeof runtimeAssembly?.model === "string" ? runtimeAssembly.model : undefined;
}

function readPromptVariantOverride(runtimeAssembly: Record<string, unknown> | undefined): string | undefined {
  return typeof runtimeAssembly?.promptVariant === "string" ? runtimeAssembly.promptVariant : undefined;
}

function selectLatestAssemblyRecord(
  records: ThreadAssemblyRecord[],
): ThreadAssemblyRecord | undefined {
  let latest: ThreadAssemblyRecord | undefined;
  for (const record of records) {
    if (latest === undefined || record.createdAt >= latest.createdAt) {
      latest = record;
    }
  }
  return latest;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
