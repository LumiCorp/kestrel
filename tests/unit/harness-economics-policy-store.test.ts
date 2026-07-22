import assert from "node:assert/strict";

import type { HarnessEconomicsPolicyV1 } from "../../src/economics/contracts.js";
import { InMemoryOrchestrationStore } from "../../src/orchestration/InMemoryOrchestrationStore.js";
import { PostgresOrchestrationStore } from "../../src/orchestration/PostgresOrchestrationStore.js";
import { ScriptedSqlExecutor } from "../helpers/ScriptedSqlExecutor.js";
import { contractTest } from "../helpers/contract-test.js";

contractTest("runtime.hermetic", "context policy store preserves economics policy by immutable id", async () => {
  const store = new InMemoryOrchestrationStore();
  const base = contextPolicy(economicsPolicy(64));
  await store.upsertContextPolicyDefinition(base);
  await store.upsertContextPolicyDefinition({
    ...base,
    label: "Renamed label",
    economicsPolicy: undefined,
    updatedAt: "2026-07-22T12:01:00.000Z",
  });

  const persisted = await store.getContextPolicyDefinition(base.contextPolicyId);
  assert.equal(persisted?.label, "Renamed label");
  assert.equal(persisted?.economicsPolicy?.tools.modelContextMaxTokens, 64);

  await assert.rejects(
    () => store.upsertContextPolicyDefinition(contextPolicy(economicsPolicy(32))),
    /already has a different economics policy/u,
  );
});

contractTest("runtime.hermetic", "postgres context policy writes and reads the explicit economics column", async () => {
  const policy = economicsPolicy(64);
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_context_policy_definitions/,
      rows: [{ context_policy_id: policy.policyId }],
      rowCount: 1,
    },
    {
      match: /^SELECT context_policy_id, label, default_action, economics_policy_json/,
      rows: [{
        context_policy_id: policy.policyId,
        label: "Economics",
        default_action: "continue",
        economics_policy_json: policy,
        metadata_json: { source: "test" },
        created_at: "2026-07-22T12:00:00.000Z",
        updated_at: "2026-07-22T12:00:00.000Z",
      }],
      rowCount: 1,
    },
  ]);
  const store = new PostgresOrchestrationStore(sql);

  await store.upsertContextPolicyDefinition(contextPolicy(policy));
  const persisted = await store.getContextPolicyDefinition(policy.policyId);

  assert.equal(sql.queries[0]?.values?.[3], JSON.stringify(policy));
  assert.equal(persisted?.economicsPolicy?.policyId, policy.policyId);
  sql.assertExhausted();
});

contractTest("runtime.hermetic", "postgres context policy rejects an immutable policy conflict", async () => {
  const policy = economicsPolicy(64);
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_context_policy_definitions/,
      rows: [],
      rowCount: 0,
    },
  ]);
  const store = new PostgresOrchestrationStore(sql);

  await assert.rejects(
    () => store.upsertContextPolicyDefinition(contextPolicy(policy)),
    /Create a new policy id instead/u,
  );
});

function contextPolicy(economics: HarnessEconomicsPolicyV1) {
  return {
    contextPolicyId: economics.policyId,
    label: "Economics",
    defaultAction: "continue" as const,
    economicsPolicy: economics,
    metadata: { source: "test" },
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
  };
}

function economicsPolicy(modelContextMaxTokens: number): HarnessEconomicsPolicyV1 {
  return {
    version: 1,
    policyId: "context-policy:test:economics-v1",
    mode: "observe",
    counting: {
      estimatorVersion: "test-1",
      allowEstimatedEnforcement: false,
    },
    context: {
      outputReserveTokens: 16,
      safetyReserveTokens: 4,
      sections: [{ id: "task", priority: "required" }],
    },
    compaction: {
      requireStructuredAnchors: true,
      maxSummaryAttempts: 1,
    },
    tools: {
      exposure: "assembly_allowlist",
      modelContextMaxTokens,
      allowedFamiliesByPhase: {},
    },
  };
}
