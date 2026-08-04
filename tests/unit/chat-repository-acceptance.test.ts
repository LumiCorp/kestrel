import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeChatRepositoryReplay,
  resolveChatAcceptanceAssistantText,
} from "../../scripts/lib/chat-repository-acceptance.js";


test("chat repository acceptance treats parallel searches as one decision batch", () => {
  const events = [
    modelRequested(2),
    toolStarted(3, "fs.search_text", { path: "src", query: "like" }),
    toolCompleted(3, "fs.search_text", {
      matches: [{ path: "src/app/actions/posts.ts", line: 88 }],
    }),
    toolStarted(3, "fs.search_text", { path: "prisma", query: "like" }),
    toolCompleted(3, "fs.search_text", {
      matches: [{ path: "prisma/schema.prisma", line: 33 }],
    }),
    modelRequested(4, "clipped before repository paths"),
    toolStarted(5, "fs.read_text", { path: "src/app/actions/posts.ts" }),
  ];

  assert.deepEqual(analyzeChatRepositoryReplay(events), {
    broadSearchBatchCount: 1,
    broadSearchCallCount: 2,
    successfulBroadTool: "fs.search_text",
    successfulBroadStepIndex: 3,
    returnedPaths: ["src/app/actions/posts.ts", "prisma/schema.prisma"],
    followingModelRequestStepIndex: 4,
    retainedSearchResult: true,
    followingAction: "exact_file_read",
    followingTool: "fs.read_text",
    followingToolPath: "src/app/actions/posts.ts",
    errors: [],
  });
});

test("chat repository acceptance rejects broad discovery from a later decision batch", () => {
  const analysis = analyzeChatRepositoryReplay([
    modelRequested(0),
    toolStarted(1, "repo.trace", { path: ".", seeds: ["like"] }),
    toolCompleted(1, "repo.trace", {
      groups: [{ path: "src/app/components/LikeButton.tsx" }],
    }),
    modelRequested(2),
    toolStarted(3, "fs.search_text", { path: ".", query: "Like" }),
  ]);

  assert.equal(analysis.broadSearchBatchCount, 2);
  assert.equal(analysis.followingAction, "broad_search");
  assert.match(analysis.errors.join("\n"), /2 broad search decision batches/u);
  assert.match(analysis.errors.join("\n"), /followed by another broad search/u);
});

test("chat repository acceptance falls back to the authoritative finalize message", () => {
  const resolved = resolveChatAcceptanceAssistantText({
    runId: "run-1",
    history: [{ role: "assistant", text: "", run: { runId: "run-1" } }],
    events: [
      toolStarted(9, "FinalizeAnswer", {
        data: {
          finalizeInput: {
            message: "Likes update optimistically, then toggleLike creates or deletes the row and returns the count.",
          },
        },
      }),
    ],
  });

  assert.deepEqual(resolved, {
    text: "Likes update optimistically, then toggleLike creates or deletes the row and returns the count.",
    source: "finalize-event",
  });
});

test("chat repository acceptance prefers the last persisted non-empty assistant message", () => {
  const resolved = resolveChatAcceptanceAssistantText({
    runId: "run-1",
    history: [
      { role: "assistant", text: "", run: { runId: "run-1" } },
      { role: "assistant", text: "The persisted final answer.", run: { runId: "run-1" } },
    ],
    events: [],
  });

  assert.deepEqual(resolved, {
    text: "The persisted final answer.",
    source: "history",
  });
});

function modelRequested(stepIndex: number, inputPreview = "preview") {
  return {
    type: "model.requested",
    stepIndex,
    metadata: { promptSummary: { inputPreview } },
  };
}

function toolStarted(stepIndex: number, toolName: string, input: Record<string, unknown>) {
  return {
    type: "run.tool.started",
    stepIndex,
    metadata: { toolName, input },
  };
}

function toolCompleted(stepIndex: number, toolName: string, output: Record<string, unknown>) {
  return {
    type: "run.tool.completed",
    stepIndex,
    metadata: {
      toolName,
      output,
      outcome: { kind: "success" },
    },
  };
}
