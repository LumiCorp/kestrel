import assert from "node:assert/strict";

import {
  applyTaskQueueAction,
  createEmptyTaskQueue,
  parseTaskAction,
  sortTaskQueueTasks,
  type TaskAction,
  type TaskQueue,
} from "../../src/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseTaskAction validates and preserves canonical task action fields", () => {
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

contractTest("runtime.hermetic", "parseTaskAction preserves proposal revision and order fields", () => {
  assert.deepEqual(parseTaskAction({
    type: "task.propose",
    sessionId: "session-1",
    actionId: "action-2",
    actionTs: "2026-07-10T12:00:00.000Z",
    taskId: "T-2",
    title: "Revise Mission Control",
    instructions: "Update the existing proposal without approving it.",
    order: 1,
  }), {
    type: "task.propose",
    sessionId: "session-1",
    actionId: "action-2",
    actionTs: "2026-07-10T12:00:00.000Z",
    taskId: "T-2",
    title: "Revise Mission Control",
    instructions: "Update the existing proposal without approving it.",
    order: 1,
  });
});

contractTest("runtime.hermetic", "parseTaskAction rejects malformed task action boundaries", () => {
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
  assert.throws(
    () => parseTaskAction({
      type: "task.propose",
      sessionId: "session-1",
      actionId: "action-2",
      actionTs: "2026-07-10T12:00:00.000Z",
      title: "Invalid order",
      instructions: "Reject non-positive proposal positions.",
      order: 0,
    }),
    /order must be a positive integer/u,
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

contractTest("runtime.hermetic", "user-created mission control tasks enter the approved queue", () => {
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

contractTest("runtime.hermetic", "agent-proposed mission control tasks cannot be claimed until approved", () => {
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

contractTest("runtime.hermetic", "task.propose revises and reorders only agent-created proposed tasks", () => {
  let queue = apply(createEmptyTaskQueue(), {
    type: "task.propose",
    title: "Implement the runtime gate",
    instructions: "Allow the proposal tool in Plan mode.",
    acceptanceCriteria: "Plan mode exposes only explicitly enabled proposal mutations.",
    priority: "high",
  }, 1);
  queue = apply(queue, {
    type: "task.propose",
    title: "Add regression coverage",
    instructions: "Cover the Plan-mode proposal workflow.",
  }, 2);
  const original = queue.tasks["T-2"];

  queue = apply(queue, {
    type: "task.propose",
    taskId: "T-2",
    title: "Add Plan publication regression coverage",
    instructions: "Cover create, revise, order, and approval boundaries.",
    order: 1,
    summary: "Reconciled with the latest PLAN.md.",
  }, 3);

  const revised = queue.tasks["T-2"];
  assert.equal(revised?.id, original?.id);
  assert.equal(revised?.createdAt, original?.createdAt);
  assert.equal(revised?.createdBy, "agent");
  assert.equal(revised?.status, "proposed");
  assert.equal(revised?.priority, "medium");
  assert.equal(revised?.order, 1);
  assert.equal(queue.tasks["T-1"]?.order, 2);
  assert.equal(revised?.evidence.at(-1)?.source, "agent");
  assert.equal(revised?.evidence.at(-1)?.summary, "Reconciled with the latest PLAN.md.");
});

contractTest("runtime.hermetic", "task.propose preserves omitted revision fields", () => {
  let queue = apply(createEmptyTaskQueue(), {
    type: "task.propose",
    title: "Document the workflow",
    instructions: "Document the initial workflow.",
    acceptanceCriteria: "The workflow is reviewable.",
    priority: "high",
  }, 1);
  queue = apply(queue, {
    type: "task.propose",
    taskId: "T-1",
    title: "Document the Plan publication workflow",
    instructions: "Document the revised workflow.",
  }, 2);

  assert.equal(queue.tasks["T-1"]?.acceptanceCriteria, "The workflow is reviewable.");
  assert.equal(queue.tasks["T-1"]?.priority, "high");
});

contractTest("runtime.hermetic", "task.propose rejects revisions outside the agent proposal boundary", () => {
  const userQueue = apply(createEmptyTaskQueue(), {
    type: "task.create",
    title: "Operator task",
    instructions: "Keep this operator-authored task unchanged.",
  });
  assert.throws(
    () => apply(userQueue, {
      type: "task.propose",
      taskId: "T-1",
      title: "Rewrite operator task",
      instructions: "This must be rejected.",
    }, 2),
    /Only agent-created proposed tasks can be revised/u,
  );

  let approvedQueue = apply(createEmptyTaskQueue(), {
    type: "task.propose",
    title: "Approved proposal",
    instructions: "Approve this before testing revision rejection.",
  });
  approvedQueue = apply(approvedQueue, { type: "task.approve", taskId: "T-1" }, 2);
  assert.throws(
    () => apply(approvedQueue, {
      type: "task.propose",
      taskId: "T-1",
      title: "Rewrite approved task",
      instructions: "This must be rejected.",
    }, 3),
    /Only agent-created proposed tasks can be revised/u,
  );
  assert.throws(
    () => apply(createEmptyTaskQueue(), {
      type: "task.propose",
      taskId: "T-404",
      title: "Missing proposal",
      instructions: "This must not create a fallback task.",
    }, 4),
    /Task was not found/u,
  );
});

contractTest("runtime.hermetic", "running mission control tasks move to attention or human review", () => {
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

contractTest("runtime.hermetic", "request changes returns ready mission control work to the queue", () => {
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
