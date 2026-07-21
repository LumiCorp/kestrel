import assert from "node:assert/strict";

import {
  normalizeEvidenceRecoverySummary,
  updateEvidenceRecoverySummary,
} from "../../src/runtime/evidenceQuality.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "updateEvidenceRecoverySummary marks repeated low-signal headlines payloads", () => {
  const first = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Build a nightly news opening monologue",
    toolName: "internet.search_advanced",
    output: {
      query: "top us news headlines today",
      region: "us",
      results: [
        {
          title: "Editorial Roundup: United States",
          url: "https://washingtonpost.example.com/editorial-roundup",
          source: "Washington Post",
        },
        {
          title: "Powerful storm system slams Midwest as East Coast braces for impact",
          url: "https://nbc.example.com/story-1",
          source: "NBC News",
        },
        {
          title: "Headlines from latest remarks on the Iran war",
          url: "https://ap.example.com/story-2",
          source: "AP",
        },
      ],
    },
  });
  const second = updateEvidenceRecoverySummary({
    prior: first,
    objective: "Build a nightly news opening monologue",
    toolName: "internet.search_advanced",
    output: {
      query: "top us news headlines today",
      region: "us",
      results: [
        {
          title: "Editorial Roundup: United States",
          url: "https://washingtonpost.example.com/editorial-roundup",
          source: "Washington Post",
        },
        {
          title: "Powerful storm system slams Midwest as East Coast braces for impact",
          url: "https://nbc.example.com/story-1",
          source: "NBC News",
        },
        {
          title: "Headlines from latest remarks on the Iran war",
          url: "https://ap.example.com/story-2",
          source: "AP",
        },
      ],
    },
  });

  assert.equal(first?.latest?.lowSignal, true);
  assert.equal(second?.latest?.issues.includes("repeated_payload"), true);
  assert.equal(second?.consecutiveLowSignal, 2);
});

contractTest("runtime.hermetic", "high-yield article fetch batch resets evidence recovery state", () => {
  const prior = normalizeEvidenceRecoverySummary({
    objectiveKey: "build a nightly news opening monologue",
    family: "news_research",
    attempts: 2,
    lowSignalAttempts: 2,
    consecutiveLowSignal: 2,
    broadenedSearchUsed: true,
    targetedFetchUsed: false,
    latest: {
      family: "news_research",
      toolName: "internet.news",
      quality: "low",
      lowSignal: true,
      issues: ["low_signal_mix"],
      resultsCount: 8,
      domainDiversity: 3,
      payloadFingerprint: "fp-1",
      repeatedFingerprintCount: 1,
      candidateUrls: [
        "https://nbc.example.com/story-1",
      ],
    },
  });

  const updated = updateEvidenceRecoverySummary({
    prior,
    objective: "Build a nightly news opening monologue",
    output: {
      kind: "tool_batch",
      recoveryStage: "target_article_fetch",
      items: [
        {
          name: "internet.extract",
          output: {
            url: "https://nbc.example.com/story-1",
            quality: "high",
            truncated: false,
            contentIssues: [],
          },
        },
      ],
    },
    action: {
      kind: "tool_batch",
    },
  });

  assert.equal(updated?.consecutiveLowSignal, 0);
  assert.equal(updated?.lowSignalAttempts, 0);
  assert.equal(updated?.broadenedSearchUsed, false);
  assert.equal(updated?.targetedFetchUsed, false);
});

contractTest("runtime.hermetic", "low signal mix stays until cleaned article fetch restores throughput", () => {
  const first = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Explain today's US news summary",
    toolName: "internet.news",
    output: {
      query: "top us news headlines today",
      region: "us",
      results: [
        {
          title: "Editorial Roundup: US Politics",
          url: "https://site.example.com/politics",
          source: "Example",
        },
        {
          title: "Editorial Roundup: Business Brief",
          url: "https://site.example.com/business",
          source: "Example",
        },
        {
          title: "Video: Behind the Headlines",
          url: "https://site.example.com/video",
          source: "Example",
        },
        {
          title: "Latest newsletter: Morning Brief",
          url: "https://site.example.com/newsletter",
          source: "Example",
        },
      ],
    },
  });

  assert.equal(first?.latest?.issues.includes("low_signal_mix"), true);
  assert.equal(first?.consecutiveLowSignal, 1);

  const recovered = updateEvidenceRecoverySummary({
    prior: first,
    objective: "Explain today's US news summary",
    output: {
      kind: "tool_batch",
      recoveryStage: "target_article_fetch",
      items: [
        {
          name: "internet.extract",
          output: {
            url: "https://site.example.com/clean-article",
            quality: "high",
            truncated: false,
            contentIssues: [],
          },
        },
      ],
    },
    action: {
      kind: "tool_batch",
    },
  });

  assert.equal(recovered?.lowSignalAttempts, 0);
  assert.equal(recovered?.consecutiveLowSignal, 0);
});

