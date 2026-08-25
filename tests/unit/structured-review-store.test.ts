import test from "node:test";
import assert from "node:assert/strict";
import type { RunnerInteractionRequestV1 } from "@kestrel-agents/protocol";

import { PostgresOrchestrationStore } from "../../src/orchestration/PostgresOrchestrationStore.js";
import { ScriptedSqlExecutor } from "../helpers/ScriptedSqlExecutor.js";
import { legacyRecoveryReviewInteractionFixture } from "../fixtures/structured-review-contract.js";

test("PostgreSQL orchestration store round-trips the complete interaction envelope", async () => {
  const interaction = structuredClone(
    legacyRecoveryReviewInteractionFixture,
  ) as unknown as RunnerInteractionRequestV1;
  const row = {
    request_id: interaction.requestId,
    thread_id: "thread-review",
    run_id: null,
    kind: "user_input",
    status: "PENDING",
    event_type: "user.reply",
    delegation_id: null,
    wait_kind: "user",
    prompt: interaction.prompt,
    interaction_json: interaction,
    metadata_json: { reason: "recovery_review" },
    response_json: null,
    created_at: "2026-08-11T12:00:00.000Z",
    resolved_at: null,
  };
  const sql = new ScriptedSqlExecutor([
    {
      match: /^INSERT INTO orchestration_interaction_requests/u,
      rowCount: 1,
    },
    {
      match: /^SELECT request_id, thread_id, run_id, kind, status, event_type, delegation_id, wait_kind, prompt, interaction_json/u,
      rows: [row],
    },
  ]);
  const store = new PostgresOrchestrationStore(sql);

  await store.upsertInteractionRequest({
    requestId: interaction.requestId,
    threadId: "thread-review",
    kind: "user_input",
    status: "PENDING",
    eventType: "user.reply",
    waitKind: "user",
    prompt: interaction.prompt,
    interaction,
    metadata: { reason: "recovery_review" },
    createdAt: row.created_at,
  });
  const restored = await store.getInteractionRequest(interaction.requestId);

  assert.equal(sql.queries[0]?.values?.[9], JSON.stringify(interaction));
  assert.deepEqual(restored?.interaction, interaction);
  sql.assertExhausted();
});
