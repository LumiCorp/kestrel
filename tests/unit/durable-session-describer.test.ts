import test from "node:test";
import assert from "node:assert/strict";

import { createDurableSessionDescriber } from "../../cli/runner/DurableSessionDescriber.js";
import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import { buildOperatorSessionProjection } from "../../src/orchestration/OperatorSessionProjection.js";
import { OperatorControlPlane } from "../../src/orchestration/OperatorControlPlane.js";

test("durable session describe fails closed when thread and assembly environment identities conflict", async () => {
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

  await assert.rejects(
    createDurableSessionDescriber(readOnlyStore).describeSession(sessionId),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "SESSION_ENVIRONMENT_IDENTITY_CONFLICT",
  );
  assert.deepEqual(mutationCalls, []);
  assert.equal(await store.getOperatorFocus(sessionId), null);
  assert.equal((await store.listThreads({ sessionId })).length, 1);
  assert.equal((await store.listThreadAssemblyRecords(threadId)).length, 1);
});

test("durable session describe uses a deterministic record-id tie-break for equal assembly timestamps", async () => {
  const store = new InMemorySessionStore();
  const sessionId = "equal-assembly-session";
  const threadId = "equal-assembly-thread";
  const createdAt = "2026-08-28T12:00:00.000Z";
  await store.ensureSession(sessionId, "agent.loop");
  await store.upsertThread({
    threadId,
    sessionId,
    title: "Equal assemblies",
    status: "IDLE",
    metadata: { mainThread: true },
    createdAt,
    updatedAt: createdAt,
  });
  for (const suffix of ["a", "z"] as const) {
    await store.upsertAssemblyBundle({
      bundleId: `bundle-${suffix}`,
      label: `Bundle ${suffix}`,
      source: "profile_default",
      toolAllowlist: [],
      specialistIds: [],
      metadata: {
        environmentPresetId: suffix === "z" ? "cli_dev_local" : "cli_safe_local",
      },
      createdAt,
      updatedAt: createdAt,
    });
    await store.appendThreadAssemblyRecord({
      recordId: `record-${suffix}`,
      threadId,
      bundleId: `bundle-${suffix}`,
      cause: "thread_start",
      authority: "profile",
      createdAt,
    });
  }

  assert.deepEqual(
    (await store.listThreadAssemblyRecords(threadId)).map((record) => record.recordId),
    ["record-z", "record-a"],
  );
  const described = await createDurableSessionDescriber(store).describeSession(sessionId);
  assert.equal(described?.activeAssembly?.bundleId, "bundle-z");
  assert.equal(described?.activeAssembly?.environmentPresetId, "cli_dev_local");
});

for (const scenario of [
  "pending_checkpoint",
  "child_blocker",
  "stalled",
  "obsolete_attention",
] as const) {
  test(`durable session describe does not synchronize ${scenario} attention`, async () => {
    const store = new InMemorySessionStore();
    const sessionId = `attention-${scenario}`;
    const threadId = `thread-${scenario}`;
    const now = "2026-08-28T12:00:00.000Z";
    await store.ensureSession(sessionId, "agent.loop");
    await store.upsertThread({
      threadId,
      sessionId,
      title: scenario,
      status: "IDLE",
      environmentPresetId: "cli_dev_local",
      ...(scenario === "stalled" ? { activeRunId: `run-${scenario}` } : {}),
      metadata: { mainThread: true },
      createdAt: now,
      updatedAt: now,
    });
    if (scenario === "pending_checkpoint") {
      await store.upsertContextCheckpoint({
        checkpointId: "checkpoint-pending",
        threadId,
        runId: "run-pending",
        status: "PENDING",
        recommendedAction: "operator_checkpoint",
        reason: "Review before continuing.",
        createdAt: now,
      });
    }
    if (scenario === "child_blocker") {
      const childThreadId = "thread-blocked-child";
      await store.upsertThread({
        threadId: childThreadId,
        sessionId: "child-blocker-session",
        parentThreadId: threadId,
        title: "Blocked child",
        status: "WAITING",
        waitFor: { kind: "user", eventType: "user.reply" },
        createdAt: now,
        updatedAt: now,
      });
      await store.upsertDelegation({
        delegationId: "delegation-blocked-child",
        parentThreadId: threadId,
        childThreadId,
        title: "Blocked child",
        prompt: "Wait for user",
        launchedBy: "agent",
        status: "WAITING",
        waitEventType: "user.reply",
        createdAt: now,
        updatedAt: now,
      });
    }
    if (scenario === "stalled") {
      await store.appendRunEvent({
        runId: `run-${scenario}`,
        sessionId,
        type: "run.started",
        level: "INFO",
        timestamp: "2026-08-28T11:00:00.000Z",
        metadata: { threadId },
      });
    }
    if (scenario === "obsolete_attention") {
      await store.upsertOperatorAttention({
        attentionId: "obsolete-attention",
        sessionId,
        threadId,
        kind: "context_checkpoint",
        status: "ACTIVE",
        title: "Obsolete",
        checkpointId: "missing-checkpoint",
        createdAt: now,
        updatedAt: now,
      });
    }
    const originalUpsert = store.upsertOperatorAttention.bind(store);
    let attentionWrites = 0;
    store.upsertOperatorAttention = async (record) => {
      attentionWrites += 1;
      await originalUpsert(record);
    };

    const described = await createDurableSessionDescriber(store).describeSession(sessionId);
    const describedAgain = await createDurableSessionDescriber(store).describeSession(sessionId);

    assert.equal(described?.threadId, threadId);
    assert.equal(attentionWrites, 0);
    assert.deepEqual(describedAgain, described);
    const expectedKind = scenario === "pending_checkpoint"
      ? "context_checkpoint"
      : scenario === "child_blocker"
        ? "child_thread_blocker"
        : scenario === "stalled"
          ? "stalled_thread_attention"
          : undefined;
    if (expectedKind !== undefined) {
      assert.equal(
        described?.operatorThreadView?.inboxItems?.some(
          (item) => item.kind === expectedKind,
        ),
        true,
      );
    }

    const getThreadStatus = async (candidateThreadId: string) => {
      const thread = await store.getThread(candidateThreadId);
      if (thread === null) return null;
      return {
        thread,
        openRequests: await store.listInteractionRequests({
          threadId: candidateThreadId,
          status: "PENDING",
        }),
        activeGrants: await store.listApprovalGrants({
          threadId: candidateThreadId,
          status: "ACTIVE",
        }),
        contextCheckpoints: await store.listContextCheckpoints({
          threadId: candidateThreadId,
        }),
        delegations: await store.listDelegations({
          parentThreadId: candidateThreadId,
        }),
      };
    };
    await new OperatorControlPlane({
      store,
      runtime: { getThreadStatus },
    }).listOperatorInbox({ sessionId });
    assert.equal(attentionWrites > 0, true);
  });
}

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
      getOperatorThreadViewReadOnly: async () => null,
    },
  });

  assert.equal(projection.activeAssembly?.environmentPresetId, "cli_dev_local");
  assert.equal(mutationCalls, 0);
});
