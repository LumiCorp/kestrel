import type { SharedToolContext } from "../contracts.js";
import type {
  InternetAdvancedSearchInput,
  InternetCrawlInput,
  InternetExtractInput,
  InternetImagesInput,
  InternetMapInput,
  InternetNewsInput,
  InternetResearchInput,
  InternetResearchStatusInput,
  InternetSearchInput,
  TavilyInternetProvider,
} from "./contracts.js";
import { createTavilyInternetProvider } from "./provider.js";

const CAPABILITY_RUNTIME_NAMES = {
  search: "internet.search",
  search_advanced: "internet.search_advanced",
  news: "internet.news",
  images: "internet.images",
  extract: "internet.extract",
  crawl: "internet.crawl",
  map: "internet.map",
  research: "internet.research",
  research_status: "internet.research_status",
  usage: "internet.usage",
} as const;

type TavilyCapabilityKey = keyof typeof CAPABILITY_RUNTIME_NAMES;

export function createKestrelOneTavilyProvider(input: {
  appUrl: string;
  executionTicket: string;
  approvalModes?: Record<string, "auto" | "ask"> | undefined;
  fetchImpl?: typeof fetch | undefined;
}): TavilyInternetProvider {
  const providers = new Map<TavilyCapabilityKey, TavilyInternetProvider>();
  const providerFor = (capability: TavilyCapabilityKey) => {
    const existing = providers.get(capability);
    if (existing) return existing;
    const runtimeName = CAPABILITY_RUNTIME_NAMES[capability];
    const approval =
      input.approvalModes?.[runtimeName] === "ask" ? "confirmed" : "auto";
    const baseUrl = new URL(
      `/api/runtime/apps/tavily/${capability}/${approval}`,
      input.appUrl
    ).toString();
    const provider = createTavilyInternetProvider({
      apiKey: input.executionTicket,
      baseUrl: baseUrl.replace(/\/$/u, ""),
      fetchImpl: input.fetchImpl,
    });
    providers.set(capability, provider);
    return provider;
  };

  return {
    search: (value: InternetSearchInput) => providerFor("search").search(value),
    searchAdvanced: (value: InternetAdvancedSearchInput) =>
      providerFor("search_advanced").searchAdvanced(value),
    news: (value: InternetNewsInput) => providerFor("news").news(value),
    images: (value: InternetImagesInput) => providerFor("images").images(value),
    extract: (value: InternetExtractInput) =>
      providerFor("extract").extract(value),
    crawl: (value: InternetCrawlInput) => providerFor("crawl").crawl(value),
    map: (value: InternetMapInput) => providerFor("map").map(value),
    research: (value: InternetResearchInput) =>
      providerFor("research").research(value),
    researchStatus: (value: InternetResearchStatusInput) =>
      providerFor("research_status").researchStatus(value),
    usage: () => providerFor("usage").usage(),
  };
}

export function hasKestrelOneTavilyContext(
  context: SharedToolContext
): context is SharedToolContext & {
  kestrelOne: {
    appUrl: string;
    executionTicket: string;
    appApprovalModes?: Record<string, "auto" | "ask"> | undefined;
  };
} {
  return Boolean(
    context.kestrelOne?.appUrl?.trim() &&
      context.kestrelOne.executionTicket?.trim()
  );
}
