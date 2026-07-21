import assert from "node:assert/strict";

import { internetCrawlTool } from "../../tools/internet/crawl.js";
import { internetExtractTool } from "../../tools/internet/extract.js";
import { internetImagesTool } from "../../tools/internet/images.js";
import { internetMapTool } from "../../tools/internet/map.js";
import { internetNewsTool } from "../../tools/internet/news.js";
import { createTavilyInternetProvider } from "../../tools/internet/provider.js";
import { internetResearchTool } from "../../tools/internet/research.js";
import { internetSearchTool } from "../../tools/internet/search.js";
import { internetSearchAdvancedTool } from "../../tools/internet/searchAdvanced.js";
import { internetUsageTool } from "../../tools/internet/usage.js";
import type { TavilySdkClient } from "../../tools/internet/client.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "internet.search normalizes Tavily web results and uses SDK search options", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 42,
            requestId: "req-search-1",
            images: [],
            results: [
              {
                title: "Cincinnati weekend guide",
                url: "https://example.com/cincy-weekend",
                content: "Top events and activities in Cincinnati this weekend.",
                score: 0.91,
                publishedDate: "2026-03-12T12:00:00Z",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    query: "top things to do in cincinnati this weekend",
    limit: 5,
    freshness: "week",
  })) as {
    status: string;
    provider: string;
    query: string;
    attempts: number;
    results: Array<{ title: string; url: string; snippet: string; source?: string }>;
  };

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.query, "top things to do in cincinnati this weekend");
  assert.deepEqual(searchCalls[0]?.options, {
    searchDepth: "basic",
    topic: "general",
    maxResults: 10,
    timeout: 12,
    timeRange: "week",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.query, "top things to do in cincinnati this weekend");
  assert.equal(result.attempts, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.title, "Cincinnati weekend guide");
  assert.equal(result.results[0]?.url, "https://example.com/cincy-weekend");
  assert.equal(result.results[0]?.source, "example.com");
});

contractTest("runtime.hermetic", "internet.search_advanced passes valid Tavily options and preserves rich result metadata", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            answer: "Ada Lovelace was a computing pioneer.",
            responseTime: 6,
            requestId: "req-advanced-1",
            usage: { credits: 2 },
            images: [],
            results: [
              {
                title: "Ada Lovelace",
                url: "https://wikipedia.org/wiki/Ada_Lovelace",
                content: "Ada Lovelace wrote notes on the Analytical Engine.",
                rawContent: "Full Ada Lovelace article text.",
                favicon: "https://wikipedia.org/favicon.ico",
                score: 0.98,
                publishedDate: "2026-03-12T12:00:00Z",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    query: "Ada Lovelace",
    topic: "general",
    searchDepth: "advanced",
    includeAnswer: "basic",
    includeRawContent: "markdown",
    includeFavicon: true,
    includeUsage: true,
    country: "united states",
    domainAllow: ["wikipedia.org"],
    domainDeny: ["example.com"],
  })) as {
    answer?: string;
    requestId?: string;
    usage?: { credits?: number };
    results: Array<{ score?: number; favicon?: string; rawContent?: string }>;
  };

  assert.deepEqual(searchCalls[0]?.options, {
    searchDepth: "advanced",
    topic: "general",
    maxResults: 13,
    timeout: 12,
    includeAnswer: "basic",
    includeRawContent: "markdown",
    includeFavicon: true,
    includeUsage: true,
    country: "united states",
    includeDomains: ["wikipedia.org"],
    excludeDomains: ["example.com"],
  });
  assert.equal(result.answer, "Ada Lovelace was a computing pioneer.");
  assert.equal(result.requestId, "req-advanced-1");
  assert.equal(result.usage?.credits, 2);
  assert.equal(result.results[0]?.score, 0.98);
  assert.equal(result.results[0]?.favicon, "https://wikipedia.org/favicon.ico");
  assert.equal(result.results[0]?.rawContent, "Full Ada Lovelace article text.");
});

contractTest("runtime.hermetic", "internet.search_advanced canonicalizes includeRawContent true to markdown", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 1,
            requestId: "req-raw-content-true",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  await handler({
    query: "Ada Lovelace",
    includeRawContent: true,
  });

  assert.equal(searchCalls[0]?.options?.includeRawContent, "markdown");
});

contractTest("runtime.hermetic", "internet.search_advanced prefers explicit dates over freshness timeRange and days", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 1,
            requestId: "req-date-range",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  await handler({
    query: "TCS latest revenue and headcount",
    freshness: "year",
    days: 7,
    startDate: "2026-01-01",
    endDate: "2026-05-15",
  });

  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "timeRange"), false);
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "days"), false);
  assert.equal(searchCalls[0]?.options?.startDate, "2026-01-01");
  assert.equal(searchCalls[0]?.options?.endDate, "2026-05-15");
});

