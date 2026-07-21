import assert from "node:assert/strict";

import { createTavilyClient } from "../../tools/internet/client.js";
import type { TavilySdkClient } from "../../tools/internet/client.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "createTavilyClient wires SDK config from explicit options", async () => {
  let captured:
    | {
        apiKey?: string;
        apiBaseURL?: string;
        projectId?: string;
        clientSource?: string;
        proxies?: { http?: string; https?: string };
      }
    | undefined;

  const client = createTavilyClient({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
    projectId: "proj_123",
    httpProxy: "http://proxy.internal:8080",
    httpsProxy: "http://proxy.internal:8443",
    tavilyFactory(options) {
      captured = options;
      return createNoopClient();
    },
  });

  assert.ok(client);
  assert.deepEqual(captured, {
    apiKey: "test-key",
    apiBaseURL: "https://api.example.test",
    projectId: "proj_123",
    clientSource: "kestrel",
    proxies: {
      http: "http://proxy.internal:8080",
      https: "http://proxy.internal:8443",
    },
  });
});

contractTest("runtime.hermetic", "createTavilyClient throws structured error when api key is missing", async () => {
  const previous = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;

  try {
    assert.throws(
      () =>
        createTavilyClient({
          tavilyFactory() {
            throw new Error("factory should not be called");
          },
        }),
      (error: unknown) => {
        const cast = error as { code?: string; details?: Record<string, unknown> };
        assert.equal(cast.code, "TOOL_PROVIDER_FAILED");
        assert.equal(cast.details?.envVar, "TAVILY_API_KEY");
        assert.equal(cast.details?.classification, "configuration");
        return true;
      },
    );
  } finally {
    if (previous !== undefined) {
      process.env.TAVILY_API_KEY = previous;
    }
  }
});

contractTest("runtime.hermetic", "createTavilyClient treats an explicit environment as authoritative", () => {
  const previous = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "global-key-must-not-leak";
  let capturedApiKey: string | undefined;

  try {
    assert.throws(
      () => createTavilyClient({
        env: {},
        tavilyFactory() {
          throw new Error("factory should not be called without an explicit key");
        },
      }),
      /Missing Tavily API key/u,
    );

    createTavilyClient({
      env: { TAVILY_API_KEY: "core-owned-key" },
      tavilyFactory(options) {
        capturedApiKey = options?.apiKey;
        return createNoopClient();
      },
    });
    assert.equal(capturedApiKey, "core-owned-key");
  } finally {
    if (previous === undefined) {
      delete process.env.TAVILY_API_KEY;
    } else {
      process.env.TAVILY_API_KEY = previous;
    }
  }
});

function createNoopClient(): TavilySdkClient {
  return {
    search: async () => {
      throw new Error("search not implemented");
    },
    extract: async () => {
      throw new Error("extract not implemented");
    },
    crawl: async () => {
      throw new Error("crawl not implemented");
    },
	    map: async () => {
	      throw new Error("map not implemented");
	    },
	    research: async () => {
	      throw new Error("research not implemented");
	    },
	    getResearch: async () => {
	      throw new Error("getResearch not implemented");
	    },
	  };
	}