contractTest("runtime.hermetic", "runtime-owned recoveryStage marks broadened search after prior low-signal attempts", () => {
  const prior = normalizeEvidenceRecoverySummary({
    objectiveKey: "cults and high-control religious groups in cincinnati",
    family: "news_research",
    attempts: 1,
    lowSignalAttempts: 1,
    consecutiveLowSignal: 1,
    broadenedSearchUsed: false,
    targetedFetchUsed: false,
    latest: {
      family: "news_research",
      toolName: "internet.search",
      quality: "low",
      lowSignal: true,
      issues: ["low_domain_diversity"],
      resultsCount: 3,
      domainDiversity: 1,
      payloadFingerprint: "fp-search",
      repeatedFingerprintCount: 1,
      candidateUrls: ["https://example.com/article"],
    },
  });

  const updated = updateEvidenceRecoverySummary({
    prior,
    objective: "Cults and high-control religious groups in Cincinnati",
    toolName: "internet.search",
    output: {
      query: "Cincinnati Ohio church former members spiritual abuse",
      results: [
        {
          title: "Example result",
          url: "https://example.com/article-2",
          source: "Example",
        },
      ],
      recoveryStage: "broaden_search",
    },
  });

  assert.equal(updated?.broadenedSearchUsed, true);
  assert.equal(updated?.targetedFetchUsed, false);
});

contractTest("runtime.hermetic", "evidence recovery treats low-value URL patterns as low signal", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Create a U.S. business headlines brief",
    toolName: "internet.news",
    output: {
      query: "latest U.S. business headlines today",
      results: [
        {
          title: "Reuters sitemap",
          url: "https://www.reuters.com/arc/outboundfeeds/sitemap-index.xml",
          source: "Reuters",
        },
        {
          title: "Markets video",
          url: "https://www.cnbc.com/video/2026/03/19/closing-bell.html",
          source: "CNBC",
        },
        {
          title: "Fed policy in focus",
          url: "https://apnews.com/article/fed-policy-focus-2026-03-19",
          source: "AP",
        },
      ],
    },
  });

  assert.equal(updated?.latest?.issues.includes("low_signal_mix"), true);
  assert.deepEqual(updated?.latest?.candidateUrls, [
    "https://apnews.com/article/fed-policy-focus-2026-03-19",
  ]);
});

contractTest("runtime.hermetic", "explicit source constraints relax low-domain-diversity penalties for news search", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Create a Reuters-first U.S. business headlines brief",
    toolName: "internet.search_advanced",
    output: {
      query: "latest U.S. business headlines today",
      results: [
        {
          title: "Markets rally on jobs data",
          url: "https://www.reuters.com/world/us/markets-rally-jobs-data-2026-03-19/",
          source: "Reuters",
        },
        {
          title: "Fed policy in focus",
          url: "https://www.reuters.com/world/us/fed-policy-focus-2026-03-19/",
          source: "Reuters",
        },
        {
          title: "Earnings lift industrials",
          url: "https://www.reuters.com/world/us/earnings-lift-industrials-2026-03-19/",
          source: "Reuters",
        },
      ],
    },
    action: {
      kind: "tool",
      name: "internet.search_advanced",
      input: {
        query: "latest U.S. business headlines today",
        domainAllow: ["reuters.com"],
      },
    },
  });

  assert.equal(updated?.latest?.issues.includes("low_domain_diversity"), false);
  assert.equal(updated?.latest?.quality, "low");
  assert.equal(updated?.latest?.issues.includes("insufficient_results"), true);
});

contractTest("runtime.hermetic", "same-domain news search without explicit source constraint still flags low-domain-diversity", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Create a U.S. business headlines brief",
    toolName: "internet.news",
    output: {
      query: "latest U.S. business headlines today",
      results: [
        {
          title: "Markets rally on jobs data",
          url: "https://www.reuters.com/world/us/markets-rally-jobs-data-2026-03-19/",
          source: "Reuters",
        },
        {
          title: "Fed policy in focus",
          url: "https://www.reuters.com/world/us/fed-policy-focus-2026-03-19/",
          source: "Reuters",
        },
        {
          title: "Earnings lift industrials",
          url: "https://www.reuters.com/world/us/earnings-lift-industrials-2026-03-19/",
          source: "Reuters",
        },
      ],
    },
  });

  assert.equal(updated?.latest?.issues.includes("low_domain_diversity"), true);
});