contractTest("runtime.hermetic", "internet.search_advanced rejects invalid explicit date strings before provider calls", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 1,
            requestId: "req-invalid-date",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  await assert.rejects(
    () =>
      handler({
        query: "TCS latest revenue and headcount",
        startDate: "today",
      }),
    /Invalid internet\.search_advanced input\.startDate/u,
  );
  assert.equal(searchCalls.length, 0);
});

contractTest("runtime.hermetic", "internet.search_advanced strips Tavily-conditional chunks and days unless prerequisites are present", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 1,
            requestId: "req-conditional-search-options",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  await handler({
    query: "TCS latest revenue and headcount",
    topic: "general",
    searchDepth: "basic",
    chunksPerSource: 3,
    days: 7,
  });
  await handler({
    query: "TCS latest revenue and headcount",
    topic: "news",
    searchDepth: "advanced",
    chunksPerSource: 2,
    days: 7,
  });

  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "chunksPerSource"), false);
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "days"), false);
  assert.equal(searchCalls[1]?.options?.chunksPerSource, 2);
  assert.equal(searchCalls[1]?.options?.days, 7);
});

contractTest("runtime.hermetic", "internet.extract and internet.crawl pass docs-supported chunksPerSource up to five", async () => {
  const extractCalls: Array<Record<string, unknown> | undefined> = [];
  const crawlCalls: Array<Record<string, unknown> | undefined> = [];
  const provider = createTavilyInternetProvider({
    client: createFakeClient({
      async extract(_urls, options) {
        extractCalls.push(options);
        return {
          responseTime: 1,
          requestId: "req-extract-chunks",
          results: [],
          failedResults: [],
        };
      },
      async crawl(_url, options) {
        crawlCalls.push(options);
        return {
          baseUrl: "https://example.com",
          responseTime: 1,
          requestId: "req-crawl-chunks",
          results: [],
        };
      },
    }),
  });

  await internetExtractTool.createHandler({ internetProvider: provider })({
    url: "https://example.com/page",
    query: "performance figures",
    chunksPerSource: 5,
  });
  await internetCrawlTool.createHandler({ internetProvider: provider })({
    url: "https://example.com",
    instructions: "Find financial pages",
    chunksPerSource: 5,
  });

  assert.equal(extractCalls[0]?.chunksPerSource, 5);
  assert.equal(crawlCalls[0]?.chunksPerSource, 5);
});

contractTest("runtime.hermetic", "internet.extract and internet.crawl strip chunksPerSource when Tavily prerequisites are absent", async () => {
  const extractCalls: Array<Record<string, unknown> | undefined> = [];
  const crawlCalls: Array<Record<string, unknown> | undefined> = [];
  const provider = createTavilyInternetProvider({
    client: createFakeClient({
      async extract(_urls, options) {
        extractCalls.push(options);
        return {
          responseTime: 1,
          requestId: "req-extract-no-query",
          results: [],
          failedResults: [],
        };
      },
      async crawl(_url, options) {
        crawlCalls.push(options);
        return {
          baseUrl: "https://example.com",
          responseTime: 1,
          requestId: "req-crawl-no-instructions",
          results: [],
        };
      },
    }),
  });

  await internetExtractTool.createHandler({ internetProvider: provider })({
    url: "https://example.com/page",
    chunksPerSource: 5,
  });
  await internetCrawlTool.createHandler({ internetProvider: provider })({
    url: "https://example.com",
    chunksPerSource: 5,
  });

  assert.equal(Object.hasOwn(extractCalls[0] ?? {}, "chunksPerSource"), false);
  assert.equal(Object.hasOwn(crawlCalls[0] ?? {}, "chunksPerSource"), false);
});

contractTest("runtime.hermetic", "internet.search retries recoverable 429 responses and returns degraded envelope", async () => {
  let calls = 0;
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      maxAttempts: 2,
      client: createFakeClient({
        async search() {
          calls += 1;
          throw createSdkError("429 Error: {\"detail\":{\"error\":\"rate limited\"}}", {
            status: 429,
            headers: { "retry-after": "7" },
          });
        },
      }),
    }),
  });

  const result = (await handler({
    query: "weather in ohio",
  })) as {
    status: string;
    attempts: number;
    results: unknown[];
    degraded?: {
      code?: string;
      retryAfterSeconds?: number;
      recoverable?: boolean;
    };
  };

  assert.equal(calls, 2);
  assert.equal(result.status, "degraded");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.results, []);
  assert.equal(result.degraded?.code, "provider_rate_limited");
  assert.equal(result.degraded?.retryAfterSeconds, 7);
  assert.equal(result.degraded?.recoverable, true);
});

