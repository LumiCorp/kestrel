import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRunnerStructuredReviewInteractionV1,
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";

import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";

import {
  DelegationSupervisor,
  InteractionManager,
  ThreadRuntime,
  type SubmitTurnInput,
  type SubmitTurnResult,
  type TurnExecutionInput,
  type TurnExecutionResult,
  type TurnExecutor,
} from "../../src/orchestration/index.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { createEvaluationReviewBindingV1 } from "../../src/kestrel/contracts/evaluation.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";


class StaticTurnExecutor implements TurnExecutor {
  private readonly result: TurnExecutionResult;
  private readonly sessionStore: InMemorySessionStore;

  constructor(sessionStore: InMemorySessionStore, result: TurnExecutionResult) {
    this.sessionStore = sessionStore;
    this.result = result;
  }

  async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    const runId = input.runtimeTurn?.runId;
    if (runId === undefined) {
      throw new Error("Static fixture requires a prestarted run.");
    }
    const output = {
      ...this.result.output,
      runId,
      sessionId: input.sessionId,
    };
    await this.sessionStore.completeRun(runId, output.status, output.errors[0]);
    return { ...this.result, output };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionStore.getSession(sessionId);
  }
}

class ThrowingTurnExecutor implements TurnExecutor {
  private readonly sessionStore: InMemorySessionStore;
  private readonly error: Error;

  constructor(sessionStore: InMemorySessionStore, error: Error) {
    this.sessionStore = sessionStore;
    this.error = error;
  }

  async executeTurn(_input: TurnExecutionInput): Promise<TurnExecutionResult> {
    throw this.error;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessionStore.getSession(sessionId);
  }
}

test("InteractionManager emits normalized not-found and state failures", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-a",
        requestId: "missing-request",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_NOT_FOUND" },
  );

  await store.upsertInteractionRequest({
    requestId: "request-a",
    threadId: "thread-owner",
    kind: "user_input",
    status: "PENDING",
    eventType: "user.reply",
    createdAt: "2026-03-16T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-other",
        requestId: "request-a",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_THREAD_MISMATCH" },
  );

  await store.upsertInteractionRequest({
    requestId: "request-b",
    threadId: "thread-owner",
    kind: "user_input",
    status: "RESOLVED",
    eventType: "user.reply",
    createdAt: "2026-03-16T12:00:00.000Z",
    resolvedAt: "2026-03-16T12:00:01.000Z",
  });

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-owner",
        requestId: "request-b",
        message: "reply",
      }),
    { code: "INTERACTION_REQUEST_NOT_PENDING" },
  );
});

test("InteractionManager grants only an exact, current, same-actor external approval once", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);
  const actor = {
    actorType: "end_user" as const,
    actorId: "user-1",
    tenantId: "org-1",
  };
  const payload = { repository: "acme/widgets", title: "Ship it" };
  const binding = buildApprovalBinding({
    approvalId: "approval-exact",
    threadId: "thread-exact",
    runId: "run-exact",
    actionKey: "github.issue.create",
    payload,
  });
  const request = await manager.syncWaitState({
    threadId: "thread-exact",
    turnId: "turn-exact",
    runId: "run-exact",
    actor,
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        approvalId: binding.approvalId,
        toolName: binding.actionKey,
        toolInput: payload,
        externalApprovalBinding: binding,
      },
    },
  });
  assert.ok(request);
  assert.equal(request.metadata?.conversationTurnId, "turn-exact");
  assert.equal(request.metadata?.conversationRunId, "run-exact");

  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-exact",
        requestId: request.requestId,
        message: "approve",
        approve: true,
        actor: { ...actor, actorId: "different-user" },
      }),
    { code: "APPROVAL_ACTOR_MISMATCH" },
  );
  assert.equal((await store.getInteractionRequest(request.requestId))?.status, "PENDING");

  const resolved = await manager.resolveRequest({
    threadId: "thread-exact",
    requestId: request.requestId,
    message: "approve",
    approve: true,
    actor,
  });
  assert.equal(resolved.grant?.binding?.payloadHash, binding.payloadHash);
  assert.deepEqual(resolved.grant?.allowedCapabilities, ["external.invoke"]);
  await assert.rejects(
    () =>
      manager.resolveRequest({
        threadId: "thread-exact",
        requestId: request.requestId,
        message: "approve again",
        approve: true,
        actor,
      }),
    { code: "INTERACTION_REQUEST_NOT_PENDING" },
  );
});

