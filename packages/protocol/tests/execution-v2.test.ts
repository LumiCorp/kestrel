import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_PROTOCOL_V2,
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_COMMAND_TYPES,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_EVENT_TYPES,
  RUNNER_JOB_STREAM_EVENT_TYPES,
  RunnerProtocolContractError,
  RUNNER_STREAMING_COMMAND_TYPES,
  isRunnerEventAllowedForCommand,
  isRunnerExpectedResponseEvent,
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  isRunnerStreamingCommandType,
  isRunnerTerminalResponseEvent,
  parseRunnerCommandV2,
  parseRunnerEventV2,
  type RunnerCommandType,
  type RunnerEventType,
} from "../src/index.js";

const profile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const turn = {
  sessionId: "session-1",
  message: "Run the task",
  eventType: "user.message",
  systemInstructions: ["Return the requested structured output."],
};

const replay = {
  version: "job_replay_pointer_v1",
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
  replayQuery: {
    sessionId: "session-1",
    threadId: "thread-1",
    runId: "run-1",
  },
  commands: {
    replay: "kestrel replay",
    doctor: "kestrel doctor",
    bundle: "kestrel bundle",
  },
};

const terminalResult = {
  assistantText: "Done.",
  finalizedPayload: null,
  output: {
    status: "COMPLETED",
    sessionId: "session-1",
    runId: "run-1",
    errors: [],
  },
};

const jobOutput = {
  version: "job_run_result_v1",
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
  status: "COMPLETED",
  replay,
  result: terminalResult,
};

const commandPayloads: Record<RunnerCommandType, Record<string, unknown>> = {
  "profile.list": {},
  "profile.get": { profileId: "reference" },
  "job.run": {
    profileId: "reference",
    input: {
      version: "job_input_v1",
      turn,
    },
  },
  "run.start": { profileId: "reference", turn },
  "run.cancel": { sessionId: "session-1", runId: "run-1" },
  "session.describe": { sessionId: "session-1" },
  "session.state": { sessionId: "session-1" },
  "operator.inbox": { sessionId: "session-1" },
  "operator.thread": { threadId: "thread-1" },
  "operator.runs": { status: "RUNNING", limit: 10 },
  "operator.run": { runId: "run-1" },
  "operator.control": { action: "approve", threadId: "thread-1" },
  "task.graph.get": { sessionId: "session-1" },
  "task.graph.update": { sessionId: "session-1", graph: {} },
  "workspace.checkpoint.capture": { sessionId: "session-1" },
  "workspace.checkpoint.list": { sessionId: "session-1" },
  "workspace.checkpoint.inspect": {
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
  },
  "workspace.checkpoint.diff": {
    sessionId: "session-1",
    source: { checkpointId: "checkpoint-1" },
    target: { workingTree: true },
  },
  "workspace.checkpoint.restore": {
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
  },
  "workspace.checkpoint.cleanup": { sessionId: "session-1" },
  "workspace.promotion.list": { sessionId: "session-1" },
  "workspace.promotion.preview": {
    sessionId: "session-1",
    promotionId: "promotion-1",
  },
  "workspace.promotion.apply": {
    sessionId: "session-1",
    promotionId: "promotion-1",
    candidateFingerprint: "sha256:fingerprint",
  },
  "workspace.promotion.undo_latest": { sessionId: "session-1" },
  "project.snapshot.get": { sessionId: "session-1" },
  "project.snapshot.update": { sessionId: "session-1", snapshot: {} },
  "project.action": {
    type: "branch.create",
    sessionId: "session-1",
    branchName: "feature/protocol-v2",
  },
  "project.review.get": { sessionId: "session-1", target: {} },
  "project.review.action": {
    sessionId: "session-1",
    action: {
      type: "review.refresh",
      sessionId: "session-1",
      target: {},
    },
  },
  "runner.ping": { nonce: "ping-1" },
  "mcp.status": { profile },
  "mcp.refresh": { profileId: "reference" },
};