contractTest("runtime.hermetic", "internet.search throws TOOL_PROVIDER_FAILED on non-recoverable provider response", async () => {
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search() {
          throw createSdkError("400 Error: {\"error\":\"bad_request\"}", {
            status: 400,
          });
        },
      }),
    }),
  });

  await assert.rejects(
    async () => handler({ query: "invalid" }),
    (error: unknown) => {
      const cast = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(cast.code, "TOOL_PROVIDER_FAILED");
      assert.equal(cast.details?.status, 400);
      assert.equal(cast.details?.sdkMethod, "search");
      return true;
    },
  );
});

contractTest("runtime.hermetic", "internet.search fans out oversized queries in parallel and reapplies the requested limit", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          searchCalls.push({ query, options });
          const callIndex = searchCalls.length;
          await new Promise((resolve) => setTimeout(resolve, 10));
          inFlight -= 1;
          return {
            query,
            responseTime: 17,
            requestId: `req-search-long-${callIndex}`,
            images: [],
            results: [
              {
                title: `Result ${callIndex}`,
                url: `https://example.com/result-${callIndex}`,
                content: `Content ${callIndex}`,
                score: 0.8,
              },
              {
                title: "Shared result",
                url: "https://example.com/shared",
                content: "Duplicate across fan-out branches",
                score: 0.7,
              },
            ],
          } as any;
        },
      }),
    }),
  });

  const longQuery =
    "(\"Greg Asher\" OR \"Gregory Asher\" OR \"Gregory M. Asher\") " +
    "(Cincinnati OR \"Greater Cincinnati\" OR \"Cincinnati, OH\") " +
    "(bio OR biography OR \"about\" OR \"press release\" OR speaker OR \"board of directors\" OR director OR manager OR engineer OR attorney) " +
    "-linkedin -facebook -instagram -pdf -spokeo -whitepages -beenverified -radaris -truepeoplesearch -fastpeoplesearch -peekyou -intelius -instantcheckmate site:example.com site:foo.com";
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    limit: 3,
  })) as {
    query: string;
    status: string;
    attempts: number;
    results: Array<{ url?: string }>;
  };

  assert.equal(searchCalls.length > 1, true);
  assert.equal(maxInFlight > 1, true);
  for (const call of searchCalls) {
    assert.equal(call.query.length <= 400, true);
    assert.equal(/\s(?:AND|OR|NOT)$/u.test(call.query), false);
    assert.equal(/[-(|]$/u.test(call.query), false);
    assert.equal(call.query.includes("  "), false);
  }
  assert.equal(result.status, "ok");
  assert.equal(result.query, longQuery);
  assert.equal(result.attempts, searchCalls.length);
  assert.equal(result.results.length, 3);
  assert.deepEqual(
    result.results.map((entry) => entry.url),
    [
      "https://example.com/result-1",
      "https://example.com/shared",
      "https://example.com/result-2",
    ],
  );
});

contractTest("runtime.hermetic", "internet.search preserves all fan-out branches beyond eight subqueries", async () => {
  const searchCalls: string[] = [];
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query) {
          searchCalls.push(query);
          const callIndex = searchCalls.length;
          return {
            query,
            responseTime: 12,
            requestId: `req-search-branch-${callIndex}`,
            images: [],
            results: [
              {
                title: `Branch ${callIndex}`,
                url: `https://example.com/branch-${callIndex}`,
                content: `Branch content ${callIndex}`,
                score: 0.8,
              },
            ],
          } as any;
        },
      }),
    }),
  });

  const aliases = Array.from(
    { length: 9 },
    (_, index) => `"candidate ${index} ${"regional executive biography ".repeat(4).trim()}"`,
  );
  const longQuery =
    `(${aliases.join(" OR ")}) ` +
    "-linkedin -facebook -instagram -spokeo -whitepages -beenverified " +
    "-radaris -truepeoplesearch -fastpeoplesearch site:example.com site:foo.com";
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    limit: 20,
  })) as {
    query: string;
    status: string;
    attempts: number;
    results: Array<{ url?: string }>;
  };

  assert.equal(searchCalls.length > 8, true);
  assert.equal(result.status, "ok");
  assert.equal(result.query, longQuery);
  assert.equal(result.attempts, searchCalls.length);
  assert.equal(result.results.length, searchCalls.length);
  for (const call of searchCalls) {
    assert.equal(call.length <= 400, true);
  }
});

