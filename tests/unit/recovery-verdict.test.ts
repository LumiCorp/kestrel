import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecoveryAdaptationVerdict,
  isLowYieldSourceClusterStalled,
} from "../../src/runtime/recoveryVerdict.js";

test("buildRecoveryAdaptationVerdict classifies exhausted evidence recovery and low-yield extraction centrally", () => {
  const verdict = buildRecoveryAdaptationVerdict({
    evidenceRecovery: {
      objectiveKey: "weekly supplier audit summary",
      family: "news_research",
      attempts: 4,
      lowSignalAttempts: 3,
      consecutiveLowSignal: 3,
      broadenedSearchUsed: true,
      targetedFetchUsed: true,
      latest: {
        family: "news_research",
        toolName: "internet.search",
        quality: "low",
        lowSignal: true,
        issues: ["low_signal_mix"],
        resultsCount: 3,
        domainDiversity: 1,
        payloadFingerprint: "fp-1",
        repeatedFingerprintCount: 1,
        candidateUrls: ["https://example.com/audit"],
      },
    },
    webExtraction: {
      objectiveKey: "weekly supplier audit summary",
      searchFallbackUsed: true,
      clusters: [
        {
          key: "weekly supplier audit summary:example.com/news",
          sourceCluster: "example.com/news",
          attempts: 2,
          lowYieldAttempts: 2,
          consecutiveLowYield: 2,
          lastToolName: "internet.extract",
          lastQuality: "low",
          lastIssues: ["boilerplate_heavy"],
          lastUrl: "https://example.com/news/story",
          searchFallbackUsed: true,
        },
      ],
    },
    contextPressure: "high",
    thrashIndex: 0.4,
    outputStatus: "COMPLETED",
    lowProgressCycles: 3,
    researchToolActive: true,
  });

  assert.equal(verdict.lowSignalState, "exhausted");
  assert.equal(verdict.hasLowSignalResearchStall, true);
  assert.equal(verdict.recoveryExhausted, true);
  assert.equal(verdict.contextPressure.high, true);
  assert.equal(verdict.autoCompactEligible, true);
  assert.equal(verdict.lowYieldClusters.length, 1);
  assert.equal(verdict.researchStall.active, true);
});

test("isLowYieldSourceClusterStalled uses the shared low-yield threshold", () => {
  const summary = {
    objectiveKey: "vendor onboarding checklist",
    searchFallbackUsed: false,
    clusters: [
      {
        key: "vendor onboarding checklist:example.com/docs",
        sourceCluster: "example.com/docs",
        attempts: 2,
        lowYieldAttempts: 2,
        consecutiveLowYield: 2,
        lastToolName: "internet.extract",
        lastQuality: "low",
        lastIssues: ["empty_content"],
        lastUrl: "https://example.com/docs/page",
        searchFallbackUsed: false,
      },
      {
        key: "vendor onboarding checklist:other.example.com/help",
        sourceCluster: "other.example.com/help",
        attempts: 1,
        lowYieldAttempts: 1,
        consecutiveLowYield: 1,
        lastToolName: "internet.extract",
        lastQuality: "medium",
        lastIssues: ["truncated_content"],
        lastUrl: "https://other.example.com/help/page",
        searchFallbackUsed: false,
      },
    ],
  };

  assert.equal(isLowYieldSourceClusterStalled(summary, "example.com/docs"), true);
  assert.equal(isLowYieldSourceClusterStalled(summary, "other.example.com/help"), false);
});
