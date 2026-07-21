import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createProviderReasoningVaultFromEnv,
  ProviderReasoningVault,
} from "../../src/runtime/ProviderReasoningVault.js";
import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type { ProviderReasoningEncryptedRecord, RuntimeStore } from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


function memoryReasoningStore() {
  const records: ProviderReasoningEncryptedRecord[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const store = {
    async appendProviderReasoningAccessAudit(record: Record<string, unknown>) { audits.push(record); },
    async saveProviderReasoningRecord(record: ProviderReasoningEncryptedRecord) {
      const index = record.kind === "continuation" ? records.findIndex((item) => item.kind === "continuation" &&
        item.sessionId === record.sessionId && item.turnId === record.turnId &&
        item.provider === record.provider && item.model === record.model) : -1;
      if (index >= 0) records.splice(index, 1, record);
      else records.push(record);
    },
    async listProviderReasoningRecords(input: Record<string, unknown>) {
      return records.filter((record) => Object.entries(input).every(([key, value]) =>
        key === "includeExpired" || value === undefined || record[key as keyof ProviderReasoningEncryptedRecord] === value));
    },
    async deleteProviderReasoningRecords(input: Record<string, unknown>) {
      const before = records.length;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!;
        if (Object.entries(input).every(([key, value]) => value === undefined || record[key as keyof ProviderReasoningEncryptedRecord] === value)) {
          records.splice(index, 1);
        }
      }
      return before - records.length;
    },
    async purgeExpiredProviderReasoning() { return 0; },
    async applyProviderReasoningRetentionPolicy(input: {
      retentionScope: string;
      mode: "live_only" | "provider_visible";
      expiresAt: string;
    }) {
      let changed = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index]!;
        if (record.kind !== "retained_visible" || record.retentionScope !== input.retentionScope) continue;
        if (input.mode === "live_only") {
          records.splice(index, 1);
          changed += 1;
        } else if (record.expiresAt > input.expiresAt) {
          record.expiresAt = input.expiresAt;
          changed += 1;
        }
      }
      return changed;
    },
  } as unknown as RuntimeStore;
  return { store, records, audits };
}

contractTest("runtime.hermetic", "ProviderReasoningVault encrypts continuation and opt-in visible content with separate keys", async () => {
  const memory = memoryReasoningStore();
  const vault = new ProviderReasoningVault(
    memory.store,
    { ready: true, keySource: "environment", keyVersion: 1 },
    Buffer.alloc(32, 7),
  );
  await vault.captureResponse({
    text: "Answer.",
    toolIntents: [],
    reasoning: {
      visible: [{ format: "summary", text: "Visible provider summary." }],
      continuation: [{ provider: "openai", kind: "encrypted_content", value: { type: "reasoning", encrypted_content: "opaque" } }],
    },
    provider: { name: "openai", model: "gpt-5.2", endpoint: "responses" },
  }, {
    runId: "run-1",
    sessionId: "session-1",
    turnId: "turn-1",
    retentionScope: "profile-1",
    provider: "openai",
    model: "gpt-5.2",
    retention: { mode: "provider_visible", days: 7 },
  });

  assert.equal(memory.records.length, 2);
  assert.equal(JSON.stringify(memory.records).includes("Visible provider summary."), false);
  assert.equal(JSON.stringify(memory.records).includes("opaque"), false);

  const prepared = await vault.prepareRequest({
    input: "continue",
    reasoning: { mode: "summary" },
  }, {
    runId: "run-1",
    sessionId: "session-1",
    turnId: "turn-1",
    retentionScope: "profile-1",
    provider: "openai",
    model: "gpt-5.2",
    retention: { mode: "provider_visible", days: 7 },
  });
  assert.equal(prepared.reasoning?.continuation?.[0]?.kind, "encrypted_content");

  await assert.rejects(() => vault.readRetainedForAdmin({ runId: "run-1", sessionId: "session-1", actorRole: "member" }), /administrators/u);
  const retained = await vault.readRetainedForAdmin({ runId: "run-1", sessionId: "session-1", actorRole: "org_admin", actorId: "admin-1" });
  assert.equal(retained[0]?.text, "Visible provider summary.");
  assert.equal(memory.audits[0]?.action, "read");
});

contractTest("runtime.hermetic", "admin reads and deletions are session-scoped and audited even when no records exist", async () => {
  const memory = memoryReasoningStore();
  const vault = new ProviderReasoningVault(
    memory.store,
    { ready: true, keySource: "environment", keyVersion: 1 },
    Buffer.alloc(32, 11),
  );
  assert.deepEqual(await vault.readRetainedForAdmin({
    runId: "run-empty",
    sessionId: "session-a",
    actorRole: "org_admin",
    actorId: "admin-1",
  }), []);
  assert.equal(await vault.deleteRetainedForAdmin({
    runId: "run-empty",
    sessionId: "session-a",
    actorRole: "org_admin",
    actorId: "admin-1",
  }), 0);
  assert.deepEqual(memory.audits.map((audit) => audit.action), ["read", "delete"]);
  assert.deepEqual(memory.audits.map((audit) => audit.sessionId), ["session-a", "session-a"]);
});