contractTest("runtime.hermetic", "internet.search keeps unary NOT clauses bound to the negated term during fan-out", async () => {
  const searchCalls: string[] = [];
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query) {
          searchCalls.push(query);
          return {
            query,
            responseTime: 14,
            requestId: `req-search-not-${searchCalls.length}`,
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  const longQuery =
    `${Array.from({ length: 28 }, (_, index) => `topic-${index}-regional-biography`).join(" ")} ` +
    "NOT banana site:example.com site:foo.com";
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    limit: 5,
  })) as {
    query: string;
    status: string;
    attempts: number;
  };

  assert.equal(searchCalls.length > 1, true);
  assert.equal(result.status, "ok");
  assert.equal(result.query, longQuery);
  assert.equal(result.attempts, searchCalls.length);
  for (const call of searchCalls) {
    assert.equal(call.includes("NOT banana"), true);
    assert.equal(/\bbanana NOT\b/u.test(call), false);
    assert.equal(/\bNOT$/u.test(call), false);
  }
});

contractTest("runtime.hermetic", "internet.search degrades oversized unsplittable queries instead of truncating them", async () => {
  let calls = 0;
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search() {
          calls += 1;
          return {
            query: "unexpected",
            responseTime: 10,
            requestId: "req-search-unsplittable",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  const longQuery = `"${"a".repeat(410)}"`;
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    limit: 5,
  })) as {
    query: string;
    status: string;
    attempts: number;
    results: unknown[];
    degraded?: { code?: string; message?: string; recoverable?: boolean };
  };

  assert.equal(calls, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.query, longQuery);
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.degraded?.code, "query_too_complex");
  assert.equal(result.degraded?.recoverable, true);
  assert.equal(result.degraded?.message?.includes("could not be split without truncation"), true);
});

contractTest("runtime.hermetic", "internet.news handles headline-style queries through the news tool", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetNewsTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 10,
            requestId: "req-headlines-1",
            images: [],
            results: [
              {
                title: "US headline",
                url: "https://example.com/us-headline",
                content: "Top US story",
                score: 0.8,
                publishedDate: "2026-03-12T15:00:00Z",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({ query: "top US headlines today", region: "us" })) as {
    status: string;
    results: Array<{ title?: string }>;
  };

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.query, "top US headlines today");
  assert.equal(searchCalls[0]?.options?.topic, "news");
  assert.equal(Object.hasOwn(result, "region"), false);
  assert.equal(result.status, "ok");
  assert.equal(result.results[0]?.title, "US headline");
});

contractTest("runtime.hermetic", "internet.research submits and polls for source inventory", async () => {
  const handler = internetResearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async research(input) {
          return {
            requestId: "req-research-1",
            createdAt: "2026-03-12T12:00:00Z",
            status: "pending",
            input,
            model: "auto",
            responseTime: 1,
          };
        },
        async getResearch(requestId) {
          return {
            requestId,
            createdAt: "2026-03-12T12:00:00Z",
            status: "completed",
            content: "Benchmark summary content",
            sources: [{ title: "Automation benchmark", url: "https://example.com/benchmark" }],
            responseTime: 2,
          };
        },
      }),
    }),
  });

  const result = (await handler({ input: "process automation", pollIntervalMs: 250 })) as {
    status: string;
    provider: string;
    researchStatus: string;
    content?: unknown;
    sources?: unknown[];
  };

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.researchStatus, "completed");
  assert.equal(result.content, "Benchmark summary content");
  assert.equal(result.sources?.length, 1);
});

contractTest("runtime.hermetic", "internet.research omits empty outputSchema when submitting to Tavily", async () => {
  const researchCalls: Array<{ input: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetResearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async research(input, options) {
          researchCalls.push({ input, options });
          return {
            requestId: "req-research-omit-empty-schema",
            createdAt: "2026-03-12T12:00:00Z",
            status: "completed",
            input,
            model: "auto",
            responseTime: 1,
          };
        },
      }),
    }),
  });

  await handler({
    input: "process automation",
    outputSchema: {},
    waitForCompletion: false,
  });

  assert.equal(researchCalls.length, 1);
  assert.deepEqual(researchCalls[0], {
    input: "process automation",
    options: {
      stream: false,
      timeout: 12,
    },
  });
});

