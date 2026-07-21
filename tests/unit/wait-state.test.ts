import assert from "node:assert/strict";

import {
  buildWaitResumeToken,
  buildCanonicalWaitingFor,
  readActiveWaitState,
  readWaitResumeStepAgent,
} from "../../src/runtime/waitState.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "readActiveWaitState reads canonical waitingFor and ignores legacy shapes", () => {
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

contractTest("runtime.hermetic", "readActiveWaitState ignores legacy nextAction and exec wait shapes", () => {
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

contractTest("runtime.hermetic", "readActiveWaitState does not fall back to legacy exec and top-level wait state", () => {
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

contractTest("runtime.hermetic", "buildWaitResumeToken is stable across metadata key order", () => {
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
  assert.match(left, /agent\.exec\.dispatch/u);
});

contractTest("runtime.hermetic", "readWaitResumeStepAgent only reads canonical waitingFor", () => {
  assert.equal(readWaitResumeStepAgent({ wait: { resumeStepAgent: "agent.exec.collect" } }), undefined);
});
