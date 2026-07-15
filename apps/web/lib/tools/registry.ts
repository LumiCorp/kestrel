import type {
  ToolCapabilityDefinition,
  ToolCapabilityPolicy,
  ToolProviderDefinition,
  ToolProviderKey,
} from "./types";

function createDefaultPolicy(
  overrides: Partial<ToolCapabilityPolicy>
): ToolCapabilityPolicy {
  return {
    enabled: true,
    approvalMode: "auto",
    surfaceAccess: { chat: true, admin: false },
    rateLimitMode: "default",
    loggingMode: "full",
    settings: {},
    ...overrides,
  };
}

function createCapability(
  definition: Omit<ToolCapabilityDefinition, "defaultPolicy"> & {
    defaultPolicy?: Partial<ToolCapabilityPolicy>;
  }
): ToolCapabilityDefinition {
  return {
    ...definition,
    defaultPolicy: createDefaultPolicy(definition.defaultPolicy ?? {}),
  };
}

export const TOOL_PROVIDER_REGISTRY: ToolProviderDefinition[] = [
  {
    key: "built_in.weather",
    displayName: "Weather",
    description:
      "Get current conditions and multi-day forecasts for a location.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "environment",
      connectionRequirement: "optional",
      authMethods: ["api_key"],
      delivery: "native",
      installMode: "inherited",
      icon: "cloud-sun",
    },
    metadata: {
      icon: "cloud-sun",
      category: "built_in",
    },
    capabilities: [
      createCapability({
        key: "getWeather",
        runtimeName: "free.weather.current",
        displayName: "Current weather",
        description: "Get current conditions for a city or coordinates.",
        accessMode: "read",
        metadata: { group: "weather" },
      }),
      createCapability({
        key: "forecast",
        runtimeName: "free.weather.forecast",
        displayName: "Weather forecast",
        description:
          "Get hourly and daily forecasts for a city or coordinates.",
        accessMode: "read",
        metadata: { group: "weather" },
      }),
    ],
  },
  {
    key: "built_in.time",
    displayName: "Time",
    description: "Get the current time in an IANA timezone.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "clock",
    },
    metadata: { icon: "clock", category: "built_in" },
    capabilities: [
      createCapability({
        key: "current",
        runtimeName: "free.time.current",
        displayName: "Current time",
        description: "Get the current time in a requested timezone.",
        accessMode: "read",
        metadata: { group: "time" },
      }),
    ],
  },
  {
    key: "built_in.geocoding",
    displayName: "Geocoding",
    description: "Resolve place names to geographic coordinates.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "map-pin",
    },
    metadata: { icon: "map-pin", category: "built_in" },
    capabilities: [
      createCapability({
        key: "lookup",
        runtimeName: "free.geocode.lookup",
        displayName: "Location lookup",
        description: "Resolve a location query to matching coordinates.",
        accessMode: "read",
        metadata: { group: "locations" },
      }),
    ],
  },
  {
    key: "built_in.exchange_rates",
    displayName: "Exchange Rates",
    description: "Get current reference exchange rates for world currencies.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "arrow-left-right",
    },
    metadata: { icon: "arrow-left-right", category: "built_in" },
    capabilities: [
      createCapability({
        key: "rate",
        runtimeName: "free.exchange.rate",
        displayName: "Exchange rate",
        description:
          "Get current rates for a base and optional quote currency.",
        accessMode: "read",
        metadata: { group: "finance" },
      }),
    ],
  },
  {
    key: "built_in.hacker_news",
    displayName: "Hacker News",
    description: "Get the current top stories from Hacker News.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "newspaper",
    },
    metadata: { icon: "newspaper", category: "built_in" },
    capabilities: [
      createCapability({
        key: "topStories",
        runtimeName: "free.hn.top",
        displayName: "Top stories",
        description: "Get the current top Hacker News stories.",
        accessMode: "read",
        metadata: { group: "news" },
      }),
    ],
  },
  {
    key: "built_in.knowledge_search",
    displayName: "Knowledge Search",
    description: "Search uploaded knowledge documents.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "book-open",
    },
    metadata: {
      icon: "book-open",
      category: "built_in",
    },
    capabilities: [
      createCapability({
        key: "searchKnowledgeDocuments",
        runtimeName: "searchKnowledgeDocuments",
        displayName: "Search Knowledge Documents",
        description:
          "Search uploaded knowledge documents for grouped, citation-ready evidence.",
        accessMode: "read",
        defaultPolicy: {
          loggingMode: "metadata_only",
          settings: { defaultLimit: 5 },
        },
      }),
    ],
  },
  {
    key: "built_in.sandbox",
    displayName: "Sandbox",
    description: "Inspect synced source content with read-only shell commands.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "terminal",
    },
    metadata: {
      icon: "terminal",
      category: "built_in",
    },
    capabilities: [
      createCapability({
        key: "bash",
        runtimeName: "bash",
        displayName: "Sandbox Bash",
        description: "Run one read-only shell command in the synced sandbox.",
        accessMode: "internal",
        defaultPolicy: {
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
      }),
      createCapability({
        key: "bash_batch",
        runtimeName: "bash_batch",
        displayName: "Sandbox Bash Batch",
        description:
          "Run multiple read-only shell commands in the synced sandbox.",
        accessMode: "internal",
        defaultPolicy: {
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
      }),
    ],
  },
  {
    key: "built_in.artifacts",
    displayName: "Artifacts",
    description: "Create and update chat artifacts.",
    type: "built_in",
    authType: "system",
    app: {
      category: "kestrel",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "native",
      installMode: "inherited",
      icon: "file-text",
    },
    metadata: {
      icon: "file-text",
      category: "built_in",
    },
    capabilities: [
      createCapability({
        key: "createDocument",
        runtimeName: "createDocument",
        displayName: "Create Document",
        description: "Create an artifact document beside the conversation.",
        accessMode: "write",
      }),
      createCapability({
        key: "updateDocument",
        runtimeName: "updateDocument",
        displayName: "Update Document",
        description: "Update an existing artifact document.",
        accessMode: "write",
      }),
      createCapability({
        key: "requestSuggestions",
        runtimeName: "requestSuggestions",
        displayName: "Request Suggestions",
        description: "Request suggestions for an artifact document.",
        accessMode: "read",
      }),
    ],
  },
  {
    key: "github",
    displayName: "GitHub",
    description:
      "GitHub bot connection status, webhook readiness, and snapshot-backed runtime health.",
    type: "oauth",
    authType: "oauth",
    app: {
      category: "engineering",
      connectionModel: "personal",
      connectionRequirement: "required",
      authMethods: ["oauth_personal"],
      delivery: "oauth",
      installMode: "explicit",
      icon: "github",
    },
    metadata: {
      icon: "github",
      category: "integration",
    },
    capabilities: [
      createCapability({
        key: "repository.read",
        runtimeName: "githubRepositoryRead",
        displayName: "Read repository",
        description: "Clone and read an explicitly granted GitHub repository.",
        accessMode: "read",
        defaultPolicy: { approvalMode: "auto", loggingMode: "metadata_only" },
      }),
      createCapability({
        key: "repository.push_agent_branch",
        runtimeName: "githubPushAgentBranch",
        displayName: "Push agent branch",
        description:
          "Push the current managed worktree to a Kestrel-owned agent branch in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "auto" },
      }),
      createCapability({
        key: "pull_request.write",
        runtimeName: "githubPullRequestWrite",
        displayName: "Create and update pull requests",
        description:
          "Create or update pull requests in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "issue.write",
        runtimeName: "githubIssueWrite",
        displayName: "Create and update issues",
        description:
          "Create or update issues in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "merge.write",
        runtimeName: "githubMergeWrite",
        displayName: "Merge pull requests",
        description:
          "Merge an approved pull request in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "release.write",
        runtimeName: "githubReleaseWrite",
        displayName: "Create releases",
        description: "Create a release in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "workflow.dispatch",
        runtimeName: "githubWorkflowDispatch",
        displayName: "Dispatch workflows",
        description:
          "Dispatch a selected workflow in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
    ],
  },
  {
    key: "google_workspace",
    displayName: "Google Workspace",
    description:
      "User-owned Google Workspace services connected to shared Projects.",
    type: "oauth",
    authType: "oauth",
    app: {
      category: "productivity",
      connectionModel: "personal",
      connectionRequirement: "required",
      authMethods: ["oauth_personal"],
      delivery: "oauth",
      installMode: "explicit",
      icon: "/integrations/google.svg",
    },
    metadata: {
      icon: "google",
      category: "integration",
      connectionModel: "user_oauth",
    },
    capabilities: [
      createCapability({
        key: "calendar.events.read",
        runtimeName: "googleCalendarListEvents",
        displayName: "List calendar events",
        description: "List events from the connected user's primary calendar.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.events.create",
        runtimeName: "googleCalendarCreateEvent",
        displayName: "Create calendar events",
        description: "Create events on the connected user's primary calendar.",
        accessMode: "write",
        defaultPolicy: {
          approvalMode: "ask",
          loggingMode: "metadata_only",
        },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.events.update",
        runtimeName: "googleCalendarUpdateEvent",
        displayName: "Update calendar events",
        description: "Update events on the connected user's primary calendar.",
        accessMode: "write",
        defaultPolicy: {
          approvalMode: "ask",
          loggingMode: "metadata_only",
        },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.events.delete",
        runtimeName: "googleCalendarDeleteEvent",
        displayName: "Delete calendar events",
        description:
          "Delete events from the connected user's primary calendar.",
        accessMode: "write",
        defaultPolicy: {
          approvalMode: "ask",
          loggingMode: "metadata_only",
        },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.availability.subjects",
        runtimeName: "googleCalendarListAvailabilitySubjects",
        displayName: "List availability subjects",
        description:
          "List Project teammates who opted in to free/busy sharing.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.availability.read",
        runtimeName: "googleCalendarCheckAvailability",
        displayName: "Check teammate availability",
        description:
          "Read normalized free/busy intervals for opted-in Project teammates.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { audience: "self_or_project" },
      }),
    ],
  },
  {
    key: "tavily",
    displayName: "Tavily",
    description:
      "Search, extract, crawl, map, and research the web with source-aware results.",
    type: "api_key",
    authType: "api_key",
    app: {
      category: "search_research",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "api_key",
      installMode: "explicit",
      icon: "/integrations/tavily.png",
    },
    metadata: {
      icon: "/integrations/tavily.png",
      category: "search_research",
      connectionModel: "environment",
      provider: "tavily",
    },
    capabilities: [
      createCapability({
        key: "search",
        runtimeName: "internet.search",
        displayName: "Search the web",
        description: "Search the web and return source-aware results.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "search" },
      }),
      createCapability({
        key: "search_advanced",
        runtimeName: "internet.search_advanced",
        displayName: "Advanced search",
        description:
          "Run advanced web searches with domain, depth, and result controls.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "search" },
      }),
      createCapability({
        key: "news",
        runtimeName: "internet.news",
        displayName: "Search news",
        description: "Search recent news with source-aware results.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "search" },
      }),
      createCapability({
        key: "images",
        runtimeName: "internet.images",
        displayName: "Search images",
        description: "Find relevant web images and their source pages.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "search" },
      }),
      createCapability({
        key: "extract",
        runtimeName: "internet.extract",
        displayName: "Extract pages",
        description: "Extract readable content from selected web pages.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "content" },
      }),
      createCapability({
        key: "crawl",
        runtimeName: "internet.crawl",
        displayName: "Crawl a site",
        description: "Crawl a selected site within configured limits.",
        accessMode: "read",
        defaultPolicy: {
          approvalMode: "ask",
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
        metadata: { group: "research" },
      }),
      createCapability({
        key: "map",
        runtimeName: "internet.map",
        displayName: "Map a site",
        description: "Discover and map pages within a selected site.",
        accessMode: "read",
        defaultPolicy: {
          approvalMode: "ask",
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
        metadata: { group: "research" },
      }),
      createCapability({
        key: "research",
        runtimeName: "internet.research",
        displayName: "Run research",
        description: "Run a longer, multi-source Tavily research task.",
        accessMode: "read",
        defaultPolicy: {
          approvalMode: "ask",
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
        metadata: { group: "research" },
      }),
      createCapability({
        key: "research_status",
        runtimeName: "internet.research_status",
        displayName: "Check research status",
        description: "Check the status of a Tavily research task.",
        accessMode: "status",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "research" },
      }),
      createCapability({
        key: "usage",
        runtimeName: "internet.usage",
        displayName: "View usage",
        description: "View Tavily plan and usage metadata for administrators.",
        accessMode: "status",
        defaultPolicy: {
          enabled: false,
          approvalMode: "deny",
          rateLimitMode: "strict",
          loggingMode: "minimal",
        },
        metadata: { adminOnly: true, group: "administration" },
      }),
    ],
  },
  {
    key: "discord",
    displayName: "Discord",
    description:
      "Discord bot connection status, guild binding, and gateway runtime health.",
    type: "inbound_adapter",
    authType: "env",
    app: {
      category: "communication",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "webhook",
      installMode: "explicit",
      icon: "message-square",
    },
    metadata: {
      icon: "message-square",
      category: "integration",
    },
    capabilities: [],
  },
  {
    key: "source.github",
    displayName: "GitHub Sources",
    description:
      "Manage GitHub repository source ingestion and snapshot readiness for the knowledge sandbox.",
    type: "source_connector",
    authType: "system",
    app: {
      category: "knowledge_sources",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["deployment_managed"],
      delivery: "source",
      installMode: "explicit",
      icon: "github",
    },
    metadata: {
      icon: "github",
      category: "sources",
    },
    capabilities: [],
  },
  {
    key: "source.youtube",
    displayName: "YouTube Sources",
    description:
      "Manage YouTube transcript source ingestion and snapshot readiness for the knowledge sandbox.",
    type: "source_connector",
    authType: "api_key",
    app: {
      category: "knowledge_sources",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "source",
      installMode: "explicit",
      icon: "video",
    },
    metadata: {
      icon: "video",
      category: "sources",
    },
    capabilities: [],
  },
];

export function listToolProviders() {
  return TOOL_PROVIDER_REGISTRY;
}

export function getToolProviderDefinition(providerKey: ToolProviderKey) {
  return TOOL_PROVIDER_REGISTRY.find(
    (provider) => provider.key === providerKey
  );
}

export function getToolCapabilityDefinition(
  providerKey: ToolProviderKey,
  capabilityKey: string
) {
  return getToolProviderDefinition(providerKey)?.capabilities.find(
    (capability) => capability.key === capabilityKey
  );
}

export function listToolRuntimeNames() {
  return TOOL_PROVIDER_REGISTRY.flatMap((provider) =>
    provider.capabilities
      .map((capability) => capability.runtimeName)
      .filter((runtimeName): runtimeName is string => Boolean(runtimeName))
  );
}
