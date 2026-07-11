import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidenceCompletionSummary,
  buildEvidenceLedgerContext,
  parseEvidenceLedger,
} from "../../agents/reference-react/src/evidenceLedger.js";
import {
  readLatestActiveArtifactVerificationFacts,
} from "../../agents/reference-react/src/artifactVerificationFacts.js";
import { applyReactStateEvent } from "../../agents/reference-react/src/reactStateReducer.js";

test("tool results append evidence without committing workItem state", () => {
  const result = applyReactStateEvent({
    reactState: {
      workItem: { phase: "derive_artifact", objective: "legacy state" },
      workItemTransition: { reason: "legacy transition" },
    },
    event: {
      type: "tool_result_observed",
      stepIndex: 2,
      toolName: "fs.read_text",
      toolInput: { path: "/app/maze_controller.py" },
      toolOutput: {
        status: "COMPLETED",
        path: "/app/maze_controller.py",
        text: "print('controller')\n",
      },
    },
  });

  assert.equal(result.reactState.workItem, undefined);
  assert.equal(result.reactState.workItemTransition, undefined);
  const ledger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]?.source, "tool");
  assert.equal(result.transition.reason, "tool_result_observed:fs.read_text");
  assert.deepEqual(result.transition.consumedEvidenceIds, []);
});

test("filesystem search evidence preserves zero-match constraint facts", () => {
  const result = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 4,
      toolName: "fs.search_text",
      toolInput: {
        path: "/app/synonyms.txt",
        query: "privileged",
        glob: "*.txt",
        caseSensitive: true,
        maxResults: 20,
      },
      toolOutput: {
        path: "/app/synonyms.txt",
        query: "privileged",
        matches: [],
      },
    },
  });

  const ledger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const entry = ledger.at(-1) as Record<string, unknown>;
  const facts = entry.facts as Record<string, unknown>;
  assert.equal(entry.summary, 'fs.search_text /app/synonyms.txt for "privileged" returned 0 matches.');
  assert.equal(facts.query, "privileged");
  assert.equal(facts.glob, "*.txt");
  assert.equal(facts.caseSensitive, true);
  assert.equal(facts.maxResults, 20);
  assert.equal(facts.matchCount, 0);
  assert.deepEqual(facts.matches, []);
});

test("filesystem search evidence preserves capped match previews", () => {
  const result = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 5,
      toolName: "fs.search_text",
      toolInput: {
        path: "/app/input.tex",
        query: "wisdom",
      },
      toolOutput: {
        path: "/app/input.tex",
        query: "wisdom",
        matches: Array.from({ length: 8 }, (_item, index) => ({
          path: "/app/input.tex",
          line: index + 10,
          column: 4,
          preview: `Finnish wisdom ${index}`,
        })),
      },
    },
  });

  const ledger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const entry = ledger.at(-1) as Record<string, unknown>;
  const facts = entry.facts as Record<string, unknown>;
  const matches = facts.matches as Array<Record<string, unknown>>;
  assert.equal(entry.summary, 'fs.search_text /app/input.tex for "wisdom" returned 8 matches.');
  assert.equal(facts.matchCount, 8);
  assert.equal(matches.length, 6);
  assert.deepEqual(matches[0], {
    path: "/app/input.tex",
    line: 10,
    column: 4,
    preview: "Finnish wisdom 0",
    previewTruncated: false,
  });
  assert.equal(facts.matchesTruncated, true);
});

