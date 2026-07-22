/** Stable product identities shared by Kestrel Desktop and Kestrel One. */
export const KESTREL_APP_IDS = {
  WEATHER: "built_in.weather",
  TIME: "built_in.time",
  GEOCODING: "built_in.geocoding",
  EXCHANGE_RATES: "built_in.exchange_rates",
  KNOWLEDGE_SEARCH: "built_in.knowledge_search",
  SANDBOX: "built_in.sandbox",
  ARTIFACTS: "built_in.artifacts",
  GITHUB: "github",
  GOOGLE_WORKSPACE: "google_workspace",
  MICROSOFT_365: "microsoft_365",
  TAVILY: "tavily",
  LINEAR: "linear",
  NOTION: "notion",
  SLACK: "slack",
  ATLASSIAN: "atlassian",
  VERCEL: "vercel",
  SOFTWARE_DELIVERY: "workflow.software_delivery",
  MEETING_FOLLOW_THROUGH: "workflow.meeting_follow_through",
  INCIDENT_RESPONSE: "workflow.incident_response",
  CUSTOMER_ESCALATION: "workflow.customer_escalation",
} as const;

export type KestrelAppId =
  (typeof KESTREL_APP_IDS)[keyof typeof KESTREL_APP_IDS];

export type KestrelAppCapabilityPack = {
  key: string;
  name: string;
  description: string;
};

export type KestrelAppDependency = {
  role: string;
  appIds: KestrelAppId[];
  minimum: number;
};

export type KestrelAppManifest = {
  id: KestrelAppId;
  name: string;
  description: string;
  category:
    | "built_in"
    | "productivity"
    | "engineering"
    | "communication"
    | "workflow";
  capabilityPacks: KestrelAppCapabilityPack[];
  dependencies?: KestrelAppDependency[];
  workflowInstructions?: string;
};

/**
 * Product-facing manifests for Kestrel's standard App gallery. Delivery and
 * authentication details intentionally do not belong in this shared contract.
 */
