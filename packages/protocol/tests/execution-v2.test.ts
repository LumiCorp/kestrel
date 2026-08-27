import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_PROTOCOL_V4,
  EXECUTION_PROTOCOL_VERSION,
  RUNNER_COMMAND_CONTRACT_VERSION,
  RUNNER_COMMAND_TYPES,
  RUNNER_EVENT_CONTRACT_VERSION,
  RUNNER_EVENT_TYPES,
  RUNNER_JOB_STREAM_EVENT_TYPES,
  WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
  RunnerProtocolContractError,
  RUNNER_STREAMING_COMMAND_TYPES,
  isRunnerEventAllowedForCommand,
  isRunnerExpectedResponseEvent,
  isRunnerRunStreamEvent,
  isRunnerRunTerminalEvent,
  isRunnerStreamingCommandType,
  isRunnerTerminalResponseEvent,
  encodeConversationMessageCursor,
  parseRunnerStructuredReviewInteractionV1,
  createRunnerStructuredReviewInteractionV1,
  parseConversationMessageCursor,
  parseRunnerCommandV2,
  parseRunnerEventV2,
  type RunnerCommandType,
  type RunnerEventType,
} from "../src/index.js";
import {
  evaluationReviewInteractionFixture,
  legacyRecoveryReviewInteractionFixture,
} from "../../../tests/fixtures/structured-review-contract.js";


const profile = {
  id: "kestrel",
  label: "Kestrel",
  agent: "kestrel",
  sessionPrefix: "kestrel",
};

const turn = {
  sessionId: "session-1",
  message: "Run the task",
  eventType: "user.message",
  systemInstructions: ["Return the requested structured output."],
};

test("run.start accepts the autonomous turn marker", () => {
  const parsed = parseRunnerCommandV2({
    id: "command-autonomous",
    type: "run.start",
    payload: {
      profileId: "kestrel",
      turn: { ...turn, noninteractive: true },
    },
  });

  assert.equal(parsed.type, "run.start");
  if (parsed.type === "run.start") {
    assert.equal(parsed.payload.turn.noninteractive, true);
  }
});

test("run.start carries only strict hosted approval decisions", () => {
  for (const decision of [
    "decline",
    "approve_once",
    "remember_approval",
  ] as const) {
    const parsed = parseRunnerCommandV2({
      id: `command-${decision}`,
      type: "run.start",
      payload: {
        profileId: "kestrel",
        turn: {
          ...turn,
          eventType: "user.approval",
          resumeRequestId: "approval-request",
          decision,
          decidingActor: {
            actorType: "end_user",
            actorId: "user-1",
            tenantId: "org-1",
          },
        },
      },
    });
    assert.equal(
      parsed.type === "run.start" ? parsed.payload.turn.decision : undefined,
      decision,
    );
    assert.deepEqual(
      parsed.type === "run.start" ? parsed.payload.turn.decidingActor : undefined,
      { actorType: "end_user", actorId: "user-1", tenantId: "org-1" },
    );
  }
  assert.throws(() => parseRunnerCommandV2({
    id: "command-invalid-decision",
    type: "run.start",
    payload: {
      profileId: "kestrel",
      turn: {
        ...turn,
        eventType: "user.approval",
        resumeRequestId: "approval-request",
        decision: "approve",
      },
    },
  }), /decision/u);
});

test("run.start accepts cleanup only for the exact declined approval request", () => {
  const cleanup = {
    version: "runner_prepared_approval_cleanup_v1" as const,
    organizationId: "org-1",
    threadId: "session-1",
    turnId: "turn-1",
    interactionId: "interaction-1",
    requestId: "approval-request",
    failureCode: "EXTERNAL_APPROVAL_EXPIRED" as const,
    failureMessage: "Expired.",
  };
  const command = {
    id: "command-cleanup",
    type: "run.start" as const,
    payload: {
      profileId: "kestrel",
      turn: {
        ...turn,
        eventType: "user.approval",
        resumeRequestId: cleanup.requestId,
        decision: "decline" as const,
        decidingActor: {
          actorType: "end_user" as const,
          actorId: "user-1",
          tenantId: "org-1",
        },
        preparedApprovalCleanup: cleanup,
      },
    },
  };
  assert.deepEqual(
    parseRunnerCommandV2(command).payload.turn.preparedApprovalCleanup,
    cleanup,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      ...command,
      payload: {
        ...command.payload,
        turn: { ...command.payload.turn, decision: "approve_once" },
      },
    }),
    /preparedApprovalCleanup requires the exact declined approval request/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      ...command,
      payload: {
        ...command.payload,
        turn: { ...command.payload.turn, resumeRequestId: "other-request" },
      },
    }),
    /preparedApprovalCleanup requires the exact declined approval request/u,
  );
});

test("execution protocol v4 accepts canonical attachments and rejects v3 payloads", () => {
  const canonicalAttachment = {
    attachmentId: "attachment-1",
    threadId: "thread-1",
    filename: "archive.zip",
    mimeType: "application/zip",
    sizeBytes: 2,
    sha256: "0".repeat(64),
    kind: "file",
    representationStatus: "metadata_only",
    metadataOnlyReason: "No automatic interpreter is available.",
  } as const;
  const parsed = parseRunnerCommandV2({
    id: "command-with-attachment",
    type: "run.start",
    payload: { profileId: "kestrel", turn: { ...turn, message: "", attachments: [canonicalAttachment] } },
  });
  assert.equal(parsed.type, "run.start");
  assert.equal(parsed.type === "run.start" ? parsed.payload.turn.attachments?.[0]?.kind : undefined, "file");

  const { representationStatus: _removed, ...v3Attachment } = canonicalAttachment;
  assert.throws(() => parseRunnerCommandV2({
    id: "command-with-v3-attachment",
    type: "run.start",
    payload: { profileId: "kestrel", turn: { ...turn, attachments: [v3Attachment] } },
  }), /representationStatus/u);
});