test("filesystem mutation evidence preserves compact edit facts", () => {
  const afterReplace = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 6,
      toolName: "fs.replace_text",
      toolInput: {
        path: "/app/input.tex",
        find: "a great deal more",
        replace: "a lot more",
        all: true,
      },
      toolOutput: {
        path: "/app/input.tex",
        replacements: 1,
        changed: true,
        status: "OK",
        message: "Replaced 1 occurrence.",
        findWhitespaceTokenCount: 4,
        replaceWhitespaceTokenCount: 3,
        perReplacementWhitespaceTokenDelta: -1,
        bytesBefore: 42,
        bytesAfter: 36,
        lineCountBefore: 2,
        lineCountAfter: 2,
        whitespaceTokenCountBefore: 8,
        whitespaceTokenCountAfter: 7,
        lineCountDelta: 0,
        whitespaceTokenCountDelta: -1,
      },
    },
  });
  const afterWrite = applyReactStateEvent({
    reactState: afterReplace.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: 7,
      toolName: "fs.write_text",
      toolInput: {
        path: "/app/report.txt",
        content: "done\n",
        mode: "overwrite",
        createParents: true,
      },
      toolOutput: {
        path: "/app/report.txt",
        mode: "overwrite",
        bytesWritten: 5,
        existed: true,
        changed: true,
        bytesBefore: 11,
        bytesAfter: 5,
        lineCountBefore: 2,
        lineCountAfter: 2,
        whitespaceTokenCountBefore: 2,
        whitespaceTokenCountAfter: 1,
        diffPreview: {
          before: "old report\n",
          after: "done\n",
          truncated: false,
        },
      },
    },
  });

  const ledger = afterWrite.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const replaceFacts = (ledger[0]?.facts ?? {}) as Record<string, unknown>;
  const writeFacts = (ledger[1]?.facts ?? {}) as Record<string, unknown>;
  assert.equal(ledger[0]?.summary, 'fs.replace_text "a great deal more" -> "a lot more" (1 replacement, token delta -1).');
  assert.equal(replaceFacts.find, "a great deal more");
  assert.equal(replaceFacts.replace, "a lot more");
  assert.equal(replaceFacts.all, true);
  assert.equal(replaceFacts.replacements, 1);
  assert.equal(replaceFacts.changed, true);
  assert.equal(replaceFacts.findWhitespaceTokenCount, 4);
  assert.equal(replaceFacts.replaceWhitespaceTokenCount, 3);
  assert.equal(replaceFacts.perReplacementWhitespaceTokenDelta, -1);
  assert.equal(replaceFacts.bytesBefore, 42);
  assert.equal(replaceFacts.bytesAfter, 36);
  assert.equal(replaceFacts.lineCountBefore, 2);
  assert.equal(replaceFacts.lineCountAfter, 2);
  assert.equal(replaceFacts.whitespaceTokenCountBefore, 8);
  assert.equal(replaceFacts.whitespaceTokenCountAfter, 7);
  assert.equal(replaceFacts.lineCountDelta, 0);
  assert.equal(replaceFacts.whitespaceTokenCountDelta, -1);
  assert.equal(ledger[1]?.summary, "fs.write_text overwrote existing file /app/report.txt with 5 bytes (token delta -1, line delta +0).");
  assert.equal(writeFacts.mode, "overwrite");
  assert.equal(writeFacts.createParents, true);
  assert.equal(writeFacts.existed, true);
  assert.equal(writeFacts.changed, true);
  assert.equal(writeFacts.bytesBefore, 11);
  assert.equal(writeFacts.bytesAfter, 5);
  assert.equal(writeFacts.lineCountBefore, 2);
  assert.equal(writeFacts.lineCountAfter, 2);
  assert.equal(writeFacts.whitespaceTokenCountBefore, 2);
  assert.equal(writeFacts.whitespaceTokenCountAfter, 1);
  assert.equal(writeFacts.whitespaceTokenCountDelta, -1);
  assert.equal(writeFacts.lineCountDelta, 0);
  assert.equal(writeFacts.diffPreviewBefore, "old report\n");
  assert.equal(writeFacts.diffPreviewAfter, "done\n");
  assert.equal(writeFacts.diffPreviewTruncated, false);
  assert.equal(writeFacts.contentBytes, 5);
  assert.equal(writeFacts.contentPreview, "done\n");
  assert.equal(writeFacts.bytesWritten, 5);
});

test("dev shell changed files are preserved as file mutation evidence", () => {
  const result = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 8,
      toolName: "dev.shell.run",
      toolInput: {
        command: "python3 edit.py",
        cwd: "/app",
      },
      toolOutput: {
        status: "COMPLETED",
        command: "python3 edit.py",
        cwd: "/app",
        workspaceRoot: "/app",
        exitCode: 0,
        changedFiles: ["input.tex"],
      },
    },
  });

  const ledger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const entry = ledger.at(-1) as Record<string, unknown>;
  const facts = entry.facts as Record<string, unknown>;
  const completion = buildEvidenceCompletionSummary({ ledger });

  assert.equal(entry.kind, "process_result");
  assert.deepEqual(facts.changedFiles, ["input.tex"]);
  assert.ok(completion.supportedTokens.includes("file:input.tex"));
});