const eventPayloads: Record<RunnerEventType, Record<string, unknown>> = {
  "profile.listed": { profiles: [profile] },
  "profile.loaded": { profile },
  "job.started": {
    sessionId: "session-1",
    threadId: "thread-1",
    profileId: "reference",
  },
  "job.progress": {
    sessionId: "session-1",
    threadId: "thread-1",
    stage: "accepted",
    message: "Accepted",
  },
  "job.completed": { output: jobOutput, replay },
  "job.failed": {
    output: { ...jobOutput, status: "FAILED" },
    error: { code: "JOB_FAILED", message: "Job failed" },
  },
  "run.started": { sessionId: "session-1", eventType: "user.message" },
  "run.cancelled": { sessionId: "session-1", result: terminalResult },
  "run.tool.started": { update: {} },
  "run.tool.completed": { update: {} },
  "run.tool.failed": { update: {} },
  "run.log": { entry: {} },
  "run.console": { update: {} },
  "run.progress": { update: {} },
  "run.reasoning": { update: {} },
  "run.completed": { result: terminalResult },
  "run.failed": {
    result: { ...terminalResult, output: { ...terminalResult.output, status: "FAILED" } },
    error: { code: "RUN_FAILED", message: "Run failed" },
  },
  "runner.error": { code: "INVALID_COMMAND", message: "Invalid command" },
  "runner.pong": { nonce: "ping-1" },
  "session.described": { sessionId: "session-1", version: 1 },
  "session.state": {
    session: { sessionId: "session-1", version: 1 },
    version: 1,
    graph: {},
  },
  "operator.inbox": { inbox: {} },
  "operator.thread": { view: {} },
  "operator.runs": { view: {} },
  "operator.run": { view: {} },
  "operator.controlled": { threadId: "thread-1" },
  "task.updated": { task: {}, kind: "waiting", assistantText: null },
  "task.graph": { sessionId: "session-1", version: 1, graph: {} },
  "workspace.checkpoint": { sessionId: "session-1", operation: "list" },
  "project.snapshot": { sessionId: "session-1", snapshot: {} },
  "project.review": { sessionId: "session-1", detail: {} },
  "mcp.status": { status: {} },
  "mcp.refreshed": { status: {} },
};

test("Execution Protocol v2 descriptor owns the full supported registries", () => {
  assert.equal(EXECUTION_PROTOCOL_VERSION, "execution-protocol-v2");
  assert.equal(RUNNER_COMMAND_CONTRACT_VERSION, "runner-command-v2");
  assert.equal(RUNNER_EVENT_CONTRACT_VERSION, "dotted-runtime-events-v2");
  assert.deepEqual(EXECUTION_PROTOCOL_V2, {
    version: EXECUTION_PROTOCOL_VERSION,
    contracts: {
      command: RUNNER_COMMAND_CONTRACT_VERSION,
      events: RUNNER_EVENT_CONTRACT_VERSION,
    },
    commands: {
      supported: RUNNER_COMMAND_TYPES,
      streaming: RUNNER_STREAMING_COMMAND_TYPES,
    },
    events: {
      supported: RUNNER_EVENT_TYPES,
      runStream: EXECUTION_PROTOCOL_V2.events.runStream,
      jobStream: RUNNER_JOB_STREAM_EVENT_TYPES,
      runTerminal: EXECUTION_PROTOCOL_V2.events.runTerminal,
    },
  });
  assert.equal(new Set(RUNNER_COMMAND_TYPES).size, RUNNER_COMMAND_TYPES.length);
  assert.equal(new Set(RUNNER_EVENT_TYPES).size, RUNNER_EVENT_TYPES.length);
  for (const required of [
    "job.run",
    "operator.runs",
    "operator.run",
    "workspace.promotion.undo_latest",
  ]) {
    assert.equal(new Set<string>(RUNNER_COMMAND_TYPES).has(required), true);
  }
  assert.deepEqual(RUNNER_STREAMING_COMMAND_TYPES, ["job.run", "run.start"]);
  assert.equal(isRunnerStreamingCommandType("job.run"), true);
  assert.equal(isRunnerStreamingCommandType("run.start"), true);
  assert.equal(isRunnerStreamingCommandType("run.cancel"), false);
});

