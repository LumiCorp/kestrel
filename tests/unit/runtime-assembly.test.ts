import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  AssemblyCatalog,
  AssemblyPolicyEvaluator,
  RuntimeComposer,
} from "../../src/orchestration/index.js";
import {
  composeKestrelOneProfile,
  fingerprintResolvedProfile,
} from "../../src/profile/kestrelOnePolicy.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "AssemblyCatalog persists default bundle, specialist, and context policy definitions", async () => {
  const store = new InMemorySessionStore();
  const profile = {
    ...buildProfile({ toolAllowlist: ["fs.read_text", "web.search"] }),
    harnessEconomics: economicsControl(),
  };
  const profileFingerprint = fingerprintResolvedProfile(profile);
  const bundleId = `bundle:reference:${profileFingerprint}`;
  const contextPolicyId = `context-policy:reference:${profileFingerprint}`;
  const catalog = new AssemblyCatalog({
    store,
    profile,
  });

  const defaults = await catalog.ensureDefaults();
  const persistedBundle = await catalog.resolveBundle(bundleId);

  assert.equal(defaults.defaultBundle?.bundleId, bundleId);
  assert.equal(defaults.defaultBundle?.label, "Reference on web:web_balanced");
  assert.equal(defaults.defaultContextPolicy.contextPolicyId, contextPolicyId);
  assert.equal(defaults.defaultContextPolicy.economicsPolicy?.mode, "observe");
  assert.equal(defaults.specialists[0]?.specialistId, "specialist:reference:delegation");
  assert.deepEqual(persistedBundle?.toolAllowlist, ["fs.read_text", "web.search"]);
  assert.equal(persistedBundle?.metadata?.agentProfileId, "reference");
  assert.equal(persistedBundle?.metadata?.agentProfileLabel, "Reference");
  assert.equal(persistedBundle?.metadata?.environmentShellKind, "web");
  assert.equal(persistedBundle?.metadata?.environmentPresetId, "web_balanced");
  assert.deepEqual(persistedBundle?.metadata?.environmentCapabilityPackIds, ["balanced"]);
  assert.equal(persistedBundle?.metadata?.effectiveAssemblyId, bundleId);
  assert.equal(persistedBundle?.metadata?.effectiveAssemblyLabel, "Reference on web:web_balanced");
  assert.equal(persistedBundle?.metadata?.modelProvider, "openrouter");
  assert.equal(persistedBundle?.metadata?.promptVariant, "reference-react:chat");
  assert.equal(persistedBundle?.metadata?.compatibilityProfile, "router.chat");
  assert.deepEqual(persistedBundle?.metadata?.harnessEconomics, economicsControl());
});

contractTest("runtime.hermetic", "AssemblyCatalog fingerprints profile revisions and keeps prior defaults available", async () => {
  const store = new InMemorySessionStore();
  const firstProfile = {
    ...buildProfile({ toolAllowlist: ["fs.read_text"] }),
    harnessEconomics: economicsControl(1),
  };
  const secondProfile = {
    ...buildProfile({ toolAllowlist: ["fs.read_text"] }),
    harnessEconomics: economicsControl(2),
  };
  const firstCatalog = new AssemblyCatalog({ store, profile: firstProfile });
  const first = await firstCatalog.ensureDefaults();
  const repeated = await firstCatalog.ensureDefaults();
  const second = await new AssemblyCatalog({
    store,
    profile: secondProfile,
  }).ensureDefaults();

  assert.equal(first.defaultBundle?.bundleId, repeated.defaultBundle?.bundleId);
  assert.notEqual(first.defaultBundle?.bundleId, second.defaultBundle?.bundleId);
  assert.notEqual(
    first.defaultContextPolicy.contextPolicyId,
    second.defaultContextPolicy.contextPolicyId,
  );
  assert.equal(
    (
      await store.getAssemblyBundle(
        first.defaultBundle?.bundleId ?? "missing",
      )
    )?.metadata?.harnessEconomics !== undefined,
    true,
  );
  assert.equal(
    second.defaultContextPolicy.economicsPolicy?.compaction
      .maxSummaryAttempts,
    2,
  );
});