test("InteractionManager replaces a pending approval when the exact approval identity changes", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);
  const actor = {
    actorType: "end_user" as const,
    actorId: "user-1",
    tenantId: "org-1",
  };
  const payload = {
    to: ["operator@example.test"],
    subject: "Test",
    text: "Hello",
  };
  const firstBinding = buildApprovalBinding({
    approvalId: "approval-email-first",
    threadId: "thread-email",
    runId: "run-email-first",
    actionKey: "kestrel_one.email_send",
    payload,
  });
  const first = await manager.syncWaitState({
    threadId: firstBinding.threadId,
    runId: firstBinding.runId,
    actor,
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        approvalId: firstBinding.approvalId,
        toolName: firstBinding.actionKey,
        toolInput: payload,
        reason: "Build: Ask First requires per-call approval",
        externalApprovalBinding: firstBinding,
      },
    },
  });
  assert.ok(first);

  const secondBinding = buildApprovalBinding({
    approvalId: "approval-email-second",
    threadId: "thread-email",
    runId: "run-email-second",
    actionKey: "kestrel_one.email_send",
    payload,
  });
  const second = await manager.syncWaitState({
    threadId: secondBinding.threadId,
    runId: secondBinding.runId,
    actor,
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: {
        approvalId: secondBinding.approvalId,
        toolName: secondBinding.actionKey,
        toolInput: payload,
        reason: "Build: Ask First requires per-call approval",
        externalApprovalBinding: secondBinding,
      },
    },
  });
  assert.ok(second);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.runId, secondBinding.runId);
  assert.equal(second.metadata?.approvalId, secondBinding.approvalId);
  assert.equal(
    (await store.getInteractionRequest(first.requestId))?.status,
    "CANCELLED",
  );
});

test("InteractionManager rejects changed, expired, or unbound executable authority", async () => {
  const actor = { actorType: "operator" as const, actorId: "operator-1" };
  for (const scenario of ["changed_payload", "expired"] as const) {
    const store = new InMemorySessionStore();
    const manager = new InteractionManager(store);
    const payload = { command: "deploy" };
    const binding = buildApprovalBinding({
      approvalId: `approval-${scenario}`,
      threadId: `thread-${scenario}`,
      runId: `run-${scenario}`,
      actionKey: "deploy.run",
      payload,
      ...(scenario === "expired"
        ? {
            requestedAt: new Date(Date.now() - 120_000),
            expiresAt: new Date(Date.now() - 60_000),
          }
        : {}),
    });
    const request = await manager.syncWaitState({
      threadId: binding.threadId,
      runId: binding.runId,
      actor,
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        metadata: {
          approvalId: binding.approvalId,
          toolName: binding.actionKey,
          toolInput:
            scenario === "changed_payload" ? { command: "deploy --force" } : payload,
          externalApprovalBinding: binding,
        },
      },
    });
    assert.ok(request);
    await assert.rejects(
      () =>
        manager.resolveRequest({
          threadId: binding.threadId,
          requestId: request.requestId,
          message: "approve",
          approve: true,
          actor,
        }),
      {
        code:
          scenario === "changed_payload"
            ? "EXTERNAL_APPROVAL_ACTION_MISMATCH"
            : "EXTERNAL_APPROVAL_EXPIRED",
      },
    );
    assert.equal((await store.listApprovalGrants({ threadId: binding.threadId })).length, 0);
  }

  const unboundStore = new InMemorySessionStore();
  const unboundManager = new InteractionManager(unboundStore);
  const unbound = await unboundManager.syncWaitState({
    threadId: "thread-unbound",
    runId: "run-unbound",
    actor,
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: { approvalId: "approval-unbound" },
    },
  });
  assert.ok(unbound);
  const decision = await unboundManager.resolveRequest({
    threadId: "thread-unbound",
    requestId: unbound.requestId,
    message: "approve",
    approve: true,
    actor,
  });
  assert.equal(decision.grant, undefined);
});