test("Execution Protocol v2 correlates command responses and shared workspace operations", () => {
  const event = parseRunnerEventV2({
    id: "event-workspace-list",
    type: "workspace.checkpoint",
    ts: "2026-07-13T12:00:00.000Z",
    commandId: "command-workspace-list",
    payload: { sessionId: "session-1", operation: "list" },
  });
  assert.equal(isRunnerExpectedResponseEvent("workspace.checkpoint.list", event), true);
  assert.equal(isRunnerExpectedResponseEvent("workspace.checkpoint.capture", event), false);
  assert.equal(isRunnerEventAllowedForCommand("workspace.checkpoint.list", event), true);
  assert.equal(isRunnerTerminalResponseEvent(event.type), true);

  const progress = parseRunnerEventV2({
    id: "event-job-progress",
    type: "job.progress",
    ts: "2026-07-13T12:00:00.000Z",
    commandId: "command-job",
    payload: {
      sessionId: "session-1",
      threadId: "thread-1",
      stage: "runtime_progress",
      message: "Running",
    },
  });
  assert.equal(isRunnerEventAllowedForCommand("job.run", progress), true);
  assert.equal(isRunnerEventAllowedForCommand("run.start", progress), false);
  assert.equal(isRunnerTerminalResponseEvent(progress.type), false);

  const runtimeProgress = parseRunnerEventV2({
    id: "event-runtime-progress-for-job",
    type: "run.progress",
    ts: "2026-07-13T12:00:00.000Z",
    commandId: "command-job",
    payload: { update: {} },
  });
  assert.equal(isRunnerEventAllowedForCommand("job.run", runtimeProgress), true);
  assert.equal(isRunnerTerminalResponseEvent(runtimeProgress.type), false);

  const runTerminal = parseRunnerEventV2({
    id: "event-run-terminal",
    type: "run.completed",
    ts: "2026-07-13T12:00:00.000Z",
    commandId: "command-run",
    payload: { result: terminalResult },
  });
  assert.equal(isRunnerRunStreamEvent(runtimeProgress), true);
  assert.equal(isRunnerRunTerminalEvent(runtimeProgress), false);
  assert.equal(isRunnerRunStreamEvent(runTerminal), true);
  assert.equal(isRunnerRunTerminalEvent(runTerminal), true);
  assert.equal(isRunnerRunStreamEvent(progress), false);
});

test("canonical command parser accepts every registered discriminant", () => {
  for (const type of RUNNER_COMMAND_TYPES) {
    const parsed = parseRunnerCommandV2({
      id: `command:${type}`,
      type,
      payload: commandPayloads[type],
      metadata: {
        actor: { actorId: "user-1", actorType: "end_user" },
        durability: "continue_on_disconnect",
      },
    });
    assert.equal(parsed.type, type);
    assert.equal(parsed.id, `command:${type}`);
  }
});

