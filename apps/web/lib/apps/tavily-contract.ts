export const TAVILY_RUNTIME_CAPABILITIES = [
  "search",
  "search_advanced",
  "news",
  "images",
  "extract",
  "crawl",
  "map",
  "research",
  "research_status",
  "usage",
] as const;

export type TavilyRuntimeCapability =
  (typeof TAVILY_RUNTIME_CAPABILITIES)[number];

export class TavilyRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 403) {
    super(code);
    this.name = "TavilyRuntimeError";
    this.code = code;
    this.status = status;
  }
}

export function assertTavilyProxyTarget(input: {
  capability: TavilyRuntimeCapability;
  method: string;
  path: string[];
}) {
  const method = input.method.toUpperCase();
  const singlePath: Partial<
    Record<TavilyRuntimeCapability, { method: "GET" | "POST"; path: string }>
  > = {
    search: { method: "POST", path: "search" },
    search_advanced: { method: "POST", path: "search" },
    news: { method: "POST", path: "search" },
    images: { method: "POST", path: "search" },
    extract: { method: "POST", path: "extract" },
    crawl: { method: "POST", path: "crawl" },
    map: { method: "POST", path: "map" },
    research: { method: "POST", path: "research" },
    usage: { method: "GET", path: "usage" },
  };
  const expected = singlePath[input.capability];
  if (
    expected &&
    method === expected.method &&
    input.path.length === 1 &&
    input.path[0] === expected.path
  ) {
    return;
  }
  if (
    input.capability === "research_status" &&
    method === "GET" &&
    input.path.length === 2 &&
    input.path[0] === "research" &&
    /^[A-Za-z0-9_-]{1,256}$/u.test(input.path[1] ?? "")
  ) {
    return;
  }
  throw new TavilyRuntimeError("TAVILY_PROXY_TARGET_DENIED", 404);
}