contractTest("runtime.hermetic", "AssemblyCatalog rejects a conflicting definition under the same profile fingerprint", async () => {
  const store = new InMemorySessionStore();
  const profile = buildProfile({ toolAllowlist: ["fs.read_text"] });
  const profileFingerprint = fingerprintResolvedProfile(profile);
  const bundleId = `bundle:reference:${profileFingerprint}`;
  await store.upsertAssemblyBundle({
    bundleId,
    label: "Conflicting definition",
    source: "profile_default",
    toolAllowlist: ["web.search"],
    specialistIds: [],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });

  await assert.rejects(
    () => new AssemblyCatalog({ store, profile }).ensureDefaults(),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "ASSEMBLY_BUNDLE_IMMUTABLE",
      );
      assert.match(
        String((error as { message?: unknown }).message),
        /already has a different definition/u,
      );
      return true;
    },
  );
});

contractTest("runtime.hermetic", "AssemblyCatalog rejects a conflicting context policy under the same profile fingerprint", async () => {
  const store = new InMemorySessionStore();
  const profile = buildProfile({ toolAllowlist: ["fs.read_text"] });
  const profileFingerprint = fingerprintResolvedProfile(profile);
  const contextPolicyId =
    `context-policy:reference:${profileFingerprint}`;
  await store.upsertContextPolicyDefinition({
    contextPolicyId,
    label: "Conflicting context policy",
    defaultAction: "compact",
    metadata: { source: "conflicting" },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  });

  await assert.rejects(
    () => new AssemblyCatalog({ store, profile }).ensureDefaults(),
    (error: unknown) => {
      assert.equal(
        (error as { code?: unknown }).code,
        "CONTEXT_POLICY_IMMUTABLE",
      );
      assert.match(
        String((error as { message?: unknown }).message),
        /already has a different definition/u,
      );
      return true;
    },
  );
});

contractTest("runtime.hermetic", "RuntimeComposer keeps existing threads pinned until an operator applies a new profile revision", async () => {
  const store = new InMemorySessionStore();
  const firstCatalog = new AssemblyCatalog({
    store,
    profile: {
      ...buildProfile({ toolAllowlist: ["fs.read_text"] }),
      harnessEconomics: economicsControl(1),
    },
  });
  const firstDefaults = await firstCatalog.ensureDefaults();
  const firstComposer = new RuntimeComposer({
    store,
    catalog: firstCatalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });
  const thread = buildThread("thread-pinned-revision");
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  const initial = await firstComposer.composeThreadAssembly({
    thread,
    cause: "thread_start",
  });

  const secondCatalog = new AssemblyCatalog({
    store,
    profile: {
      ...buildProfile({ toolAllowlist: ["fs.read_text"] }),
      harnessEconomics: economicsControl(2),
    },
  });
  const secondDefaults = await secondCatalog.ensureDefaults();
  const secondComposer = new RuntimeComposer({
    store,
    catalog: secondCatalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });
  const stillPinned = await secondComposer.composeThreadAssembly({
    thread,
    cause: "turn_start",
  });

  assert.equal(initial.record.bundleId, firstDefaults.defaultBundle?.bundleId);
  assert.equal(
    stillPinned.record.bundleId,
    firstDefaults.defaultBundle?.bundleId,
  );
  assert.notEqual(
    stillPinned.record.bundleId,
    secondDefaults.defaultBundle?.bundleId,
  );

  const migrated = await secondComposer.proposeAssemblyChange({
    thread,
    requestedBundleId: secondDefaults.defaultBundle?.bundleId,
    proposedBy: "operator",
    reason: "Adopt the two-attempt compaction policy.",
  });
  assert.equal(migrated.decision.result, "ALLOWED");
  assert.equal(
    migrated.activeAssembly?.bundleId,
    secondDefaults.defaultBundle?.bundleId,
  );
  assert.equal(
    (await secondComposer.getActiveAssembly(thread.threadId))?.record.bundleId,
    secondDefaults.defaultBundle?.bundleId,
  );
});