contractTest("runtime.hermetic", "internet.news normalizes Tavily news results without passing unsupported country hints", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetNewsTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 18,
            requestId: "req-news-1",
            images: [],
            results: [
              {
                title: "Ohio rainfall report",
                url: "https://example.com/oh-rain",
                content: "Recent rainfall trends by city.",
                score: 0.87,
                publishedDate: "2026-03-12T12:00:00Z",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    query: "recent rainfall in ohio cities",
    region: "us",
    limit: 3,
  })) as {
    status: string;
    provider: string;
    query: string;
    attempts: number;
    results: Array<{ publishedAt?: string; source?: string }>;
  };

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.options?.topic, "news");
  assert.equal(searchCalls[0]?.options?.maxResults, 8);
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "includeDomains"), false);
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "excludeDomains"), false);
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "country"), false);
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.query, "recent rainfall in ohio cities");
  assert.equal(Object.hasOwn(result, "region"), false);
  assert.equal(result.attempts, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.source, "example.com");
  assert.equal(result.results[0]?.publishedAt, "2026-03-12T12:00:00Z");
});

contractTest("runtime.hermetic", "internet.search_advanced strips unsupported country hints for fast search depth", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchAdvancedTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 22,
            requestId: "req-advanced-fast-1",
            images: [],
            results: [
              {
                title: "Markets react to latest tech earnings",
                url: "https://example.com/markets-tech-earnings",
                content: "A grounded business and technology result.",
                score: 0.9,
                publishedDate: "2026-03-12T12:00:00Z",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    query: "current U.S. business and technology news",
    searchDepth: "fast",
    country: "united states",
    limit: 5,
  })) as {
    status: string;
    provider: string;
    query: string;
    results: Array<{ title?: string }>;
  };

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]?.options?.searchDepth, "fast");
  assert.equal(Object.hasOwn(searchCalls[0]?.options ?? {}, "country"), false);
  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.query, "current U.S. business and technology news");
  assert.equal(result.results[0]?.title, "Markets react to latest tech earnings");
});

contractTest("runtime.hermetic", "internet.search overfetches and prunes low-value non-article endpoints", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetSearchTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 25,
            requestId: "req-search-prune-1",
            images: [],
            results: [
              {
                title: "Reuters sitemap",
                url: "https://www.reuters.com/arc/outboundfeeds/sitemap-index.xml",
                content: "Low-value sitemap endpoint",
                score: 0.99,
              },
              {
                title: "Markets rally on jobs data",
                url: "https://www.reuters.com/world/us/markets-rally-jobs-data-2026-03-19/",
                content: "Stocks rose after the latest jobs report.",
                score: 0.98,
              },
              {
                title: "Video: Closing bell",
                url: "https://www.cnbc.com/video/2026/03/19/closing-bell.html",
                content: "Market wrap video.",
                score: 0.9,
              },
              {
                title: "Fed policy in focus",
                url: "https://www.apnews.com/article/fed-policy-focus-2026-03-19",
                content: "Investors assessed the latest policy signals.",
                score: 0.88,
              },
            ],
          } as any;
        },
      }),
    }),
  });

  const result = (await handler({
    query: "latest U.S. business headlines",
    limit: 2,
  })) as {
    results: Array<{ url: string }>;
  };

  assert.equal(searchCalls[0]?.options?.maxResults, 7);
  assert.deepEqual(result.results.map((entry) => entry.url), [
    "https://www.reuters.com/world/us/markets-rally-jobs-data-2026-03-19/",
    "https://www.apnews.com/article/fed-policy-focus-2026-03-19",
  ]);
});

contractTest("runtime.hermetic", "internet.news fans out oversized queries before calling Tavily", async () => {
  const searchCalls: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetNewsTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query, options) {
          searchCalls.push({ query, options });
          return {
            query,
            responseTime: 21,
            requestId: "req-news-long-1",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  const longQuery = `${"cincinnati market update ".repeat(30)} OR`;
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    region: "us",
  })) as {
    query: string;
    status: string;
    attempts: number;
  };

  assert.equal(searchCalls.length > 1, true);
  for (const call of searchCalls) {
    assert.equal(call.query.length <= 400, true);
    assert.equal(/\s(?:AND|OR|NOT)$/u.test(call.query), false);
  }
  assert.equal(result.status, "ok");
  assert.equal(result.query, longQuery);
  assert.equal(result.attempts, searchCalls.length);
});

contractTest("runtime.hermetic", "internet.news degrades oversized unsplittable queries instead of truncating them", async () => {
  let calls = 0;
  const handler = internetNewsTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search() {
          calls += 1;
          return {
            query: "unexpected",
            responseTime: 9,
            requestId: "req-news-unsplittable",
            images: [],
            results: [],
          };
        },
      }),
    }),
  });

  const longQuery = `"${"market".repeat(70)}"`;
  assert.equal(longQuery.length > 400, true);

  const result = (await handler({
    query: longQuery,
    region: "us",
  })) as {
    query: string;
    status: string;
    attempts: number;
    results: unknown[];
    degraded?: { code?: string; recoverable?: boolean };
  };

  assert.equal(calls, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.query, longQuery);
  assert.equal(Object.hasOwn(result, "region"), false);
  assert.equal(result.attempts, 0);
  assert.deepEqual(result.results, []);
  assert.equal(result.degraded?.code, "query_too_complex");
  assert.equal(result.degraded?.recoverable, true);
});

