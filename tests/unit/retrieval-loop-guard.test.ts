import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRetrievalRedundancy,
  normalizeRetrievalGuardInput,
  normalizeRetrievalGuardOutput,
  readRetrievalToolFamily,
} from "../../src/engine/retrievalLoopGuard.js";

test("normalizeRetrievalGuardInput canonicalizes string query fields", () => {
  const normalized = normalizeRetrievalGuardInput("internet.search", {
    query: " FC Cincinnati next 3 games today ",
    region: "US",
  });

  assert.deepEqual(normalized, {
    toolName: "internet.search",
    primaryText: "3 cincinnati fc game next",
    comparableFields: {
      query: "fc cincinnati next 3 games today",
      region: "us",
    },
  });
});

test("normalizeRetrievalGuardOutput keeps top url and domain evidence for search-like tools", () => {
  const normalized = normalizeRetrievalGuardOutput("internet.search", {
    results: [
      {
        url: "https://www.mlssoccer.com/news/foo?utm_source=newsletter#top",
        source: "www.mlssoccer.com",
      },
      {
        url: "https://www.espn.com/soccer/bar",
        source: "www.espn.com",
      },
    ],
  });

  assert.deepEqual(normalized.topUrls, [
    "https://mlssoccer.com/news/foo",
    "https://espn.com/soccer/bar",
  ]);
  assert.deepEqual(normalized.topDomains, ["mlssoccer.com", "espn.com"]);
});

test("normalizeRetrievalGuardOutput keeps top signal evidence for filesystem reads", () => {
  const normalized = normalizeRetrievalGuardOutput("fs.read_text", {
    path: "notes/fc-cincinnati.md",
    summary: "Workspace note",
    content: "FC Cincinnati are playing at home tonight.",
  });

  assert.deepEqual(normalized.topSignals, [
    "notes/fc-cincinnati.md | workspace note | fc cincinnati are playing at home tonight.",
  ]);
});

test("classifyRetrievalRedundancy requires both input and output similarity", () => {
  const redundant = classifyRetrievalRedundancy({
    prior: {
      toolName: "internet.search",
      input: normalizeRetrievalGuardInput("internet.search", {
        query: "FC Cincinnati exact record next 3 games today",
      }),
      output: normalizeRetrievalGuardOutput("internet.search", {
        results: [
          {
            url: "https://www.mlssoccer.com/news/fc-cincinnati-preview",
            source: "www.mlssoccer.com",
          },
        ],
      }),
    },
    current: {
      toolName: "internet.search",
      input: normalizeRetrievalGuardInput("internet.search", {
        query: "FC Cincinnati record and next three fixtures today",
      }),
      output: normalizeRetrievalGuardOutput("internet.search", {
        results: [
          {
            url: "https://mlssoccer.com/news/fc-cincinnati-preview?utm_source=mail",
            source: "mlssoccer.com",
          },
        ],
      }),
    },
  });

  assert.equal(redundant.redundant, true);
});

test("classifyRetrievalRedundancy covers filesystem read-only retrieval families", () => {
  const redundant = classifyRetrievalRedundancy({
    prior: {
      toolName: "fs.read_text",
      input: normalizeRetrievalGuardInput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
      }),
      output: normalizeRetrievalGuardOutput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
        content: "FC Cincinnati exact record and next three games.",
      }),
    },
    current: {
      toolName: "fs.read_text",
      input: normalizeRetrievalGuardInput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
      }),
      output: normalizeRetrievalGuardOutput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
        content: "FC Cincinnati exact record and next three games.",
      }),
    },
  });

  assert.equal(redundant.redundant, true);
});

test("filesystem tools stay outside generic read-like retrieval families", () => {
  assert.equal(readRetrievalToolFamily("fs.read_text"), "fs.read_text");
  assert.equal(readRetrievalToolFamily("fs.list"), "fs.list");
  assert.equal(readRetrievalToolFamily("fs.search_text"), "fs.search_text");
  assert.equal(readRetrievalToolFamily("fs.write_text"), "fs.write_text");

  const redundant = classifyRetrievalRedundancy({
    prior: {
      toolName: "fs.read_text",
      input: normalizeRetrievalGuardInput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
      }),
      output: normalizeRetrievalGuardOutput("fs.read_text", {
        path: "notes/fc-cincinnati.md",
        content: "FC Cincinnati exact record and next three games.",
      }),
    },
    current: {
      toolName: "fs.write_text",
      input: normalizeRetrievalGuardInput("fs.write_text", {
        path: "notes/fc-cincinnati.md",
        content: "Updated note",
      }),
      output: normalizeRetrievalGuardOutput("fs.write_text", {
        path: "notes/fc-cincinnati.md",
        bytesWritten: 12,
      }),
    },
  });

  assert.equal(redundant.redundant, false);
});

test("classifyRetrievalRedundancy does not flag similar inputs without shared evidence", () => {
  const redundant = classifyRetrievalRedundancy({
    prior: {
      toolName: "internet.search",
      input: normalizeRetrievalGuardInput("internet.search", {
        query: "FC Cincinnati exact record next 3 games today",
      }),
      output: normalizeRetrievalGuardOutput("internet.search", {
        results: [
          {
            url: "https://www.mlssoccer.com/news/fc-cincinnati-preview",
            source: "www.mlssoccer.com",
          },
        ],
      }),
    },
    current: {
      toolName: "internet.search",
      input: normalizeRetrievalGuardInput("internet.search", {
        query: "FC Cincinnati record and next three fixtures today",
      }),
      output: normalizeRetrievalGuardOutput("internet.search", {
        results: [
          {
            url: "https://www.espn.com/soccer/fc-cincinnati",
            source: "www.espn.com",
          },
        ],
      }),
    },
  });

  assert.equal(redundant.redundant, false);
});
