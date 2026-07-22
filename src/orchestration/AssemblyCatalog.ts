import type { TuiProfile } from "../../cli/contracts.js";
import type {
  AssemblyBundleRecord,
  ContextPolicyDefinitionRecord,
  OrchestrationStore,
  SpecialistDefinitionRecord,
} from "./contracts.js";
import { buildCompatibilityDecision, mergeAssemblyCompatibilityMetadata } from "./AssemblyCompatibility.js";
import {
  buildRuntimeIdentityMetadata,
  formatRuntimeAssemblyLabel,
} from "../profile/runtimeProfile.js";

export class AssemblyCatalog {
  private readonly store: OrchestrationStore;
  private readonly profile?: TuiProfile | undefined;

  constructor(options: {
    store: OrchestrationStore;
    profile?: TuiProfile | undefined;
  }) {
    this.store = options.store;
    this.profile = options.profile;
  }

  async ensureDefaults(): Promise<{
    defaultBundle?: AssemblyBundleRecord | undefined;
    defaultContextPolicy: ContextPolicyDefinitionRecord;
    specialists: SpecialistDefinitionRecord[];
  }> {
    const now = new Date().toISOString();
    const contextPolicy: ContextPolicyDefinitionRecord = {
      contextPolicyId: `context-policy:${this.profile?.id ?? "default"}:default`,
      label: `${this.profile?.label ?? "Default"} context policy`,
      defaultAction: "continue",
      ...(this.profile?.harnessEconomicsPolicy !== undefined
        ? { economicsPolicy: this.profile.harnessEconomicsPolicy }
        : {}),
      metadata: {
        source: "profile_default",
      },
      createdAt: now,
      updatedAt: now,
    };
    await this.store.upsertContextPolicyDefinition(contextPolicy);

    const specialists: SpecialistDefinitionRecord[] = [];
    if (this.profile?.delegation?.allowAgentSpawn === true) {
      const specialist: SpecialistDefinitionRecord = {
        specialistId: `specialist:${this.profile.id}:delegation`,
        label: `${this.profile.label} delegation specialist`,
        description: "Delegated child-thread specialist available for eligible runtime assemblies.",
        allowedToolAllowlist: [...new Set(this.profile.toolAllowlist ?? [])],
        metadata: {
          source: "profile_default",
          kind: "delegation",
        },
        createdAt: now,
        updatedAt: now,
      };
      await this.store.upsertSpecialistDefinition(specialist);
      specialists.push(specialist);
    }

    let defaultBundle: AssemblyBundleRecord | undefined;
    if (this.profile !== undefined) {
      const bundleId = `bundle:${this.profile.id}:default`;
      const runtimeIdentity = buildRuntimeIdentityMetadata({
        agentProfileId: this.profile.agentProfileId ?? this.profile.id,
        agentProfileLabel: this.profile.agentProfileLabel ?? this.profile.label,
        legacyProfileLabel: this.profile.label,
        shellKind: this.profile.environmentShellKind ?? this.profile.shellKind,
        presetId: this.profile.environmentPresetId ?? this.profile.presetId,
        capabilityPacks: this.profile.environmentCapabilityPackIds ?? this.profile.capabilityPacks,
        effectiveAssemblyId: bundleId,
      });
      const assemblyLabel = runtimeIdentity.effectiveAssemblyLabel ??
        formatRuntimeAssemblyLabel({
          agentProfileLabel: runtimeIdentity.agentProfileLabel,
          environmentShellKind: runtimeIdentity.environmentShellKind,
          environmentPresetId: runtimeIdentity.environmentPresetId,
        });
      const compatibility = buildCompatibilityDecision({
        agent: this.profile.agent,
        interactionMode: this.profile.defaultInteractionMode ?? "chat",
        provider: this.profile.modelProvider,
        model: this.profile.model,
        decisionSource: "profile",
      });
      defaultBundle = {
        bundleId,
        label: assemblyLabel,
        source: "profile_default",
        toolAllowlist: [...new Set(this.profile.toolAllowlist ?? [])],
        specialistIds: specialists.map((entry) => entry.specialistId),
        contextPolicyId: contextPolicy.contextPolicyId,
        approvalPolicyId: "approval-policy:turn_scoped",
        metadata: mergeAssemblyCompatibilityMetadata(
          {
            profileId: this.profile.id,
            agent: this.profile.agent,
            defaultInteractionMode: this.profile.defaultInteractionMode,
            agentProfileId: runtimeIdentity.agentProfileId,
            agentProfileLabel: runtimeIdentity.agentProfileLabel,
            environmentShellKind: runtimeIdentity.environmentShellKind,
            environmentPresetId: runtimeIdentity.environmentPresetId,
            environmentCapabilityPackIds: [...runtimeIdentity.environmentCapabilityPackIds],
            effectiveAssemblyId: runtimeIdentity.effectiveAssemblyId,
            effectiveAssemblyLabel: assemblyLabel,
            ...(this.profile.modelEconomicsProfile !== undefined
              ? { modelEconomicsProfile: this.profile.modelEconomicsProfile }
              : {}),
          },
          compatibility,
        ),
        createdAt: now,
        updatedAt: now,
      };
      await this.store.upsertAssemblyBundle(defaultBundle);
    }

    return {
      ...(defaultBundle !== undefined ? { defaultBundle } : {}),
      defaultContextPolicy: contextPolicy,
      specialists,
    };
  }

  async resolveBundle(bundleId: string): Promise<AssemblyBundleRecord | null> {
    return this.store.getAssemblyBundle(bundleId);
  }
}
