import { isDeepStrictEqual } from "node:util";

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
import { fingerprintResolvedProfile } from "../profile/kestrelOnePolicy.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";

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
    const profileId = this.profile?.id ?? "default";
    const profileFingerprint =
      this.profile === undefined
        ? "default"
        : fingerprintResolvedProfile(this.profile);
    let contextPolicy: ContextPolicyDefinitionRecord = {
      contextPolicyId:
        `context-policy:${profileId}:${profileFingerprint}`,
      label: `${this.profile?.label ?? "Default"} context policy`,
      defaultAction: "continue",
      ...(this.profile?.harnessEconomics !== undefined
        ? { economicsPolicy: this.profile.harnessEconomics.policy }
        : {}),
      metadata: {
        source: "profile_default",
      },
      createdAt: now,
      updatedAt: now,
    };
    const existingContextPolicy =
      this.store.getContextPolicyDefinition !== undefined
        ? await this.store.getContextPolicyDefinition(
            contextPolicy.contextPolicyId,
          )
        : (await this.store.listContextPolicyDefinitions()).find(
            (record) =>
              record.contextPolicyId === contextPolicy.contextPolicyId,
          ) ?? null;
    if (
      existingContextPolicy !== null &&
      sameContextPolicyDefinition(
        existingContextPolicy,
        contextPolicy,
      ) === false
    ) {
      throw createRuntimeFailure(
        "CONTEXT_POLICY_IMMUTABLE",
        `Context policy '${contextPolicy.contextPolicyId}' already has a different definition. Create a new profile revision instead.`,
        {
          contextPolicyId: contextPolicy.contextPolicyId,
          profileFingerprint,
        },
      );
    }
    if (existingContextPolicy === null) {
      await this.store.upsertContextPolicyDefinition(contextPolicy);
    } else {
      contextPolicy = existingContextPolicy;
    }

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
      const bundleId = `bundle:${this.profile.id}:${profileFingerprint}`;
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
            promptVariant:
              runtimeIdentity.agentProfileId === "kestrel-one"
                ? `kestrel-one:${this.profile.defaultInteractionMode ?? "chat"}`
                : `reference-react:${this.profile.defaultInteractionMode ?? "chat"}`,
            agentProfileId: runtimeIdentity.agentProfileId,
            agentProfileLabel: runtimeIdentity.agentProfileLabel,
            environmentShellKind: runtimeIdentity.environmentShellKind,
            environmentPresetId: runtimeIdentity.environmentPresetId,
            environmentCapabilityPackIds: [...runtimeIdentity.environmentCapabilityPackIds],
            effectiveAssemblyId: runtimeIdentity.effectiveAssemblyId,
            effectiveAssemblyLabel: assemblyLabel,
            ...(this.profile.harnessEconomics !== undefined
              ? { harnessEconomics: this.profile.harnessEconomics }
              : {}),
          },
          compatibility,
        ),
        createdAt: now,
        updatedAt: now,
      };
      const existingBundle = await this.store.getAssemblyBundle(bundleId);
      if (
        existingBundle !== null &&
        sameAssemblyBundleDefinition(existingBundle, defaultBundle) === false
      ) {
        throw createRuntimeFailure(
          "ASSEMBLY_BUNDLE_IMMUTABLE",
          `Assembly bundle '${bundleId}' already has a different definition. Create a new profile revision instead.`,
          { bundleId, profileFingerprint },
        );
      }
      if (existingBundle === null) {
        await this.store.upsertAssemblyBundle(defaultBundle);
      } else {
        defaultBundle = existingBundle;
      }
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

function sameAssemblyBundleDefinition(
  left: AssemblyBundleRecord,
  right: AssemblyBundleRecord,
): boolean {
  return isDeepStrictEqual(
    assemblyBundleDefinition(left),
    assemblyBundleDefinition(right),
  );
}

function sameContextPolicyDefinition(
  left: ContextPolicyDefinitionRecord,
  right: ContextPolicyDefinitionRecord,
): boolean {
  return isDeepStrictEqual(
    contextPolicyDefinition(left),
    contextPolicyDefinition(right),
  );
}

function contextPolicyDefinition(
  record: ContextPolicyDefinitionRecord,
): Omit<ContextPolicyDefinitionRecord, "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } =
    record;
  return definition;
}

function assemblyBundleDefinition(
  record: AssemblyBundleRecord,
): Omit<AssemblyBundleRecord, "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } =
    record;
  return definition;
}