test("execution protocol v4 enforces attachment ordering identities and byte limits", () => {
  const attachment = (attachmentId: string, sizeBytes: number) => ({
    attachmentId,
    filename: `${attachmentId}.bin`,
    mimeType: "application/octet-stream",
    sizeBytes,
    sha256: "0".repeat(64),
    kind: "file",
    representationStatus: "metadata_only",
  });
  const parse = (attachments: ReturnType<typeof attachment>[]) => parseRunnerCommandV2({
    id: "command-attachment-limits",
    type: "run.start",
    payload: { profileId: "kestrel", turn: { ...turn, attachments } },
  });
  assert.throws(() => parse(Array.from({ length: 21 }, (_, index) => attachment(`a-${index}`, 0))), /at most 20/u);
  assert.throws(() => parse([attachment("duplicate", 0), attachment("duplicate", 0)]), /unique/u);
  assert.throws(() => parse([attachment("oversized", 100 * 1024 * 1024 + 1)]), /100 MiB/u);
  assert.throws(() => parse([
    ...Array.from({ length: 5 }, (_, index) => attachment(`full-${index}`, 100 * 1024 * 1024)),
    attachment("one-byte-over", 1),
  ]), /500 MiB/u);
});

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

test("evaluation review contract is canonical across first-party clients", () => {
  const interaction = createRunnerStructuredReviewInteractionV1({
    reason: "evaluation_review",
    requestId: evaluationReviewInteractionFixture.requestId,
    prompt: evaluationReviewInteractionFixture.prompt,
    allowedOptionIds: ["evaluation.accept_once", "evaluation.revise", "terminal.fail"],
    evaluationTechnicalDisclosure:
      evaluationReviewInteractionFixture.metadata.evaluationTechnicalDisclosure,
  });

  assert.deepEqual(interaction, evaluationReviewInteractionFixture);
  assert.deepEqual(parseRunnerStructuredReviewInteractionV1(interaction), {
    kind: "structured_review",
    reason: "evaluation_review",
    requestId: "evaluation-review-fixture",
    eventType: "user.reply",
    prompt: "Result requires review.",
    allowedOptionIds: ["evaluation.accept_once", "evaluation.revise", "terminal.fail"],
    evaluationTechnicalDisclosure:
      evaluationReviewInteractionFixture.metadata.evaluationTechnicalDisclosure,
  });
  assert.deepEqual(interaction.inputSchema, {
    type: "object",
    additionalProperties: false,
    required: ["recoveryOptionId"],
    properties: {
      recoveryOptionId: {
        type: "string",
        enum: ["evaluation.accept_once", "evaluation.revise", "terminal.fail"],
      },
    },
  });
});

test("operator controls accept follow-up queue actions and fields", () => {
  const commands = [
    {
      id: "command-enqueue-follow-up",
      type: "operator.control",
      payload: {
        action: "enqueue_follow_up",
        threadId: "thread-1",
        followUpId: "follow-up-1",
        message: "Continue with this request.",
        attachmentIds: ["attachment-1"],
        interactionMode: "build",
        actSubmode: "safe",
      },
    },
    {
      id: "command-edit-follow-up",
      type: "operator.control",
      payload: {
        action: "edit_follow_up",
        threadId: "thread-1",
        followUpId: "follow-up-1",
        message: "Use the updated request.",
      },
    },
    {
      id: "command-cancel-follow-up",
      type: "operator.control",
      payload: {
        action: "cancel_follow_up",
        threadId: "thread-1",
        followUpId: "follow-up-1",
      },
    },
    {
      id: "command-resume-follow-up-queue",
      type: "operator.control",
      payload: {
        action: "resume_follow_up_queue",
        threadId: "thread-1",
      },
    },
    {
      id: "command-continue-waiting",
      type: "operator.control",
      payload: {
        action: "continue_waiting",
        threadId: "thread-1",
      },
    },
  ] as const;

  for (const command of commands) {
    const parsed = parseRunnerCommandV2(command);
    assert.equal(parsed.type, "operator.control");
    assert.equal(parsed.payload.action, command.payload.action);
  }
});

test("operator controls require follow-up identity only for item actions", () => {
  for (const action of ["enqueue_follow_up", "edit_follow_up", "cancel_follow_up"] as const) {
    assert.throws(() => parseRunnerCommandV2({
      id: `missing-${action}`,
      type: "operator.control",
      payload: {
        action,
        threadId: "thread-1",
        ...((action === "enqueue_follow_up" || action === "edit_follow_up")
          ? { message: "Follow up." }
          : {}),
      },
    }), /followUpId/u);
  }
  assert.throws(() => parseRunnerCommandV2({
    id: "reply-with-follow-up-id",
    type: "operator.control",
    payload: {
      action: "reply",
      threadId: "thread-1",
      followUpId: "follow-up-1",
      message: "Ordinary reply.",
    },
  }), /followUpId is supported only/u);
});

