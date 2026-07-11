import assert from "node:assert/strict";
import test from "node:test";

import MiniSearch from "minisearch";

import { SEARCH_FIELDS, SEARCH_STORE_FIELDS, searchWithIndex } from "../lib/search-utils";
import { buildSerializedSearchIndex } from "../lib/search";
import type { SearchDocument } from "../lib/types";

test("full-text search finds pages by title and body content", async () => {
  const { initialResults, serializedIndex } = await buildSerializedSearchIndex();
  const index = MiniSearch.loadJSON<SearchDocument>(serializedIndex, {
    fields: [...SEARCH_FIELDS],
    storeFields: [...SEARCH_STORE_FIELDS],
  });

  assert.ok(initialResults.length > 0);
  assert.ok(!("fullText" in initialResults[0]), "initial search payload should not include full page text");
  assert.equal(initialResults.length, 8, "expected a concise curated default result set");
  assert.ok(initialResults.every((result) => result.sourceKind !== "archived"), "default results should exclude archive");
  assert.ok(initialResults.every((result) => result.pageKind !== "landing" && result.pageKind !== "home"), "default results should prefer substantive pages");
  assert.ok(
    initialResults.some((result) => result.url === "/docs/why-kestrel"),
    "expected current product narrative in default search results",
  );
  assert.ok(
    initialResults.some((result) => result.url === "/build/building-your-first-agent"),
    "expected canonical build tutorial in default search results",
  );
  assert.ok(
    initialResults.some((result) => result.url === "/build/openai-compatible-http"),
    "expected capability-heavy integration page in default search results",
  );
  assert.ok(
    initialResults.some((result) => result.url === "/cli/kchat"),
    "expected CLI operator cockpit page in default search results",
  );

  const firstAgentMatches = searchWithIndex(index, "Building your first agent");
  assert.equal(firstAgentMatches[0]?.url, "/build/building-your-first-agent");

  const demoMatches = searchWithIndex(index, "Workspace Copilot");
  assert.ok(demoMatches.some((result) => result.url === "/build/workspace-copilot-demo"));

  const workspaceMatches = searchWithIndex(index, "workspace catalog");
  assert.ok(workspaceMatches.some((result) => result.url === "/build/workspaces-and-automation"));

  const deployMatches = searchWithIndex(index, "runner service");
  assert.ok(
    deployMatches[0]?.url === "/deploy/running-the-runner-service" ||
      deployMatches[0]?.url === "/cli/runner-service",
  );

  const copilotRouteMatches = searchWithIndex(index, "/api/copilot/stream");
  assert.ok(copilotRouteMatches.some((result) => result.url === "/build/integrating-with-nextjs"));

  const cookbookMatches = searchWithIndex(index, "route cookbook");
  assert.ok(cookbookMatches.some((result) => result.url === "/build/nextjs-route-cookbook"));

  const openAiMatches = searchWithIndex(index, "OpenAI compatible");
  assert.equal(openAiMatches[0]?.url, "/build/openai-compatible-http");

  const compatRouteMatches = searchWithIndex(index, "/v1/chat/completions");
  assert.ok(compatRouteMatches.some((result) => result.url === "/build/openai-compatible-http"));

  const kcronMatches = searchWithIndex(index, "kcron");
  assert.ok(
    kcronMatches.some((result) => result.url === "/build/automating-common-tasks" || result.url === "/cli/kcron"),
  );

  const memoryMatches = searchWithIndex(index, "session memory");
  assert.ok(
    memoryMatches.some((result) => result.url === "/build/adding-session-memory" || result.url === "/packages/sdk"),
  );

  const replayMatches = searchWithIndex(index, "replay");
  assert.ok(
    replayMatches.some((result) => result.url === "/runtime/store-and-replay" || result.url === "/operations/evaluations"),
  );

  const runtimeMatches = searchWithIndex(index, "runtime");
  assert.ok(
    runtimeMatches[0]?.url === "/docs/runtime-model" || runtimeMatches[0]?.url === "/runtime/store-and-replay",
  );

  const nextjsMatches = searchWithIndex(index, "nextjs");
  assert.ok(
    nextjsMatches[0]?.url === "/build/integrating-with-nextjs" || nextjsMatches[0]?.url === "/packages/next",
  );

  const operatorMatches = searchWithIndex(index, "operator control");
  assert.ok(
    operatorMatches.some(
      (result) => result.url === "/operations/operator-control-workflows" || result.url === "/packages/sdk",
    ),
  );

  const reviewMatches = searchWithIndex(index, "project review");
  assert.equal(reviewMatches[0]?.url, "/operations/review-and-state-workflows");
  assert.ok(
    reviewMatches.some(
      (result) => result.url === "/operations/review-and-state-workflows" || result.url === "/apps/web",
    ),
  );

  const taskGraphMatches = searchWithIndex(index, "task graph");
  assert.ok(
    taskGraphMatches.some(
      (result) =>
        result.url === "/packages/sdk" ||
        result.url === "/apps/web" ||
        result.url === "/operations/review-and-state-workflows",
    ),
  );

  const snapshotMatches = searchWithIndex(index, "project.snapshot");
  assert.ok(
    snapshotMatches.some(
      (result) =>
        result.url === "/packages/sdk" ||
        result.url === "/apps/web" ||
        result.url === "/operations/review-and-state-workflows",
    ),
  );

  const evaluationMatches = searchWithIndex(index, "Ruhroh evaluations");
  assert.ok(evaluationMatches.some((result) => result.url === "/operations/evaluations"));

  const modelsMatches = searchWithIndex(index, "v1 models");
  assert.equal(modelsMatches[0]?.url, "/build/openai-compatible-http");

  const responsesMatches = searchWithIndex(index, "v1 responses");
  assert.equal(responsesMatches[0]?.url, "/build/openai-compatible-http");

  const codeModeMatches = searchWithIndex(index, "codeMode");
  assert.ok(codeModeMatches.some((result) => result.url === "/cli/profiles-code-mode-and-mcp"));

  const mcpServerMatches = searchWithIndex(index, "mcpServers");
  assert.ok(mcpServerMatches.some((result) => result.url === "/cli/profiles-code-mode-and-mcp"));

  const allowlistMatches = searchWithIndex(index, "toolAllowlist");
  assert.ok(allowlistMatches.some((result) => result.url === "/cli/profiles-code-mode-and-mcp"));

  const artifactMatches = searchWithIndex(index, "nightly-review.md");
  assert.ok(
    artifactMatches.some((result) => result.url === "/build/workspace-copilot-demo" || result.url === "/operations/artifact-inspection"),
  );

  const artifactInspectionMatches = searchWithIndex(index, "artifact inspection");
  assert.equal(artifactInspectionMatches[0]?.url, "/operations/artifact-inspection");

  const cliMatches = searchWithIndex(index, "CLI terminal");
  assert.equal(cliMatches[0]?.url, "/cli/kchat");

  const ownershipMatches = searchWithIndex(index, "ownership ledger");
  assert.ok(ownershipMatches.some((result) => result.url === "/operations/evaluations"));

  const workspaceAutomationMatches = searchWithIndex(index, "workspace automation");
  assert.ok(
    workspaceAutomationMatches[0]?.url === "/build/workspaces-and-automation" ||
      workspaceAutomationMatches[0]?.url === "/build/automating-common-tasks",
  );
});