test("canonical command parser rejects unknown and malformed payloads", () => {
  assert.throws(
    () => parseRunnerCommandV2({}),
    (error: unknown) => (
      error instanceof RunnerProtocolContractError
      && error.code === "RUNNER_PROTOCOL_INVALID"
    ),
  );
  assert.throws(
    () => parseRunnerCommandV2({ id: "command-1", type: "unknown.run", payload: {} }),
    /supported Execution Protocol v2 command/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({ id: "command-1", type: "profile.get", payload: {} }),
    /profileId/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "run.start",
      payload: { profileId: "reference", turn: {} },
    }),
    /turn\.sessionId/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "run.start",
      payload: {
        profileId: "reference",
        turn: { sessionId: "session-1", eventType: "user.message" },
      },
    }),
    /turn\.message/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({ id: "command-1", type: "job.run", payload: {} }),
    /input/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "operator.runs",
      payload: { limit: 51 },
    }),
    /between 1 and 50/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "operator.runs",
      payload: { cursor: "future-page" },
    }),
    /cursor is not supported/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({ id: "command-1", type: "runner.ping", payload: [] }),
    /payload must be an object/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "runner.ping",
      payload: {},
      metadata: { profile: { id: "incomplete" } },
    }),
    /metadata\.profile\.label/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "run.start",
      payload: {
        profileId: "reference",
        turn: {
          sessionId: "session-1",
          message: "run",
          eventType: "user.message",
          systemInstructions: [""],
        },
      },
    }),
    /systemInstructions must be an array of non-empty strings/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "mcp.status",
      payload: {},
    }),
    /must include profile or profileId/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "project.action",
      payload: { type: "branch.create", sessionId: "session-1" },
    }),
    /branchName/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "project.action",
      payload: {
        type: "future.action",
        sessionId: "session-1",
      },
    }),
    /type is invalid/u,
  );

  const projectAction = parseRunnerCommandV2({
    id: "command-project-action",
    type: "project.action",
    payload: {
      type: "branch.create",
      sessionId: "session-1",
      taskId: "task-1",
      branchName: "feature/protocol-v2",
      ignored: "not-on-the-wire",
    },
  });
  assert.equal(projectAction.type, "project.action");
  if (projectAction.type === "project.action") {
    assert.equal(projectAction.payload.taskId, "task-1");
    assert.equal(projectAction.payload.branchName, "feature/protocol-v2");
    assert.equal(projectAction.payload.ignored, undefined);
  }
});

test("canonical project actions reject malformed provided optional fields", () => {
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-git-push-invalid-branch",
      type: "project.action",
      payload: {
        type: "git.push",
        sessionId: "session-1",
        branchName: 42,
      },
    }),
    /branchName must be a string/u,
  );

  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-task-create-invalid-priority",
      type: "project.action",
      payload: {
        type: "task.create",
        sessionId: "session-1",
        actionId: "action-1",
        actionTs: "2026-07-13T12:00:00.000Z",
        title: "Implement the contract",
        instructions: "Keep the parser canonical.",
        priority: "critical",
      },
    }),
    /priority must be one of low, medium, high, urgent/u,
  );

  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-task-claim-invalid-agent",
      type: "project.action",
      payload: {
        type: "task.claim",
        sessionId: "session-1",
        actionId: "action-2",
        actionTs: "2026-07-13T12:00:00.000Z",
        taskId: "task-1",
        assignedAgentId: false,
      },
    }),
    /assignedAgentId must be a string/u,
  );

  for (const pullRequestNumber of [0, -1, 1.5]) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: `command-pr-merge-invalid-${pullRequestNumber}`,
        type: "project.action",
        payload: {
          type: "pull_request.merge",
          sessionId: "session-1",
          pullRequestNumber,
        },
      }),
      /pullRequestNumber must be a positive integer/u,
    );
  }
});

test("canonical job.run parsing preserves job defaults and bounded enums", () => {
  const parsed = parseRunnerCommandV2({
    id: "command-job-default-event",
    type: "job.run",
    payload: {
      profileId: "reference",
      input: {
        version: "job_input_v1",
        turn: {
          sessionId: "session-job-default-event",
          message: "Run unattended",
        },
        storeDriver: "sqlite",
        approvalPolicyPackId: "ci_bot",
      },
    },
  });
  assert.equal(parsed.type, "job.run");
  if (parsed.type === "job.run") {
    assert.equal(parsed.payload.input.turn.eventType, "job.run");
  }

  for (const [field, value] of [
    ["storeDriver", "memory"],
    ["approvalPolicyPackId", "anything"],
  ] as const) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: `command-job-invalid-${field}`,
        type: "job.run",
        payload: {
          profileId: "reference",
          input: {
            version: "job_input_v1",
            turn: {
              sessionId: "session-job-invalid-enum",
              message: "Run unattended",
            },
            [field]: value,
          },
        },
      }),
      new RegExp(`${field} must be one of`, "u"),
    );
  }
});