test("structured review contract rejects metadata and schema drift", () => {
  const interaction = createRunnerStructuredReviewInteractionV1({
    reason: "evaluation_review",
    requestId: "evaluation-review-1",
    prompt: "Result requires review.",
    allowedOptionIds: ["evaluation.accept_once", "terminal.fail"],
    evaluationTechnicalDisclosure: {
      candidate: "Withheld result.",
      assertions: [],
      evidenceReferences: [],
    },
  });
  const inputSchema = structuredClone(interaction.inputSchema) as Record<string, unknown>;
  const properties = inputSchema.properties as Record<string, Record<string, unknown>>;
  properties.recoveryOptionId!.enum = ["terminal.fail"];

  assert.deepEqual(
    parseRunnerStructuredReviewInteractionV1({ ...interaction, inputSchema }),
    {
      kind: "invalid_review",
      reason: "evaluation_review",
      error: "Structured review schema options must exactly match metadata.allowedOptionIds.",
    },
  );
  assert.throws(
    () => createRunnerStructuredReviewInteractionV1({
      reason: "evaluation_review",
      requestId: "evaluation-review-unknown",
      prompt: "Choose one option.",
      allowedOptionIds: ["evaluation.unknown"],
    }),
    /unsupported option/u,
  );
  assert.throws(
    () => createRunnerStructuredReviewInteractionV1({
      reason: "recovery_review",
      requestId: "recovery-review-retired",
      prompt: "Choose one option.",
      allowedOptionIds: ["retry.primary"],
    }),
    /retired/u,
  );
  assert.equal(
    parseRunnerStructuredReviewInteractionV1(legacyRecoveryReviewInteractionFixture).kind,
    "invalid_review",
  );
  const missingRequestId = structuredClone(evaluationReviewInteractionFixture) as Record<string, unknown>;
  delete missingRequestId.requestId;
  assert.equal(
    parseRunnerStructuredReviewInteractionV1(missingRequestId).kind,
    "invalid_review",
  );
  const missingSchema = structuredClone(evaluationReviewInteractionFixture) as Record<string, unknown>;
  delete missingSchema.inputSchema;
  assert.equal(
    parseRunnerStructuredReviewInteractionV1(missingSchema).kind,
    "invalid_review",
  );
  const missingReason = structuredClone(evaluationReviewInteractionFixture) as Record<string, unknown>;
  const missingReasonMetadata = missingReason.metadata as Record<string, unknown>;
  delete missingReasonMetadata.reason;
  assert.deepEqual(
    parseRunnerStructuredReviewInteractionV1(missingReason),
    {
      kind: "invalid_review",
      error: "Structured reviews require a supported metadata.reason.",
    },
  );
});

const jobOutput = {
  version: "job_run_result_v1",
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
  status: "COMPLETED",
  replay,
  result: terminalResult,
};

const presentationIdentity = {
  version: "v1",
  runId: "run-1",
  sessionId: "session-1",
  ts: "2026-07-13T12:00:00.000Z",
  seq: 1,
} as const;

const progressUpdate = {
  ...presentationIdentity,
  kind: "stage",
  phase: "agent",
  code: "STEP_STARTED",
  message: "Applying the accepted action.",
  persist: true,
} as const;

const toolUpdate = (phase: "started" | "completed" | "failed") => ({
  ...presentationIdentity,
  toolCallId: "tool-1",
  toolName: "knowledge.search",
  phase,
});

const reasoningUpdate = (
  event: "started" | "delta" | "completed" | "failed" | "unavailable",
) => ({
  ...presentationIdentity,
  event,
  attempt: 1,
  format: "summary" as const,
  ...(event === "delta" ? { delta: "Checking" } : {}),
  contentState: event === "unavailable" ? "not_retained" as const : "live" as const,
});

const commandPayloads: Record<RunnerCommandType, Record<string, unknown>> = {
  "profile.list": {},
  "profile.get": { profileId: "kestrel" },
  "execution-profile.resolve": {
    environmentPresetId: "workspace_hosted",
    exactToolNames: ["exec_command"],
    managedConfiguration: {
      modelProvider: "openrouter",
      model: "z-ai/glm-5.2",
    },
  },
  "job.run": {
    profileId: "kestrel",
    input: {
      version: "job_input_v1",
      turn,
    },
  },
  "run.start": { profileId: "kestrel", turn },
  "conversation.message.submit": {
    profileId: "kestrel",
    threadId: "thread-1",
    messageId: "message-1",
    turn: {
      sessionId: "session-1",
      message: "Continue with this information.",
    },
  },
  "run.cancel": { sessionId: "session-1", runId: "run-1" },
  "effect.result.get": { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" },
  "session.describe": { sessionId: "session-1" },
  "session.state": { sessionId: "session-1" },
  "operator.inbox": { sessionId: "session-1" },
  "operator.thread": { threadId: "thread-1" },
  "conversation.messages.list": { threadId: "thread-1", limit: 100 },
  "operator.runs": { status: "RUNNING", limit: 10 },
  "operator.run": { runId: "run-1" },
  "operator.run.reasoning": { runId: "run-1", sessionId: "session-1", action: "read" },
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
  "workspace.managed.inspect": { sessionId: "session-1", threadId: "thread-1" },
  "workspace.managed.cleanup": {
    sessionId: "session-1",
    threadId: "thread-1",
    reason: "operator cleanup",
  },
  "workspace.managed.restore": {
    sessionId: "session-1",
    threadId: "thread-1",
    checkpointId: "checkpoint-1",
  },
  "workspace.managed.setup.retry": { sessionId: "session-1", threadId: "thread-1" },
  "user.terminal.start": { sessionId: "session-1", threadId: "thread-1" },
  "user.terminal.list": { sessionId: "session-1", threadId: "thread-1" },
  "user.terminal.read": { sessionId: "session-1", terminalId: "terminal-1", cursor: 0 },
  "user.terminal.write": { sessionId: "session-1", terminalId: "terminal-1", data: "pwd\r" },
  "user.terminal.resize": { sessionId: "session-1", terminalId: "terminal-1", cols: 120, rows: 32 },
  "user.terminal.stop": { sessionId: "session-1", terminalId: "terminal-1" },
  "workspace.changes.inspect": { sessionId: "session-1", threadId: "thread-1", scope: { kind: "uncommitted" } },
  "workspace.changes.mutate": { sessionId: "session-1", threadId: "thread-1", expectedFingerprint: "sha256:fingerprint", mutation: { operation: "stage_file", path: "src/app.ts" } },
  "workspace.feedback.add": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, path: "src/app.ts", line: 1, side: "RIGHT", body: "Review this." },
  "workspace.feedback.list": { sessionId: "session-1", threadId: "thread-1" },
  "workspace.feedback.remove": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, commentId: "comment-1" },
  "workspace.feedback.submit": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, commentIds: ["comment-1"] },
  "workspace.review.run": { sessionId: "session-1", threadId: "thread-1", scope: { kind: "uncommitted" }, mode: "current_thread" },
  "workspace.review.list": { sessionId: "session-1", threadId: "thread-1" },
  "workspace.review.update": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, reviewId: "review-1", findingId: "finding-1", action: "accept" },
  "workspace.review.submit": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, reviewId: "review-1", findingIds: ["finding-1"], request: "address" },
  "workspace.validation.inspect": { sessionId: "session-1", threadId: "thread-1" },
  "workspace.validation.run": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, actionId: "package:test" },
  "workspace.validation.cancel": { sessionId: "session-1", threadId: "thread-1", resultId: "result-1" },
  "workspace.validation.submit": { sessionId: "session-1", threadId: "thread-1", resultIds: ["result-1"] },
  "workspace.git.inspect": { sessionId: "session-1", threadId: "thread-1" },
  "workspace.git.action": { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: `sha256:${"a".repeat(64)}`, action: { kind: "fetch", remote: "origin" } },
  "mission_control.project.get": { projectId: "11111111-1111-4111-8111-111111111111" },
  "mission_control.action.execute": {
    action: {
      type: "item.create",
      projectId: "11111111-1111-4111-8111-111111111111",
      actionId: "create-1",
      actionTs: "2026-07-30T00:00:00.000Z",
      expectedRevision: 0,
      itemId: "item-1",
      title: "Canonical work",
      instructions: "Exercise the project-scoped authority.",
      createdBy: "operator",
      order: 1,
    },
  },
  "project.snapshot.get": { sessionId: "session-1" },
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
  "mcp.refresh": { profileId: "kestrel" },
};