contractTest("runtime.hermetic", "duplicate executed search results increment duplicate counters in evidence recovery", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Track supplier onboarding controls coverage",
    toolName: "internet.search",
    output: {
      results: [
        {
          title: "Supplier controls overview",
          url: "https://example.com/controls",
          source: "Example",
        },
      ],
      duplicateResult: {
        kind: "duplicate_executed_result",
        family: "web_search_results",
        toolName: "internet.search",
        fingerprint: "fp-dup-search",
        duplicateCount: 2,
        matchedPriorStep: 3,
        canonicalSource: "example.com",
        canonicalUrl: "https://example.com/controls",
      },
    },
  });

  assert.equal(updated?.duplicateEvents, 1);
  assert.equal(updated?.latestDuplicate?.kind, "duplicate_executed_result");
  assert.equal(updated?.latestDuplicate?.duplicateCount, 2);
  assert.equal(updated?.latest?.issues.includes("repeated_payload"), true);
});

contractTest("runtime.hermetic", "duplicate page fetch marks low-signal recovery and preserves duplicate verdict", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Track supplier onboarding controls coverage",
    toolName: "internet.extract",
    output: {
      url: "https://example.com/report",
      content: "Evidence report body",
      duplicateResult: {
        kind: "duplicate_executed_result",
        family: "web_page_content",
        toolName: "internet.extract",
        fingerprint: "fp-dup-page",
        duplicateCount: 3,
        matchedPriorStep: 4,
        canonicalSource: "example.com/report",
        canonicalUrl: "https://example.com/report",
      },
    },
  });

  assert.equal(updated?.lowSignalAttempts, 1);
  assert.equal(updated?.consecutiveLowSignal, 1);
  assert.equal(updated?.latest?.toolName, "internet.extract");
  assert.deepEqual(updated?.latest?.issues, ["repeated_payload"]);
  assert.equal(updated?.latestDuplicate?.duplicateCount, 3);
});

contractTest("runtime.hermetic", "normalizeEvidenceRecoverySummary maps legacy news_research to canonical web_research", () => {
  const normalized = normalizeEvidenceRecoverySummary({
    objectiveKey: "legacy recovery summary",
    family: "news_research",
    attempts: 1,
    lowSignalAttempts: 1,
    consecutiveLowSignal: 1,
    broadenedSearchUsed: false,
    targetedFetchUsed: false,
    duplicateEvents: 0,
  });

  assert.equal(normalized?.family, "web_research");
});

contractTest("runtime.hermetic", "updateEvidenceRecoverySummary writes canonical filesystem retrieval family and inspection counters", () => {
  const listed = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Keep working on the website",
    toolName: "fs.list",
    output: {
      path: ".",
      entries: [
        { path: "app", kind: "directory" },
        { path: "app/page.tsx", kind: "file" },
      ],
    },
  });
  const read = updateEvidenceRecoverySummary({
    prior: listed,
    objective: "Keep working on the website",
    toolName: "fs.read_text",
    output: {
      path: "app/page.tsx",
      content: "export default function Page() { return <main />; }\n",
    },
    action: {
      kind: "tool",
      input: {
        path: "app/page.tsx",
      },
    },
  });

  assert.equal(listed?.family, "filesystem_retrieval");
  assert.equal(listed?.filesystemInspection?.inventoryActions, 1);
  assert.deepEqual(listed?.filesystemInspection?.inventoryPaths, [".", "app", "app/page.tsx"]);
  assert.equal(read?.family, "filesystem_retrieval");
  assert.equal(read?.filesystemInspection?.groundedReadActions, 1);
  assert.equal(read?.filesystemInspection?.budgetExhausted, false);
});

contractTest("runtime.hermetic", "updateEvidenceRecoverySummary counts explicit fs.read_text paths without prior inventory", () => {
  const read = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Keep working on the website",
    toolName: "fs.read_text",
    output: {
      path: "app/page.tsx",
      content: "export default function Page() { return <main />; }\n",
    },
    action: {
      kind: "tool",
      input: {
        path: "app/page.tsx",
      },
    },
  });

  assert.equal(read?.family, "filesystem_retrieval");
  assert.equal(read?.filesystemInspection?.inventoryActions, 0);
  assert.equal(read?.filesystemInspection?.groundedReadActions, 1);
  assert.equal(read?.filesystemInspection?.budgetExhausted, false);
});