contractTest("runtime.hermetic", "AssemblyPolicyEvaluator rejects unknown bundles and requires approval for model widening", () => {
  const evaluator = new AssemblyPolicyEvaluator();
  const thread = buildThread("thread-policy");

  const unknownDecision = evaluator.evaluate({
    thread,
    proposal: {
      proposalId: "proposal-unknown",
      threadId: thread.threadId,
      requestedBundleId: "bundle:missing",
      proposedBy: "operator",
      status: "PENDING",
      createdAt: "2026-03-16T12:00:00.000Z",
    },
  });
  assert.equal(unknownDecision.result, "REJECTED");

  const wideningDecision = evaluator.evaluate({
    thread,
    currentBundle: {
      bundleId: "bundle:current",
      label: "Current",
      source: "profile_default",
      toolAllowlist: ["fs.read_text"],
      specialistIds: [],
      createdAt: "2026-03-16T12:00:00.000Z",
      updatedAt: "2026-03-16T12:00:00.000Z",
    },
    requestedBundle: {
      bundleId: "bundle:wider",
      label: "Wider",
      source: "proposal",
      toolAllowlist: ["fs.read_text", "web.search"],
      specialistIds: [],
      createdAt: "2026-03-16T12:01:00.000Z",
      updatedAt: "2026-03-16T12:01:00.000Z",
    },
    proposal: {
      proposalId: "proposal-wider",
      threadId: thread.threadId,
      requestedToolAllowlist: ["fs.read_text", "web.search"],
      proposedBy: "model",
      status: "PENDING",
      createdAt: "2026-03-16T12:01:00.000Z",
    },
  });
  assert.equal(wideningDecision.result, "APPROVAL_REQUIRED");

  const providerChangeDecision = evaluator.evaluate({
    thread,
    currentBundle: {
      bundleId: "bundle:current",
      label: "Current",
      source: "profile_default",
      toolAllowlist: ["fs.read_text"],
      specialistIds: [],
      metadata: {
        modelProvider: "openrouter",
        model: "openai/gpt-4.1-mini",
        promptVariant: "reference-react:chat",
        compatibilityStatus: "compatible",
      },
      createdAt: "2026-03-16T12:00:00.000Z",
      updatedAt: "2026-03-16T12:00:00.000Z",
    },
    requestedBundle: {
      bundleId: "bundle:provider-change",
      label: "OpenAI",
      source: "proposal",
      toolAllowlist: ["fs.read_text"],
      specialistIds: [],
      metadata: {
        modelProvider: "openai",
        model: "gpt-4.1-mini",
        promptVariant: "reference-react:chat:responses",
        compatibilityProfile: "openai.responses",
        compatibilityStatus: "compatible",
      },
      createdAt: "2026-03-16T12:01:00.000Z",
      updatedAt: "2026-03-16T12:01:00.000Z",
    },
    proposal: {
      proposalId: "proposal-provider-change",
      threadId: thread.threadId,
      requestedProvider: "openai",
      requestedModel: "gpt-4.1-mini",
      requestedPromptVariant: "reference-react:chat:responses",
      proposedBy: "model",
      status: "PENDING",
      createdAt: "2026-03-16T12:01:00.000Z",
    },
  });
  assert.equal(providerChangeDecision.result, "APPROVAL_REQUIRED");
});

contractTest("runtime.hermetic", "RuntimeComposer composes inherited child bundles and applies approved proposals", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search", "fs.write_text"],
    }),
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const parent = buildThread("thread-parent", {
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:reference:default",
      },
    },
  });
  await store.ensureSession(parent.sessionId);
  await store.upsertThread(parent);
  await composer.composeThreadAssembly({
    thread: parent,
    cause: "thread_start",
  });

  const child = buildThread("thread-child", {
    parentThreadId: parent.threadId,
    metadata: {
      runtimeAssembly: {
        toolAllowlist: ["fs.read_text"],
      },
    },
  });
  await store.ensureSession(child.sessionId);
  await store.upsertThread(child);

  const childAssembly = await composer.composeThreadAssembly({
    thread: child,
    cause: "thread_start",
  });
  assert.deepEqual(childAssembly.bundle?.toolAllowlist, ["fs.read_text"]);

  const proposal = await composer.proposeAssemblyChange({
    thread: child,
    requestedToolAllowlist: ["fs.read_text", "web.search"],
    proposedBy: "model",
    reason: "Need search access",
  });
  assert.equal(proposal.decision.result, "APPROVAL_REQUIRED");

  await composer.applyApprovedProposal({
    threadId: child.threadId,
    proposalId: proposal.proposal.proposalId,
  });
  const active = await composer.getActiveAssembly(child.threadId);
  assert.deepEqual(active?.bundle?.toolAllowlist, ["fs.read_text", "web.search"]);
});

