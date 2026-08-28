import {
  getKestrelStandardAppManifest,
  KESTREL_APP_IDS,
} from "@kestrel-agents/protocol";
import type {
  ToolCapabilityDefinition,
  ToolCapabilityPolicy,
  ToolProviderDefinition,
  ToolProviderKey,
} from "./types.js";
function createDefaultPolicy(
  overrides: Partial<ToolCapabilityPolicy>,
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
  },
): ToolCapabilityDefinition {
  return {
    ...definition,
    defaultPolicy: createDefaultPolicy(definition.defaultPolicy ?? {}),
  };
}

const LINEAR_APP_MANIFEST = getKestrelStandardAppManifest(
  KESTREL_APP_IDS.LINEAR,
);
if (!LINEAR_APP_MANIFEST) {
  throw new Error("Linear App manifest is unavailable.");
}
const ATLASSIAN_APP_MANIFEST = getKestrelStandardAppManifest(
  KESTREL_APP_IDS.ATLASSIAN,
);
if (!ATLASSIAN_APP_MANIFEST) {
  throw new Error("Atlassian App manifest is unavailable.");
}
const NOTION_APP_MANIFEST = getKestrelStandardAppManifest(
  KESTREL_APP_IDS.NOTION,
);
if (!NOTION_APP_MANIFEST) {
  throw new Error("Notion App manifest is unavailable.");
}
const SLACK_APP_MANIFEST = getKestrelStandardAppManifest(KESTREL_APP_IDS.SLACK);
if (!SLACK_APP_MANIFEST) {
  throw new Error("Slack App manifest is unavailable.");
}
const VERCEL_APP_MANIFEST = getKestrelStandardAppManifest(
  KESTREL_APP_IDS.VERCEL,
);
if (!VERCEL_APP_MANIFEST) {
  throw new Error("Vercel App manifest is unavailable.");
}
const MICROSOFT_365_APP_MANIFEST = getKestrelStandardAppManifest(
  KESTREL_APP_IDS.MICROSOFT_365,
);
if (!MICROSOFT_365_APP_MANIFEST) {
  throw new Error("Microsoft 365 App manifest is unavailable.");
}