test("InteractionManager validates exact evaluation choices before consuming the request", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);
  const actor = {
    actorType: "operator" as const,
    actorId: "operator-1",
    tenantId: "tenant-1",
  };
  const reviewBinding = buildEvaluationReviewBinding({
    threadId: "thread-recovery",
    runId: "run-recovery",
  });
  const request = await manager.syncWaitState({
    threadId: "thread-recovery",
    runId: "run-recovery",
    actor,
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "evaluation_review",
        evaluationReviewBinding: reviewBinding,
        decisionId: reviewBinding.evaluationDecisionId,
        allowedOptionIds: reviewBinding.allowedOptionIds,
      },
      interaction: evaluationReviewInteraction(reviewBinding.requestId),
    },
  });
  assert.ok(request);
  assert.deepEqual(
    request.interaction,
    evaluationReviewInteraction(reviewBinding.requestId),
  );

  await assert.rejects(
    () => manager.resolveRequest({
      threadId: "thread-recovery",
      requestId: request.requestId,
      message: "retry",
      actor,
    }),
    { code: "EVALUATION_REVIEW_RESUME_INVALID" },
  );
  assert.equal((await store.getInteractionRequest(request.requestId))?.status, "PENDING");

  await assert.rejects(
    () => manager.resolveRequest({
      threadId: "thread-recovery",
      requestId: request.requestId,
      message: "invalid",
      recoveryOptionId: "evaluation.unknown",
      actor,
    }),
    { code: "EVALUATION_OPTION_NOT_ALLOWED" },
  );
  assert.equal((await store.getInteractionRequest(request.requestId))?.status, "PENDING");

  const resolved = await manager.resolveRequest({
    threadId: "thread-recovery",
    requestId: request.requestId,
    message: "Accept once",
    recoveryOptionId: "evaluation.accept_once",
    actor,
  });
  assert.equal(resolved.request.status, "RESOLVED");
  assert.equal(
    resolved.request.response?.recoveryOptionId,
    "evaluation.accept_once",
  );
});

test("InteractionManager refuses to guess a legacy structured review from metadata", async () => {
  const store = new InMemorySessionStore();
  const manager = new InteractionManager(store);
  const request = await manager.syncWaitState({
    threadId: "thread-legacy-review",
    runId: "run-legacy-review",
    actor: { actorType: "operator", actorId: "operator-1", tenantId: "tenant-1" },
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "recovery_review",
        allowedOptionIds: ["retry.primary", "terminal.fail"],
      },
    },
  });
  assert.ok(request);

  await assert.rejects(
    () => manager.resolveRequest({
      threadId: "thread-legacy-review",
      requestId: request.requestId,
      message: "Try again",
      recoveryOptionId: "retry.primary",
      actor: { actorType: "operator", actorId: "operator-1", tenantId: "tenant-1" },
    }),
    { code: "STRUCTURED_REVIEW_INVALID" },
  );
  assert.equal((await store.getInteractionRequest(request.requestId))?.status, "PENDING");
});

test("InteractionManager rejects expired evaluation reviews and preserves actor failures", async () => {
  const expiredStore = new InMemorySessionStore();
  const expiredManager = new InteractionManager(expiredStore);
  const expiredBinding = buildEvaluationReviewBinding({
    threadId: "thread-expired-recovery",
    runId: "run-expired-recovery",
    requestedAt: new Date(Date.now() - 120_000),
    expiresAt: new Date(Date.now() - 60_000),
  });
  const expiredRequest = await expiredManager.syncWaitState({
    threadId: "thread-expired-recovery",
    runId: "run-expired-recovery",
    actor: { actorType: "operator", actorId: "operator-1", tenantId: "tenant-1" },
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "evaluation_review",
        evaluationReviewBinding: expiredBinding,
        decisionId: expiredBinding.evaluationDecisionId,
      },
      interaction: evaluationReviewInteraction(expiredBinding.requestId),
    },
  });
  assert.ok(expiredRequest);
  await assert.rejects(
    () => expiredManager.resolveRequest({
      threadId: "thread-expired-recovery",
      requestId: expiredRequest.requestId,
      message: "Accept once",
      recoveryOptionId: "evaluation.accept_once",
      actor: { actorType: "operator", actorId: "operator-1", tenantId: "tenant-1" },
    }),
    { code: "EVALUATION_WAIT_EXPIRED" },
  );
  assert.equal(
    (await expiredStore.getInteractionRequest(expiredRequest.requestId))?.status,
    "PENDING",
  );

  const actorStore = new InMemorySessionStore();
  const actorManager = new InteractionManager(actorStore);
  const actorBinding = buildEvaluationReviewBinding({
    threadId: "thread-actor-recovery",
    runId: "run-actor-recovery",
  });
  const actorRequest = await actorManager.syncWaitState({
    threadId: "thread-actor-recovery",
    runId: "run-actor-recovery",
    actor: { actorType: "operator", actorId: "operator-1", tenantId: "tenant-1" },
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "evaluation_review",
        evaluationReviewBinding: actorBinding,
        decisionId: actorBinding.evaluationDecisionId,
      },
      interaction: evaluationReviewInteraction(actorBinding.requestId),
    },
  });
  assert.ok(actorRequest);
  await assert.rejects(
    () => actorManager.resolveRequest({
      threadId: "thread-actor-recovery",
      requestId: actorRequest.requestId,
      message: "Accept once",
      recoveryOptionId: "evaluation.accept_once",
      actor: { actorType: "service", actorId: "service-1", tenantId: "tenant-1" },
    }),
    { code: "EVALUATION_REVIEW_ACTOR_INVALID" },
  );
  assert.equal(
    (await actorStore.getInteractionRequest(actorRequest.requestId))?.status,
    "PENDING",
  );
});