test("canonical profile references require one unambiguous source", () => {
  for (const type of ["run.start", "mcp.status", "mcp.refresh"] as const) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: `command-ambiguous-${type}`,
        type,
        payload: {
          profile,
          profileId: "reference",
          ...(type === "run.start" ? { turn } : {}),
        },
      }),
      /must include only one of profile or profileId/u,
    );
  }

  for (const payload of [
    {
      profile,
      profileId: "reference",
      input: { version: "job_input_v1", turn },
    },
    {
      profileId: "reference",
      input: {
        version: "job_input_v1",
        profileId: "nested-reference",
        turn,
      },
    },
    {
      input: {
        version: "job_input_v1",
        profile,
        profileId: "nested-reference",
        turn,
      },
    },
  ]) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: "command-ambiguous-job",
        type: "job.run",
        payload,
      }),
      /must include exactly one profile reference/u,
    );
  }
});

test("canonical turn parsing validates structured auto-compaction fields", () => {
  const parsed = parseRunnerCommandV2({
    id: "command-auto-compaction",
    type: "run.start",
    payload: {
      profileId: "reference",
      turn: {
        ...turn,
        autoCompaction: {
          enabled: true,
          state: "armed",
          suppressOnce: false,
          extensionHint: "preserved-for-forward-compatibility",
        },
      },
    },
  });
  assert.equal(parsed.type, "run.start");
  if (parsed.type === "run.start") {
    assert.deepEqual(parsed.payload.turn.autoCompaction, {
      enabled: true,
      state: "armed",
      suppressOnce: false,
      extensionHint: "preserved-for-forward-compatibility",
    });
  }

  for (const [field, value] of [
    ["enabled", "yes"],
    ["state", 1],
    ["suppressOnce", "no"],
  ] as const) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: `command-invalid-auto-compaction-${field}`,
        type: "run.start",
        payload: {
          profileId: "reference",
          turn: {
            ...turn,
            autoCompaction: { [field]: value },
          },
        },
      }),
      new RegExp(`autoCompaction\\.${field} must be`, "u"),
    );
  }

  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-invalid-auto-compaction-state",
      type: "run.start",
      payload: {
        profileId: "reference",
        turn: {
          ...turn,
          autoCompaction: { state: "arrmed" },
        },
      },
    }),
    /autoCompaction\.state must be one of/u,
  );
});

test("canonical event parser accepts every registered discriminant", () => {
  for (const type of RUNNER_EVENT_TYPES) {
    const parsed = parseRunnerEventV2({
      id: `event:${type}`,
      type,
      ts: "2026-07-13T12:00:00.000Z",
      payload: eventPayloads[type],
    });
    assert.equal(parsed.type, type);
    assert.equal(parsed.id, `event:${type}`);
  }
});

test("canonical event parser rejects unknown and malformed payloads", () => {
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-1",
      type: "run.future",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {},
    }),
    /supported Execution Protocol v2 event/u,
  );
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-1",
      type: "run.started",
      ts: "2026-07-13T12:00:00.000Z",
      payload: { eventType: "user.message" },
    }),
    /sessionId/u,
  );
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-1",
      type: "runner.error",
      ts: "2026-07-13T12:00:00.000Z",
      payload: { message: "missing code" },
    }),
    /code/u,
  );
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-1",
      type: "runner.error",
      ts: "",
      payload: { code: "ERROR", message: "bad timestamp" },
    }),
    /event\.ts/u,
  );
});