export const TOOL_PROVIDER_REGISTRY: ToolProviderDefinition[] = [
  {
    key: "built_in.workspace",
    displayName: "Workspace",
    description: "Work with the hosted project workspace.",
    type: "built_in",
    authType: "system",
    app: {
      category: "engineering",
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
        key: "executeCommand",
        runtimeName: "exec_command",
        displayName: "Execute command",
        description: "Run a command in the hosted project workspace.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
    ],
  },
  {
    key: "built_in.previews",
    displayName: "Kestrel Edge Previews",
    description:
      "Publish anonymous HTTPS URLs for HTTP apps through the Kestrel Edge ingress.",
    type: "built_in",
    authType: "system",
    app: {
      category: "engineering",
      connectionModel: "none",
      connectionRequirement: "none",
      authMethods: ["none"],
      delivery: "lifecycle",
      installMode: "inherited",
      icon: "external-link",
    },
    metadata: {
      icon: "external-link",
      category: "built_in",
      provider: "kestrel_edge",
    },
    capabilities: [
      createCapability({
        key: "publish",
        runtimeName: "workspace.preview.publish",
        displayName: "Publish preview",
        description:
          "Expose a listening local HTTP port at a public URL. In the final response, copy the returned preview.url byte-for-byte; never infer, normalize, shorten, or replace its hostname.",
        accessMode: "write",
        defaultPolicy: { loggingMode: "metadata_only", rateLimitMode: "off" },
      }),
      createCapability({
        key: "list",
        runtimeName: "workspace.preview.list",
        displayName: "List previews",
        description: "List active public Workspace previews.",
        accessMode: "status",
        defaultPolicy: { loggingMode: "metadata_only", rateLimitMode: "off" },
      }),
      createCapability({
        key: "inspect",
        runtimeName: "workspace.preview.inspect",
        displayName: "Inspect preview port",
        description: "Check whether a local Workspace port is listening.",
        accessMode: "status",
        defaultPolicy: { loggingMode: "metadata_only", rateLimitMode: "off" },
      }),
      createCapability({
        key: "renew",
        runtimeName: "workspace.preview.renew",
        displayName: "Renew preview",
        description: "Extend a preview within its maximum lifetime.",
        accessMode: "write",
        defaultPolicy: { loggingMode: "metadata_only", rateLimitMode: "off" },
      }),
      createCapability({
        key: "close",
        runtimeName: "workspace.preview.close",
        displayName: "Close preview",
        description: "Permanently close a public preview URL.",
        accessMode: "write",
        defaultPolicy: { loggingMode: "metadata_only", rateLimitMode: "off" },
      }),
    ],
  },
  {
    key: KESTREL_APP_IDS.WEATHER,
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
    key: KESTREL_APP_IDS.TIME,
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
    key: KESTREL_APP_IDS.GEOCODING,
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
    key: KESTREL_APP_IDS.EXCHANGE_RATES,
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
    key: KESTREL_APP_IDS.KNOWLEDGE_SEARCH,
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
        runtimeName: "kestrel_one.search_knowledge_documents",
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
    key: KESTREL_APP_IDS.ARTIFACTS,
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
        runtimeName: null,
        displayName: "Create Document",
        description: "Create an artifact document beside the conversation.",
        accessMode: "write",
      }),
      createCapability({
        key: "updateDocument",
        runtimeName: null,
        displayName: "Update Document",
        description: "Update an existing artifact document.",
        accessMode: "write",
      }),
      createCapability({
        key: "requestSuggestions",
        runtimeName: null,
        displayName: "Request Suggestions",
        description: "Request suggestions for an artifact document.",
        accessMode: "read",
      }),
      createCapability({
        key: "createWordDocument",
        runtimeName: "kestrel_one.word_document_create",
        displayName: "Create Word Document",
        description: "Create a downloadable Microsoft Word document.",
        accessMode: "write",
      }),
    ],
  },
  {
    key: KESTREL_APP_IDS.GITHUB,
    displayName: "GitHub",
    description:
      "Connect explicitly granted GitHub repositories to Projects and workspaces.",
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
        runtimeName: "kestrel_one.github_repository_read",
        displayName: "Read repository",
        description: "Clone and read an explicitly granted GitHub repository.",
        accessMode: "read",
        defaultPolicy: { approvalMode: "auto", loggingMode: "metadata_only" },
      }),
      createCapability({
        key: "repository.push_agent_branch",
        runtimeName: "kestrel_one.github_push_agent_branch",
        displayName: "Push agent branch",
        description:
          "Push the current managed worktree to a Kestrel-owned agent branch in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "auto" },
      }),
      createCapability({
        key: "repository.initialize",
        runtimeName: null,
        displayName: "Initialize repository",
        description:
          "Create main in an empty, explicitly granted repository from one reviewed Workspace candidate.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
        minimumApprovalMode: "ask",
      }),
      createCapability({
        key: "pull_request.write",
        runtimeName: "kestrel_one.github_pull_request_create",
        displayName: "Create and update pull requests",
        description:
          "Create or update pull requests in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "issue.write",
        runtimeName: "kestrel_one.github_issue_create",
        displayName: "Create and update issues",
        description:
          "Create or update issues in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "merge.write",
        runtimeName: "kestrel_one.github_pull_request_merge",
        displayName: "Merge pull requests",
        description:
          "Merge an approved pull request in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "release.write",
        runtimeName: "kestrel_one.github_release_create",
        displayName: "Create releases",
        description: "Create a release in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
      createCapability({
        key: "workflow.dispatch",
        runtimeName: "kestrel_one.github_workflow_dispatch",
        displayName: "Dispatch workflows",
        description:
          "Dispatch a selected workflow in an explicitly granted repository.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask" },
      }),
    ],
  },
  {
    key: KESTREL_APP_IDS.GOOGLE_WORKSPACE,
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
        runtimeName: "kestrel_one.google_calendar_list_events",
        displayName: "List calendar events",
        description: "List events from the connected user's primary calendar.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.events.create",
        runtimeName: "kestrel_one.google_calendar_create_event",
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
        runtimeName: "kestrel_one.google_calendar_update_event",
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
        runtimeName: "kestrel_one.google_calendar_delete_event",
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
        runtimeName: "kestrel_one.google_calendar_list_availability_subjects",
        displayName: "List availability subjects",
        description:
          "List Project teammates who opted in to free/busy sharing.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { audience: "self" },
      }),
      createCapability({
        key: "calendar.availability.read",
        runtimeName: "kestrel_one.google_calendar_check_availability",
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
    key: "email",
    displayName: "Email",
    description:
      "Send organization email through the verified Resend sender configured by an Organization Admin.",
    type: "api_key",
    authType: "api_key",
    app: {
      category: "communication",
      connectionModel: "organization",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "native",
      installMode: "explicit",
      icon: "mail",
      configurationPath: "/organization/email",
    },
    metadata: {
      icon: "mail",
      category: "communication",
      provider: "resend",
      credentialOwner: "organization",
    },
    capabilities: [
      createCapability({
        key: "send",
        runtimeName: "kestrel_one.email_send",
        displayName: "Send email",
        description:
          "Send an external email from the organization's verified sender. Every message requires human approval; attachments are not supported.",
        accessMode: "write",
        minimumApprovalMode: "ask",
        defaultPolicy: {
          enabled: false,
          approvalMode: "ask",
          rateLimitMode: "strict",
          loggingMode: "metadata_only",
        },
        metadata: {
          audience: "project",
          group: "delivery",
          approvalRequired: true,
          attachmentsSupported: false,
          maxRecipients: 20,
        },
      }),
    ],
  },
  {
    key: KESTREL_APP_IDS.TAVILY,
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
    key: KESTREL_APP_IDS.MICROSOFT_365,
    displayName: MICROSOFT_365_APP_MANIFEST.name,
    description: "Work with Outlook and Teams.",
    type: "oauth",
    authType: "oauth",
    app: {
      category: "productivity",
      connectionModel: "personal",
      connectionRequirement: "required",
      authMethods: ["oauth_personal"],
      delivery: "oauth",
      installMode: "explicit",
      icon: "microsoft",
    },
    metadata: {
      icon: "microsoft",
      category: "productivity",
      capabilityPacks: MICROSOFT_365_APP_MANIFEST.capabilityPacks.filter(
        (pack) => pack.key === "outlook" || pack.key === "teams",
      ),
    },
    capabilities: [
      createCapability({
        key: "outlook.mail.read",
        runtimeName: "kestrel_one.microsoft_365_list_mail",
        displayName: "Read mail",
        description: "Find and read messages in the connected mailbox.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "outlook", audience: "self", pack: "outlook" },
      }),
      createCapability({
        key: "outlook.mail.send",
        runtimeName: "kestrel_one.microsoft_365_send_mail",
        displayName: "Send mail",
        description: "Send mail from the connected mailbox with approval.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask", loggingMode: "metadata_only" },
        metadata: { group: "outlook", audience: "self", pack: "outlook" },
      }),
      createCapability({
        key: "outlook.calendar.read",
        runtimeName: "kestrel_one.microsoft_365_list_events",
        displayName: "Read calendar",
        description: "List events from the connected user's calendar.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "outlook", audience: "self", pack: "outlook" },
      }),
      createCapability({
        key: "teams.chat.read",
        runtimeName: "kestrel_one.microsoft_365_list_chats",
        displayName: "Read chats",
        description: "List and read the connected user's Teams chats.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "teams", audience: "self", pack: "teams" },
      }),
      createCapability({
        key: "teams.chat.send",
        runtimeName: "kestrel_one.microsoft_365_send_chat_message",
        displayName: "Send chat messages",
        description: "Send a Teams chat message with approval.",
        accessMode: "write",
        defaultPolicy: { approvalMode: "ask", loggingMode: "metadata_only" },
        metadata: { group: "teams", audience: "self", pack: "teams" },
      }),
    ],
  },
  {
    key: KESTREL_APP_IDS.LINEAR,
    displayName: LINEAR_APP_MANIFEST.name,
    description: LINEAR_APP_MANIFEST.description,
    type: "api_key",
    authType: "api_key",
    app: {
      category: "engineering",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "mcp",
      installMode: "explicit",
      icon: "linear",
    },
    metadata: {
      icon: "linear",
      category: "engineering",
      official: true,
    },
    capabilities: [],
  },
  {
    key: KESTREL_APP_IDS.ATLASSIAN,
    displayName: ATLASSIAN_APP_MANIFEST.name,
    description: ATLASSIAN_APP_MANIFEST.description,
    type: "api_key",
    authType: "api_key",
    app: {
      category: "engineering",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "mcp",
      installMode: "explicit",
      icon: "atlassian",
    },
    metadata: {
      icon: "atlassian",
      category: "engineering",
      capabilityPacks: ATLASSIAN_APP_MANIFEST.capabilityPacks,
      official: true,
    },
    capabilities: [],
  },
  {
    key: KESTREL_APP_IDS.NOTION,
    displayName: NOTION_APP_MANIFEST.name,
    description: NOTION_APP_MANIFEST.description,
    type: "oauth",
    authType: "oauth",
    app: {
      category: "productivity",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["oauth_environment"],
      delivery: "mcp",
      installMode: "explicit",
      icon: "notion",
    },
    metadata: {
      icon: "notion",
      category: "productivity",
      capabilityPacks: NOTION_APP_MANIFEST.capabilityPacks,
      official: true,
    },
    capabilities: [],
  },
  {
    key: KESTREL_APP_IDS.SLACK,
    displayName: SLACK_APP_MANIFEST.name,
    description: SLACK_APP_MANIFEST.description,
    type: "oauth",
    authType: "oauth",
    app: {
      category: "communication",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["oauth_environment"],
      delivery: "mcp",
      installMode: "explicit",
      icon: "slack",
    },
    metadata: {
      icon: "slack",
      category: "communication",
      capabilityPacks: SLACK_APP_MANIFEST.capabilityPacks,
      connectionCapabilityPacks: SLACK_APP_MANIFEST.capabilityPacks,
      official: true,
    },
    capabilities: [],
  },
  {
    key: KESTREL_APP_IDS.VERCEL,
    displayName: VERCEL_APP_MANIFEST.name,
    description: VERCEL_APP_MANIFEST.description,
    type: "api_key",
    authType: "api_key",
    app: {
      category: "engineering",
      connectionModel: "environment",
      connectionRequirement: "required",
      authMethods: ["api_key"],
      delivery: "api_key",
      installMode: "explicit",
      icon: "vercel",
    },
    metadata: {
      icon: "vercel",
      category: "engineering",
      capabilityPacks: VERCEL_APP_MANIFEST.capabilityPacks,
      official: true,
    },
    capabilities: [
      createCapability({
        key: "projects.read",
        runtimeName: "kestrel_one.vercel_list_projects",
        displayName: "List projects",
        description:
          "Inspect projects available to the connected account or team.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "projects" },
      }),
      createCapability({
        key: "deployments.read",
        runtimeName: "kestrel_one.vercel_list_deployments",
        displayName: "List deployments",
        description: "Inspect recent deployments and their delivery state.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "deployments" },
      }),
      createCapability({
        key: "operations.read",
        runtimeName: "kestrel_one.vercel_deployment_events",
        displayName: "Read deployment events",
        description:
          "Inspect bounded build and runtime events for one deployment.",
        accessMode: "read",
        defaultPolicy: { loggingMode: "metadata_only" },
        metadata: { group: "operations" },
      }),
    ],
  },
];

