import assert from "node:assert/strict";

import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { ProductProjectStateStore } from "../src/project/store.js";
import {
  createEmptyProjectSnapshot,
  normalizeProjectSnapshot,
} from "../src/project/state.js";
import type { ProductTaskGraph } from "../src/taskGraph/contracts.js";
import { contractTest } from "./helpers/contract-test.js";

const graph: ProductTaskGraph = {
  version: 1,
  activeTaskId: "task-main",
  rootTaskIds: ["task-main"],
  tasks: {
    "task-main": {
      id: "task-main",
      title: "Main task",
      order: 0,
      status: "active",
      source: "thread",
      proposedByAgent: false,
      linkedThreadId: "thread-main",
      linkedSessionId: "session-main",
      activeThreadLineageId: "thread-main",
      memory: {
        goal: "",
        currentPlan: "",
        findings: "",
        decisions: "",
        openQuestions: "",
        nextAction: "",
        linkedArtifacts: [],
      },
      runtime: {},
      updatedAt: "2026-07-30T12:00:00.000Z",
    },
  },
};

contractTest(
  "runtime.hermetic",
  "project store remains a read-only supporting projection",
  async () => {
    const sessionStore = new InMemorySessionStore();
    const sessionId = "session-main";
    await sessionStore.ensureSession(sessionId);
    await sessionStore.saveSessionProjectSnapshot({
      sessionId,
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup: {
          ...createEmptyProjectSnapshot().setup,
          repoRoot: "/tmp/repo",
          workspaceRoot: "/tmp/repo",
          repoLabel: "kestrel",
        },
      },
    });
    const store = new ProductProjectStateStore(sessionStore, {
      async inspectReviewState() {
        return {
          repoRoot: "/tmp/repo",
          currentBranch: "main",
          branches: [{ name: "main", current: true }],
          worktrees: [],
          pullRequests: [],
          recentCommits: [],
        };
      },
    } as never);

    const snapshot = await store.getSnapshot({ sessionId, graph });

    assert.equal(snapshot.setup.repoLabel, "kestrel");
    assert.equal(snapshot.review.currentBranch, "main");
    assert.equal(snapshot.activity[0]?.title, "Main task");
    assert.equal("saveSnapshot" in store, false);
  },
);

contractTest(
  "runtime.hermetic",
  "project actions are restricted to workspace Git operations",
  async () => {
    const sessionStore = new InMemorySessionStore();
    const sessionId = "session-git-action";
    await sessionStore.ensureSession(sessionId);
    let receivedType: string | undefined;
    const store = new ProductProjectStateStore(sessionStore, {
      async inspectReviewState() {
        return createEmptyProjectSnapshot().review;
      },
      async applyAction(input: { action: { type: string } }) {
        receivedType = input.action.type;
      },
    } as never);

    const snapshot = await store.applyAction({
      sessionId,
      graph,
      action: {
        type: "branch.create",
        sessionId,
        branchName: "feature/canonical-mission-control",
      },
    });

    assert.equal(receivedType, "branch.create");
    assert.match(
      snapshot.policy.recentDecisions[0]?.summary ?? "",
      /branch\.create/,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "project snapshot normalization drops retired work-item authorities",
  () => {
    const normalized = normalizeProjectSnapshot({
      ...createEmptyProjectSnapshot(),
      board: { cards: { legacy: {} } },
      taskQueue: { tasks: { "T-1": {} } },
    });

    assert.equal("board" in normalized, false);
    assert.equal("taskQueue" in normalized, false);
  },
);
