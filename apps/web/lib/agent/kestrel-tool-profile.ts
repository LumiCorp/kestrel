import type { RunnerProfile } from "@kestrel-agents/sdk/runner";

const GOOGLE_CALENDAR_TOOL_CAPABILITIES = new Map<string, string>([
  ["kestrel_one.google_calendar_list_events", "calendar.events.read"],
  ["kestrel_one.google_calendar_create_event", "calendar.events.create"],
  ["kestrel_one.google_calendar_update_event", "calendar.events.update"],
  ["kestrel_one.google_calendar_delete_event", "calendar.events.delete"],
  [
    "kestrel_one.google_calendar_list_availability_subjects",
    "calendar.availability.subjects",
  ],
  [
    "kestrel_one.google_calendar_check_availability",
    "calendar.availability.read",
  ],
] as const);

const MICROSOFT_365_TOOL_CAPABILITIES = new Map<string, string>([
  ["kestrel_one.microsoft_365_list_mail", "outlook.mail.read"],
  ["kestrel_one.microsoft_365_send_mail", "outlook.mail.send"],
  ["kestrel_one.microsoft_365_list_events", "outlook.calendar.read"],
  ["kestrel_one.microsoft_365_list_chats", "teams.chat.read"],
  ["kestrel_one.microsoft_365_send_chat_message", "teams.chat.send"],
  ["kestrel_one.microsoft_365_search_sites", "sharepoint.sites.search"],
] as const);

const GITHUB_TOOL_CAPABILITIES = new Map<string, string>([
  ["kestrel_one.github_repository_read", "repository.read"],
  ["kestrel_one.github_push_agent_branch", "repository.push_agent_branch"],
  ["kestrel_one.github_pull_request_create", "pull_request.write"],
  ["kestrel_one.github_issue_create", "issue.write"],
  ["kestrel_one.github_pull_request_merge", "merge.write"],
  ["kestrel_one.github_release_create", "release.write"],
  ["kestrel_one.github_workflow_dispatch", "workflow.dispatch"],
] as const);

const EMAIL_TOOL_CAPABILITIES = new Map<string, string>([
  ["kestrel_one.email_send", "send"],
] as const);

const TAVILY_TOOL_CAPABILITIES = new Map<string, string>([
  ["internet.search", "search"],
  ["internet.search_advanced", "search_advanced"],
  ["internet.news", "news"],
  ["internet.images", "images"],
  ["internet.extract", "extract"],
  ["internet.crawl", "crawl"],
  ["internet.map", "map"],
  ["internet.research", "research"],
  ["internet.research_status", "research_status"],
  ["internet.usage", "usage"],
] as const);

const VERCEL_TOOL_CAPABILITIES = new Map<string, string>([
  ["kestrel_one.vercel_list_projects", "projects.read"],
  ["kestrel_one.vercel_list_deployments", "deployments.read"],
  ["kestrel_one.vercel_deployment_events", "operations.read"],
] as const);

const BUILT_IN_TOOL_CAPABILITIES = new Map<
  string,
  { appKey: string; capabilityKey: string }
>([
  [
    "free.weather.current",
    { appKey: "built_in.weather", capabilityKey: "getWeather" },
  ],
  [
    "free.weather.forecast",
    { appKey: "built_in.weather", capabilityKey: "forecast" },
  ],
  ["free.time.current", { appKey: "built_in.time", capabilityKey: "current" }],
  [
    "free.geocode.lookup",
    { appKey: "built_in.geocoding", capabilityKey: "lookup" },
  ],
  [
    "free.exchange.rate",
    { appKey: "built_in.exchange_rates", capabilityKey: "rate" },
  ],
  [
    "kestrel_one.search_knowledge_documents",
    {
      appKey: "built_in.knowledge_search",
      capabilityKey: "searchKnowledgeDocuments",
    },
  ],
  ["workspace.preview.publish", { appKey: "ngrok", capabilityKey: "publish" }],
  ["workspace.preview.list", { appKey: "ngrok", capabilityKey: "list" }],
  ["workspace.preview.renew", { appKey: "ngrok", capabilityKey: "renew" }],
  ["workspace.preview.close", { appKey: "ngrok", capabilityKey: "close" }],
  [
    "createDocument",
    { appKey: "built_in.artifacts", capabilityKey: "createDocument" },
  ],
  [
    "updateDocument",
    { appKey: "built_in.artifacts", capabilityKey: "updateDocument" },
  ],
  [
    "requestSuggestions",
    { appKey: "built_in.artifacts", capabilityKey: "requestSuggestions" },
  ],
]);

function appApprovalModes(effectiveCapabilities: string[], appKey: string) {
  const prefix = `app:${appKey}.`;
  return new Map<string, "auto" | "ask">(
    effectiveCapabilities.flatMap((entry) => {
      if (!entry.startsWith(prefix)) return [];
      const value = entry.slice(prefix.length);
      const separator = value.lastIndexOf(":");
      if (separator < 1) return [];
      const capabilityKey = value.slice(0, separator);
      const approvalMode = value.slice(separator + 1);
      return approvalMode === "auto" || approvalMode === "ask"
        ? [[capabilityKey, approvalMode]]
        : [];
    }),
  );
}

