import type { RunnerProfile } from "@kestrel-agents/sdk/runner";
import { getCoreAppDefinition } from "@/lib/apps/catalog";
import { applyMinimumApprovalMode } from "@/lib/apps/policy";

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
    "exec_command",
    { appKey: "built_in.workspace", capabilityKey: "executeCommand" },
  ],
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
  [
    "kestrel.files.search",
    {
      appKey: "built_in.knowledge_search",
      capabilityKey: "searchKnowledgeDocuments",
    },
  ],
  [
    "kestrel.files.open",
    {
      appKey: "built_in.knowledge_search",
      capabilityKey: "searchKnowledgeDocuments",
    },
  ],
  [
    "workspace.files.share",
    { appKey: "built_in.previews", capabilityKey: "publish" },
  ],
  [
    "workspace.preview.publish",
    { appKey: "built_in.previews", capabilityKey: "publish" },
  ],
  [
    "workspace.preview.list",
    { appKey: "built_in.previews", capabilityKey: "list" },
  ],
  [
    "workspace.preview.inspect",
    { appKey: "built_in.previews", capabilityKey: "inspect" },
  ],
  [
    "workspace.preview.renew",
    { appKey: "built_in.previews", capabilityKey: "renew" },
  ],
  [
    "workspace.preview.close",
    { appKey: "built_in.previews", capabilityKey: "close" },
  ],
  [
    "kestrel_one.word_document_create",
    { appKey: "built_in.artifacts", capabilityKey: "createWordDocument" },
  ],
]);

export const KESTREL_ONE_HOSTED_RUNTIME_TOOL_NAMES = Object.freeze([
  ...GOOGLE_CALENDAR_TOOL_CAPABILITIES.keys(),
  ...MICROSOFT_365_TOOL_CAPABILITIES.keys(),
  ...GITHUB_TOOL_CAPABILITIES.keys(),
  ...EMAIL_TOOL_CAPABILITIES.keys(),
  ...TAVILY_TOOL_CAPABILITIES.keys(),
  ...VERCEL_TOOL_CAPABILITIES.keys(),
  ...BUILT_IN_TOOL_CAPABILITIES.keys(),
]);

export type KestrelOneToolCapabilityBinding = {
  appKey: string;
  capabilityKey: string;
};

export type KestrelOneCapabilityApprovalPolicyEvidence = {
  appKey: string;
  capabilityKey: string;
  environment: "auto" | "ask" | "deny";
  project?: "auto" | "ask" | "deny" | undefined;
  subject?: "auto" | "ask" | "deny" | undefined;
  minimum: "auto" | "ask";
};

export function resolveKestrelOneToolCapability(
  toolName: string,
): KestrelOneToolCapabilityBinding | null {
  for (const [appKey, capabilities] of [
    ["google_workspace", GOOGLE_CALENDAR_TOOL_CAPABILITIES],
    ["microsoft_365", MICROSOFT_365_TOOL_CAPABILITIES],
    ["github", GITHUB_TOOL_CAPABILITIES],
    ["email", EMAIL_TOOL_CAPABILITIES],
    ["tavily", TAVILY_TOOL_CAPABILITIES],
    ["vercel", VERCEL_TOOL_CAPABILITIES],
  ] as const) {
    const capabilityKey = capabilities.get(toolName);
    if (capabilityKey !== undefined) {
      return { appKey, capabilityKey };
    }
  }
  return BUILT_IN_TOOL_CAPABILITIES.get(toolName) ?? null;
}

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
  approvalPolicies?: KestrelOneCapabilityApprovalPolicyEvidence[] | undefined;
}): RunnerProfile {
  const configuration = resolveKestrelOneToolProfileConfiguration({
    availableToolNames: input.profile.toolAllowlist ?? [],
    effectiveCapabilities: input.effectiveCapabilities,
    approvalPolicies: input.approvalPolicies,
  });
  return {
    ...input.profile,
    kestrelOneAppApprovalModes: configuration.kestrelOneAppApprovalModes,
    kestrelOneAppApprovalPolicies: configuration.kestrelOneAppApprovalPolicies,
    toolAllowlist: configuration.additionalToolNames,
  };
}

export function resolveKestrelOneToolProfileConfiguration(input: {
  availableToolNames: string[];
  effectiveCapabilities: string[];
  approvalPolicies?: KestrelOneCapabilityApprovalPolicyEvidence[] | undefined;
}): {
  additionalToolNames: string[];
  kestrelOneAppApprovalModes: Record<string, "auto" | "ask">;
  kestrelOneAppApprovalPolicies: Record<
    string,
    Omit<KestrelOneCapabilityApprovalPolicyEvidence, "appKey" | "capabilityKey">
  >;
} {
  const availableToolNames = [...new Set(input.availableToolNames)];
  if (
    availableToolNames.includes("kestrel_one.search_knowledge_documents")
  ) {
    availableToolNames.splice(
      availableToolNames.indexOf("kestrel_one.search_knowledge_documents") + 1,
      0,
      ...["kestrel.files.search", "kestrel.files.open"].filter(
        (toolName) => !availableToolNames.includes(toolName),
      ),
    );
  }
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
  const kestrelOneAppApprovalModes = Object.fromEntries(
    [
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
        return approvalMode ? [[toolName, approvalMode] as const] : [];
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
    ].map(([toolName, approvalMode]) => {
      const effectiveMode = applyMinimumApprovalMode({
        requested: approvalMode,
        minimum: minimumApprovalModeForTool(toolName),
      });
      return [toolName, effectiveMode === "ask" ? "ask" : "auto"] as const;
    }),
  );
  const policyByCapability = new Map(
    (input.approvalPolicies ?? []).map((policy) => [
      `${policy.appKey}:${policy.capabilityKey}`,
      policy,
    ]),
  );
  const kestrelOneAppApprovalPolicies = Object.fromEntries(
    Object.keys(kestrelOneAppApprovalModes).flatMap((toolName) => {
      const binding = resolveKestrelOneToolCapability(toolName);
      if (binding === null) return [];
      const policy = policyByCapability.get(
        `${binding.appKey}:${binding.capabilityKey}`,
      );
      if (policy === undefined) return [];
      return [
        [
          toolName,
          {
            environment: policy.environment,
            ...(policy.project === undefined
              ? {}
              : { project: policy.project }),
            ...(policy.subject === undefined
              ? {}
              : { subject: policy.subject }),
            minimum: policy.minimum,
          },
        ] as const,
      ];
    }),
  );
  return {
    kestrelOneAppApprovalModes,
    kestrelOneAppApprovalPolicies,
    additionalToolNames: availableToolNames.filter((toolName) => {
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

function minimumApprovalModeForTool(toolName: string): "auto" | "ask" {
  const binding = resolveKestrelOneToolCapability(toolName);
  if (binding === null) return "auto";
  return (
    getCoreAppDefinition(binding.appKey)?.capabilities.find(
      (capability) => capability.key === binding.capabilityKey,
    )?.minimumApprovalMode ?? "auto"
  );
}
