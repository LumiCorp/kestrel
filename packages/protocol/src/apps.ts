/** Stable executable plugin identities shared by Kestrel Desktop and Kestrel One. */
export const KESTREL_APP_IDS = {
  WEATHER: "built_in.weather", TIME: "built_in.time", GEOCODING: "built_in.geocoding", EXCHANGE_RATES: "built_in.exchange_rates", KNOWLEDGE_SEARCH: "built_in.knowledge_search", SANDBOX: "built_in.sandbox", ARTIFACTS: "built_in.artifacts", GITHUB: "github", GOOGLE_WORKSPACE: "google_workspace", MICROSOFT_365: "microsoft_365", TAVILY: "tavily", LINEAR: "linear", NOTION: "notion", SLACK: "slack", ATLASSIAN: "atlassian", VERCEL: "vercel",
} as const;

export type KestrelAppId = (typeof KESTREL_APP_IDS)[keyof typeof KESTREL_APP_IDS];
export type AppPluginRuntimeDriver = "builtin" | "cli" | "mcp-stdio" | "mcp-http" | "api";
export type AppPluginInstallScope = "desktop" | "project" | "hosted";
export type KestrelAppCapabilityPack = { key: string; name: string; description: string };
/** Product metadata. Runtime-driver wiring remains internal to each host. */
export type AppPluginManifest = { id: KestrelAppId; version: number; name: string; description: string; installScope: AppPluginInstallScope; preinstalled?: boolean; capabilityPacks: KestrelAppCapabilityPack[]; configurationSchema?: Readonly<Record<string, unknown>>; credentialBindings?: readonly string[]; permissions?: readonly string[] };
/** Compatibility name during the app-to-plugin transition. */
export type KestrelAppManifest = AppPluginManifest;
const p = (id: KestrelAppId, name: string, description: string, capabilityPacks: KestrelAppCapabilityPack[], preinstalled = false): AppPluginManifest => ({ id, version: 1, name, description, installScope: "desktop", ...(preinstalled ? { preinstalled: true } : {}), capabilityPacks });
const c = (key: string, name: string, description: string): KestrelAppCapabilityPack => ({ key, name, description });

export const KESTREL_STANDARD_APP_MANIFESTS: readonly AppPluginManifest[] = [
  p(KESTREL_APP_IDS.WEATHER, "Weather", "Check current conditions and forecasts around the world.", [c("weather", "Conditions and forecasts", "Read current conditions and forecasts.")], true),
  p(KESTREL_APP_IDS.TIME, "Time", "Find the current time in any timezone.", [c("time", "Current time", "Read local time for a timezone.")], true),
  p(KESTREL_APP_IDS.GEOCODING, "Geocoding", "Resolve place names to geographic coordinates.", [c("places", "Place lookup", "Find coordinates and place details.")], true),
  p(KESTREL_APP_IDS.EXCHANGE_RATES, "Exchange Rates", "Read current reference exchange rates.", [c("rates", "Currency rates", "Look up supported currency rates.")], true),
  p(KESTREL_APP_IDS.KNOWLEDGE_SEARCH, "Knowledge Search", "Find information in connected Kestrel knowledge.", [c("search", "Knowledge search", "Search authorized knowledge with evidence.")], true),
  p(KESTREL_APP_IDS.SANDBOX, "Sandbox", "Run governed commands in an isolated workspace.", [c("commands", "Workspace commands", "Run bounded workspace commands.")], true),
  p(KESTREL_APP_IDS.ARTIFACTS, "Artifacts", "Create and maintain conversation documents.", [c("documents", "Documents", "Create and review artifacts.")], true),
  p(KESTREL_APP_IDS.MICROSOFT_365, "Microsoft 365", "Work with Outlook, Teams, and SharePoint.", [c("outlook", "Outlook", "Read mail and calendars."), c("teams", "Teams", "Read chats and send approved messages."), c("sharepoint", "SharePoint", "Find sites.")]),
  p(KESTREL_APP_IDS.GOOGLE_WORKSPACE, "Google Workspace", "Read and manage Google Calendar.", [c("calendar", "Calendar", "Read availability and manage events.")]),
  p(KESTREL_APP_IDS.GITHUB, "GitHub", "Work with repositories, issues, pull requests, and releases.", [c("repositories", "Repositories", "Read repository content and push governed branches."), c("delivery", "Issues and pull requests", "Manage issues and pull requests."), c("automation", "Actions and releases", "Run workflows and releases with approval.")]),
  p(KESTREL_APP_IDS.LINEAR, "Linear", "Plan, track, and update product work.", [c("issues", "Issues", "Find and update issues."), c("planning", "Projects and roadmaps", "Read and update projects.")]),
  p(KESTREL_APP_IDS.NOTION, "Notion", "Find, create, and maintain workspace knowledge.", [c("search", "Search", "Find content."), c("pages", "Pages", "Read and update pages."), c("databases", "Databases", "Query structured data.")]),
  p(KESTREL_APP_IDS.SLACK, "Slack", "Find conversations and collaborate in Slack.", [c("search", "Search and history", "Find channels and history."), c("messages", "Messages", "Send approved messages.")]),
  p(KESTREL_APP_IDS.ATLASSIAN, "Atlassian", "Coordinate Jira and Confluence.", [c("jira", "Jira", "Manage work items."), c("confluence", "Confluence", "Manage shared knowledge.")]),
  p(KESTREL_APP_IDS.VERCEL, "Vercel", "Inspect projects, deployments, and operations.", [c("projects", "Projects", "Inspect project configuration."), c("deployments", "Deployments", "Manage deployments with approval."), c("operations", "Logs and domains", "Inspect delivery health.")]),
  p(KESTREL_APP_IDS.TAVILY, "Tavily", "Search, extract, crawl, and research the web.", [c("search", "Web research", "Search and research the web.")]),
];
export function getKestrelStandardAppManifest(id: KestrelAppId) { return KESTREL_STANDARD_APP_MANIFESTS.find((app) => app.id === id); }
