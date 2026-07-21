import assert from "node:assert/strict";

import {
  canonicalizeDuplicateUrl,
  detectReadOnlyResultDuplicate,
} from "../../src/runtime/readOnlyResultDuplicates.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "detectReadOnlyResultDuplicate matches repeated search payloads across executions", () => {
  const first = detectReadOnlyResultDuplicate({
    toolName: "internet.search",
    output: {
      results: [
        {
          title: "Example Result",
          url: "https://www.example.com/story?utm_source=newsletter#top",
          source: "Example",
        },
      ],
    },
    ledger: [],
  });
  const second = detectReadOnlyResultDuplicate({
    toolName: "internet.search",
    output: {
      results: [
        {
          title: "example result",
          url: "https://example.com/story",
          source: "Example",
        },
      ],
    },
    ledger: [
      {
        fingerprint: first?.fingerprint ?? "missing",
        family: "web_search_results",
        toolName: "internet.search",
        count: 1,
        firstSeenStep: 1,
        lastSeenStep: 1,
        updatedAt: "2026-03-18T12:00:00.000Z",
      },
    ],
  });

  assert.equal(first?.kind, "fresh_result");
  assert.equal(second?.kind, "duplicate_executed_result");
  assert.equal(second?.duplicateCount, 2);
  assert.equal(second?.fingerprint, first?.fingerprint);
});

contractTest("runtime.hermetic", "detectReadOnlyResultDuplicate matches repeated page payloads across get_url and scrape", () => {
  const first = detectReadOnlyResultDuplicate({
    toolName: "internet.extract",
    output: {
      url: "https://example.com/report?utm_campaign=briefing#summary",
      title: "Report",
      content: "Evidence report body",
    },
    ledger: [],
  });
  const second = detectReadOnlyResultDuplicate({
    toolName: "internet.extract",
    output: {
      url: "https://www.example.com/report",
      title: "Report",
      content: "Evidence report body",
    },
    ledger: [
      {
        fingerprint: first?.fingerprint ?? "missing",
        family: "web_page_content",
        toolName: "internet.extract",
        count: 1,
        firstSeenStep: 2,
        lastSeenStep: 2,
        updatedAt: "2026-03-18T12:01:00.000Z",
      },
    ],
  });

  assert.equal(first?.kind, "fresh_result");
  assert.equal(second?.kind, "duplicate_executed_result");
  assert.equal(second?.fingerprint, first?.fingerprint);
});

contractTest("runtime.hermetic", "canonicalizeDuplicateUrl strips obvious tracking variants", () => {
  assert.equal(
    canonicalizeDuplicateUrl("https://www.example.com/report/?utm_source=mail&gclid=abc#top"),
    "https://example.com/report",
  );
});

contractTest("runtime.hermetic", "canonicalizeDuplicateUrl preserves non-tracking ref and source params", () => {
  assert.equal(
    canonicalizeDuplicateUrl("https://example.com/report?ref=chapter-2&source=archive"),
    "https://example.com/report?ref=chapter-2&source=archive",
  );
});

contractTest("runtime.hermetic", "detectReadOnlyResultDuplicate does not collide materially different payloads", () => {
  const first = detectReadOnlyResultDuplicate({
    toolName: "internet.news",
    output: {
      results: [{ title: "Story A", url: "https://example.com/a", source: "Example" }],
    },
    ledger: [],
  });
  const second = detectReadOnlyResultDuplicate({
    toolName: "internet.news",
    output: {
      results: [{ title: "Story B", url: "https://example.com/b", source: "Example" }],
    },
    ledger: [
      {
        fingerprint: first?.fingerprint ?? "missing",
        family: "web_search_results",
        toolName: "internet.news",
        count: 1,
        firstSeenStep: 1,
        lastSeenStep: 1,
        updatedAt: "2026-03-18T12:02:00.000Z",
      },
    ],
  });

  assert.equal(second?.kind, "fresh_result");
  assert.notEqual(second?.fingerprint, first?.fingerprint);
});
