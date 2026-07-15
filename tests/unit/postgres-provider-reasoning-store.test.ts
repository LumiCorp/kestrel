import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresSessionStore,
  type SqlExecutor,
} from "../../src/store/PostgresSessionStore.js";
import type { ProviderReasoningEncryptedRecord } from "../../src/kestrel/contracts/store.js";

function recordingExecutor(rowCount = 1) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const executor: SqlExecutor = {
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: [], rowCount };
    },
  };
  return { executor, calls };
}

const record: ProviderReasoningEncryptedRecord = {
  recordId: "reasoning-1",
  kind: "retained_visible",
  runId: "run-1",
  sessionId: "session-1",
  turnId: "turn-1",
  retentionScope: "profile-1",
  provider: "openai",
  model: "gpt-5.2",
  format: "summary",
  ciphertext: "ciphertext",
  iv: "iv",
  authTag: "tag",
  keyVersion: 1,
  createdAt: "2026-07-15T12:00:00.000Z",
  expiresAt: "2026-07-22T12:00:00.000Z",
};

test("Postgres reasoning writes carry the retention scope without plaintext", async () => {
  const fake = recordingExecutor();
  const store = new PostgresSessionStore(fake.executor);
  await store.saveProviderReasoningRecord(record);

  assert.match(fake.calls[0]?.text ?? "", /retention_scope/u);
  assert.equal(fake.calls[0]?.values[5], "profile-1");
  assert.equal(JSON.stringify(fake.calls).includes("provider summary"), false);
});

test("Postgres retention policy deletes disabled visible content only within its scope", async () => {
  const fake = recordingExecutor(3);
  const store = new PostgresSessionStore(fake.executor);
  const changed = await store.applyProviderReasoningRetentionPolicy({
    retentionScope: "profile-1",
    mode: "live_only",
    expiresAt: "2026-07-22T12:00:00.000Z",
  });

  assert.equal(changed, 3);
  assert.match(fake.calls[0]?.text ?? "", /DELETE FROM provider_reasoning_state/u);
  assert.match(fake.calls[0]?.text ?? "", /record_kind = 'retained_visible'/u);
  assert.deepEqual(fake.calls[0]?.values, ["profile-1"]);
});

test("Postgres retention shortening can only clamp existing expiration", async () => {
  const fake = recordingExecutor(2);
  const store = new PostgresSessionStore(fake.executor);
  const expiresAt = "2026-07-18T12:00:00.000Z";
  const changed = await store.applyProviderReasoningRetentionPolicy({
    retentionScope: "profile-1",
    mode: "provider_visible",
    expiresAt,
  });

  assert.equal(changed, 2);
  assert.match(fake.calls[0]?.text ?? "", /SET expires_at = LEAST\(expires_at, \$2::timestamptz\)/u);
  assert.match(fake.calls[0]?.text ?? "", /expires_at > \$2::timestamptz/u);
  assert.deepEqual(fake.calls[0]?.values, ["profile-1", expiresAt]);
});