test("policy corrections are recorded in the canonical ledger", () => {
  const result = applyReactStateEvent({
    reactState: {
      workItem: { phase: "gather_evidence", objective: "legacy state" },
    },
    event: {
      type: "policy_correction_observed",
      stepIndex: 3,
      reason: "artifact_not_verified",
      message: "goal_satisfied is invalid until required verification evidence is present.",
      facts: {
        toolName: "finalize",
      },
    },
  });

  assert.equal(result.reactState.workItem, undefined);
  assert.equal(result.reactState.workItemTransition, undefined);
  const ledger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  assert.equal(ledger.at(-1)?.kind, "policy_correction");
  assert.equal(result.transition.reason, "artifact_not_verified");
  assert.deepEqual(result.transition.blockedEvidenceIds, [ledger.at(-1)?.id]);
});

test("completion evidence summary derives tool, check, file, and verify support tokens", () => {
  const afterShell = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 1,
      toolName: "dev.shell.run",
      toolInput: { command: "pnpm lint && pnpm build" },
      toolOutput: {
        status: "COMPLETED",
        exitCode: 0,
        command: "pnpm lint && pnpm build",
      },
    },
  });
  const afterWrite = applyReactStateEvent({
    reactState: afterShell.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: 2,
      toolName: "fs.write_text",
      toolInput: { path: "newsletter-report.json", content: "{}" },
      toolOutput: { status: "ok", path: "newsletter-report.json" },
    },
  });
  const afterVerify = applyReactStateEvent({
    reactState: afterWrite.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: 3,
      toolName: "fs.verify_json",
      toolInput: { path: "newsletter-report.json" },
      toolOutput: {
        status: "ok",
        artifactVerification: {
          target: "newsletter-report.json::stories",
          status: "passed",
          requirements: [],
        },
      },
    },
  });

  const ledger = afterVerify.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const completion = buildEvidenceCompletionSummary({ ledger });
  assert.deepEqual(completion.supportedTokens, [
    "check:pnpm build",
    "check:pnpm lint",
    "file:newsletter-report.json",
    "tool:dev.shell.run",
    "tool:fs.verify_json",
    "tool:fs.write_text",
    "verify:newsletter-report.json::stories",
  ]);

  const context = buildEvidenceLedgerContext({ ledger: parseEvidenceLedger(ledger) });
  assert.equal(context.successSupport.length >= 3, true);
  assert.deepEqual(context.successBlockers, []);
});

test("later compact fs.verify_json pass clears an earlier artifact verification blocker", () => {
  const afterFailedVerify = applyReactStateEvent({
    reactState: {},
    event: {
      type: "tool_result_observed",
      stepIndex: 1,
      toolName: "fs.verify_json",
      toolInput: { path: "newsletter-report.json" },
      toolOutput: {
        path: "newsletter-report.json",
        target: "newsletter-report.json::stories",
        status: "failed",
        summary: "JSON artifact verification failed for 'newsletter-report.json::stories'.",
        artifactVerification: {
          target: "newsletter-report.json::stories",
          status: "failed",
          requirements: [{ id: "min_length", status: "failed" }],
          failures: ["Array length 0 is below required minimum 10."],
        },
      },
    },
  });
  const afterPassedVerify = applyReactStateEvent({
    reactState: afterFailedVerify.reactState,
    event: {
      type: "tool_result_observed",
      stepIndex: 2,
      toolName: "fs.verify_json",
      toolInput: { path: "newsletter-report.json" },
      toolOutput: {
        path: "newsletter-report.json",
        target: "newsletter-report.json::stories",
        status: "passed",
        summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
        truncated: true,
        artifactVerification: {
          target: "newsletter-report.json::stories",
          status: "passed",
          evidence: {
            kind: "tool_result",
            toolName: "fs.verify_json",
            summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
          },
          requirementsSummary: {
            total: 80,
            passed: 80,
            failed: 0,
            inconclusive: 0,
          },
        },
      },
    },
  });

  const ledger = afterPassedVerify.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const completion = buildEvidenceCompletionSummary({ ledger });
  const context = buildEvidenceLedgerContext({ ledger: parseEvidenceLedger(ledger) });

  assert.deepEqual(completion.blockedTokens, []);
  assert.equal(completion.supportedTokens.includes("verify:newsletter-report.json::stories"), true);
  assert.deepEqual(context.successBlockers, []);
  assert.equal(context.successSupport.some((entry) => entry.kind === "artifact_verification"), true);
});

