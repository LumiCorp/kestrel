import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { ProductProjectStateStore } from "../src/project/store.js";
import { createEmptyProjectSnapshot, normalizeProjectSnapshot } from "../src/project/state.js";
import type { ProductProjectBoardAction } from "../src/project/contracts.js";
import type { ProductTaskGraph } from "../src/taskGraph/contracts.js";

const graph: ProductTaskGraph = {
  version: 1,
  activeTaskId: "task:thread:thread-main",
  rootTaskIds: ["task:thread:thread-main"],
  tasks: {
    "task:thread:thread-main": {
      id: "task:thread:thread-main",
      title: "Main task",
      order: 0,
      status: "active",
      source: "thread",
      proposedByAgent: false,
      linkedThreadId: "thread-main",
      linkedSessionId: "session-main",
      activeThreadLineageId: "thread-main",
      linkedBranch: "feature/main-task",
      memory: {
        goal: "",
        currentPlan: "",
        findings: "",
        decisions: "",
        openQuestions: "",
        nextAction: "",
        linkedArtifacts: [],
      },
      runtime: {
        latestArtifactSummary: "Edited 3 files",
        resultSummary: "Created branch and prepared diff",
      },
      updatedAt: "2026-03-17T12:00:00.000Z",
    },
  },
};

let boardActionCounter = 0;

function boardAction(
  sessionId: string,
  action: Record<string, unknown> & { type: ProductProjectBoardAction["type"] },
): ProductProjectBoardAction {
  boardActionCounter += 1;
  return {
    ...action,
    sessionId,
    actionId: `board-action-${boardActionCounter}`,
    actionTs: `2026-05-17T12:00:${String(boardActionCounter).padStart(2, "0")}.000Z`,
  } as ProductProjectBoardAction;
}

test("project store persists setup and policy state", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return {
        repoRoot: "/tmp/repo",
        currentBranch: "feature/main-task",
        statusSummary: "## feature/main-task",
        branches: [{ name: "main" }, { name: "feature/main-task", current: true }],
        worktrees: [],
        pullRequests: [],
        recentCommits: [],
      };
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-main";

  const saved = await store.saveSnapshot(sessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      workspaceRoot: "/tmp/repo",
      repoRoot: "/tmp/repo",
      repoLabel: "kestrel",
      defaultBranch: "main",
      providerProfileId: "reference-web",
      githubConnected: true,
      githubOwner: "greg",
      githubRepo: "kestrel",
      browserReady: true,
      codeReady: true,
      mcpReady: false,
    },
    policy: {
      ...createEmptyProjectSnapshot().policy,
      sandboxMode: "workspace_write",
      approvalMode: "manual",
    },
  });

  assert.equal(saved.setup.repoLabel, "kestrel");

  const snapshot = await store.getSnapshot({ sessionId, graph });
  assert.equal(snapshot.review.currentBranch, "feature/main-task");
  assert.equal(snapshot.activity[0]?.title, "Main task");
});

test("project review reads setup from product state", async () => {
  const sessionStore = new InMemorySessionStore();
  let reviewDetailRepoRoot: string | undefined;
  let reviewActionRepoRoot: string | undefined;
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
    async inspectReviewDetail(input: { setup: { repoRoot: string }; target: Record<string, unknown> }) {
      reviewDetailRepoRoot = input.setup.repoRoot;
      return {
        target: input.target,
        repoRoot: input.setup.repoRoot,
        changedFiles: [],
        diffHunks: [],
        recentCommits: [],
        checks: [],
        comments: [],
      };
    },
    async applyReviewAction(input: { setup: { repoRoot: string } }) {
      reviewActionRepoRoot = input.setup.repoRoot;
    },
  } as never);
  const sessionId = "session-review-product-state";

  await store.saveSnapshot(sessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      ...createEmptyProjectSnapshot().setup,
      repoRoot: "/tmp/product-state-review",
    },
  });

  const detail = await store.getReviewDetail({
    sessionId,
    graph,
    target: { branchName: "feature/main-task" },
  });
  assert.equal(detail.repoRoot, "/tmp/product-state-review");
  assert.equal(reviewDetailRepoRoot, "/tmp/product-state-review");

  await store.applyReviewAction({
    sessionId,
    graph,
    action: {
      type: "review.refresh",
      sessionId,
      target: { branchName: "feature/main-task" },
    },
  });
  assert.equal(reviewActionRepoRoot, "/tmp/product-state-review");
});

