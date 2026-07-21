import assert from "node:assert/strict";

import {
  buildToolOutputDigestForTests,
  compactInternetToolOutputForTests,
  shapeToolExecutionResultForTests,
} from "../../agents/reference-react/src/steps/acter.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "compactInternetToolOutputForTests condenses internet.news results into agent-loop-friendly highlights", () => {
  const compact = compactInternetToolOutputForTests("internet.news", {
    status: "ok",
    provider: "tavily",
    attempts: 1,
    query: "news headlines for Cincinnati",
    results: [
      {
        title: "Cincinnati budget proposal advances",
        url: "https://example.com/budget",
        source: "example.com",
        publishedAt: "2026-03-13T01:00:00Z",
        snippet:
          "City council advanced a new budget proposal after a lengthy debate over policing, parks, and neighborhood services.",
      },
      {
        title: "Transit expansion debated downtown",
        url: "https://example.com/transit",
        source: "example.com",
        publishedAt: "2026-03-13T02:00:00Z",
        snippet:
          "Regional transit leaders and business groups debated a proposed downtown expansion and its funding strategy.",
      },
    ],
  });

  assert.deepEqual(compact, {
    status: "ok",
    attempts: 1,
    provider: "tavily",
    query: "news headlines for Cincinnati",
    resultCount: 2,
    highlights: [
      {
        title: "Cincinnati budget proposal advances",
        url: "https://example.com/budget",
        source: "example.com",
        publishedAt: "2026-03-13T01:00:00Z",
        snippet:
          "City council advanced a new budget proposal after a lengthy debate over policing, parks, and neighborhood services.",
      },
      {
        title: "Transit expansion debated downtown",
        url: "https://example.com/transit",
        source: "example.com",
        publishedAt: "2026-03-13T02:00:00Z",
        snippet:
          "Regional transit leaders and business groups debated a proposed downtown expansion and its funding strategy.",
      },
    ],
  });
});

contractTest("runtime.hermetic", "compactInternetToolOutputForTests condenses fetched page content to a preview", () => {
  const compact = compactInternetToolOutputForTests("internet.extract", {
    status: "ok",
    provider: "tavily",
    attempts: 1,
    url: "https://example.com/page",
    title: "Example page",
    content: "A".repeat(600),
    charCount: 600,
  });

  assert.equal(compact?.url, "https://example.com/page");
  assert.equal(compact?.title, "Example page");
  assert.equal(compact?.charCount, 600);
  assert.equal(typeof compact?.contentPreview, "string");
  assert.equal((compact?.contentPreview as string).length <= 1600, true);
});

contractTest("runtime.hermetic", "shapeToolExecutionResultForTests sanitizes malformed unicode in stored previews and artifacts", () => {
  const shaped = shapeToolExecutionResultForTests({
    runId: "run-1",
    stepIndex: 4,
    toolName: "tool.test",
    output: {
      text: "\ud800hello" + "a".repeat(9000),
    },
  });

  assert.equal((shaped.storedOutput as { truncated?: boolean }).truncated, true);
  assert.match((shaped.storedOutput as { summary: string }).summary, /\uFFFDhello/u);
  assert.match((shaped.verificationOutput as { summary: string }).summary, /\uFFFDhello/u);
  assert.equal(
    (((shaped.artifacts[0]?.payload ?? {}) as { output?: { text?: string } }).output?.text ?? "").startsWith("\uFFFDhello"),
    true,
  );
});

contractTest("runtime.hermetic", "buildToolOutputDigestForTests is deterministic and bounded for generic JSON outputs", () => {
  const output = {
    b: "second",
    a: {
      text: "x".repeat(600),
      values: [1, 2, 3, 4, 5],
    },
    c: true,
  };

  const first = buildToolOutputDigestForTests("tool.test", output);
  const second = buildToolOutputDigestForTests("tool.test", output);

  assert.deepEqual(first, second);
  assert.equal(Array.isArray((first as { topLevelKeys?: unknown }).topLevelKeys), true);
  assert.equal(((first as { topLevelKeys?: unknown[] }).topLevelKeys ?? []).length <= 20, true);
  assert.equal(((first as { scalarFacts?: unknown[] }).scalarFacts ?? []).length <= 40, true);
  assert.equal(((first as { arrayStats?: unknown[] }).arrayStats ?? []).length <= 20, true);
  assert.equal(typeof (first as { textPreview?: unknown }).textPreview, "string");
});