test("conversation message cursors and recovery pages are boundary validated", () => {
  const cursor = encodeConversationMessageCursor({
    completedAt: "2026-07-31T10:00:00.000Z",
    turnId: "turn:recovery/1",
  });
  assert.deepEqual(parseConversationMessageCursor(cursor), {
    completedAt: "2026-07-31T10:00:00.000Z",
    turnId: "turn:recovery/1",
  });
  const recoveryCommand = parseRunnerCommandV2({
    id: "messages-1",
    type: "conversation.messages.list",
    payload: {
      threadId: "thread-1",
      afterCursor: cursor,
      limit: 500,
      includeFinalizedPayload: true,
    },
  });
  assert.equal(recoveryCommand.type, "conversation.messages.list");
  assert.equal(recoveryCommand.payload.includeFinalizedPayload, true);
  const recoveryEvent = parseRunnerEventV2({
    id: "messages-result-1",
    type: "conversation.messages",
    ts: "2026-07-31T10:01:00.000Z",
    threadId: "thread-1",
    payload: {
      threadId: "thread-1",
      messages: [{
        messageId: "terminal:run-1",
        turnId: "turn-1",
        threadId: "thread-1",
        sessionId: "session-1",
        runId: "run-1",
        completedAt: "2026-07-31T10:00:00.000Z",
        result: {
          assistantText: "Recovered.",
          output: terminalResult.output,
          finalizedPayload: {
            payload: { data: { modeSwitch: { mode: "build" } } },
          },
        },
      }],
      nextCursor: cursor,
      hasMore: false,
    },
  });
  assert.equal(recoveryEvent.type, "conversation.messages");
  if (recoveryEvent.type !== "conversation.messages") {
    throw new Error("Expected conversation.messages recovery event.");
  }
  assert.deepEqual(
    recoveryEvent.payload.messages[0]?.result.finalizedPayload,
    { payload: { data: { modeSwitch: { mode: "build" } } } },
  );
  assert.throws(() => parseRunnerCommandV2({
    id: "messages-invalid-finalized-payload",
    type: "conversation.messages.list",
    payload: { threadId: "thread-1", includeFinalizedPayload: "yes" },
  }), /includeFinalizedPayload must be a boolean/u);
  assert.throws(() => parseRunnerCommandV2({
    id: "messages-invalid",
    type: "conversation.messages.list",
    payload: { threadId: "thread-1", afterCursor: "not-a-cursor" },
  }), /afterCursor is invalid/u);
  assert.throws(() => parseRunnerCommandV2({
    id: "messages-too-large",
    type: "conversation.messages.list",
    payload: { threadId: "thread-1", limit: 501 },
  }), /limit must be an integer between 1 and 500/u);
  assert.throws(() => parseRunnerEventV2({
    id: "messages-invalid-output",
    type: "conversation.messages",
    ts: "2026-07-31T10:01:00.000Z",
    threadId: "thread-1",
    payload: {
      threadId: "thread-1",
      messages: [{
        messageId: "terminal:run-1",
        turnId: "turn-1",
        threadId: "thread-1",
        sessionId: "session-1",
        runId: "run-1",
        completedAt: "2026-07-31T10:00:00.000Z",
        result: { assistantText: "Recovered.", output: { status: "COMPLETED" } },
      }],
      hasMore: false,
    },
  }), /result\.output\.sessionId/u);
  assert.throws(() => parseRunnerEventV2({
    id: "messages-mismatched-output",
    type: "conversation.messages",
    ts: "2026-07-31T10:01:00.000Z",
    threadId: "thread-1",
    payload: {
      threadId: "thread-1",
      messages: [{
        messageId: "terminal:run-1",
        turnId: "turn-1",
        threadId: "thread-1",
        sessionId: "session-1",
        runId: "run-1",
        completedAt: "2026-07-31T10:00:00.000Z",
        result: {
          assistantText: "Recovered.",
          output: { ...terminalResult.output, runId: "run-other" },
        },
      }],
      hasMore: false,
    },
  }), /result\.output\.runId must match message\.runId/u);
});

const exactResultActivation = {
  version: "v1",
  descriptor: { version: "v1", toolId: "code.execute", sourceKind: "builtin", sourceId: "builtin", contractRevision: `sha256:${"a".repeat(64)}`, inputSchemaHash: `sha256:${"b".repeat(64)}`, outputContractHash: `sha256:${"c".repeat(64)}` },
  registryGeneration: "generation-1",
  scopeFingerprint: `sha256:${"d".repeat(64)}`,
};
const exactLoadedResult = {
  version: "v2",
  toolName: "code.execute",
  status: "OK",
  toolCallId: "call-1",
  activation: exactResultActivation,
  outcome: { version: "v1", callId: "call-1", activation: exactResultActivation, kind: "success", startedAt: "2026-07-13T12:00:00.000Z", completedAt: "2026-07-13T12:00:01.000Z", effectState: "not_applicable", rawOutput: {} },
  modelContext: { text: "ok", rawOutputRef: "sha256:result", truncated: false },
  auditRecord: { toolName: "code.execute", input: {}, output: {}, startedAt: "2026-07-13T12:00:00.000Z", completedAt: "2026-07-13T12:00:01.000Z", durationMs: 1000, status: "OK" },
};

