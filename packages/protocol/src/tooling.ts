/** Canonical public names for the runtime-owned, no-credential built-in tools. */
export const RUNNER_BUILT_IN_TOOL_NAMES = [
  "free.weather.current",
  "free.weather.forecast",
  "free.time.current",
  "free.geocode.lookup",
  "free.exchange.rate",
  "free.hn.top",
] as const;

export type RunnerBuiltInToolName =
  (typeof RUNNER_BUILT_IN_TOOL_NAMES)[number];

/** Runtime tool names that public application capability registries may bind. */
export const RUNNER_SHARED_TOOL_NAMES = [
  ...RUNNER_BUILT_IN_TOOL_NAMES,
  "internet.search",
  "internet.search_advanced",
  "internet.news",
  "internet.images",
  "internet.extract",
  "internet.crawl",
  "internet.map",
  "internet.research",
  "internet.research_status",
  "internet.usage",
] as const;
