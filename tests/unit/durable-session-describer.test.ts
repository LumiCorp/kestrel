import test from "node:test";
import assert from "node:assert/strict";

import { createDurableSessionDescriber } from "../../cli/runner/DurableSessionDescriber.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { buildOperatorSessionProjection } from "../../src/orchestration/OperatorSessionProjection.js";

test("durable session describe recovers default-tmp-3 after restart without runtime state or writes", async () => {
  const store = new InMemorySessionStore();
  const sessionId = "reference-default-tmp-3";
  const threadId = `thread-main:${sessionId}`;
  await store.ensureSession(sessionId, "agent.loop");
  await store.upsertThread({
    threadId,
    sessionId,
    title: "default-tmp-3",
    status: "WAITING",
    environmentPresetId: "cli_safe_local",
    effectiveAssemblyId: "assembly-safe",
    effectiveAssemblyLabel: "Safe sandbox",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: { prompt: "Continue?" },
    },
    metadata: { mainThread: true },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:01:00.000Z",
  });
  await store.upsertAssemblyBundle({
    bundleId: "assembly-safe",
    label: "Safe sandbox",
    source: "profile_default",
    toolAllowlist: ["fs.read_text"],
    specialistIds: [],
    metadata: {
      // Thread identity is authoritative even if older bundle metadata disagrees.
      environmentPresetId: "cli_dev_local",
    },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  });
  await store.appendThreadAssemblyRecord({
    recordId: "assembly-record-safe",
    threadId,
    bundleId: "assembly-safe",
    cause: "thread_start",
    authority: "profile",
    createdAt: "2026-08-28T12:00:00.000Z",
  });

  const mutationCalls: string[] = [];
  const readOnlyStore = new Proxy(store, {
    get(target, property, receiver) {
      if (
        typeof property === "string"
        && (/^(upsert|append|save|patch|update|claim|create|delete|record|restore)/u).test(property)
      ) {
        return async () => {
          mutationCalls.push(property);
          throw new Error(`session.describe attempted mutation ${property}`);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SessionStore;

  const described = await createDurableSessionDescriber(readOnlyStore)
    .describeSession(sessionId);

  assert.equal(described?.threadId, threadId);
  assert.equal(described?.focusedThreadId, threadId);
  assert.equal(described?.activeAssembly?.bundleId, "assembly-safe");
  assert.equal(described?.activeAssembly?.environmentPresetId, "cli_safe_local");
  assert.equal(described?.waitFor?.kind, "user");
  assert.deepEqual(described?.operatorInbox, {
    total: 0,
    actionable: 0,
    approvals: 0,
    userInputs: 0,
    checkpoints: 0,
    childBlockers: 0,
    stalled: 0,
    assemblyProposals: 0,
    compatibilityAlerts: 0,
  });
  assert.equal(described?.operatorThreadView?.thread.threadId, threadId);
  assert.deepEqual(mutationCalls, []);
  assert.equal(await store.getOperatorFocus(sessionId), null);
  assert.equal((await store.listThreads({ sessionId })).length, 1);
  assert.equal((await store.listThreadAssemblyRecords(threadId)).length, 1);
});

test("durable session describe isolates exact session identity from other cached durable sessions", async () => {
  const store = new InMemorySessionStore();
  for (const environmentPresetId of ["cli_safe_local", "cli_dev_local"] as const) {
    const sessionId = `session-${environmentPresetId}`;
    await store.ensureSession(sessionId, "agent.loop");
    await store.upsertThread({
      threadId: `thread-${environmentPresetId}`,
      sessionId,
      title: sessionId,
      status: "IDLE",
      environmentPresetId,
      metadata: { mainThread: true },
      createdAt: "2026-08-28T12:00:00.000Z",
      updatedAt: "2026-08-28T12:00:00.000Z",
    });
  }

  const describer = createDurableSessionDescriber(store);
  const safe = await describer.describeSession("session-cli_safe_local");
  const dev = await describer.describeSession("session-cli_dev_local");

  assert.equal(safe?.threadId, "thread-cli_safe_local");
  assert.equal(safe?.activeAssembly?.environmentPresetId, "cli_safe_local");
  assert.equal(dev?.threadId, "thread-cli_dev_local");
  assert.equal(dev?.activeAssembly?.environmentPresetId, "cli_dev_local");
});

test("durable session describe recovers legacy environment identity from exact assembly metadata", async () => {
  const store = new InMemorySessionStore();
  const sessionId = "legacy-safe-session";
  const threadId = "legacy-safe-thread";
  await store.ensureSession(sessionId, "agent.loop");
  await store.upsertThread({
    threadId,
    sessionId,
    title: "Legacy safe session",
    status: "IDLE",
    metadata: { mainThread: true },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  });
  await store.upsertAssemblyBundle({
    bundleId: "legacy-safe-assembly",
    label: "Legacy safe assembly",
    source: "profile_default",
    toolAllowlist: [],
    specialistIds: [],
    metadata: { environmentPresetId: "cli_safe_local" },
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  });
  await store.appendThreadAssemblyRecord({
    recordId: "legacy-safe-record",
    threadId,
    bundleId: "legacy-safe-assembly",
    cause: "thread_start",
    authority: "profile",
    createdAt: "2026-08-28T12:00:00.000Z",
  });

  const described = await createDurableSessionDescriber(store).describeSession(sessionId);

  assert.equal(described?.activeAssembly?.environmentPresetId, "cli_safe_local");
});

test("read-only operator projection never invokes thread or focus creation seams", async () => {
  const thread = {
    threadId: "thread-read-only",
    sessionId: "session-read-only",
    title: "Read only",
    status: "IDLE" as const,
    environmentPresetId: "cli_dev_local" as const,
    createdAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
  };
  let mutationCalls = 0;
  const projection = await buildOperatorSessionProjection({
    sessionId: thread.sessionId,
    session: {
      version: 1,
      updatedAt: thread.updatedAt,
      state: {},
    },
    createMainThread: false,
    threadRuntime: {
      findMainThreadForSession: async () => thread,
      ensureMainThreadForSession: async () => {
        mutationCalls += 1;
        throw new Error("main thread creation must not run");
      },
      getThreadStatus: async () => ({
        thread,
        openRequests: [],
        activeGrants: [],
        contextCheckpoints: [],
        delegations: [],
      }),
      listOperatorInbox: async () => {
        mutationCalls += 1;
        throw new Error("focus-creating inbox path must not run");
      },
      listOperatorInboxReadOnly: async () => ({
        focusThreadId: thread.threadId,
        items: [],
        summary: {
          total: 0,
          actionable: 0,
          approvals: 0,
          userInputs: 0,
          checkpoints: 0,
          childBlockers: 0,
          stalled: 0,
          assemblyProposals: 0,
          compatibilityAlerts: 0,
        },
      }),
      getOperatorThreadView: async () => null,
    },
  });

  assert.equal(projection.activeAssembly?.environmentPresetId, "cli_dev_local");
  assert.equal(mutationCalls, 0);
});