test("canonical event parser normalizes terminal assistant text without changing payload data", () => {
  const finalizedPayload = {
    deploymentId: "deployment-1",
    regions: ["iad1"],
  };
  const parsed = parseRunnerEventV2({
    id: "event-1",
    type: "run.completed",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      result: {
        assistantText: "  Deployment completed.  ",
        finalizedPayload,
        output: terminalResult.output,
      },
    },
  });
  assert.equal(parsed.type, "run.completed");
  if (parsed.type !== "run.completed") {
    assert.fail("expected run.completed");
  }
  assert.equal(parsed.payload.result.assistantText, "Deployment completed.");
  assert.equal(parsed.payload.result.finalizedPayload, finalizedPayload);

  const explicitNull = parseRunnerEventV2({
    id: "event-2",
    type: "run.completed",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      result: {
        assistantText: null,
        finalizedPayload: null,
        output: terminalResult.output,
      },
    },
  });
  assert.equal(explicitNull.type, "run.completed");
  if (explicitNull.type === "run.completed") {
    assert.equal(explicitNull.payload.result.assistantText, null);
    assert.equal(explicitNull.payload.result.finalizedPayload, null);
  }

  const jobTerminal = parseRunnerEventV2({
    id: "event-job-terminal",
    type: "job.completed",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      output: {
        ...jobOutput,
        result: {
          assistantText: "  Deployment job completed.  ",
          finalizedPayload,
          output: terminalResult.output,
        },
      },
      replay,
    },
  });
  assert.equal(jobTerminal.type, "job.completed");
  if (jobTerminal.type === "job.completed") {
    assert.equal(
      jobTerminal.payload.output.result?.assistantText,
      "Deployment job completed.",
    );
    assert.equal(
      jobTerminal.payload.output.result?.finalizedPayload,
      finalizedPayload,
    );
  }

  const taskTerminal = parseRunnerEventV2({
    id: "event-task-terminal",
    type: "task.updated",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      task: {},
      kind: "completed",
      assistantText: "  Delegated task completed.  ",
    },
  });
  assert.equal(taskTerminal.type, "task.updated");
  if (taskTerminal.type === "task.updated") {
    assert.equal(taskTerminal.payload.assistantText, "Delegated task completed.");
  }

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-job-terminal-invalid",
      type: "job.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        output: {
          ...jobOutput,
          result: { output: terminalResult.output },
        },
        replay,
      },
    }),
    /assistantText is required/u,
  );
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-job-terminal-missing-result",
      type: "job.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        output: {
          ...jobOutput,
          result: undefined,
        },
        replay,
      },
    }),
    /runner result must be an object/u,
  );
});

test("canonical terminal parsing rejects malformed concrete run outputs", () => {
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-run-output-null",
      type: "run.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        result: {
          assistantText: "Done.",
          output: null,
        },
      },
    }),
    /runner result\.output must be an object/u,
  );

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-operator-output-incomplete",
      type: "operator.controlled",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        threadId: "thread-1",
        result: {
          assistantText: "Approved.",
          output: { status: "COMPLETED" },
        },
      },
    }),
    /runner result\.output\.sessionId/u,
  );

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-job-output-incomplete",
      type: "job.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        output: {
          ...jobOutput,
          result: {
            assistantText: "Done.",
            output: {
              status: "COMPLETED",
              sessionId: "session-1",
              runId: "run-1",
            },
          },
        },
        replay,
      },
    }),
    /runner result\.output\.errors must be an array/u,
  );

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-run-output-invalid-telemetry",
      type: "run.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        result: {
          assistantText: "Done.",
          output: {
            status: "COMPLETED",
            sessionId: "session-1",
            runId: "run-1",
            errors: [],
            telemetry: { stepsExecuted: "one" },
          },
        },
      },
    }),
    /runner result\.output\.telemetry\.stepsExecuted must be a non-negative number/u,
  );

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-run-output-invalid-read-budget",
      type: "run.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        result: {
          assistantText: "Done.",
          output: {
            status: "COMPLETED",
            sessionId: "session-1",
            runId: "run-1",
            errors: [],
            readBudgets: { filesystemResume: {} },
          },
        },
      },
    }),
    /runner result\.output\.readBudgets\.filesystemResume\.kind/u,
  );
});