test("later passed shell check clears an earlier artifact verification blocker", () => {
  const ledger = [
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
        normalizedValue: "newsletter page in workspace",
      },
      facts: {
        target: "newsletter page in workspace",
        status: "inconclusive",
        failures: ["No concrete file artifact is visible in the current workspace evidence."],
      },
    },
    {
      id: "ev_shell_check",
      version: "v1",
      createdAt: "2026-06-09T21:01:00.000Z",
      source: "tool",
      kind: "process_result",
      status: "passed",
      summary: "exists= True has_html= True has_newsletter= True has_three_items= True result= True",
      target: {
        type: "tool",
        value: "dev.shell.run",
        normalizedValue: "dev.shell.run",
      },
      facts: {
        toolName: "dev.shell.run",
        command: "python3 verify_newsletter.py",
      },
    },
  ];

  const completion = buildEvidenceCompletionSummary({ ledger });
  const context = buildEvidenceLedgerContext({ ledger: parseEvidenceLedger(ledger) });

  assert.deepEqual(completion.blockedTokens, []);
  assert.equal(completion.supportedTokens.includes("check:python3 verify_newsletter.py"), true);
  assert.equal(readLatestActiveArtifactVerificationFacts(ledger), undefined);
  assert.deepEqual(context.successBlockers, []);
});

test("later passed file read clears an earlier artifact verification blocker", () => {
  const ledger = [
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
        value: "itinerary page in workspace",
        normalizedValue: "itinerary page in workspace",
      },
      facts: {
        target: "itinerary page in workspace",
        status: "inconclusive",
        failures: ["No concrete file artifact is visible in the current workspace evidence."],
      },
    },
    {
      id: "ev_index_read",
      version: "v1",
      createdAt: "2026-06-09T21:01:00.000Z",
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
        outputPath: "index.html",
      },
    },
  ];

  const completion = buildEvidenceCompletionSummary({ ledger });
  const context = buildEvidenceLedgerContext({ ledger: parseEvidenceLedger(ledger) });

  assert.deepEqual(completion.blockedTokens, []);
  assert.equal(completion.supportedTokens.includes("file:index.html"), true);
  assert.equal(readLatestActiveArtifactVerificationFacts(ledger), undefined);
  assert.deepEqual(context.successBlockers, []);
});

test("successful tool result records evidence and transcript without progress attempts", () => {
  const result = applyReactStateEvent({
    reactState: {
      visibleTodos: {
        objective: "Build static newsletter artifacts.",
        items: [
          { id: "verify-json", text: "Verify newsletter JSON", status: "in_progress" },
        ],
      },
    },
    event: {
      type: "tool_result_observed",
      stepIndex: 1,
      toolName: "fs.verify_json",
      toolInput: { path: "newsletter-report.json", arrayPath: "stories", minLength: 3 },
      toolOutput: {
        status: "passed",
        path: "newsletter-report.json",
        target: "newsletter-report.json::stories",
        artifactVerification: {
          target: "newsletter-report.json::stories",
          status: "passed",
          requirements: [{ id: "min_length", status: "passed" }],
        },
      },
    },
  });

  const evidenceLedger = result.reactState.evidenceLedger as Array<Record<string, unknown>>;
  const modelTranscript = result.reactState.modelTranscript as Record<string, unknown>;
  assert.equal(evidenceLedger.length > 0, true);
  assert.deepEqual(result.reactState.visibleTodos, {
    objective: "Build static newsletter artifacts.",
    items: [
      { id: "verify-json", text: "Verify newsletter JSON", status: "in_progress" },
    ],
  });
  assert.equal(Array.isArray(modelTranscript.items), true);
});

test("tool result scrubs legacy progress fields instead of updating them", () => {
  const result = applyReactStateEvent({
    reactState: {
      executionLedger: [{ id: "legacy" }],
      workPlan: { id: "legacy" },
      progress: { id: "legacy" },
    },
    event: {
      type: "tool_result_observed",
      stepIndex: 1,
      toolName: "fs.list",
      toolInput: { path: "." },
      toolOutput: { status: "ok", entries: ["index.html"] },
    },
  });

  assert.equal(Object.hasOwn(result.reactState, "executionLedger"), false);
  assert.equal(Object.hasOwn(result.reactState, "workPlan"), false);
  assert.equal(Object.hasOwn(result.reactState, "progress"), false);
  assert.equal(Array.isArray(result.reactState.evidenceLedger), true);
});