contractTest("runtime.hermetic", "buildToolOutputDigestForTests applies tool adapter for code.execute outputs", () => {
  const digest = buildToolOutputDigestForTests("code.execute", {
    status: "ok",
    summary: "Execution completed successfully.",
    exitCode: 0,
    durationMs: 120,
    stdout: "hello world",
    artifacts: [
      {
        path: "out/report.txt",
      },
    ],
  });

  const adapter = (digest as { adapter?: Record<string, unknown> }).adapter;
  assert.equal(adapter?.adapterName, "code.execute");
  assert.equal(adapter?.status, "ok");
  assert.equal(adapter?.artifactCount, 1);
});

contractTest("runtime.hermetic", "shapeToolExecutionResultForTests persists digest artifact and digest pointers for large outputs", () => {
  const shaped = shapeToolExecutionResultForTests({
    runId: "run-2",
    stepIndex: 7,
    toolName: "internet.search",
    output: {
      query: "latest US news",
      results: Array.from({ length: 30 }, (_, index) => ({
        title: `Title ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        snippet: "x".repeat(400),
      })),
    },
  });

  const stored = shaped.storedOutput as Record<string, unknown>;
  assert.equal(stored.truncated, true);
  assert.equal(Array.isArray(stored.artifactIds), true);
  assert.equal(typeof stored.digestArtifactId, "string");
  assert.equal(typeof stored.digestSummary, "object");
  assert.equal(shaped.artifacts.some((artifact) => artifact.type === "tool-output"), true);
  assert.equal(shaped.artifacts.some((artifact) => artifact.type === "tool-output-digest"), true);
});

contractTest("runtime.hermetic", "shapeToolExecutionResultForTests keeps compact fs.verify_json artifact facts for large outputs", () => {
  const requirements = Array.from({ length: 80 }, (_, index) => ({
    id: `field_${index}`,
    status: "passed",
    observed: `story ${index} contains the required field ${"x".repeat(80)}`,
    expectation: `field ${index} is present ${"y".repeat(80)}`,
  }));
  const shaped = shapeToolExecutionResultForTests({
    runId: "run-verify",
    stepIndex: 31,
    toolName: "fs.verify_json",
    output: {
      path: "newsletter-report.json",
      target: "newsletter-report.json::stories",
      status: "passed",
      verificationToken: "verify:newsletter-report.json::stories",
      summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
      artifactVerification: {
        target: "newsletter-report.json::stories",
        status: "passed",
        evidence: {
          kind: "tool_result",
          toolName: "fs.verify_json",
          truncated: false,
          summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
        },
        requirements,
      },
    },
  });

  const verificationOutput = shaped.verificationOutput as Record<string, unknown>;
  const artifactVerification = verificationOutput.artifactVerification as Record<string, unknown>;
  const requirementsSummary = artifactVerification.requirementsSummary as Record<string, unknown>;

  assert.equal(verificationOutput.truncated, true);
  assert.equal(verificationOutput.status, "passed");
  assert.equal(verificationOutput.target, "newsletter-report.json::stories");
  assert.equal(verificationOutput.verificationToken, "verify:newsletter-report.json::stories");
  assert.equal(artifactVerification.status, "passed");
  assert.equal(artifactVerification.target, "newsletter-report.json::stories");
  assert.equal(requirementsSummary.total, 80);
  assert.equal(requirementsSummary.passed, 80);
  assert.equal(requirementsSummary.failed, 0);
  assert.equal(Array.isArray(artifactVerification.requirements), false);
  assert.equal(shaped.artifacts.some((artifact) => artifact.type === "tool-output"), true);
});