contractTest("runtime.hermetic", "updateEvidenceRecoverySummary resets filesystem inspection budget after explicit fs mutation", () => {
  const exhausted = updateEvidenceRecoverySummary({
    prior: {
      objectiveKey: "keep working on the website",
      family: "filesystem_retrieval",
      attempts: 6,
      lowSignalAttempts: 0,
      consecutiveLowSignal: 0,
      broadenedSearchUsed: false,
      targetedFetchUsed: false,
      duplicateEvents: 0,
      filesystemInspection: {
        inventoryActions: 1,
        groundedReadActions: 4,
        budgetExhausted: true,
        inventoryPaths: [".", "src", "src/App.jsx"],
      },
    },
    objective: "Keep working on the website",
    toolName: "fs.write_text",
    output: {
      path: "src/App.jsx",
    },
    action: {
      kind: "tool",
      input: {
        path: "src/App.jsx",
        content: "updated",
      },
    },
  });
  const relisted = updateEvidenceRecoverySummary({
    prior: exhausted,
    objective: "Keep working on the website",
    toolName: "fs.list",
    output: {
      path: "src",
      entries: [
        { path: "src/App.jsx", kind: "file" },
      ],
    },
  });

  assert.equal(exhausted?.family, "filesystem_retrieval");
  assert.equal(exhausted?.filesystemInspection, undefined);
  assert.equal(exhausted?.attempts, 6);
  assert.equal(relisted?.filesystemInspection?.inventoryActions, 1);
  assert.equal(relisted?.filesystemInspection?.groundedReadActions, 0);
  assert.equal(relisted?.filesystemInspection?.budgetExhausted, false);
});

contractTest("runtime.hermetic", "updateEvidenceRecoverySummary writes canonical web_research family for internet recovery", () => {
  const updated = updateEvidenceRecoverySummary({
    prior: undefined,
    objective: "Build a nightly news opening monologue",
    toolName: "internet.news",
    output: {
      query: "top us news headlines today",
      results: [
        {
          title: "Example story",
          url: "https://one.example.com/story",
          source: "Example One",
        },
        {
          title: "Second story",
          url: "https://two.example.com/story",
          source: "Example Two",
        },
        {
          title: "Third story",
          url: "https://three.example.com/story",
          source: "Example Three",
        },
        {
          title: "Fourth story",
          url: "https://four.example.com/story",
          source: "Example Four",
        },
        {
          title: "Fifth story",
          url: "https://five.example.com/story",
          source: "Example Five",
        },
      ],
    },
  });

  assert.equal(updated?.family, "web_research");
  assert.equal(updated?.latest?.family, "web_research");
});

contractTest("runtime.hermetic", "updateEvidenceRecoverySummary accumulates retained sources and records latest-turn novelty without contract parsing", () => {
  const objective = "Research the top current U.S. business and technology stories for a newsletter report.";

  const first = updateEvidenceRecoverySummary({
    prior: undefined,
    objective,
    toolName: "internet.news",
    output: {
      query: "top us business technology stories",
      results: Array.from({ length: 6 }, (_, index) => ({
        title: `Story ${index + 1}`,
        url: `https://news-${index + 1}.example.com/story`,
        source: `Publisher ${index + 1}`,
      })),
    },
  });

  const second = updateEvidenceRecoverySummary({
    prior: first,
    objective,
    toolName: "internet.search",
    output: {
      query: "top us business technology stories follow up",
      results: [
        {
          title: "Story 2 duplicate",
          url: "https://news-2.example.com/story",
          source: "Publisher 2",
        },
        {
          title: "Follow-up Story 7",
          url: "https://followup-7.example.com/story",
          source: "Publisher 7",
        },
      ],
    },
  });

  assert.equal(first?.retainedCandidates?.length, 6);
  assert.equal(first?.latestNewCandidateCount, 6);
  assert.equal(first?.retainedCandidates?.[0]?.url, "https://news-1.example.com/story");
  assert.equal(second?.retainedCandidates?.length, 7);
  assert.equal(second?.latestNewCandidateCount, 1);
  assert.equal(second?.retainedCandidates?.[0]?.url, "https://news-2.example.com/story");
  assert.equal(second?.retainedCandidates?.[1]?.url, "https://followup-7.example.com/story");
});
