import test from "node:test";
import assert from "node:assert/strict";

import MiniSearch from "minisearch";

import { buildSerializedSearchIndex } from "../lib/search";
import { SEARCH_FIELDS, SEARCH_STORE_FIELDS, searchWithIndex } from "../lib/search-utils";
import type { SearchDocument } from "../lib/types";


test("search represents every public journey without leaking internal metadata", async () => {
  const { initialResults, serializedIndex } = await buildSerializedSearchIndex();
  const index = MiniSearch.loadJSON<SearchDocument>(serializedIndex, {
    fields: [...SEARCH_FIELDS],
    storeFields: [...SEARCH_STORE_FIELDS],
  });

  assert.equal(initialResults.length, 8);
  assert.ok(initialResults.every((result) => !("fullText" in result)));

  const cases: Array<[string, string, string]> = [
    ["Start", "choose your first Kestrel journey", "/start/quickstart"],
    ["Concepts", "agent loop model proposal durable work", "/concepts/agent-loop"],
    ["Desktop", "provider setup", "/desktop/providers"],
    ["Kestrel One", "Threads Projects Knowledge", "/kestrel-one"],
    ["Build", "protocol terminal results", "/build/protocol-and-results"],
    ["Operate", "credential leases", "/operate/credential-leases"],
    ["Reference", "compatibility", "/reference/compatibility"],
  ];
  for (const [section, query, expected] of cases) {
    const matches = searchWithIndex(index, query);
    assert.ok(matches.some((result) => result.url === expected), `${section} missing for ${query}`);
  }

  const conceptCases: Array<[string, string]> = [
    ["signed URL fileId attachments", "/concepts/files-attachments"],
    ["context compaction history", "/concepts/context-management-compaction"],
    ["interaction modes autonomy", "/concepts/interaction-modes-autonomy"],
    ["background jobs noninteractive", "/concepts/background-jobs"],
    ["delegation child agents", "/concepts/delegation-child-agents"],
    ["task graph expectedVersion work state", "/concepts/task-graphs-work-state"],
    ["workspace checkpoints promotions", "/concepts/workspace-checkpoints-promotions"],
    ["MCP catalog refresh", "/concepts/apps-mcp-services"],
    ["idempotency duplicate command concurrency", "/concepts/concurrency-idempotency"],
    ["Next.js server identity", "/concepts/nextjs-routes"],
    ["AI SDK presentation accumulator", "/concepts/ai-sdk-presentation"],
    ["observability trace context", "/concepts/observability-trace-context"],
  ];
  for (const [query, expected] of conceptCases) {
    const matches = searchWithIndex(index, query);
    assert.ok(matches.some((result) => result.url === expected), `Concepts missing ${expected} for ${query}`);
  }

  const serializedPublicPayload = JSON.stringify({ initialResults, serializedIndex });
  assert.doesNotMatch(serializedPublicPayload, /Kestrel Studio|\/studio(?:["/]|$)/iu);
  assert.ok(!serializedPublicPayload.includes(["Scene", "Runner"].join("")));
  assert.doesNotMatch(serializedPublicPayload, /archive\/plans/iu);
  assert.doesNotMatch(serializedPublicPayload, /sourceKind|repo-inferred|archetype|experienceLevel|"internal"/u);
});