contractTest("runtime.hermetic", "internet.images normalizes Tavily image results", async () => {
  const handler = internetImagesTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async search(query) {
          return {
            query,
            responseTime: 13,
            requestId: "req-images-1",
            images: [
              {
                url: "https://example.com/skyline.jpg",
                description: "Cincinnati skyline",
              },
            ],
            results: [],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    query: "cincinnati skyline photos",
    limit: 5,
  })) as {
    status: string;
    provider: string;
    query: string;
    attempts: number;
    results: Array<{ title?: string; url?: string; source?: string }>;
  };

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.attempts, 1);
  assert.equal(result.query, "cincinnati skyline photos");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.title, "Cincinnati skyline");
  assert.equal(result.results[0]?.url, "https://example.com/skyline.jpg");
  assert.equal(result.results[0]?.source, "example.com");
});

contractTest("runtime.hermetic", "internet.extract normalizes extracted fetch payload", async () => {
  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async extract(urls) {
          assert.deepEqual(urls, ["https://example.com/report"]);
          return {
            responseTime: 16,
            requestId: "req-extract-1",
            failedResults: [],
            results: [
              {
                url: "https://example.com/report",
                title: "Report",
                rawContent: "Evidence report body",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com/report",
  })) as {
    status: string;
    provider: string;
    url: string;
    title?: string;
    content: string;
    contentType: string;
    charCount: number;
    truncated?: boolean;
    quality?: string;
    attempts: number;
  };

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.url, "https://example.com/report");
  assert.equal(result.title, "Report");
  assert.equal(result.content, "Evidence report body");
  assert.equal(result.contentType, "text/markdown");
  assert.equal(result.charCount, "Evidence report body".length);
  assert.equal(result.truncated, false);
  assert.equal(result.quality, "medium");
  assert.equal(result.attempts, 1);
});

