import assert from "node:assert/strict";

import {
  countTextTokens,
  HarnessEconomicsController,
  parseHarnessEconomicsPolicyV1,
  parseModelEconomicsProfileV1,
  type HarnessEconomicsPolicyV1,
  type ModelEconomicsProfileV1,
  type TokenCountV1,
} from "../../src/economics/index.js";
import { contractTest } from "../helpers/contract-test.js";

const EXACT_ZERO: TokenCountV1 = {
  version: 1,
  tokens: 0,
  bytes: 0,
  method: "model_tokenizer",
  confidence: "model_compatible",
  counter: "test-counter",
  counterVersion: "1",
};

contractTest("runtime.hermetic", "harness economics policy parser accepts the strict v1 contract", () => {
  const policy = parseHarnessEconomicsPolicyV1(policyFixture());

  assert.equal(policy.policyId, "economics:test:observe");
  assert.equal(policy.context.sections[1]?.priority, "required");
  assert.deepEqual(policy.tools.allowedFamiliesByPhase, {
    "agent.loop": ["filesystem", "devshell"],
  });
});

contractTest("runtime.hermetic", "harness economics policy parser rejects unknown fields and unsafe compaction", () => {
  assert.throws(
    () => parseHarnessEconomicsPolicyV1({ ...policyFixture(), threshold: 0.8 }),
    /unknown field 'threshold'/u,
  );
  assert.throws(
    () => parseHarnessEconomicsPolicyV1({
      ...policyFixture(),
      compaction: {
        requireStructuredAnchors: false,
        maxSummaryAttempts: 2,
      },
    }),
    /structured anchors and exactly one summary attempt/u,
  );
  assert.throws(
    () => parseHarnessEconomicsPolicyV1({
      ...policyFixture(),
      context: {
        ...policyFixture().context,
        sections: [{ id: "transcript", priority: "elastic", maxTokens: 30 }],
      },
    }),
    /unknown field 'maxTokens'/u,
  );
});

contractTest("runtime.hermetic", "model economics profile preserves versioned authoritative pricing", () => {
  const profile = parseModelEconomicsProfileV1({
    version: 1,
    profileId: "openai:test-model:2026-07-22",
    provider: "openai",
    model: "test-model",
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    counting: {
      counter: "tiktoken:o200k_base",
      counterVersion: "1.0.21",
      method: "model_tokenizer",
      confidence: "model_compatible",
    },
    cache: { behavior: "provider_automatic" },
    price: {
      version: 1,
      priceVersion: "openai-2026-07-22",
      currency: "USD",
      effectiveAt: "2026-07-22T00:00:00.000Z",
      retrievedAt: "2026-07-22T12:00:00.000Z",
      sourceUrl: "https://example.com/pricing",
      perMillionTokens: {
        input: 1.25,
        output: 10,
        cachedInput: 0.125,
      },
    },
  });

  assert.equal(profile.price?.priceVersion, "openai-2026-07-22");
  assert.equal(profile.price?.perMillionTokens.cachedInput, 0.125);
});

contractTest("runtime.hermetic", "token counting labels exact and conservative estimates", () => {
  const estimated = countTextTokens("hello");
  const exact = countTextTokens("hello", {
    id: "word-test",
    version: "1",
    count: () => 1,
  });

  assert.deepEqual(
    { method: estimated.method, confidence: estimated.confidence, tokens: estimated.tokens },
    { method: "conservative_estimate", confidence: "conservative", tokens: 5 },
  );
  assert.deepEqual(
    { method: exact.method, confidence: exact.confidence, tokens: exact.tokens },
    { method: "model_tokenizer", confidence: "model_compatible", tokens: 1 },
  );
});

contractTest("runtime.hermetic", "observation mode reports policy pressure without changing effective admission", () => {
  const controller = new HarnessEconomicsController();
  const decision = controller.decide({
    policy: policyFixture(),
    modelProfile: profileFixture(),
    sections: [
      section("task", 30),
      section("transcript", 30),
      section("background", 20),
    ],
    toolSchema: exactCount(5),
    providerOverhead: exactCount(5),
  });

  assert.equal(decision.manifest.availableContextTokens, 75);
  assert.equal(decision.manifest.proposedContextTokens, 80);
  assert.equal(decision.manifest.policyContextTokens, 60);
  assert.equal(decision.manifest.effectiveContextTokens, 80);
  assert.deepEqual(
    decision.manifest.sections.map((section) => [section.id, section.policyAdmission, section.effectiveAdmission, section.policyTokens]),
    [
      ["task", "admitted", "admitted", 30],
      ["transcript", "admitted", "admitted", 30],
      ["background", "dropped", "admitted", 0],
    ],
  );
});

contractTest("runtime.hermetic", "enforcement preserves required context and drops optional sections whole", () => {
  const controller = new HarnessEconomicsController();
  const policy: HarnessEconomicsPolicyV1 = {
    ...policyFixture(),
    mode: "enforce",
  };
  const decision = controller.decide({
    policy,
    modelProfile: profileFixture(),
    sections: [
      section("task", 30),
      section("transcript", 30),
      section("background", 20),
    ],
    toolSchema: exactCount(5),
    providerOverhead: exactCount(5),
  });

  assert.equal(decision.manifest.enforceable, true);
  assert.equal(decision.manifest.effectiveContextTokens, 60);
  assert.deepEqual(decision.admittedSectionIds, ["task", "transcript"]);
  assert.deepEqual(decision.droppedSectionIds, ["background"]);
});

