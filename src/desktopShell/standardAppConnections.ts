import { KESTREL_APP_IDS, type KestrelAppId } from "@kestrel-agents/protocol";

interface DesktopStandardAppConnectionBase {
  appId: KestrelAppId;
  url: string;
}

export interface DesktopStandardAppTokenConnectionDefinition extends DesktopStandardAppConnectionBase {
  kind: "token";
  credentialLabel: string;
  credentialPlaceholder: string;
}

export interface DesktopStandardAppAuthorizationConnectionDefinition extends DesktopStandardAppConnectionBase {
  kind: "authorization";
  runtime?: "mcp" | "native" | undefined;
  credentialPrefix: `mcp.${string}`;
  clientIdEnvironmentVariable?: string | undefined;
  capabilityPackScopes?:
    | Readonly<Record<string, readonly string[]>>
    | undefined;
  capabilityPackTools?:
    | Readonly<Record<string, readonly string[]>>
    | undefined;
  capabilityPackRequiredTools?:
    | Readonly<Record<string, readonly string[]>>
    | undefined;
  approvalRequiredTools?: readonly string[] | undefined;
}

export type DesktopStandardAppConnectionDefinition =
  | DesktopStandardAppTokenConnectionDefinition
  | DesktopStandardAppAuthorizationConnectionDefinition;

const DESKTOP_STANDARD_APP_CONNECTIONS: readonly DesktopStandardAppConnectionDefinition[] =
  Object.freeze([
    Object.freeze({
      appId: KESTREL_APP_IDS.GOOGLE_WORKSPACE,
      kind: "authorization",
      runtime: "native",
      url: "https://www.googleapis.com",
      credentialPrefix: "mcp.standard.google_workspace",
      clientIdEnvironmentVariable: "KESTREL_GOOGLE_WORKSPACE_CLIENT_ID",
      capabilityPackScopes: Object.freeze({
        calendar: Object.freeze([
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/calendar.events.owned",
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.freebusy",
        ]),
      }),
      capabilityPackTools: Object.freeze({
        calendar: Object.freeze([
          "google_workspace.list_events",
          "google_workspace.create_event",
          "google_workspace.update_event",
          "google_workspace.delete_event",
        ]),
      }),
      capabilityPackRequiredTools: Object.freeze({
        calendar: Object.freeze([
          "google_workspace.list_events",
          "google_workspace.create_event",
          "google_workspace.update_event",
          "google_workspace.delete_event",
        ]),
      }),
      approvalRequiredTools: Object.freeze([
        "google_workspace.create_event",
        "google_workspace.update_event",
        "google_workspace.delete_event",
      ]),
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.MICROSOFT_365,
      kind: "authorization",
      runtime: "native",
      url: "https://graph.microsoft.com/v1.0",
      credentialPrefix: "mcp.standard.microsoft_365",
      clientIdEnvironmentVariable: "KESTREL_MICROSOFT_365_CLIENT_ID",
      capabilityPackScopes: Object.freeze({
        outlook: Object.freeze(["openid", "profile", "email", "offline_access", "User.Read", "Mail.Read", "Mail.Send", "Calendars.Read"]),
        teams: Object.freeze(["openid", "profile", "email", "offline_access", "User.Read", "Chat.Read", "ChatMessage.Send"]),
        sharepoint: Object.freeze(["openid", "profile", "email", "offline_access", "User.Read", "Sites.Read.All"]),
      }),
      capabilityPackTools: Object.freeze({
        outlook: Object.freeze(["microsoft_365.list_mail", "microsoft_365.send_mail", "microsoft_365.list_events"]),
        teams: Object.freeze(["microsoft_365.list_chats", "microsoft_365.send_chat_message"]),
        sharepoint: Object.freeze(["microsoft_365.search_sites"]),
      }),
      capabilityPackRequiredTools: Object.freeze({
        outlook: Object.freeze(["microsoft_365.list_mail", "microsoft_365.send_mail", "microsoft_365.list_events"]),
        teams: Object.freeze(["microsoft_365.list_chats", "microsoft_365.send_chat_message"]),
        sharepoint: Object.freeze(["microsoft_365.search_sites"]),
      }),
      approvalRequiredTools: Object.freeze([
        "microsoft_365.send_mail",
        "microsoft_365.send_chat_message",
      ]),
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.GITHUB,
      kind: "token",
      url: "https://api.githubcopilot.com/mcp/",
      credentialLabel: "GitHub personal access token",
      credentialPlaceholder: "Paste a fine-grained GitHub token",
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.LINEAR,
      kind: "token",
      url: "https://mcp.linear.app/mcp",
      credentialLabel: "Linear API key",
      credentialPlaceholder: "Paste your Linear API key",
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.ATLASSIAN,
      kind: "token",
      url: "https://mcp.atlassian.com/v1/mcp",
      credentialLabel: "Atlassian service account API key",
      credentialPlaceholder: "Paste your Atlassian service account API key",
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.NOTION,
      kind: "authorization",
      url: "https://mcp.notion.com/mcp",
      credentialPrefix: "mcp.standard.notion",
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.SLACK,
      kind: "authorization",
      url: "https://mcp.slack.com/mcp",
      credentialPrefix: "mcp.standard.slack",
      clientIdEnvironmentVariable: "KESTREL_SLACK_MCP_CLIENT_ID",
      capabilityPackScopes: Object.freeze({
        search: Object.freeze([
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
        ]),
        messages: Object.freeze(["chat:write"]),
      }),
    }),
    Object.freeze({
      appId: KESTREL_APP_IDS.VERCEL,
      kind: "authorization",
      url: "https://mcp.vercel.com",
      credentialPrefix: "mcp.standard.vercel",
      capabilityPackScopes: Object.freeze({
        projects: Object.freeze(["openid", "offline_access"]),
        deployments: Object.freeze(["openid", "offline_access"]),
        operations: Object.freeze(["openid", "offline_access"]),
      }),
      capabilityPackTools: Object.freeze({
        projects: Object.freeze([
          "search_documentation",
          "list_teams",
          "list_projects",
          "get_project",
        ]),
        deployments: Object.freeze([
          "list_deployments",
          "get_deployment",
          "use_vercel_cli",
          "deploy_to_vercel",
        ]),
        operations: Object.freeze([
          "get_deployment_build_logs",
          "get_runtime_logs",
          "list_agent_run_projects",
          "list_agent_runs",
          "get_agent_run",
          "get_agent_run_trace",
          "check_domain_availability_and_price",
          "buy_domain",
          "get_access_to_vercel_url",
          "web_fetch_vercel_url",
          "list_toolbar_threads",
          "get_toolbar_thread",
          "change_toolbar_thread_resolve_status",
          "reply_to_toolbar_thread",
          "edit_toolbar_message",
          "add_toolbar_reaction",
        ]),
      }),
      capabilityPackRequiredTools: Object.freeze({
        projects: Object.freeze(["list_projects"]),
        deployments: Object.freeze(["list_deployments"]),
        operations: Object.freeze(["get_runtime_logs"]),
      }),
    }),
  ]);

