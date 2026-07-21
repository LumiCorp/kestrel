import assert from "node:assert/strict";

import {
  applyFollowUpSourceGrounding,
  collectPriorSources,
} from "../../agents/reference-react/src/followUpSourceGrounding.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "collectPriorSources extracts latest-first deduped prior internet sources", () => {
  const priorSources = collectPriorSources({
    reactState: {
      lastActionResult: {
        kind: "tool",
        name: "internet.news",
        output: {
          query: "news headlines for Cincinnati",
          highlights: [
            {
              title: "Budget vote nears",
              url: "https://example.com/budget",
              source: "WCPO",
            },
            {
              title: "Budget vote nears duplicate",
              url: "https://example.com/budget",
              source: "WCPO",
            },
          ],
        },
      },
    },
    toolOutcomeCache: [
      {
        toolName: "internet.search",
        stepIndex: 2,
        updatedAt: "2026-03-12T14:00:00.000Z",
        output: {
          query: "Cincinnati politics",
          results: [
            {
              title: "Transit vote heads to council",
              url: "https://example.com/transit",
              source: "WVXU",
            },
          ],
        },
      },
    ],
  });

  assert.equal(priorSources.length, 2);
  assert.match(String(priorSources[0]?.id ?? ""), /^[a-f0-9]{16}$/u);
  assert.equal(priorSources[0]?.url, "https://example.com/budget");
  assert.equal(priorSources[1]?.url, "https://example.com/transit");
});

contractTest("runtime.hermetic", "collectPriorSources keeps candidate ids stable when descriptive fields change", () => {
  const first = collectPriorSources({
    reactState: {
      postToolVerification: {
        evidenceRecoverySummary: {
          retainedCandidates: [
            {
              title: "Budget vote nears",
              url: " https://example.com/budget ",
              publisher: "WCPO",
              category: "business",
              summary: "First retained summary.",
              toolName: "internet.news",
            },
          ],
        },
      },
    },
    toolOutcomeCache: [],
  });
  const second = collectPriorSources({
    reactState: {
      postToolVerification: {
        evidenceRecoverySummary: {
          retainedCandidates: [
            {
              title: "Budget vote nears",
              url: "https://example.com/budget",
              publisher: "WCPO",
              category: "technology",
              summary: "Updated retained summary.",
              toolName: "internet.search",
            },
          ],
        },
      },
    },
    toolOutcomeCache: [],
  });

  assert.match(String(first[0]?.id ?? ""), /^[a-f0-9]{16}$/u);
  assert.equal(first[0]?.id, second[0]?.id);
  assert.equal(first[0]?.url, "https://example.com/budget");
  assert.equal(first[0]?.category, "business");
  assert.equal(second[0]?.category, "technology");
  assert.equal(first[0]?.summary, "First retained summary.");
  assert.equal(second[0]?.summary, "Updated retained summary.");
});

contractTest("runtime.hermetic", "applyFollowUpSourceGrounding applies explicit prior-source selection by candidate id", () => {
  const priorSourceId = "source-crosby";
  const result = applyFollowUpSourceGrounding({
    userMessage: "tell me more about the Corsby deal falling through",
    toolIntent: {
      toolUseIntent: "single",
      objective: "Explain the Crosby deal",
      confidence: 0.92,
      candidateTools: [
        {
          name: "internet.extract",
          allowlisted: true,
          capabilityClasses: ["web.fetch"],
          executionClass: "read_only",
        },
      ],
      allowlistedCandidates: ["internet.extract"],
      derivedRequiredCapabilities: ["web.fetch"],
      concreteToolName: "internet.extract",
      followUpSourceSelection: {
        kind: "use_prior_source",
        candidateId: priorSourceId,
      },
      isAmbiguous: false,
    },
    priorSources: [
      {
        id: priorSourceId,
        title: "Ravens pivot after Crosby deal falls through",
        url: "https://example.com/crosby",
        source: "WKRC",
        snippet: "The Ravens changed course after the Maxx Crosby deal fell through.",
        toolName: "internet.news",
      },
    ],
    capabilityManifest: [
      {
        name: "internet.extract",
        description: "Fetch URL",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.fetch"],
      },
      {
        name: "internet.news",
        description: "News search",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["news.search"],
      },
    ],
  });

  assert.equal(result.grounding?.status, "selected_prior_source");
  assert.equal(result.grounding?.candidateId, priorSourceId);
  assert.equal(result.executionIntent?.inputHints?.url, "https://example.com/crosby");
  assert.equal(result.executionIntent?.inputHints?.urlSource, "prior_result_grounding");
});