const eventPayloads: Record<RunnerEventType, Record<string, unknown>> = {
  "profile.listed": { profiles: [profile] },
  "profile.loaded": { profile },
  "execution-profile.resolved": {
    version: 1,
    profileId: `kestrel:workspace_hosted:${"a".repeat(64)}`,
    fingerprint: "a".repeat(64),
    policy: { id: "kestrel", version: 2 },
    environmentPreset: { id: "workspace_hosted", version: 1 },
    resolvedProfile: {
      ...profile,
      id: `kestrel:workspace_hosted:${"a".repeat(64)}`,
      agentProfileId: "kestrel",
    },
    exactToolDecisions: {
      exec_command: {
        version: "effective_tool_decision_v1",
        available: true,
        availabilityReason: "available",
        approvalDisposition: {
          mode: "ask",
          reasonCode: "environment_policy",
          authority: {
            kind: "hosted_app_policy",
            revision: "authority-v1",
          },
        },
        rememberApprovalEligible: true,
        authorityRevision: "authority-v1",
        evidence: {
          interactionMode: "build",
          toolClass: "sandboxed_only",
          requiredCapabilities: ["shell.exec", "external.confirm"],
          actorAccess: true,
        },
      },
    },
  },
  "job.started": {
    sessionId: "session-1",
    threadId: "thread-1",
    profileId: "kestrel",
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
  "run.started": {
    sessionId: "session-1",
    eventType: "user.message",
    followUpId: "follow-up:message-1",
    sourceMessageId: "message-1",
    reasoningKeyReady: true,
    reasoningKeyVersion: 1,
  },
  "run.cancelled": { sessionId: "session-1", result: terminalResult },
  "run.tool.started": { update: toolUpdate("started") },
  "run.tool.completed": { update: toolUpdate("completed") },
  "run.tool.failed": { update: toolUpdate("failed") },
  "run.log": { entry: {} },
  "run.console": { update: {} },
  "run.progress": { update: progressUpdate },
  "run.model.reasoning.started": { update: reasoningUpdate("started") },
  "run.model.reasoning.delta": { update: reasoningUpdate("delta") },
  "run.model.reasoning.completed": { update: reasoningUpdate("completed") },
  "run.model.reasoning.failed": { update: reasoningUpdate("failed") },
  "run.model.reasoning.unavailable": { update: reasoningUpdate("unavailable") },
  "run.agent_progress": {
    update: {
      ...presentationIdentity,
      message: "I am applying the accepted action.",
      stepIndex: 1,
      stepAgent: "agent.loop",
    },
  },
  "run.completed": { result: terminalResult },
  "run.failed": {
    result: { ...terminalResult, output: { ...terminalResult.output, status: "FAILED" } },
    error: { code: "RUN_FAILED", message: "Run failed" },
  },
  "effect.result.loaded": {
    version: 1,
    sessionId: "session-1",
    runId: "run-1",
    idempotencyKey: "call-1",
    result: exactLoadedResult,
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
  "conversation.message.routed": {
    threadId: "thread-1",
    sessionId: "session-1",
    messageId: "message-1",
    disposition: "queued",
    followUpId: "follow-up:message-1",
    view: {},
  },
  "conversation.messages": { threadId: "thread-1", messages: [], hasMore: false },
  "operator.runs": { view: {} },
  "operator.run": { view: {} },
  "operator.run.reasoning": {
    runId: "run-1",
    entries: [],
    action: "read",
    retention: "provider_visible",
    access: "org_admin",
  },
  "operator.controlled": { threadId: "thread-1" },
  "task.updated": { task: {}, kind: "waiting", assistantText: null },
  "task.graph": { sessionId: "session-1", version: 1, graph: {} },
  "workspace.checkpoint": { sessionId: "session-1", operation: "list" },
  "user.terminal": { sessionId: "session-1", operation: "list", terminals: [] },
  "workspace.changes": { sessionId: "session-1", threadId: "thread-1", operation: "inspect", snapshot: {} },
  "workspace.feedback": { sessionId: "session-1", threadId: "thread-1", operation: "list", snapshot: {} },
  "workspace.review": { sessionId: "session-1", threadId: "thread-1", operation: "list", snapshot: {} },
  "workspace.validation": { sessionId: "session-1", threadId: "thread-1", operation: "inspect", snapshot: {} },
  "workspace.git": { sessionId: "session-1", threadId: "thread-1", operation: "inspect", snapshot: {} },
  "mission_control.project": {
    projectId: "11111111-1111-4111-8111-111111111111",
    project: {},
  },
  "project.snapshot": { sessionId: "session-1", snapshot: {} },
  "project.review": { sessionId: "session-1", detail: {} },
  "mcp.status": { status: {} },
  "mcp.refreshed": { status: {} },
};

test("Execution Protocol v4 descriptor owns the full supported registries", () => {
  assert.equal(EXECUTION_PROTOCOL_VERSION, "execution-protocol-v4");
  assert.equal(RUNNER_COMMAND_CONTRACT_VERSION, "runner-command-v3");
  assert.equal(RUNNER_EVENT_CONTRACT_VERSION, "dotted-runtime-events-v3");
  assert.deepEqual(EXECUTION_PROTOCOL_V4, {
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
      runStream: EXECUTION_PROTOCOL_V4.events.runStream,
      jobStream: RUNNER_JOB_STREAM_EVENT_TYPES,
      runTerminal: EXECUTION_PROTOCOL_V4.events.runTerminal,
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
  assert.deepEqual(RUNNER_STREAMING_COMMAND_TYPES, [
    "job.run",
    "run.start",
    "conversation.message.submit",
  ]);
  assert.equal(isRunnerStreamingCommandType("job.run"), true);
  assert.equal(isRunnerStreamingCommandType("run.start"), true);
  assert.equal(isRunnerStreamingCommandType("run.cancel"), false);
});

test("Execution Protocol v4 correlates command responses and shared workspace operations", () => {
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
    payload: { update: progressUpdate },
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

  const cancelFinalizing = parseRunnerEventV2({
    id: "event-run-cancel-finalizing",
    type: "runner.error",
    ts: "2026-07-13T12:00:00.000Z",
    commandId: "command-cancel",
    payload: {
      code: "RUN_ALREADY_FINALIZING",
      message: "The run has accepted final assistant output and is no longer cancellable.",
    },
  });
  assert.equal(isRunnerExpectedResponseEvent("run.cancel", cancelFinalizing), true);
  assert.equal(isRunnerEventAllowedForCommand("run.cancel", cancelFinalizing), true);
  assert.equal(isRunnerEventAllowedForCommand("run.start", cancelFinalizing), true);
  assert.equal(isRunnerTerminalResponseEvent(cancelFinalizing.type), true);
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

test("canonical execution profile contracts accept isolated local presets", () => {
  for (const environmentPresetId of [
    "cli_safe_local",
    "desktop_safe_local",
  ] as const) {
    const parsed = parseRunnerCommandV2({
      id: `command:${environmentPresetId}`,
      type: "execution-profile.resolve",
      payload: { environmentPresetId },
    });
    assert.equal(
      parsed.payload.environmentPresetId,
      environmentPresetId,
    );
  }
});

test("canonical execution profile contracts validate exact-tool preflight fields", () => {
  const command = parseRunnerCommandV2({
    id: "command:exact-tools",
    type: "execution-profile.resolve",
    payload: {
      environmentPresetId: "workspace_hosted",
      exactToolNames: ["exec_command"],
    },
  });
  assert.deepEqual(command.payload.exactToolNames, ["exec_command"]);

  assert.throws(
    () => parseRunnerCommandV2({
      id: "command:duplicate-exact-tools",
      type: "execution-profile.resolve",
      payload: {
        environmentPresetId: "workspace_hosted",
        exactToolNames: ["exec_command", "exec_command"],
      },
    }),
    /exactToolNames must not contain duplicates/u,
  );

  assert.throws(
    () => parseRunnerEventV2({
      id: "event:invalid-exact-tool-decision",
      type: "execution-profile.resolved",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        ...eventPayloads["execution-profile.resolved"],
        exactToolDecisions: {
          exec_command: {
            ...(eventPayloads["execution-profile.resolved"]!
              .exactToolDecisions as Record<string, Record<string, unknown>>)
              .exec_command,
            evidence: {
              interactionMode: "build",
              toolClass: "sandboxed_only",
              requiredCapabilities: ["shell.exec"],
            },
          },
        },
      },
    }),
    /evidence\.actorAccess must be a boolean/u,
  );
});

test("an older Web event parser can transport the V4 hosted preset for fail-closed negotiation", () => {
  const event = parseRunnerEventV2({
    id: "event:workspace-hosted-v4",
    type: "execution-profile.resolved",
    ts: "2026-08-26T12:00:00.000Z",
    payload: {
      ...eventPayloads["execution-profile.resolved"],
      environmentPreset: {
        id: "workspace_hosted",
        version: WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
      },
      resolvedProfile: {
        ...(eventPayloads["execution-profile.resolved"]!
          .resolvedProfile as Record<string, unknown>),
        approvalPolicyPackId: "hosted_workspace",
      },
    },
  });
  assert.equal(event.type, "execution-profile.resolved");
  assert.equal(
    event.payload.environmentPreset.version,
    WORKSPACE_HOSTED_APPROVAL_PRESET_VERSION,
  );
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
    /supported Execution Protocol v4 command/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({ id: "command-1", type: "profile.get", payload: {} }),
    /profileId/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "run.start",
      payload: { profileId: "kestrel", turn: {} },
    }),
    /turn\.sessionId/u,
  );
  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-1",
      type: "run.start",
      payload: {
        profileId: "kestrel",
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
        profileId: "kestrel",
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

test("canonical project actions reject retired lifecycle authorities and malformed Git fields", () => {
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
    /optional field must be a string/u,
  );

  for (const type of ["task.create", "task.propose", "board.card.create"]) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: `command-retired-${type}`,
        type: "project.action",
        payload: { type, sessionId: "session-1" },
      }),
      /project\.action payload\.type is invalid/u,
    );
  }

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
      profileId: "kestrel",
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
          profileId: "kestrel",
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
          profileId: "kestrel",
          ...(type === "run.start" ? { turn } : {}),
        },
      }),
      /must include only one of profile or profileId/u,
    );
  }

  for (const payload of [
    {
      profile,
      profileId: "kestrel",
      input: { version: "job_input_v1", turn },
    },
    {
      profileId: "kestrel",
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
      profileId: "kestrel",
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
          profileId: "kestrel",
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
        profileId: "kestrel",
        turn: {
          ...turn,
          autoCompaction: { state: "arrmed" },
        },
      },
    }),
    /autoCompaction\.state must be one of/u,
  );
});

