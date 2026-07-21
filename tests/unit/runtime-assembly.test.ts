import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  AssemblyCatalog,
  AssemblyPolicyEvaluator,
  RuntimeComposer,
} from "../../src/orchestration/index.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "AssemblyCatalog persists default bundle, specialist, and context policy definitions", async () => {
  const store = new InMemorySessionStore();
  const catalog = new AssemblyCatalog({
    store,
    profile: buildProfile({
      toolAllowlist: ["fs.read_text", "web.search"],
    }),
  });

  const defaults = await catalog.ensureDefaults();
  const persistedBundle = await catalog.resolveBundle("bundle:reference:default");

  assert.equal(defaults.defaultBundle?.bundleId, "bundle:reference:default");
  assert.equal(defaults.defaultBundle?.label, "Reference on web:web_balanced");
  assert.equal(defaults.defaultContextPolicy.contextPolicyId, "context-policy:reference:default");
  assert.equal(defaults.specialists[0]?.specialistId, "specialist:reference:delegation");
  assert.deepEqual(persistedBundle?.toolAllowlist, ["fs.read_text", "web.search"]);
  assert.equal(persistedBundle?.metadata?.agentProfileId, "reference");
  assert.equal(persistedBundle?.metadata?.agentProfileLabel, "Reference");
  assert.equal(persistedBundle?.metadata?.environmentShellKind, "web");
  assert.equal(persistedBundle?.metadata?.environmentPresetId, "web_balanced");
  assert.deepEqual(persistedBundle?.metadata?.environmentCapabilityPackIds, ["balanced"]);
  assert.equal(persistedBundle?.metadata?.effectiveAssemblyId, "bundle:reference:default");
  assert.equal(persistedBundle?.metadata?.effectiveAssemblyLabel, "Reference on web:web_balanced");
  assert.equal(persistedBundle?.metadata?.modelProvider, "openrouter");
  assert.equal(persistedBundle?.metadata?.promptVariant, "reference-react:chat");
  assert.equal(persistedBundle?.metadata?.compatibilityProfile, "router.chat");
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
