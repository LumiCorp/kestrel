import test from "node:test";
import assert from "node:assert/strict";

import { buildCorruptedNextActionInspectionReport } from "../../src/runtime/corruptedNextActionInspection.js";

test("corrupted nextAction inspection reports affected sessions without mutating data", () => {
  const report = buildCorruptedNextActionInspectionReport({
    sessions: [
      {
        sessionId: "session-corrupt",
        latestVersion: 12,
        currentStepAgent: "agent.exec.wait_approval",
        currentState: {
          agent: {
            waitingFor: {
              kind: "approval",
              eventType: "user.approval",
              reason: "approval",
              resumeInstruction: "Resume after approval.",
            },
            nextAction: "[Circular]",
            lastAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "app/page.tsx" },
            },
          },
        },
      },
      {
        sessionId: "session-clean",
        latestVersion: 3,
        currentStepAgent: "agent.loop",
        currentState: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.read_text",
              input: { path: "README.md" },
            },
          },
        },
      },
    ],
    versions: [
      {
        sessionId: "session-corrupt",
        version: 7,
        state: {},
        statePatch: {
          agent: {
            nextAction: {
              kind: "tool",
              name: "fs.write_text",
              input: { path: "app/page.tsx" },
            },
          },
        },
      },
      {
        sessionId: "session-corrupt",
        version: 8,
        state: {},
        statePatch: {
          agent: {
            nextAction: "[Circular]",
          },
        },
      },
    ],
  });

  assert.equal(report.mutatesData, false);
  assert.equal(report.affectedSessions.length, 1);
  assert.deepEqual(report.affectedSessions[0], {
    sessionId: "session-corrupt",
    latestVersion: 12,
    firstCorruptedVersion: 8,
    currentStepAgent: "agent.exec.wait_approval",
    waitEventType: "user.approval",
    latestStateCorrupt: true,
    repairability: "candidate:lastAction",
  });
});