test("canonical execution commands preserve exact Mission Control correlation", () => {
  const missionControl = {
    projectId: "11111111-1111-4111-8111-111111111111",
    itemId: "work-1",
    attemptId: "attempt-1",
    commandId: "command-1",
    runId: "run-1",
  };
  const started = parseRunnerCommandV2({
    id: "command-mission-control-start",
    type: "run.start",
    payload: {
      profileId: "kestrel",
      turn: { ...turn, missionControl },
    },
  });
  assert.equal(started.type, "run.start");
  if (started.type === "run.start") {
    assert.deepEqual(started.payload.turn.missionControl, missionControl);
  }
  const continued = parseRunnerCommandV2({
    id: "command-mission-control-retry",
    type: "operator.control",
    payload: {
      action: "retry",
      threadId: "thread-1",
      completionMode: "accepted",
      missionControl,
    },
  });
  assert.equal(continued.type, "operator.control");
  if (continued.type === "operator.control") {
    assert.deepEqual(continued.payload.missionControl, missionControl);
  }

  assert.throws(
    () =>
      parseRunnerCommandV2({
        id: "command-invalid-mission-control",
        type: "run.start",
        payload: {
          profileId: "kestrel",
          turn: {
            ...turn,
            missionControl: {
              ...missionControl,
              runId: "",
              inferredRunId: "latest",
            },
          },
        },
      }),
    /missionControl\.inferredRunId is not supported/u,
  );
});