contractTest("runtime.hermetic", "live-only policy never stores provider-visible text", async () => {
  const memory = memoryReasoningStore();
  const vault = new ProviderReasoningVault(
    memory.store,
    { ready: true, keySource: "environment", keyVersion: 1 },
    Buffer.alloc(32, 9),
  );
  await vault.captureResponse({
    toolIntents: [],
    reasoning: { visible: [{ format: "summary", text: "Live only." }], continuation: [] },
    provider: { name: "openai", model: "gpt-5.2", endpoint: "responses" },
  }, {
    runId: "run-2",
    sessionId: "session-2",
    turnId: "turn-2",
    retentionScope: "profile-2",
    provider: "openai",
    model: "gpt-5.2",
    retention: { mode: "live_only", days: 7 },
  });
  assert.deepEqual(memory.records, []);
});

contractTest("runtime.hermetic", "retention policy activation deletes disabled content and clamps shortened expirations by scope", async () => {
  const memory = memoryReasoningStore();
  const vault = new ProviderReasoningVault(
    memory.store,
    { ready: true, keySource: "environment", keyVersion: 1 },
    Buffer.alloc(32, 13),
  );
  for (const retentionScope of ["profile-a", "profile-b"]) {
    await vault.captureResponse({
      toolIntents: [],
      reasoning: { visible: [{ format: "summary", text: `Visible ${retentionScope}` }], continuation: [] },
      provider: { name: "openai", model: "gpt-5.2", endpoint: "responses" },
    }, {
      runId: `run-${retentionScope}`,
      sessionId: `session-${retentionScope}`,
      turnId: `turn-${retentionScope}`,
      retentionScope,
      provider: "openai",
      model: "gpt-5.2",
      retention: { mode: "provider_visible", days: 30 },
    });
  }
  const now = new Date("2026-07-15T12:00:00.000Z");
  assert.equal(await vault.applyRetentionPolicy("profile-a", { mode: "provider_visible", days: 3 }, now), 1);
  assert.equal(
    memory.records.find((record) => record.retentionScope === "profile-a")?.expiresAt,
    "2026-07-18T12:00:00.000Z",
  );
  assert.equal(await vault.applyRetentionPolicy("profile-a", { mode: "live_only", days: 7 }, now), 1);
  assert.deepEqual(memory.records.map((record) => record.retentionScope), ["profile-b"]);
});

contractTest("runtime.hermetic", "hosted reasoning fails closed without a configured master key", () => {
  const memory = memoryReasoningStore();
  assert.throws(
    () => createProviderReasoningVaultFromEnv(memory.store, { KESTREL_HOSTED: "true" }),
    /KESTREL_REASONING_MASTER_KEY is required/u,
  );
  assert.throws(
    () => createProviderReasoningVaultFromEnv(memory.store, {
      KESTREL_HOSTED: "true",
      KESTREL_REASONING_MASTER_KEY: "not-a-32-byte-key",
    }),
    /exactly 32 bytes/u,
  );
});

contractTest("runtime.hermetic", "local reasoning creates a private key file and advertises local readiness", () => {
  const memory = memoryReasoningStore();
  const directory = mkdtempSync(join(tmpdir(), "kestrel-reasoning-key-"));
  const keyPath = join(directory, "nested", "reasoning.key");
  const vault = createProviderReasoningVaultFromEnv(memory.store, {
    KESTREL_REASONING_KEY_FILE: keyPath,
  });
  assert.deepEqual(vault.status(), {
    ready: true,
    keySource: "local_file",
    keyVersion: 1,
  });
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
});

contractTest("runtime.hermetic", "the engine purges exact provider continuation state when the active turn ends", async () => {
  const memory = memoryReasoningStore();
  const runtimeStore = Object.assign(new InMemorySessionStore(), memory.store);
  const vault = new ProviderReasoningVault(
    runtimeStore,
    { ready: true, keySource: "environment", keyVersion: 1 },
    Buffer.alloc(32, 17),
  );
  const kestrel = new Kestrel({
    store: runtimeStore,
    providerReasoningVault: vault,
    modelGateway: new RetryingModelGateway(async <T>() => ({
      text: "Done.",
      toolIntents: [],
      reasoning: {
        visible: [{ format: "summary", text: "Checked." }],
        continuation: [{ provider: "openai", kind: "encrypted_content", value: { encrypted_content: "opaque" } }],
      },
      provider: { name: "openai", model: "gpt-5.2", endpoint: "responses" },
    } as T)),
    toolGateway: { async call<T>() { return {} as T; } },
  });
  kestrel.registerStep("finish", async (_context, io) => {
    await io.useModel({
      input: "finish",
      reasoning: { mode: "summary" },
      metadata: {
        requestedProvider: "openai",
        reasoningRetentionScope: "profile-1",
        reasoningRetention: { mode: "provider_visible", days: 7 },
      },
    });
    return { status: "COMPLETED" };
  });

  await kestrel.run({
    id: "event-turn-purge",
    type: "user.message",
    sessionId: "session-turn-purge",
    stepAgent: "finish",
    payload: { message: "finish", metadata: { turnId: "turn-purge" } },
  });

  assert.equal(memory.records.some((item) => item.kind === "continuation"), false);
  assert.equal(memory.records.filter((item) => item.kind === "retained_visible").length, 1);
});

contractTest("runtime.hermetic", "local reasoning keeps its generated key inside an explicit KESTREL_HOME", () => {
  const memory = memoryReasoningStore();
  const kestrelHome = mkdtempSync(join(tmpdir(), "kestrel-reasoning-home-"));
  createProviderReasoningVaultFromEnv(memory.store, { KESTREL_HOME: kestrelHome });
  assert.equal(statSync(join(kestrelHome, "reasoning.key")).mode & 0o777, 0o600);
});
