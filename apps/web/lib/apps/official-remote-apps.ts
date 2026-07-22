import { KESTREL_APP_IDS } from "@kestrel-agents/protocol";

export type OfficialRemoteTokenApp = {
  appKey: string;
  displayName: string;
  slug: string;
  remoteUrl: string;
  authorizationHeader: (token: string) => string;
};

export type OfficialRemoteOauthApp = {
  appKey: string;
  displayName: string;
  slug: string;
  remoteUrl: string;
  oauthClient?: {
    clientIdEnvironmentVariable: string;
    clientSecretEnvironmentVariable: string;
    tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
  };
  capabilityPackScopes?: Record<string, readonly string[]>;
  acceptedTokenTypes?: readonly string[];
};

const OFFICIAL_REMOTE_TOKEN_APPS: readonly OfficialRemoteTokenApp[] = [
  {
    appKey: KESTREL_APP_IDS.LINEAR,
    displayName: "Linear",
    slug: "linear",
    remoteUrl: "https://mcp.linear.app/mcp",
    authorizationHeader: (token) => `Bearer ${token}`,
  },
  {
    appKey: KESTREL_APP_IDS.ATLASSIAN,
    displayName: "Atlassian",
    slug: "atlassian",
    remoteUrl: "https://mcp.atlassian.com/v1/mcp",
    authorizationHeader: (token) => `Bearer ${token}`,
  },
];

const OFFICIAL_REMOTE_OAUTH_APPS: readonly OfficialRemoteOauthApp[] = [
  {
    appKey: KESTREL_APP_IDS.NOTION,
    displayName: "Notion",
    slug: "notion",
    remoteUrl: "https://mcp.notion.com/mcp",
  },
  {
    appKey: KESTREL_APP_IDS.SLACK,
    displayName: "Slack",
    slug: "slack",
    remoteUrl: "https://mcp.slack.com/mcp",
    oauthClient: {
      clientIdEnvironmentVariable: "SLACK_MCP_CLIENT_ID",
      clientSecretEnvironmentVariable: "SLACK_MCP_CLIENT_SECRET",
      tokenEndpointAuthMethod: "client_secret_basic",
    },
    capabilityPackScopes: {
      search: [
        "search:read.public",
        "search:read.private",
        "search:read.mpim",
        "search:read.im",
        "search:read.files",
        "search:read.users",
        "files:read",
        "channels:history",
        "groups:history",
        "mpim:history",
        "im:history",
        "channels:read",
        "groups:read",
        "mpim:read",
      ],
      messages: ["chat:write"],
    },
    acceptedTokenTypes: ["bearer", "user"],
  },
];

export function resolveOfficialOauthCapabilitySelection(input: {
  app: OfficialRemoteOauthApp;
  capabilityPacks?: string[];
}) {
  const configured = input.app.capabilityPackScopes;
  if (!configured) {
    if (input.capabilityPacks?.length) {
      throw new Error("This App does not select permissions before connection.");
    }
    return { capabilityPacks: [] as string[], scopes: undefined };
  }
  const selected = [...new Set(input.capabilityPacks ?? [])];
  if (!selected.length) {
    throw new Error("Choose at least one App capability before connecting.");
  }
  if (selected.some((pack) => !configured[pack])) {
    throw new Error("The App capability selection is invalid.");
  }
  return {
    capabilityPacks: selected,
    scopes: [...new Set(selected.flatMap((pack) => configured[pack] ?? []))],
  };
}

export function getOfficialRemoteTokenApp(appKey: string) {
  return OFFICIAL_REMOTE_TOKEN_APPS.find((app) => app.appKey === appKey) ?? null;
}

export function listOfficialRemoteTokenApps() {
  return [...OFFICIAL_REMOTE_TOKEN_APPS];
}

export function getOfficialRemoteOauthApp(appKey: string) {
  return OFFICIAL_REMOTE_OAUTH_APPS.find((app) => app.appKey === appKey) ?? null;
}

export function listOfficialRemoteOauthApps() {
  return [...OFFICIAL_REMOTE_OAUTH_APPS];
}