contractTest("runtime.hermetic", "applyFollowUpSourceGrounding applies explicit search pivot", () => {
  const result = applyFollowUpSourceGrounding({
    userMessage: "tell me more about that one",
    toolIntent: {
      toolUseIntent: "single",
      objective: "Explain that one",
      confidence: 0.71,
      candidateTools: [
        {
          name: "internet.extract",
          allowlisted: true,
          capabilityClasses: ["web.fetch"],
          executionClass: "read_only",
        },
      ],
      allowlistedCandidates: ["internet.extract"],
      derivedRequiredCapabilities: ["web.fetch"],
      concreteToolName: "internet.extract",
      followUpSourceSelection: {
        kind: "search_pivot",
        toolName: "internet.news",
        query: "Cincinnati budget debate intensifies",
      },
      isAmbiguous: false,
    },
    priorSources: [
      {
        id: "source-budget",
        title: "Cincinnati budget debate intensifies",
        url: "https://example.com/budget",
        source: "WCPO",
        toolName: "internet.news",
        contextHint: "news headlines for Cincinnati",
      },
      {
        id: "source-transit",
        title: "Transit vote heads to council",
        url: "https://example.com/transit",
        source: "WVXU",
        toolName: "internet.news",
        contextHint: "news headlines for Cincinnati",
      },
    ],
    capabilityManifest: [
      {
        name: "internet.extract",
        description: "Fetch URL",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.fetch"],
      },
      {
        name: "internet.news",
        description: "News search",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["news.search"],
      },
    ],
  });

  assert.equal(result.grounding?.status, "search_pivot");
  assert.deepEqual(result.executionIntent?.candidateTools, ["internet.news"]);
  assert.equal(result.executionIntent?.inputHints?.query, "Cincinnati budget debate intensifies");
});

contractTest("runtime.hermetic", "applyFollowUpSourceGrounding fails closed when a fetch follow-up omits explicit selection", () => {
  const result = applyFollowUpSourceGrounding({
    userMessage: "tell me more about that article",
    toolIntent: {
      toolUseIntent: "single",
      objective: "Explain that article",
      confidence: 0.71,
      candidateTools: [
        {
          name: "internet.extract",
          allowlisted: true,
          capabilityClasses: ["web.fetch"],
          executionClass: "read_only",
        },
      ],
      allowlistedCandidates: ["internet.extract"],
      derivedRequiredCapabilities: ["web.fetch"],
      concreteToolName: "internet.extract",
      isAmbiguous: false,
    },
    priorSources: [
      {
        id: "source-budget",
        title: "Cincinnati budget debate intensifies",
        url: "https://example.com/budget",
        source: "WCPO",
        toolName: "internet.news",
      },
    ],
    capabilityManifest: [
      {
        name: "internet.extract",
        description: "Fetch URL",
        freshnessClass: "live",
        latencyClass: "medium",
        costClass: "metered",
        executionClass: "read_only",
        capabilityClasses: ["web.fetch"],
      },
    ],
  });

  assert.equal(result.grounding?.status, "insufficient");
  assert.equal(result.executionIntent?.inputHints?.url, undefined);
});

contractTest("runtime.hermetic", "collectPriorSources keeps retained source memory unbounded and latest-first", () => {
  const priorSources = collectPriorSources({
    reactState: {
      goal: "Research the top current U.S. business and technology stories.",
      postToolVerification: {
        evidenceRecoverySummary: {
          retainedCandidates: Array.from({ length: 12 }, (_, index) => ({
            title: `Story ${12 - index}`,
            url: `https://example.com/story-${12 - index}`,
            publisher: `Publisher ${12 - index}`,
            toolName: index % 2 === 0 ? "internet.search" : "internet.news",
            updatedAt: `2026-03-12T14:${String(59 - index).padStart(2, "0")}:00.000Z`,
          })),
        },
      },
    },
    toolOutcomeCache: Array.from({ length: 4 }, (_, index) => ({
      toolName: "internet.search",
      stepIndex: index + 1,
      updatedAt: `2026-03-12T15:${String(index).padStart(2, "0")}:00.000Z`,
      output: {
        results: [
          {
            title: `Duplicate Story ${index + 1}`,
            url: `https://example.com/story-${index + 1}`,
            source: `Publisher ${index + 1}`,
          },
        ],
      },
    })),
  });

  assert.equal(priorSources.length, 12);
  assert.equal(priorSources[0]?.url, "https://example.com/story-12");
  assert.equal(priorSources[11]?.url, "https://example.com/story-1");
});