contractTest("runtime.hermetic", "internet.extract supports batched URLs and failed results", async () => {
  const extractCalls: Array<{ urls: string[]; options: Record<string, unknown> | undefined }> = [];
  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async extract(urls, options) {
          extractCalls.push({ urls, options });
          return {
            responseTime: 16,
            requestId: "req-extract-batch",
            usage: { credits: 1 },
            failedResults: [{ url: "https://example.com/missing", error: "not found" }],
            results: [
              {
                url: "https://example.com/report",
                title: "Report",
                rawContent: "Evidence report body",
                images: ["https://example.com/image.jpg"],
                favicon: "https://example.com/favicon.ico",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    urls: ["https://example.com/report", "https://example.com/missing"],
    query: "evidence",
    includeImages: true,
    includeFavicon: true,
    includeUsage: true,
  })) as {
    requestId?: string;
    usage?: { credits?: number };
    results: Array<{ images?: string[]; favicon?: string }>;
    failedResults: Array<{ url: string; error: string }>;
  };

  assert.deepEqual(extractCalls[0], {
    urls: ["https://example.com/report", "https://example.com/missing"],
    options: {
      extractDepth: "advanced",
      format: "markdown",
      timeout: 12,
      includeImages: true,
      includeFavicon: true,
      includeUsage: true,
      query: "evidence",
    },
  });
  assert.equal(result.requestId, "req-extract-batch");
  assert.equal(result.usage?.credits, 1);
  assert.deepEqual(result.results[0]?.images, ["https://example.com/image.jpg"]);
  assert.equal(result.results[0]?.favicon, "https://example.com/favicon.ico");
  assert.deepEqual(result.failedResults, [{ url: "https://example.com/missing", error: "not found" }]);
});

contractTest("runtime.hermetic", "internet.extract ignores unsupported selector-shaped input and returns extracted content", async () => {
  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async extract() {
          return {
            responseTime: 15,
            requestId: "req-extract-2",
            failedResults: [],
            results: [
              {
                url: "https://example.com/page",
                title: null,
                rawContent: "Extracted page content",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com/page",
    selectors: ["article"],
  })) as {
    status: string;
    provider: string;
    url: string;
    content: string;
    contentType: string;
    charCount: number;
    attempts: number;
    contentIssues?: string[];
  };

  assert.equal(result.status, "ok");
  assert.equal(result.provider, "tavily");
  assert.equal(result.url, "https://example.com/page");
  assert.equal(result.content, "Extracted page content");
  assert.equal(result.contentType, "text/markdown");
  assert.equal(result.charCount, "Extracted page content".length);
  assert.equal(result.attempts, 1);
  assert.equal(result.contentIssues, undefined);
});

contractTest("runtime.hermetic", "internet.extract labels truncated boilerplate-heavy extracts as low quality", async () => {
  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async extract() {
          return {
            responseTime: 11,
            requestId: "req-extract-3",
            failedResults: [],
            results: [
              {
                url: "https://example.com/noisy",
                title: "Noisy page",
                rawContent:
                  "Menu\nPrivacy Policy\nSubscribe\nContact Us\n" +
                  "A".repeat(1400),
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com/noisy",
    maxChars: 500,
  })) as {
    truncated?: boolean;
    quality?: string;
    contentIssues?: string[];
    charCount: number;
  };

  assert.equal(result.truncated, true);
  assert.equal(result.quality, "medium");
  assert.ok(result.charCount <= 500);
  assert.equal(result.contentIssues?.includes("truncated_content"), true);
  assert.equal(result.contentIssues?.includes("boilerplate_heavy"), false);
});

contractTest("runtime.hermetic", "internet.extract strips navigation blocks before rating quality", async () => {
  const paragraphs = [
    "Breaking: Major weather system sweeps across coastal cities while officials coordinate shelters.",
    "Officials warn of flash flooding, but evacuation orders remain localized to low-lying districts.",
    "Forecast models show the system slowing overnight, giving crews more time to clear routes and secure debris.",
    "Residents are urged to keep phones charged and plug in portable radios for updates during power outages.",
    "Community shelters are opening starting at 5 p.m.; bring documentation for pets and personal items.",
    "Public transit agencies are adjusting schedules to keep people moving outside flood zones.",
    "Emergency managers are dispatching drone crews to chart where rivers have overtopped their banks.",
    "Utility crews are strategically fortifying substations to avoid lengthy outages.",
  ];
  const article = [...paragraphs, ...paragraphs].join(" ");

  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async extract() {
          return {
            responseTime: 11,
            requestId: "req-extract-4",
            failedResults: [],
            results: [
              {
                url: "https://example.com/clean-news",
                title: "Clean article",
                rawContent:
                  "Skip to content\nMenu\nNavigation\nPrivacy Policy\nSubscribe\n" +
                  "Latest headlines\nHeader\n" +
                  article,
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com/clean-news",
    maxChars: 2000,
  })) as {
    truncated?: boolean;
    quality?: string;
    contentIssues?: string[];
    content: string;
    results: unknown[];
    failedResults: Array<{ url: string; error: string }>;
  };

  assert.equal(result.truncated, false);
  assert.equal(result.quality, "high");
  assert.equal(result.content.includes(paragraphs[0] ?? ""), true);
  assert.equal(result.content.includes("Menu"), false);
  const hasBoilerplate = result.contentIssues?.includes("boilerplate_heavy") ?? false;
  assert.equal(hasBoilerplate, false);
});

contractTest("runtime.hermetic", "internet.extract returns degraded envelope on recoverable provider failures", async () => {
  let calls = 0;
  const handler = internetExtractTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      maxAttempts: 2,
      client: createFakeClient({
        async extract() {
          calls += 1;
          throw createSdkError("503 Error: {\"detail\":{\"error\":\"service unavailable\"}}", {
            status: 503,
          });
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com/report",
  })) as {
    status: string;
    provider: string;
    attempts: number;
    content: string;
    results: unknown[];
    failedResults: Array<{ url: string; error: string }>;
    degraded?: { code?: string; recoverable?: boolean };
  };

  assert.equal(calls, 2);
  assert.equal(result.status, "degraded");
  assert.equal(result.provider, "tavily");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failedResults, [{ url: "https://example.com/report", error: "provider_unavailable" }]);
  assert.equal(result.degraded?.code, "provider_unavailable");
  assert.equal(result.degraded?.recoverable, true);
});

contractTest("runtime.hermetic", "internet.crawl passes Tavily crawl options and normalizes page content", async () => {
  const crawlCalls: Array<{ url: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetCrawlTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async crawl(url, options) {
          crawlCalls.push({ url, options });
          return {
            responseTime: 20,
            requestId: "req-crawl-1",
            baseUrl: url,
            usage: { credits: 1 },
            results: [
              {
                url: "https://example.com/docs",
                rawContent: "Documentation content",
                images: ["https://example.com/docs.png"],
                favicon: "https://example.com/favicon.ico",
              },
            ],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com",
    instructions: "Find documentation",
    maxDepth: 8,
    maxBreadth: 400,
    limit: 5,
    selectPaths: ["/docs"],
    includeImages: true,
    includeFavicon: true,
    includeUsage: true,
  })) as { baseUrl: string; results: Array<{ url: string; images?: string[] }>; usage?: { credits?: number } };

  assert.equal(crawlCalls[0]?.url, "https://example.com");
  assert.equal(crawlCalls[0]?.options?.instructions, "Find documentation");
  assert.equal(crawlCalls[0]?.options?.maxDepth, 5);
  assert.equal(crawlCalls[0]?.options?.maxBreadth, 400);
  assert.deepEqual(crawlCalls[0]?.options?.selectPaths, ["/docs"]);
  assert.equal(crawlCalls[0]?.options?.includeImages, true);
  assert.equal(result.baseUrl, "https://example.com");
  assert.equal(result.results[0]?.url, "https://example.com/docs");
  assert.deepEqual(result.results[0]?.images, ["https://example.com/docs.png"]);
  assert.equal(result.usage?.credits, 1);
});

contractTest("runtime.hermetic", "internet.map passes Tavily map options and returns discovered URLs", async () => {
  const mapCalls: Array<{ url: string; options: Record<string, unknown> | undefined }> = [];
  const handler = internetMapTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      client: createFakeClient({
        async map(url, options) {
          mapCalls.push({ url, options });
          return {
            responseTime: 8,
            requestId: "req-map-1",
            baseUrl: url,
            usage: { credits: 1 },
            results: ["https://example.com/docs", "https://example.com/pricing"],
          };
        },
      }),
    }),
  });

  const result = (await handler({
    url: "https://example.com",
    instructions: "Find product pages",
    maxDepth: 8,
    maxBreadth: 400,
    limit: 10,
    allowExternal: false,
    includeUsage: true,
  })) as { baseUrl: string; results: string[]; usage?: { credits?: number } };

  assert.equal(mapCalls[0]?.url, "https://example.com");
  assert.equal(mapCalls[0]?.options?.instructions, "Find product pages");
  assert.equal(mapCalls[0]?.options?.maxDepth, 5);
  assert.equal(mapCalls[0]?.options?.maxBreadth, 400);
  assert.equal(mapCalls[0]?.options?.limit, 10);
  assert.equal(mapCalls[0]?.options?.allowExternal, false);
  assert.equal(result.baseUrl, "https://example.com");
  assert.deepEqual(result.results, ["https://example.com/docs", "https://example.com/pricing"]);
  assert.equal(result.usage?.credits, 1);
});

