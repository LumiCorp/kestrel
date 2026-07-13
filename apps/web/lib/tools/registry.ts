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
    description: "Get current weather for a location.",
    type: "built_in",
    authType: "system",
    metadata: {
      icon: "cloud-sun",
      category: "built_in",
    },
    capabilities: [
      createCapability({
        key: "getWeather",
        runtimeName: "getWeather",
        displayName: "Get Weather",
        description: "Get current weather and geocoded location data.",
        accessMode: "read",
        defaultPolicy: {
          settings: {
            units: "fahrenheit",
            timeoutMs: 8000,
            retryCount: 1,
          },
        },
      }),
    ],
  },
  {
    key: "built_in.knowledge_search",
    displayName: "Knowledge Search",
    description: "Search uploaded knowledge documents.",
    type: "built_in",
    authType: "system",
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
    authType: "env",
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
    key: "discord",
    displayName: "Discord",
    description:
      "Discord bot connection status, guild binding, and gateway runtime health.",
    type: "inbound_adapter",
    authType: "env",
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
