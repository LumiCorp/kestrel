import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalizePayload } from "../../agents/reference-react/src/steps/acter/finalizePayload.js";
import { appendUserTurnToTranscript } from "../../src/runtime/modelTranscript.js";

test("buildFinalizePayload forwards inconclusive artifact verification as report data", () => {
  const payload = buildFinalizePayload(
    {
      goal: "Build newsletter page",
      decisionVerification: {
        verificationSteps: ["verify:newsletter page in workspace"],
        expectedRepoDelta: ["src/App.jsx"],
      },
      evidenceLedger: [
        {
          id: "ev_empty_workspace",
          version: "v1",
          createdAt: "2026-06-09T21:00:00.000Z",
          source: "runtime",
          kind: "artifact_verification",
          status: "inconclusive",
          summary: "Workspace is empty.",
          target: {
            type: "artifact",
            value: "newsletter page in workspace",
          },
          facts: {
            target: "newsletter page in workspace",
            status: "inconclusive",
            failures: ["No concrete file artifact is visible in the current workspace evidence."],
          },
        },
      ],
    },
    {
      message: "Done.",
      data: {
        completionState: "implemented_and_verified",
      },
    },
  );

  assert.deepEqual(payload.payload.data.artifactVerification, {
    target: "newsletter page in workspace",
    status: "inconclusive",
    failures: ["No concrete file artifact is visible in the current workspace evidence."],
  });
});

test("buildFinalizePayload drops model-supplied passed artifact verification without ledger evidence", () => {
  const payload = buildFinalizePayload(
    {
      goal: "Build newsletter page",
      decisionVerification: {
        expectedRepoDelta: ["file:index.html"],
      },
      evidenceLedger: [
        {
          id: "ev_index",
          version: "v1",
          createdAt: "2026-06-09T21:00:00.000Z",
          source: "tool",
          kind: "tool_result",
          status: "passed",
          summary: "Wrote index.html.",
          target: {
            type: "path",
            value: "index.html",
            normalizedValue: "index.html",
          },
          facts: {
            toolName: "fs.write_text",
            inputPath: "index.html",
          },
        },
      ],
    },
    {
      message: "Done.",
      data: {
        completionState: "implemented_and_verified",
        artifactVerification: {
          status: "passed",
          target: "local newsletter page",
        },
      },
    },
  );

  assert.equal((payload.payload.data as Record<string, unknown>).artifactVerification, undefined);
});

test("buildFinalizePayload omits recovered validation feedback from final report data", () => {
  const payload = buildFinalizePayload(
    {
      goal: "Build itinerary page",
      decisionVerification: {
        expectedRepoDelta: ["file:index.html"],
      },
      lastActionResult: {
        kind: "validation_feedback",
        status: "failed",
        error: {
          code: "DECISION_POLICY_FAILED",
          message: "The previous decision was invalid.",
        },
      },
      evidenceLedger: [
        {
          id: "ev_index",
          version: "v1",
          createdAt: "2026-06-09T21:00:00.000Z",
          source: "tool",
          kind: "file_content",
          status: "passed",
          summary: "Read index.html.",
          target: {
            type: "path",
            value: "index.html",
            normalizedValue: "index.html",
          },
          facts: {
            toolName: "fs.read_text",
            inputPath: "index.html",
          },
        },
      ],
    },
    {
      message: "Done.",
      data: {
        completionState: "implemented_and_verified",
        summary: "Created index.html.",
      },
    },
  );

  const data = payload.payload.data as Record<string, unknown>;
  assert.equal(data.lastActionResult, undefined);
  assert.deepEqual(data.runtimeEvidenceSummary, {
    supportedTokens: ["file:index.html", "tool:fs.read_text"],
    blockedTokens: [],
  });
});

test("buildFinalizePayload uses transcript task before stale agent goal", () => {
  const payload = buildFinalizePayload(
    {
      goal: "Keep going.",
      modelTranscript: appendUserTurnToTranscript({
        transcript: undefined,
        message: "Build Chirp, a text-only microblogging app.",
        stepIndex: 1,
      }),
    },
    {
      message: "Done.",
    },
  );

  assert.equal(payload.payload.data.goal, "Build Chirp, a text-only microblogging app.");
});

test("buildFinalizePayload does not use stale agent goal when transcript lacks a task", () => {
  const payload = buildFinalizePayload(
    {
      goal: "Keep going.",
      modelTranscript: {
        version: 1,
        windowId: 1,
        items: [
          {
            id: "mt_1_0001_assistant_text",
            createdAt: "2026-07-06T12:00:00.000Z",
            kind: "assistant_text",
            content: "No user task survived.",
          },
        ],
      },
    },
    {
      message: "Done.",
    },
  );

  assert.equal(payload.payload.data.goal, undefined);
});
