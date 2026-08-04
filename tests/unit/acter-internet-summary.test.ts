import test from "node:test";
import assert from "node:assert/strict";

import {
  buildToolOutputDigestForTests,
  compactInternetToolOutputForTests,
  shapeToolExecutionResultForTests,
} from "../../agents/reference-react/src/steps/acter.js";
import {
  buildAgentToolSuccessResult,
  replaceAgentToolResultOutput,
} from "../../tools/toolResult.js";


test("compactInternetToolOutputForTests condenses internet.news results into agent-loop-friendly highlights", () => {
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

test("compactInternetToolOutputForTests condenses fetched page content to a preview", () => {
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

test("shapeToolExecutionResultForTests sanitizes malformed unicode in stored previews and artifacts", () => {
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
  assert.match((shaped.verificationOutput as { text: string }).text, /\uFFFDhello/u);
  assert.equal((shaped.verificationOutput as { text: string }).text.length > 9000, true);
  assert.equal(
    (((shaped.artifacts[0]?.payload ?? {}) as { output?: { text?: string } }).output?.text ?? "").startsWith("\uFFFDhello"),
    true,
  );
});

test("buildToolOutputDigestForTests is deterministic and bounded for generic JSON outputs", () => {
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

test("buildToolOutputDigestForTests applies tool adapter for code.execute outputs", () => {
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

test("shapeToolExecutionResultForTests persists digest artifact and digest pointers for large outputs", () => {
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

test("shapeToolExecutionResultForTests keeps full verification facts and compact persisted facts", () => {
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
  const storedOutput = shaped.storedOutput as Record<string, unknown>;
  const storedVerification = storedOutput.artifactVerification as Record<string, unknown>;
  const requirementsSummary = storedVerification.requirementsSummary as Record<string, unknown>;

  assert.equal(verificationOutput.status, "passed");
  assert.equal(verificationOutput.target, "newsletter-report.json::stories");
  assert.equal(verificationOutput.verificationToken, "verify:newsletter-report.json::stories");
  assert.equal(artifactVerification.status, "passed");
  assert.equal(artifactVerification.target, "newsletter-report.json::stories");
  assert.equal(Array.isArray(artifactVerification.requirements), true);
  assert.equal((artifactVerification.requirements as unknown[]).length, 80);
  assert.equal(storedOutput.truncated, true);
  assert.equal(Array.isArray(storedVerification.requirements), false);
  assert.equal(requirementsSummary.total, 80);
  assert.equal(requirementsSummary.passed, 80);
  assert.equal(shaped.artifacts.some((artifact) => artifact.type === "tool-output"), true);
});

test("oversized repo.trace results keep exact returned paths in model-visible context", () => {
  const output = {
    path: ".",
    seeds: ["like", "likeCount", "toggleLike"],
    searchedFileCount: 80,
    matchedFileCount: 24,
    resultCount: 48,
    truncated: true,
    groups: Array.from({ length: 24 }, (_, index) => ({
      path: index === 0
        ? "src/app/components/LikeButton.tsx"
        : `src/generated/like-result-${index}.tsx`,
      matches: [
        {
          seed: "like",
          line: index + 1,
          column: 3,
          preview: `const likeResult${index} = ${JSON.stringify("x".repeat(320))};`,
          contextBefore: ["before".repeat(30)],
          contextAfter: ["after".repeat(30)],
        },
      ],
    })),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(output), "utf8") > 8 * 1024, true);

  const shaped = shapeToolExecutionResultForTests({
    runId: "run-repo-trace",
    stepIndex: 3,
    toolName: "repo.trace",
    output,
  });
  const projected = replaceAgentToolResultOutput(
    buildAgentToolSuccessResult({
      toolName: "repo.trace",
      input: { path: ".", seeds: output.seeds },
      output,
    }),
    shaped.storedOutput,
  );

  assert.equal((shaped.storedOutput as Record<string, unknown>).truncated, true);
  assert.match(projected.modelContext.text, /src\/app\/components\/LikeButton\.tsx/u);
  assert.match(projected.modelContext.text, /matchedFileCount: 24/u);
  assert.equal(
    ((shaped.verificationOutput as { groups: unknown[] }).groups).length,
    24,
  );
});

test("oversized fs.search_text results keep exact returned paths in model-visible context", () => {
  const output = {
    path: ".",
    query: "like",
    matchCount: 40,
    returnedMatchCount: 40,
    truncated: true,
    previewTruncatedCount: 0,
    totalPreviewChars: 12_000,
    matches: Array.from({ length: 40 }, (_, index) => ({
      path: index === 0
        ? "src/app/actions/posts.ts"
        : `src/generated/search-result-${index}.ts`,
      line: index + 1,
      column: 1,
      preview: `const likeResult${index} = ${JSON.stringify("y".repeat(300))};`,
    })),
  };
  assert.equal(Buffer.byteLength(JSON.stringify(output), "utf8") > 8 * 1024, true);

  const shaped = shapeToolExecutionResultForTests({
    runId: "run-search-text",
    stepIndex: 5,
    toolName: "fs.search_text",
    output,
  });
  const projected = replaceAgentToolResultOutput(
    buildAgentToolSuccessResult({
      toolName: "fs.search_text",
      input: { path: ".", query: "like" },
      output,
    }),
    shaped.storedOutput,
  );

  assert.equal((shaped.storedOutput as Record<string, unknown>).truncated, true);
  assert.match(projected.modelContext.text, /src\/app\/actions\/posts\.ts/u);
  assert.match(projected.modelContext.text, /matchCount: 40/u);
  assert.equal(
    ((shaped.verificationOutput as { matches: unknown[] }).matches).length,
    40,
  );
});
