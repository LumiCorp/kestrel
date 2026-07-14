import { tavily, type TavilyClient, type TavilyClientOptions } from "@tavily/core";

import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";

export type TavilySdkClient = Pick<TavilyClient, "search" | "extract" | "crawl" | "map" | "research" | "getResearch">;

interface CreateTavilyClientOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  projectId?: string | undefined;
  httpProxy?: string | undefined;
  httpsProxy?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  tavilyFactory?: ((options?: TavilyClientOptions) => TavilySdkClient) | undefined;
}

export function createTavilyClient(
  options: CreateTavilyClientOptions = {},
): TavilySdkClient {
  const env = options.env ?? process.env;
  const apiKey = coalesceNonEmpty(options.apiKey, env.TAVILY_API_KEY);
  if (apiKey === undefined) {
    throw createRuntimeFailure(
      "TOOL_PROVIDER_FAILED",
      "Missing Tavily API key.",
      {
        subsystem: "tooling",
        provider: "tavily",
        classification: "configuration",
        recoverable: false,
        envVar: "TAVILY_API_KEY",
      },
    );
  }

  const baseUrl = coalesceNonEmpty(options.baseUrl, env.TAVILY_BASE_URL);
  const projectId = coalesceNonEmpty(options.projectId, env.TAVILY_PROJECT);
  const httpProxy = coalesceNonEmpty(options.httpProxy, env.TAVILY_HTTP_PROXY);
  const httpsProxy = coalesceNonEmpty(options.httpsProxy, env.TAVILY_HTTPS_PROXY);
  const factory = options.tavilyFactory ?? tavily;

  return factory({
    apiKey,
    ...(baseUrl !== undefined ? { apiBaseURL: baseUrl } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...((httpProxy !== undefined || httpsProxy !== undefined)
      ? {
          proxies: {
            ...(httpProxy !== undefined ? { http: httpProxy } : {}),
            ...(httpsProxy !== undefined ? { https: httpsProxy } : {}),
          },
        }
      : {}),
    clientSource: "kestrel",
  });
}

function coalesceNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}