export function listToolProviders() {
  return TOOL_PROVIDER_REGISTRY;
}

export function getToolProviderDefinition(providerKey: ToolProviderKey) {
  return TOOL_PROVIDER_REGISTRY.find(
    (provider) => provider.key === providerKey,
  );
}

export function getToolCapabilityDefinition(
  providerKey: ToolProviderKey,
  capabilityKey: string,
) {
  return getToolProviderDefinition(providerKey)?.capabilities.find(
    (capability) => capability.key === capabilityKey,
  );
}

export function listToolRuntimeNames() {
  return TOOL_PROVIDER_REGISTRY.flatMap((provider) =>
    provider.capabilities
      .map((capability) => capability.runtimeName)
      .filter((runtimeName): runtimeName is string => Boolean(runtimeName)),
  );
}

export interface ToolDescriptorRefResolverV1 {
  getDescriptorRef(
    runtimeName: string,
  ): ToolDescriptorReferenceLikeV1 | undefined;
}

export interface ToolDescriptorReferenceLikeV1 {
  toolId: string;
  contractRevision: string;
}

export interface ResolvedToolProviderDescriptorV1 {
  providerKey: ToolProviderKey;
  capabilityKey: string;
  runtimeName: string;
  descriptorRef: ToolDescriptorReferenceLikeV1;
}

/**
 * Resolve the Web App registry strictly as a policy overlay on the canonical
 * runtime manifest. The overlay never owns schemas or handler identity.
 */
export function resolveToolProviderDescriptorRefs(
  resolver: ToolDescriptorRefResolverV1,
): ResolvedToolProviderDescriptorV1[] {
  return TOOL_PROVIDER_REGISTRY.flatMap((provider) =>
    provider.capabilities.flatMap((capability) => {
      if (capability.runtimeName === null) return [];
      const descriptorRef = resolver.getDescriptorRef(capability.runtimeName);
      if (descriptorRef === undefined) {
        throw new Error(
          `Tool provider mapping '${provider.key}.${capability.key}' references missing runtime descriptor '${capability.runtimeName}'`,
        );
      }
      if (descriptorRef.toolId !== capability.runtimeName) {
        throw new Error(
          `Tool provider mapping '${provider.key}.${capability.key}' diverges from descriptor '${descriptorRef.toolId}'`,
        );
      }
      return [
        Object.freeze({
          providerKey: provider.key,
          capabilityKey: capability.key,
          runtimeName: capability.runtimeName,
          descriptorRef,
        }),
      ];
    }),
  );
}