test("project store uses product-state methods without patchSessionState", async () => {
  type ProductOnlyState = {
    sessionId: string;
    version: number;
    projectSnapshot: ReturnType<typeof createEmptyProjectSnapshot>;
    taskGraph: Record<string, unknown>;
    workspaceCheckpointState: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  let productState: ProductOnlyState | null = null;
  const productOnlySessionStore = {
    async ensureSession(sessionId: string) {
      return {
        sessionId,
        version: 0,
        state: {},
        updatedAt: "2026-05-17T12:00:00.000Z",
      };
    },
    async getSession() {
      return null;
    },
    async getSessionProductState() {
      return productState;
    },
    async saveSessionProjectSnapshot(input: { sessionId: string; snapshot: ReturnType<typeof createEmptyProjectSnapshot> }) {
      const now = "2026-05-17T12:00:00.000Z";
      productState = {
        sessionId: input.sessionId,
        version: productState === null ? 1 : productState.version + 1,
        projectSnapshot: normalizeProjectSnapshot(input.snapshot, input.snapshot.graphVersion),
        taskGraph: {},
        workspaceCheckpointState: {},
        createdAt: productState?.createdAt ?? now,
        updatedAt: now,
      };
      return productState;
    },
    async updateSessionProjectSnapshot(input: {
      sessionId: string;
      graphVersion?: ReturnType<typeof createEmptyProjectSnapshot>["graphVersion"] | undefined;
      apply: (snapshot: ReturnType<typeof createEmptyProjectSnapshot>) => ReturnType<typeof createEmptyProjectSnapshot>;
    }) {
      const now = "2026-05-17T12:00:00.000Z";
      const current = productState?.projectSnapshot ?? createEmptyProjectSnapshot(input.graphVersion ?? 1);
      productState = {
        sessionId: input.sessionId,
        version: productState === null ? 1 : productState.version + 1,
        projectSnapshot: normalizeProjectSnapshot(input.apply(current), input.graphVersion ?? current.graphVersion),
        taskGraph: {},
        workspaceCheckpointState: {},
        createdAt: productState?.createdAt ?? now,
        updatedAt: now,
      };
      return productState;
    },
  };
  const store = new ProductProjectStateStore(productOnlySessionStore as never, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-product-state-only";

  await store.saveSnapshot(sessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      ...createEmptyProjectSnapshot().setup,
      repoLabel: "product-only",
    },
  });
  const savedProductState = productState as ProductOnlyState | null;
  assert.equal(savedProductState?.projectSnapshot.setup.repoLabel, "product-only");

  const snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Product only", prompt: "No patchSessionState.", source: "operator" }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.title, "Product only");
  const updatedProductState = productState as ProductOnlyState | null;
  assert.equal(updatedProductState?.projectSnapshot.board.cards["K-1"]?.title, "Product only");
});

test("project store records policy decisions for project actions", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return {
        repoRoot: "/tmp/repo",
        currentBranch: "feature/main-task",
        statusSummary: "## feature/main-task",
        branches: [{ name: "feature/main-task", current: true }],
        worktrees: [],
        pullRequests: [],
        recentCommits: [],
      };
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-main";
  await store.saveSnapshot(sessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      ...createEmptyProjectSnapshot().setup,
      repoRoot: "/tmp/repo",
      repoLabel: "kestrel",
    },
  });

  const snapshot = await store.applyAction({
    sessionId,
    graph,
    action: {
      type: "branch.create",
      sessionId,
      branchName: "feature/main-task",
    },
  });

  assert.equal(snapshot.policy.recentDecisions[0]?.summary, "branch.create feature/main-task");
});

test("normalizeProjectSnapshot drops invalid review summary entries", () => {
  const snapshot = normalizeProjectSnapshot({
    review: {
      branches: [
        { name: "main" },
        { current: true },
      ],
      worktrees: [
        { path: "/tmp/repo" },
        { branch: "feature/main-task" },
      ],
      pullRequests: [
        {
          number: 42,
          title: "Valid PR",
          branch: "feature/main-task",
          baseBranch: "main",
          state: "OPEN",
        },
        {
          number: 43,
          title: "Missing branch",
          baseBranch: "main",
        },
      ],
      recentCommits: [
        { sha: "abcdef1", summary: "Valid commit" },
        { sha: "abcdef2" },
      ],
    },
  });

  assert.deepEqual(snapshot.review.branches, [{ name: "main" }]);
  assert.deepEqual(snapshot.review.worktrees, [{ path: "/tmp/repo" }]);
  assert.equal(snapshot.review.pullRequests.length, 1);
  assert.equal(snapshot.review.pullRequests[0]?.number, 42);
  assert.deepEqual(snapshot.review.recentCommits, [{ sha: "abcdef1", summary: "Valid commit" }]);
});