export const KESTREL_STANDARD_APP_MANIFESTS: readonly KestrelAppManifest[] = [
  {
    id: KESTREL_APP_IDS.WEATHER,
    name: "Weather",
    description: "Check current conditions and forecasts around the world.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "weather",
        name: "Conditions and forecasts",
        description:
          "Read current conditions and bounded daily or hourly forecasts.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.TIME,
    name: "Time",
    description: "Find the current time in any timezone.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "time",
        name: "Current time",
        description: "Read the current local time for a selected timezone.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.GEOCODING,
    name: "Geocoding",
    description: "Resolve place names to geographic coordinates.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "places",
        name: "Place lookup",
        description: "Find coordinates and normalized place details.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.EXCHANGE_RATES,
    name: "Exchange Rates",
    description: "Read current reference exchange rates for world currencies.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "rates",
        name: "Currency rates",
        description:
          "Look up current reference rates between supported currencies.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.KNOWLEDGE_SEARCH,
    name: "Knowledge Search",
    description: "Find relevant information in connected Kestrel knowledge.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "search",
        name: "Knowledge search",
        description:
          "Search authorized knowledge and return attributable evidence.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.SANDBOX,
    name: "Sandbox",
    description: "Run governed commands in an isolated Kestrel workspace.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "commands",
        name: "Workspace commands",
        description: "Run bounded commands within the authorized workspace.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.ARTIFACTS,
    name: "Artifacts",
    description: "Create and maintain documents beside a conversation.",
    category: "built_in",
    capabilityPacks: [
      {
        key: "documents",
        name: "Documents",
        description: "Create, update, and review conversation artifacts.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.MICROSOFT_365,
    name: "Microsoft 365",
    description:
      "Work with Outlook mail and calendars, Teams chats, and SharePoint sites.",
    category: "productivity",
    capabilityPacks: [
      {
        key: "outlook",
        name: "Outlook",
        description: "Read mail and calendars, and send mail with approval.",
      },
      {
        key: "teams",
        name: "Teams",
        description: "Read chats and send messages with approval.",
      },
      {
        key: "sharepoint",
        name: "SharePoint",
        description: "Find SharePoint sites available to the connected user.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.GOOGLE_WORKSPACE,
    name: "Google Workspace",
    description: "Read and manage events in Google Calendar.",
    category: "productivity",
    capabilityPacks: [
      {
        key: "calendar",
        name: "Calendar",
        description: "Read availability and manage events.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.GITHUB,
    name: "GitHub",
    description: "Work with repositories, issues, pull requests, and releases.",
    category: "engineering",
    capabilityPacks: [
      {
        key: "repositories",
        name: "Repositories",
        description: "Read repository content and push governed branches.",
      },
      {
        key: "delivery",
        name: "Issues and pull requests",
        description: "Create and manage issues, pull requests, and merges.",
      },
      {
        key: "automation",
        name: "Actions and releases",
        description: "Run workflows and publish releases with approval.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.LINEAR,
    name: "Linear",
    description: "Plan, track, and update product and engineering work.",
    category: "engineering",
    capabilityPacks: [
      {
        key: "issues",
        name: "Issues",
        description: "Find, create, and update issues.",
      },
      {
        key: "planning",
        name: "Projects and roadmaps",
        description: "Read and update projects, cycles, and roadmaps.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.NOTION,
    name: "Notion",
    description: "Find, create, and maintain workspace knowledge.",
    category: "productivity",
    capabilityPacks: [
      {
        key: "search",
        name: "Search",
        description: "Find pages and workspace content.",
      },
      {
        key: "pages",
        name: "Pages",
        description: "Read, create, and update pages.",
      },
      {
        key: "databases",
        name: "Databases",
        description: "Query and update structured workspace data.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.SLACK,
    name: "Slack",
    description:
      "Find conversations and collaborate in channels and direct messages.",
    category: "communication",
    capabilityPacks: [
      {
        key: "search",
        name: "Search and history",
        description: "Find channels, people, and conversation history.",
      },
      {
        key: "messages",
        name: "Messages",
        description: "Draft, send, and reply to messages with approval.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.ATLASSIAN,
    name: "Atlassian",
    description:
      "Coordinate delivery and knowledge across Jira and Confluence.",
    category: "engineering",
    capabilityPacks: [
      {
        key: "jira",
        name: "Jira",
        description: "Find, create, and update work items and projects.",
      },
      {
        key: "confluence",
        name: "Confluence",
        description: "Find, create, and update shared knowledge.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.VERCEL,
    name: "Vercel",
    description:
      "Inspect projects and deployments and manage delivery operations.",
    category: "engineering",
    capabilityPacks: [
      {
        key: "projects",
        name: "Projects",
        description: "Inspect project configuration and environments.",
      },
      {
        key: "deployments",
        name: "Deployments",
        description: "Inspect, promote, and manage deployments with approval.",
      },
      {
        key: "operations",
        name: "Logs and domains",
        description: "Inspect runtime logs, domains, and delivery health.",
      },
    ],
  },
  {
    id: KESTREL_APP_IDS.SOFTWARE_DELIVERY,
    name: "Software delivery",
    description: "Carry planned work through code review and deployment.",
    category: "workflow",
    capabilityPacks: [
      {
        key: "coordinate",
        name: "Coordinate delivery",
        description: "Link work, code, reviews, and deployment status.",
      },
    ],
    dependencies: [
      { role: "Source control", appIds: [KESTREL_APP_IDS.GITHUB], minimum: 1 },
      {
        role: "Work tracking",
        appIds: [KESTREL_APP_IDS.LINEAR, KESTREL_APP_IDS.ATLASSIAN],
        minimum: 1,
      },
      { role: "Deployment", appIds: [KESTREL_APP_IDS.VERCEL], minimum: 1 },
    ],
    workflowInstructions:
      "Coordinate the selected work item through implementation, code review, and deployment. Keep identifiers and status consistent across the participating Apps, and ask before any action whose App capability requires approval.",
  },
  {
    id: KESTREL_APP_IDS.MEETING_FOLLOW_THROUGH,
    name: "Meeting follow-through",
    description:
      "Turn meetings into shared notes, decisions, and assigned follow-ups.",
    category: "workflow",
    capabilityPacks: [
      {
        key: "follow_through",
        name: "Coordinate follow-through",
        description: "Gather context and publish decisions and actions.",
      },
    ],
    dependencies: [
      {
        role: "Calendar and meetings",
        appIds: [
          KESTREL_APP_IDS.MICROSOFT_365,
          KESTREL_APP_IDS.GOOGLE_WORKSPACE,
        ],
        minimum: 1,
      },
      {
        role: "Shared knowledge",
        appIds: [KESTREL_APP_IDS.NOTION, KESTREL_APP_IDS.MICROSOFT_365],
        minimum: 1,
      },
    ],
    workflowInstructions:
      "Use meeting context to produce shared notes, explicit decisions, owners, and follow-up actions. Confirm ambiguous ownership or deadlines before publishing changes.",
  },
  {
    id: KESTREL_APP_IDS.INCIDENT_RESPONSE,
    name: "Incident response",
    description: "Coordinate investigation, communication, and recovery work.",
    category: "workflow",
    capabilityPacks: [
      {
        key: "respond",
        name: "Coordinate response",
        description:
          "Collect evidence, communicate status, and track recovery actions.",
      },
    ],
    dependencies: [
      {
        role: "Team communication",
        appIds: [KESTREL_APP_IDS.SLACK, KESTREL_APP_IDS.MICROSOFT_365],
        minimum: 1,
      },
      {
        role: "Delivery system",
        appIds: [KESTREL_APP_IDS.GITHUB, KESTREL_APP_IDS.VERCEL],
        minimum: 1,
      },
    ],
    workflowInstructions:
      "Collect current evidence, maintain a concise incident status, coordinate recovery actions, and prepare stakeholder updates. Do not claim recovery until the available delivery evidence verifies it.",
  },
  {
    id: KESTREL_APP_IDS.CUSTOMER_ESCALATION,
    name: "Customer escalation",
    description:
      "Assemble context, coordinate owners, and keep customer follow-up moving.",
    category: "workflow",
    capabilityPacks: [
      {
        key: "coordinate",
        name: "Coordinate escalation",
        description:
          "Gather evidence, assign actions, and prepare status updates.",
      },
    ],
    dependencies: [
      {
        role: "Team communication",
        appIds: [KESTREL_APP_IDS.SLACK, KESTREL_APP_IDS.MICROSOFT_365],
        minimum: 1,
      },
      {
        role: "Work tracking",
        appIds: [KESTREL_APP_IDS.LINEAR, KESTREL_APP_IDS.ATLASSIAN],
        minimum: 1,
      },
    ],
    workflowInstructions:
      "Assemble the customer context, establish owners and next actions, track the work, and prepare clear status updates. Preserve the approval requirements of every participating App.",
  },
] as const;

export function getKestrelStandardAppManifest(id: KestrelAppId) {
  return KESTREL_STANDARD_APP_MANIFESTS.find((app) => app.id === id);
}