export function listDesktopStandardAppConnections(): DesktopStandardAppConnectionDefinition[] {
  return DESKTOP_STANDARD_APP_CONNECTIONS.map((connection) => ({
    ...connection,
  }));
}

export function getDesktopStandardAppConnection(appId: string) {
  const connection = DESKTOP_STANDARD_APP_CONNECTIONS.find(
    (entry) => entry.appId === appId,
  );
  return connection === undefined ? undefined : { ...connection };
}

export function selectDesktopStandardAppTools<T extends { name: string }>(
  appId: string,
  capabilityPacks: readonly string[],
  tools: readonly T[],
): T[] {
  const connection = getDesktopStandardAppConnection(appId);
  if (
    connection?.kind !== "authorization" ||
    connection.capabilityPackTools === undefined
  ) {
    return [...tools];
  }
  const allowed = new Set(
    capabilityPacks.flatMap(
      (pack) => connection.capabilityPackTools?.[pack] ?? [],
    ),
  );
  return tools.filter((tool) => allowed.has(tool.name));
}

export function hasDesktopStandardAppRequiredTools(
  appId: string,
  capabilityPacks: readonly string[],
  toolNames: readonly string[],
): boolean {
  const connection = getDesktopStandardAppConnection(appId);
  if (
    connection?.kind !== "authorization" ||
    connection.capabilityPackRequiredTools === undefined
  ) {
    return true;
  }
  const discovered = new Set(toolNames);
  return capabilityPacks.every((pack) =>
    (connection.capabilityPackRequiredTools?.[pack] ?? []).every((tool) =>
      discovered.has(tool),
    ),
  );
}

export function desktopStandardAppToolRequiresApproval(
  appId: string,
  toolName: string,
): boolean {
  const connection = getDesktopStandardAppConnection(appId);
  return (
    connection?.kind === "authorization" &&
    connection.approvalRequiredTools?.includes(toolName) === true
  );
}