test("project board actions create update and move backlog cards", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board";

  const created = await store.applyAction({
    sessionId,
    graph,
    action: {
      ...boardAction(sessionId, {
        type: "board.card.create",
        title: "Add board",
        prompt: "Implement the board.",
        source: "tool",
      }),
    },
  });
  assert.equal(created.board.cards["K-1"]?.lane, "idea");
  assert.equal(created.board.nextCardNumber, 2);

  const updated = await store.applyAction({
    sessionId,
    graph,
    action: {
      ...boardAction(sessionId, {
        type: "board.card.update",
        cardId: "K-1",
        title: "Add runtime board",
        expectedBoardVersion: created.board.boardVersion,
        source: "tool",
      }),
    },
  });
  assert.equal(updated.board.cards["K-1"]?.title, "Add runtime board");

  const planned = await store.applyAction({
    sessionId,
    graph,
    action: {
      ...boardAction(sessionId, {
        type: "board.card.move",
        cardId: "K-1",
        targetLane: "planned",
        expectedBoardVersion: updated.board.boardVersion,
        source: "tool",
      }),
    },
  });
  assert.equal(planned.board.cards["K-1"]?.lane, "planned");
});

test("project board enforces version conflicts and tool movement scope", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-conflict";
  const created = await store.applyAction({
    sessionId,
    graph,
    action: {
      ...boardAction(sessionId, {
        type: "board.card.create",
        title: "Add board",
        prompt: "Implement the board.",
        source: "tool",
      }),
    },
  });

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: {
        ...boardAction(sessionId, {
          type: "board.card.update",
          cardId: "K-1",
          title: "Stale",
          expectedBoardVersion: created.board.boardVersion - 1,
          source: "tool",
        }),
      },
    }),
    /Project board version conflict/,
  );

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: {
        ...boardAction(sessionId, {
          type: "board.card.move",
          cardId: "K-1",
          targetLane: "wip",
          expectedBoardVersion: created.board.boardVersion,
          source: "tool",
        }),
      },
    }),
    /Card movement tool can only move idea <-> planned/,
  );
});

test("project board rejects done lane moves and invalid start lanes", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-transition-guards";

  let snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Guard", prompt: "Guard lanes.", source: "operator" }),
  });

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: boardAction(sessionId, {
        type: "board.card.move",
        cardId: "K-1",
        targetLane: "done",
        source: "operator",
      }),
    }),
    /manual_done/,
  );

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: boardAction(sessionId, { type: "board.card.start_implementation", cardId: "K-1" }),
    }),
    /Implementation can only start from planned cards/,
  );

  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.card.move",
      cardId: "K-1",
      targetLane: "planned",
      source: "operator",
    }),
  });

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: boardAction(sessionId, { type: "board.card.start_testing", cardId: "K-1" }),
    }),
    /Testing can only start from testing cards/,
  );
  assert.equal(snapshot.board.cards["K-1"]?.lane, "planned");
});

test("project board requires explicit confirmation when enabling autopilot", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-autopilot-confirmation";

  await assert.rejects(
    () => store.applyAction({
      sessionId,
      graph,
      action: boardAction(sessionId, {
        type: "board.autopilot.configure",
        autopilotEnabled: true,
      }),
    }),
    /requires an explicit confirmation timestamp/,
  );

  const snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.autopilot.configure",
      autopilotEnabled: true,
      autopilotConfirmedAt: "2026-05-17T12:00:00.000Z",
    }),
  });

  assert.equal(snapshot.board.settings.autopilotEnabled, true);
});

test("project board manual done records override evidence and stops active claims", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-manual-done";

  let snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Override", prompt: "Override done.", source: "operator" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.move", cardId: "K-1", targetLane: "planned", source: "operator" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.start_implementation", cardId: "K-1" }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.activeClaim?.kind, "implementation");

  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.card.manual_done",
      cardId: "K-1",
      reason: "Operator accepted external evidence.",
      source: "operator",
    }),
  });

  const card = snapshot.board.cards["K-1"];
  assert.equal(card?.lane, "done");
  assert.equal(card?.activeClaim, undefined);
  assert.equal(card?.threads.at(-1)?.status, "stopped");
  assert.equal(card?.evidence.some((entry) => entry.outcome === "manual_done"), true);
  assert.equal(card?.evidence.some((entry) => entry.outcome === "thread_stopped"), true);
});

test("project board product state does not invalidate active runtime commits", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-product-state";
  const event = {
    id: "event-runtime-commit",
    type: "MESSAGE",
    sessionId,
    payload: {},
  };

  await sessionStore.ensureSession(sessionId, "agent.loop");
  await sessionStore.startRun("run-product-state", event);
  const before = await sessionStore.getSession(sessionId);
  assert.equal(before?.version, 0);

  await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Product state", prompt: "Keep runtime version stable.", source: "operator" }),
  });

  const afterBoard = await sessionStore.getSession(sessionId);
  assert.equal(afterBoard?.version, 0);
  assert.equal(((afterBoard?.state.product as { projectSnapshot?: unknown } | undefined)?.projectSnapshot), undefined);
  const productState = await sessionStore.getSessionProductState?.(sessionId);
  assert.equal(productState?.projectSnapshot.board.cards["K-1"]?.lane, "idea");

  const committed = await sessionStore.commitStep({
    runId: "run-product-state",
    event,
    sessionId,
    expectedVersion: 0,
    nextStepAgent: "agent.next",
    statePatch: { agent: { loop: { status: "committed" } } },
    effects: [],
    emitEvents: [],
    stepIndex: 0,
  });
  assert.equal(committed.session.version, 1);
});