function buildApprovalBinding(input: {
  approvalId: string;
  threadId: string;
  runId: string;
  actionKey: string;
  payload: unknown;
  requestedAt?: Date;
  expiresAt?: Date;
}) {
  const requestedAt = input.requestedAt ?? new Date(Date.now() - 1_000);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60_000);
  return {
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: input.approvalId,
    threadId: input.threadId,
    runId: input.runId,
    actionKey: input.actionKey,
    payloadHash: `sha256:${createHash("sha256")
      .update(serializeCanonicalApprovalPayload(input.payload))
      .digest("hex")}`,
    toolClass: "external_side_effect" as const,
    capabilities: ["external.invoke"],
    authorityKind: "runtime_policy" as const,
    authorityRevision: `sha256:${"c".repeat(64)}`,
    requestedAt: requestedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function buildEvaluationReviewBinding(input: {
  threadId: string;
  runId: string;
  requestedAt?: Date;
  expiresAt?: Date;
}) {
  const requestedAt = input.requestedAt ?? new Date(Date.now() - 1_000);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 60_000);
  return createEvaluationReviewBindingV1({
    requestId: `binding-${input.runId}`,
    evaluationDecisionId: `decision-${input.runId}`,
    threadId: input.threadId,
    runId: input.runId,
    profileFingerprint: "a".repeat(64),
    policyRevision: `sha256:${"b".repeat(64)}`,
    allowedOptionIds: [
      "evaluation.accept_once",
      "evaluation.revise",
      "terminal.fail",
    ],
    issuedAt: requestedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tenantId: "tenant-1",
  });
}

function evaluationReviewInteraction(requestId: string) {
  return createRunnerStructuredReviewInteractionV1({
    reason: "evaluation_review",
    requestId,
    prompt: "Choose an evaluation option.",
    allowedOptionIds: [
      "evaluation.accept_once",
      "evaluation.revise",
      "terminal.fail",
    ],
    evaluationTechnicalDisclosure: {
      candidate: "Candidate",
      assertions: [],
      evidenceReferences: [],
    },
  });
}

test("ThreadRuntime emits normalized thread and supervisor failures", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new StaticTurnExecutor(store, {
      assistantText: null,
      output: buildOutput({
        runId: "run-a",
        status: "COMPLETED",
      }),
    }),
  });

  await assert.rejects(
    () =>
      runtime.submitTurn({
        threadId: "missing-thread",
        message: "hello",
        eventType: "user.message",
      }),
    { code: "THREAD_NOT_FOUND" },
  );

  await assert.rejects(
    () =>
      runtime.spawnDelegation({
        parentThreadId: "thread-root",
        title: "Research",
        prompt: "Investigate",
      }),
    { code: "DELEGATION_SUPERVISOR_UNAVAILABLE" },
  );
});

