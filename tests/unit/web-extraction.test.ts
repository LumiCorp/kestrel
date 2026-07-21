import assert from "node:assert/strict";

import { updateWebExtractionRetrySummary } from "../../src/runtime/webExtraction.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "web extraction retry summary shares consecutive low-yield counts across get_url and scrape", () => {
  const first = updateWebExtractionRetrySummary({
    prior: undefined,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "low",
      truncated: true,
      contentIssues: ["truncated_content"],
    },
  });
  const second = updateWebExtractionRetrySummary({
    prior: first,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "low",
      selectorCoverage: "none",
      contentIssues: ["selector_unresolved"],
    },
  });

  assert.equal(second?.clusters.length, 1);
  assert.equal(second?.clusters[0]?.sourceCluster, "poemhunter.com/poem");
  assert.equal(second?.clusters[0]?.attempts, 2);
  assert.equal(second?.clusters[0]?.lowYieldAttempts, 2);
  assert.equal(second?.clusters[0]?.consecutiveLowYield, 2);
  assert.equal(second?.clusters[0]?.lastToolName, "internet.extract");
});

contractTest("runtime.hermetic", "unrelated internet.search does not consume the fallback for a low-yield source cluster", () => {
  const prior = {
    objectiveKey: "compare our poem to poems about evil trees on the web",
    searchFallbackUsed: false,
    clusters: [
      {
        key: "compare our poem to poems about evil trees on the web:poemhunter.com/poem",
        sourceCluster: "poemhunter.com/poem",
        attempts: 2,
        lowYieldAttempts: 2,
        consecutiveLowYield: 2,
        lastToolName: "internet.extract",
        lastQuality: "low",
        lastIssues: ["selector_unresolved"],
        searchFallbackUsed: false,
      },
    ],
  };

  const summary = updateWebExtractionRetrySummary({
    prior,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.search",
    output: {
      query: "other tree poems",
      results: [],
    },
  });

  assert.equal(summary?.searchFallbackUsed, false);
  assert.equal(summary?.clusters[0]?.searchFallbackUsed, false);
});

contractTest("runtime.hermetic", "forced fallback search marks only the targeted cluster as having used the final search", () => {
  const prior = {
    objectiveKey: "compare our poem to poems about evil trees on the web",
    searchFallbackUsed: false,
    clusters: [
      {
        key: "compare our poem to poems about evil trees on the web:poemhunter.com/poem",
        sourceCluster: "poemhunter.com/poem",
        attempts: 2,
        lowYieldAttempts: 2,
        consecutiveLowYield: 2,
        lastToolName: "internet.extract",
        lastQuality: "low",
        lastIssues: ["selector_unresolved"],
        searchFallbackUsed: false,
      },
      {
        key: "compare our poem to poems about evil trees on the web:example.com/archive",
        sourceCluster: "example.com/archive",
        attempts: 2,
        lowYieldAttempts: 2,
        consecutiveLowYield: 2,
        lastToolName: "internet.extract",
        lastQuality: "low",
        lastIssues: ["truncated_content"],
        searchFallbackUsed: false,
      },
    ],
  };

  const summary = updateWebExtractionRetrySummary({
    prior,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.search",
    action: {
      kind: "tool",
      name: "internet.search",
      input: {
        query: "compare our poem to poems about evil trees on the web",
        limit: 5,
      },
      policyContext: {
        webExtractionSourceCluster: "poemhunter.com/poem",
      },
    },
    output: {
      query: "compare our poem to poems about evil trees on the web",
      results: [],
    },
  });

  assert.equal(summary?.searchFallbackUsed, true);
  assert.equal(
    summary?.clusters.find((cluster) => cluster.sourceCluster === "poemhunter.com/poem")?.searchFallbackUsed,
    true,
  );
  assert.equal(
    summary?.clusters.find((cluster) => cluster.sourceCluster === "example.com/archive")?.searchFallbackUsed,
    false,
  );
});

contractTest("runtime.hermetic", "high-yield extraction resets the retry window and clears fallback usage for the cluster", () => {
  const prior = {
    objectiveKey: "compare our poem to poems about evil trees on the web",
    searchFallbackUsed: true,
    clusters: [
      {
        key: "compare our poem to poems about evil trees on the web:poemhunter.com/poem",
        sourceCluster: "poemhunter.com/poem",
        attempts: 3,
        lowYieldAttempts: 3,
        consecutiveLowYield: 3,
        lastToolName: "internet.extract",
        lastQuality: "low",
        lastIssues: ["selector_unresolved"],
        searchFallbackUsed: true,
      },
    ],
  };

  const summary = updateWebExtractionRetrySummary({
    prior,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "high",
      truncated: false,
      contentIssues: [],
    },
  });

  assert.equal(summary?.searchFallbackUsed, false);
  assert.equal(summary?.clusters[0]?.attempts, 4);
  assert.equal(summary?.clusters[0]?.lowYieldAttempts, 3);
  assert.equal(summary?.clusters[0]?.consecutiveLowYield, 0);
  assert.equal(summary?.clusters[0]?.searchFallbackUsed, false);
  assert.equal(summary?.clusters[0]?.lastToolName, "internet.extract");
  assert.equal(summary?.clusters[0]?.lastQuality, "high");
});

contractTest("runtime.hermetic", "a new low-yield streak becomes eligible for one final search after a successful reset", () => {
  const reset = updateWebExtractionRetrySummary({
    prior: {
      objectiveKey: "compare our poem to poems about evil trees on the web",
      searchFallbackUsed: true,
      clusters: [
        {
          key: "compare our poem to poems about evil trees on the web:poemhunter.com/poem",
          sourceCluster: "poemhunter.com/poem",
          attempts: 3,
          lowYieldAttempts: 3,
          consecutiveLowYield: 3,
          lastToolName: "internet.extract",
          lastQuality: "low",
          lastIssues: ["selector_unresolved"],
          searchFallbackUsed: true,
        },
      ],
    },
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "high",
      truncated: false,
      contentIssues: [],
    },
  });

  const firstLowYield = updateWebExtractionRetrySummary({
    prior: reset,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "low",
      selectorCoverage: "none",
      contentIssues: ["selector_unresolved"],
    },
  });
  const secondLowYield = updateWebExtractionRetrySummary({
    prior: firstLowYield,
    objective: "Compare our poem to poems about evil trees on the web",
    toolName: "internet.extract",
    output: {
      url: "https://www.poemhunter.com/poem/evil-tree/",
      quality: "low",
      truncated: true,
      contentIssues: ["truncated_content"],
    },
  });

  assert.equal(secondLowYield?.clusters[0]?.consecutiveLowYield, 2);
  assert.equal(secondLowYield?.clusters[0]?.searchFallbackUsed, false);
});
