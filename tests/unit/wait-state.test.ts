import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWaitResumeToken,
  buildCanonicalWaitingFor,
  readActiveWaitState,
  readWaitResumeStepAgent,
} from "../../src/runtime/waitState.js";
import type { RuntimeLocalToolApprovalInteractionV1 } from "../../src/kestrel/contracts/execution.js";


test("readActiveWaitState reads canonical waitingFor and ignores legacy shapes", () => {
  const wait = readActiveWaitState({
    waitingFor: buildCanonicalWaitingFor({
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: { reason: "canonical" },
      },
      resumeStepAgent: "agent.exec.wait_user",
      resumeToken: "canonical-token",
      reason: "canonical wait",
      resumeInstruction: "Resume with the canonical wait.",
    }),
    nextAction: {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        resumeStepAgent: "agent.loop",
        metadata: { reason: "legacy-next-action" },
      },
    },
    exec: {
      waitingForUser: {
        kind: "user",
        eventType: "user.reply",
        resumeStepAgent: "agent.exec.dispatch",
        metadata: { reason: "legacy-exec" },
      },
    },
  });

  assert.equal(wait?.source, "waitingFor");
  assert.equal(wait?.eventType, "user.reply");
  assert.equal(wait?.resumeStepAgent, "agent.exec.wait_user");
  assert.equal(wait?.resumeToken, "canonical-token");
  assert.equal(wait?.reason, "canonical wait");
  assert.deepEqual(wait?.metadata, { reason: "canonical" });
});

test("readActiveWaitState ignores legacy nextAction and exec wait shapes", () => {
  const wait = readActiveWaitState({
    nextAction: {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: { prompt: "from next action" },
      },
    },
    exec: {
      waitingForUser: {
        kind: "user",
        eventType: "user.reply",
        resumeStepAgent: "agent.exec.dispatch",
        metadata: { prompt: "from exec" },
      },
    },
    wait: {
      kind: "user",
      eventType: "user.reply",
      resumeStepAgent: "agent.loop",
      metadata: { prompt: "from top level" },
    },
  });

  assert.equal(wait, undefined);
});

test("readActiveWaitState preserves canonical local tool approvals", () => {
  const interaction = {
    version: "runner_local_tool_approval_interaction_v1",
    requestId: "request-local-approval",
    kind: "approval",
    eventType: "user.approval",
    prompt: "Review this action before it runs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decision"],
      properties: {
        decision: {
          type: "string",
          enum: ["decline", "approve_once"],
        },
      },
    },
    approval: {
      approvalId: "local-approval",
      toolName: "desktop.host.open",
      requestedAt: "2026-08-28T12:00:00.000Z",
      expiresAt: "2026-08-28T12:05:00.000Z",
    },
  } satisfies RuntimeLocalToolApprovalInteractionV1;
  const wait = readActiveWaitState({
    waitingFor: buildCanonicalWaitingFor({
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        interaction,
      },
      resumeStepAgent: "agent.exec.wait_approval",
    }),
  });

  assert.deepEqual(wait?.interaction, interaction);
});

test("readActiveWaitState does not fall back to legacy exec and top-level wait state", () => {
  const execWait = readActiveWaitState({
    exec: {
      waitingForUser: {
        kind: "user",
        eventType: "user.reply",
        resumeStepAgent: "agent.exec.dispatch",
        metadata: { reason: "planner_mode_blocked" },
      },
    },
    wait: {
      kind: "user",
      eventType: "user.reply",
      resumeStepAgent: "agent.loop",
      metadata: { reason: "stale" },
    },
  });
  assert.equal(execWait, undefined);

  const topLevelWait = readActiveWaitState({
    wait: {
      kind: "user",
      eventType: "user.reply",
      resumeStepAgent: "agent.loop",
      metadata: { reason: "loop_visit_stall" },
    },
  });
  assert.equal(topLevelWait, undefined);
});

test("buildWaitResumeToken is stable across metadata key order", () => {
  const left = buildWaitResumeToken({
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: { b: 2, a: 1 },
    },
    resumeStepAgent: "agent.exec.dispatch",
  });
  const right = buildWaitResumeToken({
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: { a: 1, b: 2 },
    },
    resumeStepAgent: "agent.exec.dispatch",
  });

  assert.equal(left, right);
  assert.match(left, /^sha256:[0-9a-f]{64}$/u);
});

test("wait resume tokens remain fixed-size for oversized prepared interactions", () => {
  const token = buildWaitResumeToken({
    waitFor: {
      kind: "approval",
      eventType: "user.approval",
      metadata: { command: "x".repeat(10_000) },
    },
    resumeStepAgent: "agent.exec.dispatch",
  });

  assert.equal(token.length, 71);
  assert.match(token, /^sha256:[0-9a-f]{64}$/u);
});

test("canonical waits preserve every runtime kind and timeout", () => {
  for (const kind of ["approval", "effect", "region_merge", "tool", "user"] as const) {
    const canonical = buildCanonicalWaitingFor({
      waitFor: {
        kind,
        eventType: `${kind}.ready`,
        timeoutMs: 12_345,
        metadata: { resumeInstruction: `resume ${kind}` },
      },
      resumeStepAgent: "agent.exec.dispatch",
    });
    const read = readActiveWaitState({ waitingFor: canonical });
    assert.equal(read?.kind, kind);
    assert.equal(read?.timeoutMs, 12_345);
    assert.equal(read?.eventType, `${kind}.ready`);
  }
});

test("wait timeout participates in resume-token identity", () => {
  const short = buildWaitResumeToken({
    waitFor: { kind: "region_merge", eventType: "region.completed", timeoutMs: 1_000 },
    resumeStepAgent: "agent.exec.wait_region",
  });
  const long = buildWaitResumeToken({
    waitFor: { kind: "region_merge", eventType: "region.completed", timeoutMs: 5_000 },
    resumeStepAgent: "agent.exec.wait_region",
  });
  assert.notEqual(short, long);
});

test("readWaitResumeStepAgent only reads canonical waitingFor", () => {
  assert.equal(readWaitResumeStepAgent({ wait: { resumeStepAgent: "agent.exec.collect" } }), undefined);
});