test("operator approval commands reject caller-selected grant authority", () => {
  for (const legacyAuthority of [
    { allowToolClasses: ["external_side_effect"] },
    { allowCapabilities: ["mcp.invoke"] },
  ]) {
    assert.throws(
      () =>
        parseRunnerCommandV2({
          id: "command-legacy-approval-authority",
          type: "operator.control",
          payload: {
            action: "approve",
            threadId: "thread-1",
            ...legacyAuthority,
          },
        }),
      /is not supported/u,
    );
  }
});

test("canonical turn parsing validates workspace skill catalogs", () => {
  const workspaceSkills = [{
    installationId: "skill-1",
    name: "Release guide",
    description: "Project release instructions",
    commitSha: "0123456789abcdef",
    contentDigest: "sha256:0123456789abcdef",
    skillFile: "skills/release/SKILL.md",
  }];
  const parsed = parseRunnerCommandV2({
    id: "command-workspace-skills",
    type: "run.start",
    payload: {
      profileId: "kestrel",
      turn: { ...turn, workspaceSkills },
    },
  });
  assert.equal(parsed.type, "run.start");
  if (parsed.type === "run.start") {
    assert.deepEqual(parsed.payload.turn.workspaceSkills, workspaceSkills);
  }

  assert.throws(
    () => parseRunnerCommandV2({
      id: "command-invalid-workspace-skills",
      type: "run.start",
      payload: {
        profileId: "kestrel",
        turn: {
          ...turn,
          workspaceSkills: [{ ...workspaceSkills[0], contentDigest: "" }],
        },
      },
    }),
    /workspaceSkills\[0\]\.contentDigest must be a non-empty string/u,
  );
});

test("canonical turn history distinguishes runtime assistant text from legacy waiting prompts", () => {
  const parsed = parseRunnerCommandV2({
    id: "command-runtime-assistant-history",
    type: "run.start",
    payload: {
      profileId: "kestrel",
      turn: {
        ...turn,
        history: [
          {
            role: "assistant",
            text: "Which workspace should I inspect?",
            timestamp: "2026-07-15T12:00:00.000Z",
            data: { kind: "runtime.assistant_text", runId: "run-waiting" },
          },
          {
            role: "system",
            text: "Legacy prompt",
            timestamp: "2026-07-15T11:59:00.000Z",
            data: { kind: "runtime.waiting_prompt", runId: "run-legacy" },
          },
        ],
      },
    },
  });
  assert.equal(parsed.type, "run.start");

  for (const history of [
    [{
      role: "assistant",
      text: "Prompt",
      timestamp: "2026-07-15T12:00:00.000Z",
      data: { kind: "runtime.waiting_prompt", runId: "run-wrong-role" },
    }],
    [{
      role: "user",
      text: "Reply",
      timestamp: "2026-07-15T12:00:00.000Z",
      data: { kind: "runtime.assistant_text", runId: "run-wrong-role" },
    }],
  ]) {
    assert.throws(
      () => parseRunnerCommandV2({
        id: "command-invalid-runtime-history",
        type: "run.start",
        payload: { profileId: "kestrel", turn: { ...turn, history } },
      }),
      /data\.kind|data is only valid/u,
    );
  }
});

test("canonical tool presentation validates citation and Artifact identity", () => {
  const event = parseRunnerEventV2({
    id: "event-tool-presentation",
    type: "run.tool.completed",
    ts: "2026-07-15T12:00:00.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        ...toolUpdate("completed"),
        presentation: {
          citations: [{ id: "citation-1", title: "Project brief", documentId: "document-1" }],
          artifacts: [{ id: "artifact-1", title: "Analysis", kind: "document" }],
        },
      },
    },
  });
  assert.equal(event.type, "run.tool.completed");

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-tool-invalid-presentation",
      type: "run.tool.completed",
      ts: "2026-07-15T12:00:00.000Z",
      payload: {
        update: {
          ...toolUpdate("completed"),
          presentation: { citations: [{ id: "citation-1", title: "" }] },
        },
      },
    }),
    /presentation\.citations\[0\]\.title/u,
  );
});