test("ThreadRuntime atomically projects failed output over stale thread run metadata", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new StaticTurnExecutor(store, {
      assistantText: null,
      output: buildOutput({
        runId: "run-unpersisted",
        status: "FAILED",
      }),
    }),
  });

  await runtime.startThread({
    threadId: "thread-active-run",
    title: "Thread with active run",
  });

  const persistedRunStartEvent: RuntimeEvent = {
    id: "event-run-persisted",
    type: "user.message",
    sessionId: "thread-active-run",
    payload: {},
  };
  await store.startRun("run-persisted", persistedRunStartEvent);
  await store.completeRun("run-persisted", "COMPLETED");

  const seededThread = await store.getThread("thread-active-run");
  assert.ok(seededThread);
  await store.upsertThread({
    ...seededThread,
    activeRunId: "run-persisted",
    updatedAt: "2026-04-21T00:00:00.000Z",
  });

  const result = await runtime.submitTurn({
    threadId: "thread-active-run",
    message: "trigger failed turn",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "FAILED");
  assert.notEqual(result.output.runId, "run-unpersisted");
  assert.equal((await store.getRun(result.output.runId))?.status, "FAILED");
  assert.equal(result.thread.activeRunId, undefined);
  assert.equal(result.thread.status, "FAILED");

  const persistedThread = await store.getThread("thread-active-run");
  assert.equal(persistedThread?.activeRunId, undefined);
  assert.equal(persistedThread?.status, "FAILED");
});

test("DelegationSupervisor emits normalized limit and compatibility failures", async () => {
  const store = new InMemorySessionStore();
  const supervisor = new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 1,
      },
    },
    runtimeStore: store,
    orchestrationStore: store,
    submitChildTurn: async (_input: SubmitTurnInput) => ({
      assistantText: null,
      thread: {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: "Child thread",
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      },
      output: buildOutput({
        runId: "run-child",
        status: "COMPLETED",
      }),
    }),
    startChildThread: async (input) => {
      const thread: ThreadRecord = {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: input.title,
        parentThreadId: input.parentThreadId,
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      };
      await store.ensureSession(thread.sessionId);
      await store.upsertThread(thread);
      return thread;
    },
  });

  await store.upsertDelegation({
    delegationId: "existing",
    parentThreadId: "thread-root",
    childThreadId: "child-existing",
    title: "Existing",
    prompt: "Existing",
    status: "RUNNING",
    createdAt: "2026-03-16T12:00:00.000Z",
    updatedAt: "2026-03-16T12:00:00.000Z",
  });

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-root",
        title: "Overflow",
        prompt: "Overflow",
      }),
    { code: "DELEGATION_LIMIT_REACHED" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Profile mismatch",
        prompt: "Mismatch",
        profileId: "other-profile",
      }),
    { code: "DELEGATION_PROFILE_MISMATCH" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Provider mismatch",
        prompt: "Mismatch",
        provider: "openai",
      }),
    { code: "DELEGATION_PROVIDER_MISMATCH" },
  );

  await assert.rejects(
    () =>
      supervisor.spawnDelegation({
        parentThreadId: "thread-other",
        title: "Model mismatch",
        prompt: "Mismatch",
        model: "model-b",
      }),
    { code: "DELEGATION_MODEL_MISMATCH" },
  );
});

test("DelegationSupervisor emits normalized not-persisted failure when orchestration store loses the record", async () => {
  const store = new InMemorySessionStore();
  const orchestrationStore = Object.assign(Object.create(store), {
    async getDelegation(_delegationId: string) {
      return null;
    },
  });
  const supervisor = new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
      },
    },
    runtimeStore: store,
    orchestrationStore,
    submitChildTurn: async (_input: SubmitTurnInput) => ({
      assistantText: null,
      thread: {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: "Child thread",
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      },
      output: buildOutput({
        runId: "run-child",
        status: "COMPLETED",
      }),
    }),
    startChildThread: async (input) => {
      const thread: ThreadRecord = {
        threadId: "child-thread",
        sessionId: "child-thread",
        title: input.title,
        parentThreadId: input.parentThreadId,
        status: "IDLE",
        createdAt: "2026-03-16T12:00:00.000Z",
        updatedAt: "2026-03-16T12:00:00.000Z",
      };
      await store.ensureSession(thread.sessionId);
      await store.upsertThread(thread);
      return thread;
    },
  });

  await assert.rejects(
    () =>
      supervisor.spawnTask({
        parentSessionId: "thread-root",
        parentRunId: "run-root",
        title: "Research",
        prompt: "Investigate",
      }),
    { code: "DELEGATION_NOT_PERSISTED" },
  );
});