export function restrictKestrelOneProfileTools(input: {
  profile: RunnerProfile;
  effectiveCapabilities: string[];
}): RunnerProfile {
  const googleApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "google_workspace",
  );
  const tavilyApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "tavily",
  );
  const githubApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "github",
  );
  const emailApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "email",
  );
  const microsoftApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "microsoft_365",
  );
  const vercelApprovalByCapability = appApprovalModes(
    input.effectiveCapabilities,
    "vercel",
  );
  const builtInApprovalByApp = new Map(
    [
      ...new Set(
        [...BUILT_IN_TOOL_CAPABILITIES.values()].map((item) => item.appKey),
      ),
    ].map((appKey) => [
      appKey,
      appApprovalModes(input.effectiveCapabilities, appKey),
    ]),
  );
  const kestrelOneAppApprovalModes = Object.fromEntries([
    ...[...GOOGLE_CALENDAR_TOOL_CAPABILITIES].flatMap(
      ([toolName, capability]) => {
        const approvalMode = googleApprovalByCapability.get(capability);
        return approvalMode ? [[toolName, approvalMode] as const] : [];
      },
    ),
    ...[...TAVILY_TOOL_CAPABILITIES].flatMap(([toolName, capability]) => {
      const approvalMode = tavilyApprovalByCapability.get(capability);
      return approvalMode ? [[toolName, approvalMode] as const] : [];
    }),
    ...[...GITHUB_TOOL_CAPABILITIES].flatMap(([toolName, capability]) => {
      const approvalMode = githubApprovalByCapability.get(capability);
      return approvalMode ? [[toolName, approvalMode] as const] : [];
    }),
    ...[...EMAIL_TOOL_CAPABILITIES].flatMap(([toolName, capability]) => {
      const approvalMode = emailApprovalByCapability.get(capability);
      return approvalMode ? [[toolName, "ask"] as const] : [];
    }),
    ...[...MICROSOFT_365_TOOL_CAPABILITIES].flatMap(
      ([toolName, capability]) => {
        const approvalMode = microsoftApprovalByCapability.get(capability);
        return approvalMode ? [[toolName, approvalMode] as const] : [];
      },
    ),
    ...[...VERCEL_TOOL_CAPABILITIES].flatMap(([toolName, capability]) => {
      const approvalMode = vercelApprovalByCapability.get(capability);
      return approvalMode ? [[toolName, approvalMode] as const] : [];
    }),
    ...[...BUILT_IN_TOOL_CAPABILITIES].flatMap(
      ([toolName, { appKey, capabilityKey }]) => {
        const approvalMode = builtInApprovalByApp
          .get(appKey)
          ?.get(capabilityKey);
        return approvalMode ? [[toolName, approvalMode] as const] : [];
      },
    ),
  ]);
  return {
    ...input.profile,
    kestrelOneAppApprovalModes,
    toolAllowlist: (input.profile.toolAllowlist ?? []).filter((toolName) => {
      const requiredCapability =
        GOOGLE_CALENDAR_TOOL_CAPABILITIES.get(toolName);
      if (
        requiredCapability !== undefined &&
        !googleApprovalByCapability.has(requiredCapability)
      ) {
        return false;
      }
      const tavilyCapability = TAVILY_TOOL_CAPABILITIES.get(toolName);
      if (
        tavilyCapability !== undefined &&
        !tavilyApprovalByCapability.has(tavilyCapability)
      ) {
        return false;
      }
      const githubCapability = GITHUB_TOOL_CAPABILITIES.get(toolName);
      if (
        githubCapability !== undefined &&
        !githubApprovalByCapability.has(githubCapability)
      ) {
        return false;
      }
      const emailCapability = EMAIL_TOOL_CAPABILITIES.get(toolName);
      if (
        emailCapability !== undefined &&
        !emailApprovalByCapability.has(emailCapability)
      ) {
        return false;
      }
      const microsoftCapability = MICROSOFT_365_TOOL_CAPABILITIES.get(toolName);
      if (
        microsoftCapability !== undefined &&
        !microsoftApprovalByCapability.has(microsoftCapability)
      ) {
        return false;
      }
      const vercelCapability = VERCEL_TOOL_CAPABILITIES.get(toolName);
      if (
        vercelCapability !== undefined &&
        !vercelApprovalByCapability.has(vercelCapability)
      ) {
        return false;
      }
      const builtInCapability = BUILT_IN_TOOL_CAPABILITIES.get(toolName);
      return (
        builtInCapability === undefined ||
        builtInApprovalByApp
          .get(builtInCapability.appKey)
          ?.has(builtInCapability.capabilityKey) === true
      );
    }),
  };
}