test("terminal v2 tool events carry exact execution outcome evidence", () => {
  const event = parseRunnerEventV2({
    id: "event-tool-outcome-v2",
    type: "run.tool.completed",
    ts: "2026-07-15T12:00:00.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        ...toolUpdate("completed"),
        version: "v2",
        toolCallId: "call-1",
        toolName: "code.execute",
        activation: exactResultActivation,
        outcome: exactLoadedResult.outcome,
      },
    },
  });
  assert.equal(event.type, "run.tool.completed");
  assert.deepEqual(event.payload.update, {
    ...toolUpdate("completed"),
    version: "v2",
    toolCallId: "call-1",
    toolName: "code.execute",
    activation: exactResultActivation,
    outcome: exactLoadedResult.outcome,
  });

  assert.throws(
    () =>
      parseRunnerEventV2({
        id: "event-tool-outcome-missing",
        type: "run.tool.completed",
        ts: "2026-07-15T12:00:00.000Z",
        payload: {
          update: {
            ...toolUpdate("completed"),
            version: "v2",
            toolName: "code.execute",
            activation: exactResultActivation,
          },
        },
      }),
    /outcome is required/u,
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

test("effect.result.loaded rejects malformed or internally conflicting AgentToolResult evidence", () => {
  const parse = (result: unknown) => parseRunnerEventV2({ id: "event-effect-result", type: "effect.result.loaded", ts: "2026-07-13T12:00:00.000Z", payload: { version: 1, sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1", result } });
  assert.throws(() => parse({ version: "v2" }), /toolName/u);
  assert.throws(() => parse({ ...exactLoadedResult, extra: true }), /extra is not supported/u);
  assert.throws(() => parse({ ...exactLoadedResult, toolCallId: "other-call" }), /identities do not agree/u);
  assert.throws(() => parse({ ...exactLoadedResult, activation: { ...exactResultActivation, descriptor: { ...exactResultActivation.descriptor, toolId: "other.tool" } } }), /identities do not agree/u);
  assert.throws(() => parse({ ...exactLoadedResult, outcome: { ...exactLoadedResult.outcome, activation: { ...exactResultActivation, registryGeneration: "other-generation" } } }), /identities do not agree/u);
});

test("provider reasoning events reject opaque continuation state at the protocol boundary", () => {
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-reasoning-opaque-state",
      type: "run.model.reasoning.delta",
      ts: "2026-07-15T12:00:00.000Z",
      payload: {
        update: {
          ...reasoningUpdate("delta"),
          encrypted_content: "opaque-provider-state",
        },
      },
    }),
    /encrypted_content is not supported/u,
  );
});

test("canonical event parser rejects unknown and malformed payloads", () => {
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-1",
      type: "run.future",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {},
    }),
    /supported Execution Protocol v4 event/u,
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

test("canonical event parser normalizes a blank optional session updatedAt", () => {
  const parsed = parseRunnerEventV2({
    id: "event-session-described",
    type: "session.described",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      sessionId: "session-1",
      version: 1,
      updatedAt: "",
    },
  });
  assert.equal(parsed.type, "session.described");
  assert.equal("updatedAt" in parsed.payload, false);
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

  assert.throws(
    () => parseRunnerEventV2({
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
    }),
    /assistantText is required when output.status is COMPLETED/u,
  );

  const jobTerminal = parseRunnerEventV2({
    id: "event-job-terminal",
    type: "job.completed",
    ts: "2026-07-13T12:00:00.000Z",
    payload: {
      output: {
        ...jobOutput,
        resultHandle: {
          version: "job_managed_result_handle_v1",
          kind: "managed_worktree",
          worktreePath: "/tmp/kestrel-managed-result",
          sourceWorkspaceRoot: "/tmp/kestrel-source",
          baseRevision: "base-revision",
          candidateRevision: "candidate-revision",
          changedFiles: ["src/App.tsx"],
          promotionId: "promotion-1",
        },
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
    assert.deepEqual(jobTerminal.payload.output.resultHandle, {
      version: "job_managed_result_handle_v1",
      kind: "managed_worktree",
      worktreePath: "/tmp/kestrel-managed-result",
      sourceWorkspaceRoot: "/tmp/kestrel-source",
      baseRevision: "base-revision",
      candidateRevision: "candidate-revision",
      changedFiles: ["src/App.tsx"],
      promotionId: "promotion-1",
    });
  }

  assert.throws(
    () => parseRunnerEventV2({
      id: "event-job-invalid-result-handle",
      type: "job.completed",
      ts: "2026-07-13T12:00:00.000Z",
      payload: {
        output: {
          ...jobOutput,
          resultHandle: {
            version: "job_managed_result_handle_v1",
            kind: "managed_worktree",
            worktreePath: "/tmp/kestrel-managed-result",
            sourceWorkspaceRoot: "/tmp/kestrel-source",
            baseRevision: "base-revision",
            candidateRevision: "candidate-revision",
            changedFiles: [],
          },
        },
        replay,
      },
    }),
    /resultHandle\.changedFiles must contain at least one entry/u,
  );

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

test("waiting outcomes require one canonical assistant prompt and durable request", () => {
  const waiting = {
    status: "WAITING",
    sessionId: "session-1",
    runId: "run-1",
    errors: [],
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      interaction: {
        version: "v1",
        requestId: "opaque-request-1",
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Which workspace should I inspect?",
      },
    },
  };
  const parsed = parseRunnerEventV2({
    id: "event-waiting",
    type: "run.completed",
    ts: "2026-07-15T12:00:00.000Z",
    payload: {
      result: {
        assistantText: "Which workspace should I inspect?",
        output: waiting,
      },
    },
  });
  assert.equal(parsed.type, "run.completed");
  if (parsed.type !== "run.completed") assert.fail("expected run.completed");
  assert.equal(parsed.payload.result.assistantText, waiting.waitFor.interaction.prompt);
  assert.equal(
    parsed.payload.result.output.waitFor?.interaction?.requestId,
    "opaque-request-1",
  );

  for (const assistantText of [null, "A different question."]) {
    assert.throws(
      () =>
        parseRunnerEventV2({
          id: `event-waiting-invalid-${String(assistantText)}`,
          type: "run.completed",
          ts: "2026-07-15T12:00:00.000Z",
          payload: { result: { assistantText, output: waiting } },
        }),
      /assistantText|interaction prompt/u,
    );
  }

  const malformedLegacyReview = structuredClone(legacyRecoveryReviewInteractionFixture) as Record<string, unknown>;
  delete malformedLegacyReview.inputSchema;
  assert.doesNotThrow(
    () => parseRunnerEventV2({
      id: "event-waiting-malformed-review",
      type: "run.completed",
      ts: "2026-07-15T12:00:00.000Z",
      payload: {
        result: {
          assistantText: legacyRecoveryReviewInteractionFixture.prompt,
          output: {
            ...waiting,
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              interaction: malformedLegacyReview,
            },
          },
        },
      },
    }),
  );

  const malformedEvaluationReview = structuredClone(evaluationReviewInteractionFixture) as Record<string, unknown>;
  delete malformedEvaluationReview.inputSchema;
  assert.throws(
    () => parseRunnerEventV2({
      id: "event-waiting-malformed-evaluation-review",
      type: "run.completed",
      ts: "2026-07-15T12:00:00.000Z",
      payload: {
        result: {
          assistantText: evaluationReviewInteractionFixture.prompt,
          output: {
            ...waiting,
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              interaction: malformedEvaluationReview,
            },
          },
        },
      },
    }),
    /invalid structured review/u,
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