contractTest("runtime.hermetic", "RuntimeComposer selects provider-specific prompt variants and proposal metadata", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const thread = buildThread("thread-provider-proposal", {
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:reference:default",
      },
    },
  });
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  await composer.composeThreadAssembly({
    thread,
    cause: "thread_start",
  });

  const proposal = await composer.proposeAssemblyChange({
    thread,
    requestedProvider: "openai",
    requestedModel: "gpt-4.1-mini",
    requestedPromptVariant: "reference-react:chat:responses",
    proposedBy: "operator",
    reason: "Switch to strict OpenAI responses profile",
  });

  assert.equal(proposal.decision.result, "ALLOWED");
  assert.equal(proposal.bundle?.metadata?.modelProvider, "openai");
  assert.equal(proposal.bundle?.metadata?.model, "gpt-4.1-mini");
  assert.equal(proposal.bundle?.metadata?.promptVariant, "reference-react:chat:responses");
  assert.equal(proposal.bundle?.metadata?.compatibilityProfile, "openai.responses");
});

contractTest("runtime.hermetic", "RuntimeComposer rejects incompatible prompt variants for provider selection", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text"],
    }),
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const thread = buildThread("thread-incompatible-variant", {
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:reference:default",
      },
    },
  });
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  await composer.composeThreadAssembly({
    thread,
    cause: "thread_start",
  });

  const proposal = await composer.proposeAssemblyChange({
    thread,
    requestedProvider: "anthropic",
    requestedModel: "claude-3-7-sonnet",
    requestedPromptVariant: "reference-react:chat:responses",
    proposedBy: "operator",
  });

  assert.equal(proposal.decision.result, "REJECTED");
  assert.match(proposal.decision.reason, /not compatible with provider 'anthropic'/u);
});

contractTest("runtime.hermetic", "RuntimeComposer narrows active bundles on capability loss", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search", "fs.write_text"],
    }),
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const thread = buildThread("thread-capability", {
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:reference:default",
      },
    },
  });
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  await composer.composeThreadAssembly({
    thread,
    cause: "thread_start",
  });

  const recomposed = await composer.recomposeForCapabilityLoss({
    threadId: thread.threadId,
    availableToolNames: ["fs.read_text"],
  });

  assert.equal(recomposed?.record.cause, "capability_loss");
  assert.deepEqual(recomposed?.bundle?.toolAllowlist, ["fs.read_text"]);
  assert.equal(recomposed?.bundle?.source, "runtime_derived");
  assert.equal(recomposed?.bundle?.metadata?.compatibilityStatus, "downgraded");
  assert.match(
    String(recomposed?.bundle?.metadata?.capabilityLossReason),
    /Capabilities narrowed after tool loss: web.search, fs.write_text/u,
  );
});

contractTest("runtime.hermetic", "RuntimeComposer keeps runtime-internal tools when capability loss narrows external tools", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search", "FinalizeAnswer", "effect_result_lookup", "delegate.spawn_child"],
    }),
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const thread = buildThread("thread-capability-runtime", {
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:reference:default",
      },
    },
  });
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  await composer.composeThreadAssembly({
    thread,
    cause: "thread_start",
  });

  const recomposed = await composer.recomposeForCapabilityLoss({
    threadId: thread.threadId,
    availableToolNames: ["fs.read_text", "FinalizeAnswer", "effect_result_lookup", "delegate.spawn_child"],
  });

  assert.equal(recomposed?.record.cause, "capability_loss");
  assert.deepEqual(recomposed?.bundle?.toolAllowlist, [
    "fs.read_text",
    "FinalizeAnswer",
    "effect_result_lookup",
    "delegate.spawn_child",
  ]);
  assert.equal(recomposed?.bundle?.source, "runtime_derived");
});