test("Delegation failure persistence retains normalized message and event code", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: new ThrowingTurnExecutor(
      store,
      createRuntimeFailure("DELEGATION_CHILD_FAILED", "Child execution failed.", {
        threadId: "child-thread",
      }),
    ),
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: {
        allowAgentSpawn: true,
        maxConcurrentChildSessions: 2,
      },
    },
  });

  await runtime.startThread({
    threadId: "thread-root",
    title: "Root",
  });

  await runtime.spawnDelegation({
    parentThreadId: "thread-root",
    parentRunId: "run-root",
    title: "Research",
    prompt: "Investigate",
  });

  await tick();

  const delegations = await runtime.listDelegations("thread-root");
  assert.equal(delegations[0]?.status, "FAILED");
  assert.equal(delegations[0]?.errorMessage, "Child execution failed.");

  const replay = await store.getReplayStream({
    runId: "run-root",
  });
  const failedEvent = replay.find((event) => event.type === "delegation.failed");
  assert.equal(failedEvent?.metadata?.errorCode, "DELEGATION_CHILD_FAILED");
  assert.equal(failedEvent?.metadata?.errorMessage, "Child execution failed.");
});

test("persistent dialogs support multi-turn exchange, lifetime name ownership, and explicit close", async () => {
  const store = new InMemorySessionStore();
  const updates: import("../../src/orchestration/DelegationSupervisor.js").DialogMessageRecord[] = [];
  const emittedMessages: import("../../src/orchestration/DelegationSupervisor.js").DialogMessageRecord[] = [];
  let childCount = 0;
  const supervisor = new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: { allowAgentSpawn: true, maxConcurrentChildSessions: 2 },
    },
    runtimeStore: store,
    orchestrationStore: store,
    submitChildTurn: async (input) => ({
      assistantText: `reply:${input.message}`,
      thread: (await store.getThread(input.threadId))!,
      output: buildOutput({ runId: `run-${input.message}`, status: "COMPLETED" }),
    }),
    startChildThread: async (input) => {
      childCount += 1;
      const thread: ThreadRecord = {
        threadId: `dialog-child-${childCount}`,
        sessionId: `dialog-child-${childCount}`,
        title: input.title,
        parentThreadId: input.parentThreadId,
        status: "IDLE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await store.ensureSession(thread.sessionId);
      await store.upsertThread(thread);
      return thread;
    },
    onTaskUpdate: ({ dialogMessage }) => {
      if (dialogMessage !== undefined) emittedMessages.push(dialogMessage);
    },
    onDialogReply: ({ message }) => { updates.push(message); },
  });

  const opened = await supervisor.open({
    parentSessionId: "root",
    parentRunId: "run-dialog-1",
    name: "Peregrine",
    message: "first",
  });
  await tick();
  assert.equal(updates[0]?.text, "reply:first");
  assert.equal(updates[0]?.parentRunId, "run-dialog-1");
  await assert.rejects(
    () => supervisor.open({ parentSessionId: "root", name: "peregrine", message: "duplicate" }),
    { code: "DIALOG_NAME_IN_USE" },
  );

  const sent = await supervisor.send({
    parentSessionId: "root",
    parentRunId: "run-dialog-2",
    dialogId: opened.dialogId,
    message: "second",
  });
  assert.equal(sent.active, true);
  const sentMessage = emittedMessages.find(
    (message) => message.sender === "kestrel" && message.text === "second",
  );
  assert.equal(sentMessage?.parentRunId, "run-dialog-2");
  await tick();
  assert.equal(updates[1]?.text, "reply:second");
  assert.equal(updates[1]?.parentRunId, "run-dialog-2");

  const closed = await supervisor.close({ parentSessionId: "root", dialogId: opened.dialogId });
  assert.equal(closed.status, "closed");
  await assert.rejects(
    () => supervisor.send({ parentSessionId: "root", dialogId: opened.dialogId, message: "late" }),
    { code: "DIALOG_CLOSED" },
  );
  await assert.rejects(
    () => supervisor.open({ parentSessionId: "root", name: "Peregrine", message: "new" }),
    { code: "DIALOG_NAME_IN_USE" },
  );
  assert.equal(childCount, 1);
});