contractTest("runtime.hermetic", "unlisted transcript sections remain protected in enforce mode", () => {
  const decision = new HarnessEconomicsController().decide({
    policy: { ...policyFixture(), mode: "enforce" },
    modelProfile: profileFixture(),
    sections: [section("transcript:mt_1_0001_user", 20)],
    toolSchema: EXACT_ZERO,
    providerOverhead: EXACT_ZERO,
  });

  assert.equal(decision.manifest.sections[0]?.priority, "required");
  assert.equal(decision.manifest.sections[0]?.effectiveAdmission, "admitted");
  assert.deepEqual(decision.blockedSectionIds, []);
});

contractTest("runtime.hermetic", "core task context cannot be made optional by profile configuration", () => {
  const policy = policyFixture();
  policy.context.sections = [{ id: "task", priority: "optional" }];
  const decision = new HarnessEconomicsController().decide({
    policy: { ...policy, mode: "enforce" },
    modelProfile: profileFixture(),
    sections: [section("task", 80)],
    toolSchema: exactCount(5),
    providerOverhead: exactCount(5),
  });

  assert.equal(decision.manifest.sections[0]?.priority, "required");
  assert.equal(decision.manifest.sections[0]?.policyAdmission, "blocked");
});

contractTest("runtime.hermetic", "estimated counts cannot enforce unless the policy explicitly permits them", () => {
  const controller = new HarnessEconomicsController();
  const decision = controller.decide({
    policy: {
      ...policyFixture(),
      mode: "enforce",
    },
    modelProfile: {
      ...profileFixture(),
      counting: {
        counter: "estimate",
        counterVersion: "1",
        method: "conservative_estimate",
        confidence: "conservative",
      },
    },
    sections: [
      {
        ...section("task", 90),
        count: {
          ...exactCount(90),
          method: "conservative_estimate",
          confidence: "conservative",
        },
      },
    ],
    toolSchema: EXACT_ZERO,
    providerOverhead: EXACT_ZERO,
  });

  assert.equal(decision.manifest.enforceable, false);
  assert.equal(decision.manifest.sections[0]?.policyAdmission, "blocked");
  assert.equal(decision.manifest.sections[0]?.policyReason, "estimated_count_not_enforceable");
  assert.equal(decision.manifest.sections[0]?.effectiveAdmission, "admitted");
  assert.deepEqual(decision.blockedSectionIds, []);
});

contractTest("runtime.hermetic", "required overflow fails closed under an enforceable policy", () => {
  const controller = new HarnessEconomicsController();
  const decision = controller.decide({
    policy: {
      ...policyFixture(),
      mode: "enforce",
    },
    modelProfile: profileFixture(),
    sections: [section("task", 80)],
    toolSchema: exactCount(5),
    providerOverhead: exactCount(5),
  });

  assert.equal(decision.manifest.wouldBlock, true);
  assert.equal(decision.manifest.sections[0]?.policyReason, "required_budget_exhausted");
  assert.deepEqual(decision.blockedSectionIds, ["task"]);
});

function policyFixture(): HarnessEconomicsPolicyV1 {
  return {
    version: 1,
    policyId: "economics:test:observe",
    mode: "observe",
    counting: {
      estimatorVersion: "test-1",
      allowEstimatedEnforcement: false,
    },
    context: {
      outputReserveTokens: 10,
      safetyReserveTokens: 5,
      sections: [
        { id: "task", priority: "required" },
        { id: "transcript", priority: "required" },
        { id: "background", priority: "optional" },
      ],
    },
    compaction: {
      requireStructuredAnchors: true,
      maxSummaryAttempts: 1,
    },
    tools: {
      exposure: "assembly_allowlist",
      modelContextMaxTokens: 64,
      allowedFamiliesByPhase: {
        "agent.loop": ["filesystem", "devshell"],
      },
    },
    cache: { mode: "provider_default" },
  };
}

function profileFixture(): ModelEconomicsProfileV1 {
  return {
    version: 1,
    profileId: "test-provider:test-model:test",
    provider: "test-provider",
    model: "test-model",
    contextWindowTokens: 100,
    maxOutputTokens: 10,
    counting: {
      counter: "test-counter",
      counterVersion: "1",
      method: "model_tokenizer",
      confidence: "model_compatible",
    },
    cache: { behavior: "none" },
  };
}

function section(id: string, tokens: number) {
  return {
    id,
    origin: "test",
    contentHash: `hash-${id}`,
    count: exactCount(tokens),
  };
}

function exactCount(tokens: number): TokenCountV1 {
  return {
    version: 1,
    tokens,
    bytes: tokens * 4,
    method: "model_tokenizer",
    confidence: "model_compatible",
    counter: "test-counter",
    counterVersion: "1",
  };
}