test("project snapshot product state seeds sibling product fields from legacy session state", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-product-sibling-seed";
  sessionStore.seedSession(sessionId, {
    product: {
      taskGraph: {
        version: 1,
        rootTaskIds: ["task-one"],
        tasks: {},
      },
      workspaceCheckpointState: {
        version: 1,
        checkpoints: [],
        restores: [],
        cleanups: [],
      },
    },
  });

  await store.saveSnapshot(sessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      ...createEmptyProjectSnapshot().setup,
      repoLabel: "seeded",
    },
  });

  const productState = await sessionStore.getSessionProductState?.(sessionId);
  assert.deepEqual(productState?.taskGraph, {
    version: 1,
    rootTaskIds: ["task-one"],
    tasks: {},
  });
  assert.deepEqual(productState?.workspaceCheckpointState, {
    version: 1,
    checkpoints: [],
    restores: [],
    cleanups: [],
  });
  assert.equal(productState?.projectSnapshot.setup.repoLabel, "seeded");
});

test("project board autopilot respects wip limit and prioritizes testing", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-autopilot";
  let snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Impl", prompt: "Implement.", source: "tool" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Verify", prompt: "Verify.", source: "tool" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.move", cardId: "K-1", targetLane: "planned", source: "operator" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.move", cardId: "K-2", targetLane: "testing", source: "operator" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.autopilot.configure",
      autopilotEnabled: true,
      autopilotConfirmedAt: "2026-05-17T12:00:00.000Z",
      wipLimit: 1,
    }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.autopilot.tick" }),
  });
  assert.equal(snapshot.board.cards["K-2"]?.activeClaim?.kind, "testing");
  assert.equal(snapshot.board.cards["K-1"]?.activeClaim, undefined);

  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.testing_verdict", cardId: "K-2", testingVerdict: "pass" }),
  });
  assert.equal(snapshot.board.cards["K-2"]?.lane, "done");

  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.autopilot.tick" }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.lane, "wip");
  assert.equal(snapshot.board.cards["K-1"]?.activeClaim?.kind, "implementation");
});

test("project board implementation and testing outcomes move cards through lanes", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-flow";
  let snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.create", title: "Flow", prompt: "Implement flow.", source: "tool" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.move", cardId: "K-1", targetLane: "planned", source: "operator" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.start_implementation", cardId: "K-1" }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.lane, "wip");
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.thread_completed", cardId: "K-1", summary: "Implemented." }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.lane, "testing");
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.start_testing", cardId: "K-1" }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, { type: "board.card.testing_verdict", cardId: "K-1", testingVerdict: "fail" }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.lane, "planned");
  assert.equal(snapshot.board.cards["K-1"]?.evidence.at(-1)?.outcome, "verdict_fail");
});

test("project board actions use deterministic action metadata for timestamps", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-deterministic";
  const action = boardAction(sessionId, {
    type: "board.card.create",
    title: "Stable",
    prompt: "Stay stable.",
    source: "tool",
  });

  const snapshot = await store.applyAction({ sessionId, graph, action });

  assert.equal(snapshot.board.cards["K-1"]?.createdAt, action.actionTs);
  assert.equal(snapshot.board.cards["K-1"]?.updatedAt, action.actionTs);
  assert.equal(snapshot.board.cards["K-1"]?.evidence[0]?.timestamp, action.actionTs);
});

test("project board autopilot tick carries the real session id into active claims", async () => {
  const sessionStore = new InMemorySessionStore();
  const store = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const sessionId = "session-board-claim";

  let snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.card.create",
      title: "Claim",
      prompt: "Claim it.",
      source: "tool",
    }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.card.move",
      cardId: "K-1",
      targetLane: "planned",
      source: "operator",
    }),
  });
  snapshot = await store.applyAction({
    sessionId,
    graph,
    action: boardAction(sessionId, {
      type: "board.autopilot.configure",
      autopilotEnabled: true,
      autopilotConfirmedAt: "2026-05-17T12:00:00.000Z",
      wipLimit: 1,
    }),
  });
  const tickAction = boardAction(sessionId, { type: "board.autopilot.tick" });
  snapshot = await store.applyAction({ sessionId, graph, action: tickAction });

  const claim = snapshot.board.cards["K-1"]?.activeClaim;
  assert.equal(claim?.sessionId.startsWith(`${sessionId}:card:K-1:implementation:`), true);
  assert.equal(claim?.sessionId.includes(tickAction.actionId), true);
});