test("dialog close wins over a late child completion", async () => {
  const store = new InMemorySessionStore();
  const replies: string[] = [];
  let resolveTurn: ((value: SubmitTurnResult) => void) | undefined;
  const supervisor = createDialogSupervisor({
    store,
    submitChildTurn: async () => new Promise<SubmitTurnResult>((resolve) => { resolveTurn = resolve; }),
    onDialogReply: ({ message }) => { replies.push(message.text); },
  });

  const opened = await supervisor.open({ parentSessionId: "root", name: "Scout", message: "investigate" });
  await tick();
  const closed = await supervisor.close({ parentSessionId: "root", dialogId: opened.dialogId });
  assert.equal(closed.status, "closed");
  resolveTurn?.({
    assistantText: "late reply",
    thread: (await store.getThread(opened.childSessionId))!,
    output: buildOutput({ runId: "late-run", status: "COMPLETED" }),
  });
  await tick();
  await tick();

  const record = await store.getDelegation(opened.dialogId);
  const messages = ((record?.policy?.dialog as { messages?: Array<{ sender: string; text: string }> } | undefined)?.messages ?? []);
  assert.equal(messages.some((message) => message.sender === "collaborator" && message.text === "late reply"), false);
  assert.deepEqual(replies, []);
});

test("dialog reply saved before close remains available", async () => {
  const store = new InMemorySessionStore();
  const replies: string[] = [];
  let resolveTurn: ((value: SubmitTurnResult) => void) | undefined;
  const supervisor = createDialogSupervisor({
    store,
    submitChildTurn: async () => new Promise<SubmitTurnResult>((resolve) => { resolveTurn = resolve; }),
    onDialogReply: ({ message }) => { replies.push(message.text); },
  });

  const opened = await supervisor.open({ parentSessionId: "root", name: "Reviewer", message: "review" });
  await tick();
  resolveTurn?.({
    assistantText: "saved reply",
    thread: (await store.getThread(opened.childSessionId))!,
    output: buildOutput({ runId: "saved-run", status: "COMPLETED" }),
  });
  await tick();
  await tick();
  await supervisor.close({ parentSessionId: "root", dialogId: opened.dialogId });

  const record = await store.getDelegation(opened.dialogId);
  const messages = ((record?.policy?.dialog as { messages?: Array<{ sender: string; text: string }> } | undefined)?.messages ?? []);
  assert.equal(messages.some((message) => message.sender === "collaborator" && message.text === "saved reply"), true);
  assert.deepEqual(replies, ["saved reply"]);
});

test("restart reconciliation marks only open working dialogs interrupted", async () => {
  const store = new InMemorySessionStore();
  const supervisor = createDialogSupervisor({
    store,
    submitChildTurn: async () => new Promise<SubmitTurnResult>(() => {}),
  });
  const opened = await supervisor.open({ parentSessionId: "root", name: "Indexer", message: "index" });
  await tick();
  await supervisor.reconcileInterruptedDialogs("root");

  const record = await store.getDelegation(opened.dialogId);
  const dialog = record?.policy?.dialog as { status?: string; activity?: string } | undefined;
  assert.equal(dialog?.status, "open");
  assert.equal(dialog?.activity, "interrupted");
  assert.equal(record?.status, "WAITING");
});

function createDialogSupervisor(input: {
  store: InMemorySessionStore;
  submitChildTurn: (input: SubmitTurnInput) => Promise<SubmitTurnResult>;
  onDialogReply?: ((input: { message: import("../../src/orchestration/DelegationSupervisor.js").DialogMessageRecord }) => void) | undefined;
}): DelegationSupervisor {
  let childCount = 0;
  return new DelegationSupervisor({
    profile: {
      id: "reference",
      label: "Reference",
      agent: "reference-react",
      sessionPrefix: "session",
      modelProvider: "openrouter",
      model: "model-a",
      delegation: { allowAgentSpawn: true, maxConcurrentChildSessions: 4 },
    },
    runtimeStore: input.store,
    orchestrationStore: input.store,
    submitChildTurn: input.submitChildTurn,
    startChildThread: async (child) => {
      childCount += 1;
      const thread: ThreadRecord = {
        threadId: `race-child-${childCount}`,
        sessionId: `race-child-${childCount}`,
        title: child.title,
        parentThreadId: child.parentThreadId,
        status: "IDLE",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await input.store.ensureSession(thread.sessionId);
      await input.store.upsertThread(thread);
      return thread;
    },
    ...(input.onDialogReply === undefined
      ? {}
      : { onDialogReply: ({ message }) => input.onDialogReply?.({ message }) }),
  });
}

function buildOutput(input: {
  runId: string;
  status: NormalizedOutput["status"];
  waitFor?: NormalizedOutput["waitFor"] | undefined;
}): NormalizedOutput {
  return {
    status: input.status,
    sessionId: "session-placeholder",
    runId: input.runId,
    ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    errors: [],
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