contractTest("runtime.hermetic", "RuntimeComposer appends one canonical assembly transition for legacy Desktop threads", async () => {
  const store = new InMemorySessionStore();
  const legacyBundle = {
    bundleId: "bundle:reference-web:legacy-desktop",
    label: "Reference React on desktop:desktop_dev_local",
    source: "profile_default" as const,
    toolAllowlist: ["FinalizeAnswer"],
    specialistIds: [],
    metadata: {
      profileId: "local-core-desktop",
      agentProfileId: "reference-web",
      environmentPresetId: "desktop_dev_local",
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
  await store.upsertAssemblyBundle(legacyBundle);
  const thread = buildThread("thread-legacy-desktop");
  await store.ensureSession(thread.sessionId);
  await store.upsertThread(thread);
  await store.appendThreadAssemblyRecord({
    recordId: "assembly-record-legacy-desktop",
    threadId: thread.threadId,
    bundleId: legacyBundle.bundleId,
    cause: "thread_start",
    authority: "profile",
    createdAt: "2026-07-22T00:00:00.000Z",
  });
  const catalog = new AssemblyCatalog({
    store,
    profile: composeKestrelOneProfile({
      environmentPresetId: "desktop_dev_local",
    }).profile,
  });
  const composer = new RuntimeComposer({
    store,
    catalog,
    policyEvaluator: new AssemblyPolicyEvaluator(),
  });

  const migrated = await composer.composeThreadAssembly({
    thread,
    cause: "turn_start",
  });
  const repeated = await composer.composeThreadAssembly({
    thread,
    cause: "turn_start",
  });

  assert.equal(migrated.record.cause, "profile_migration");
  assert.equal(migrated.record.authority, "profile");
  assert.equal(migrated.bundle?.metadata?.agentProfileId, "kestrel-one");
  assert.equal(repeated.record.recordId, migrated.record.recordId);
  assert.equal(
    (await store.listThreadAssemblyRecords(thread.threadId)).length,
    2,
  );
});

function buildProfile(input?: { toolAllowlist?: string[] | undefined }): TuiProfile {
  return {
    id: "reference",
    label: "Reference",
    agent: "reference-react",
    sessionPrefix: "session",
    modelProvider: "openrouter",
    model: "mock-model",
    toolAllowlist: input?.toolAllowlist,
    delegation: {
      allowAgentSpawn: true,
      maxConcurrentChildSessions: 2,
    },
  };
}

function economicsPolicy(
  maxSummaryAttempts: 1 | 2 = 1,
): NonNullable<TuiProfile["harnessEconomics"]>["policy"] {
  return {
    version: 1,
    policyId:
      `economics:reference:observe:v${maxSummaryAttempts}`,
    mode: "observe",
    counting: { estimatorVersion: "utf8-byte-upper-bound:v1", allowEstimatedEnforcement: false },
    context: {
      outputReserveTokens: 8_000,
      safetyReserveTokens: 2_000,
      sections: [{ id: "active-task", priority: "required" }],
    },
    compaction: { requireStructuredAnchors: true, maxSummaryAttempts },
    tools: {
      exposure: "assembly_allowlist",
      modelContextMaxTokens: 4_000,
      allowedFamiliesByPhase: { agent: ["filesystem"] },
    },
    cache: { mode: "provider_default" },
  };
}

function economicsModelProfile(): NonNullable<TuiProfile["harnessEconomics"]>["modelProfiles"][number] {
  return {
    version: 1,
    profileId: "openrouter:mock-model:v1",
    provider: "openrouter",
    model: "mock-model",
    contextWindowTokens: 100_000,
    maxOutputTokens: 8_000,
    counting: {
      counter: "tiktoken:o200k_base",
      counterVersion: "1.0.21",
      method: "model_tokenizer",
      confidence: "model_compatible",
    },
    cache: { behavior: "provider_automatic" },
  };
}

function economicsControl(
  maxSummaryAttempts: 1 | 2 = 1,
): NonNullable<TuiProfile["harnessEconomics"]> {
  return {
    version: 1,
    policy: economicsPolicy(maxSummaryAttempts),
    modelProfiles: [economicsModelProfile()],
  };
}

function buildThread(
  threadId: string,
  overrides?: {
    parentThreadId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  },
) {
  return {
    threadId,
    sessionId: threadId,
    title: threadId,
    status: "IDLE" as const,
    ...(overrides?.parentThreadId !== undefined ? { parentThreadId: overrides.parentThreadId } : {}),
    ...(overrides?.metadata !== undefined ? { metadata: overrides.metadata } : {}),
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  };
}