contractTest("runtime.hermetic", "internet.usage maps Tavily usage diagnostics", async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const handler = internetUsageTool.createHandler({
    internetProvider: createTavilyInternetProvider({
      apiKey: "tvly-test",
      fetchImpl: async (url, init) => {
        const authorization = init?.headers instanceof Headers
          ? init.headers.get("Authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization;
        requests.push({
          url: String(url),
          ...(authorization !== undefined ? { authorization } : {}),
        });
        return new Response(JSON.stringify({
          key: { creditsUsed: 10 },
          account: { plan: "dev" },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      client: createFakeClient({}),
    }),
  });

  const result = (await handler({})) as { key?: Record<string, unknown>; account?: Record<string, unknown> };

  assert.equal(requests[0]?.url, "https://api.tavily.com/usage");
  assert.equal(requests[0]?.authorization, "Bearer tvly-test");
  assert.deepEqual(result.key, { creditsUsed: 10 });
  assert.deepEqual(result.account, { plan: "dev" });
});

function createFakeClient(overrides: {
	  search?: TavilySdkClient["search"];
	  extract?: TavilySdkClient["extract"];
	  crawl?: TavilySdkClient["crawl"];
	  map?: TavilySdkClient["map"];
	  research?: TavilySdkClient["research"];
	  getResearch?: TavilySdkClient["getResearch"];
	}): TavilySdkClient {
	  return {
    search: overrides.search ?? (async () => {
      throw new Error("search not implemented");
    }),
    extract: overrides.extract ?? (async () => {
      throw new Error("extract not implemented");
    }),
    crawl: overrides.crawl ?? (async () => {
      throw new Error("crawl not implemented");
    }),
	    map: overrides.map ?? (async () => {
	      throw new Error("map not implemented");
	    }),
	    research: overrides.research ?? (async () => {
	      throw new Error("research not implemented");
	    }),
	    getResearch: overrides.getResearch ?? (async () => {
	      throw new Error("getResearch not implemented");
	    }),
	  };
	}

function createSdkError(
  message: string,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Error & { response?: { status?: number; headers?: Record<string, string> } } {
  const error = new Error(message) as Error & {
    response?: { status?: number; headers?: Record<string, string> };
  };
  error.response = {
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  };
  return error;
}
