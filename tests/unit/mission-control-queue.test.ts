import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTaskQueueAction,
  createEmptyTaskQueue,
  parseTaskAction,
  sortTaskQueueTasks,
  type TaskAction,
  type TaskQueue,
} from "../../src/index.js";

test("parseTaskAction validates and preserves canonical task action fields", () => {
  const parsed = parseTaskAction({
    type: "task.create",
    sessionId: "session-1",
    actionId: "action-1",
    actionTs: "2026-07-10T12:00:00.000Z",
    title: "Ship Mission Control",
    instructions: "Use the authoritative project snapshot.",
    priority: "high",
    projectPath: "/workspace/kestrel",
  });

  assert.deepEqual(parsed, {
    type: "task.create",
    sessionId: "session-1",
    actionId: "action-1",
    actionTs: "2026-07-10T12:00:00.000Z",
    title: "Ship Mission Control",
    instructions: "Use the authoritative project snapshot.",
    priority: "high",
    projectPath: "/workspace/kestrel",
  });
});

test("parseTaskAction rejects malformed task action boundaries", () => {
  assert.throws(
    () => parseTaskAction({ type: "task.approve", sessionId: "session-1" }),
    /actionId must be a non-empty string/u,
  );
  assert.throws(
    () => parseTaskAction({
      type: "task.retry",
      sessionId: "session-1",
      actionId: "action-1",
      actionTs: "not-a-date",
      taskId: "T-1",
    }),
    /actionTs must be an ISO timestamp/u,
  );
  assert.throws(
    () => parseTaskAction({
      type: "board.card.create",
      sessionId: "session-1",
      actionId: "action-1",
      actionTs: "2026-07-10T12:00:00.000Z",
    }),
    /type is invalid/u,
  );
  assert.throws(
    () => parseTaskAction({
      type: "task.submit_review",
      sessionId: "session-1",
      actionId: "action-1",
      actionTs: "2026-07-10T12:00:00.000Z",
      taskId: "T-1",
      review: { submittedAt: "2026-07-10T12:00:00.000Z" },
    }),
    /review\.summary must be a non-empty string/u,
  );
});

type TaskActionDraft = TaskAction extends infer Action
  ? Action extends TaskAction
    ? Omit<Action, "actionId" | "actionTs" | "sessionId">
    : never
  : never;

function action(input: TaskActionDraft, index = 1): TaskAction {
  return {
    ...input,
    sessionId: "test-session",
    actionId: `action-${index}`,
    actionTs: `2026-06-15T12:00:0${index}.000Z`,
  } as TaskAction;
}

function apply(queue: TaskQueue, input: TaskActionDraft, index = 1): TaskQueue {
  return applyTaskQueueAction(queue, action(input, index));
}

test("user-created mission control tasks enter the approved queue", () => {
  const queue = apply(createEmptyTaskQueue(), {
    type: "task.create",
    title: "Fix settings crash",
    instructions: "Reproduce the crash, patch it, and run the focused test.",
    priority: "high",
  });
  const [task] = sortTaskQueueTasks(queue);

  assert.equal(task?.status, "queued");
  assert.equal(task?.createdBy, "user");
  assert.equal(task?.priority, "high");
});

test("agent-proposed mission control tasks cannot be claimed until approved", () => {
  let queue = apply(createEmptyTaskQueue(), {
    type: "task.propose",
    title: "Add regression test",
    instructions: "Add a targeted regression test for the follow-up.",
  });
  const taskId = sortTaskQueueTasks(queue)[0]?.id;

  assert.equal(queue.tasks[taskId ?? ""]?.status, "proposed");
  assert.throws(() => apply(queue, { type: "task.claim", taskId: taskId ?? "missing" }, 2), /Task must be queued/u);

  queue = apply(queue, { type: "task.approve", taskId: taskId ?? "missing" }, 3);
  queue = apply(queue, { type: "task.claim", taskId: taskId ?? "missing", assignedAgentId: "agent-1" }, 4);

  assert.equal(queue.tasks[taskId ?? ""]?.status, "running");
  assert.equal(queue.tasks[taskId ?? ""]?.assignedAgentId, "agent-1");
});

test("running mission control tasks move to attention or human review", () => {
  let attentionQueue = apply(createEmptyTaskQueue(), {
    type: "task.create",
    title: "Investigate failed run",
    instructions: "Find the first bad runtime transition.",
  });
  const attentionTaskId = sortTaskQueueTasks(attentionQueue)[0]?.id ?? "missing";
  attentionQueue = apply(attentionQueue, { type: "task.claim", taskId: attentionTaskId }, 2);
  attentionQueue = apply(attentionQueue, {
    type: "task.needs_attention",
    taskId: attentionTaskId,
    attentionReason: "blocked",
  }, 3);

  assert.equal(attentionQueue.tasks[attentionTaskId]?.status, "needs_attention");
  assert.equal(attentionQueue.tasks[attentionTaskId]?.attentionReason, "blocked");

  let reviewQueue = apply(createEmptyTaskQueue(), {
    type: "task.create",
    title: "Patch route helper",
    instructions: "Patch the helper and add tests.",
  });
  const reviewTaskId = sortTaskQueueTasks(reviewQueue)[0]?.id ?? "missing";
  reviewQueue = apply(reviewQueue, { type: "task.claim", taskId: reviewTaskId }, 2);
  reviewQueue = apply(reviewQueue, {
    type: "task.submit_review",
    taskId: reviewTaskId,
    review: {
      submittedAt: "2026-06-15T12:00:03.000Z",
      summary: "Patch complete; route helper tests pass.",
      changedFileCount: 2,
    },
  }, 3);

  assert.equal(reviewQueue.tasks[reviewTaskId]?.status, "ready_for_review");
  assert.throws(() => applyTaskQueueAction(reviewQueue, action({ type: "task.claim", taskId: reviewTaskId }, 4)), /Task must be queued/u);
  reviewQueue = apply(reviewQueue, { type: "task.accept", taskId: reviewTaskId }, 5);
  assert.equal(reviewQueue.tasks[reviewTaskId]?.status, "done");
});

test("request changes returns ready mission control work to the queue", () => {
  let queue = apply(createEmptyTaskQueue(), {
    type: "task.create",
    title: "Tighten UI copy",
    instructions: "Make the detail action copy clearer.",
  });
  const taskId = sortTaskQueueTasks(queue)[0]?.id ?? "missing";
  queue = apply(queue, { type: "task.claim", taskId }, 2);
  queue = apply(queue, {
    type: "task.submit_review",
    taskId,
    review: {
      submittedAt: "2026-06-15T12:00:03.000Z",
      summary: "Ready with revised copy.",
    },
  }, 3);
  queue = apply(queue, {
    type: "task.request_changes",
    taskId,
    instructions: "Keep the concise copy but add one concrete acceptance criterion.",
  }, 4);

  assert.equal(queue.tasks[taskId]?.status, "queued");
  assert.equal(queue.tasks[taskId]?.instructions, "Keep the concise copy but add one concrete acceptance criterion.");
});
