export type ToolProviderKey = string;
export type ToolCapabilityKey = string;

export type ToolProviderType =
  | "built_in"
  | "oauth"
  | "api_key"
  | "inbound_adapter"
  | "source_connector"
  | "custom_imported";

export type ToolAuthType = "system" | "oauth" | "api_key" | "env" | "none";

export type ToolProviderAppContract = {
  category:
    | "kestrel"
    | "communication"
    | "productivity"
    | "engineering"
    | "search_research"
    | "knowledge_sources"
    | "custom";
  connectionModel:
    | "none"
    | "organization"
    | "personal"
    | "environment"
    | "hybrid";
  connectionRequirement: "none" | "optional" | "required";
  authMethods: Array<
    | "none"
    | "api_key"
    | "oauth_personal"
    | "oauth_environment"
    | "deployment_managed"
  >;
  delivery: "native" | "oauth" | "api_key" | "mcp" | "webhook" | "source";
  installMode: "inherited" | "explicit";
  icon: string | null;
};

export type ToolApprovalMode = "auto" | "ask" | "deny";

export type ToolRateLimitMode = "default" | "strict" | "off";

export type ToolLoggingMode = "full" | "metadata_only" | "minimal";

export type ToolAccessMode = "read" | "write" | "status" | "internal";

export type ToolConnectionStatus =
  | "connected"
  | "not_configured"
  | "env_backed"
  | "degraded";

export type ToolSurfaceAccess = {
  chat: boolean;
  admin: boolean;
};

export type ToolCapabilityPolicy = {
  enabled: boolean;
  approvalMode: ToolApprovalMode;
  surfaceAccess: ToolSurfaceAccess;
  rateLimitMode: ToolRateLimitMode;
  loggingMode: ToolLoggingMode;
  settings: Record<string, unknown>;
};

export type ToolCapabilityDefinition = {
  key: ToolCapabilityKey;
  runtimeName: string | null;
  displayName: string;
  description: string;
  accessMode: ToolAccessMode;
  defaultPolicy: ToolCapabilityPolicy;
  metadata?: Record<string, unknown>;
};

export type ToolProviderDefinition = {
  key: ToolProviderKey;
  displayName: string;
  description: string;
  type: ToolProviderType;
  authType: ToolAuthType;
  app: ToolProviderAppContract;
  metadata?: Record<string, unknown>;
  capabilities: ToolCapabilityDefinition[];
};

export type ResolvedToolCapability = ToolCapabilityDefinition & {
  policy: ToolCapabilityPolicy;
  isAvailable: boolean;
};

export type ResolvedToolProviderConnection = {
  authSource: ToolAuthType;
  status: ToolConnectionStatus;
  isReady: boolean;
  label: string;
  lastError: string | null;
  metadata: Record<string, unknown>;
};

export type ToolProviderSummary = {
  key: ToolProviderKey;
  displayName: string;
  description: string;
  type: ToolProviderType;
  authType: ToolAuthType;
  enabled: boolean;
  settings: Record<string, unknown>;
  connection: ResolvedToolProviderConnection;
  capabilities: ResolvedToolCapability[];
  counts: {
    total: number;
    enabled: number;
    available: number;
  };
};

export type ResolvedToolProvider = ToolProviderSummary;

export type ToolProviderAdapterContext = {
  organizationId: string;
  origin?: string;
};

export type ToolProviderAdapterResult = ResolvedToolProviderConnection;

export type ToolProviderAdapter = {
  getConnectionStatus: (
    context: ToolProviderAdapterContext
  ) => Promise<ToolProviderAdapterResult>;
};

export type ToolRuntimeConfiguration = {
  providerKey: ToolProviderKey;
  capabilityKey: ToolCapabilityKey;
  runtimeName: string;
  approvalMode: ToolApprovalMode;
  rateLimitMode: ToolRateLimitMode;
  loggingMode: ToolLoggingMode;
  settings: Record<string, unknown>;
};

export type ToolScanStatus = "available" | "setup_required" | "unavailable";

export type ToolOverviewSummaryCounts = {
  total: number;
  enabled: number;
  available: number;
  setupRequired: number;
};

export type ToolOverviewSummary = {
  providers: ToolOverviewSummaryCounts;
  capabilities: ToolOverviewSummaryCounts;
};

export type ToolProviderScanRow = {
  key: ToolProviderKey;
  displayName: string;
  description: string;
  type: ToolProviderType;
  authType: ToolAuthType;
  enabled: boolean;
  status: ToolScanStatus;
  isReady: boolean;
  isAvailable: boolean;
  actionRequired: boolean;
  connectionStatus: ToolConnectionStatus;
  connectionLabel: string;
  capabilityCount: number;
  enabledCapabilityCount: number;
  availableCapabilityCount: number;
  lastError: string | null;
};

export type ToolCapabilityScanRow = {
  providerKey: ToolProviderKey;
  providerDisplayName: string;
  providerType: ToolProviderType;
  authType: ToolAuthType;
  capabilityKey: ToolCapabilityKey;
  runtimeName: string | null;
  displayName: string;
  description: string;
  accessMode: ToolAccessMode;
  enabled: boolean;
  approvalMode: ToolApprovalMode;
  status: ToolScanStatus;
  isAvailable: boolean;
  actionRequired: boolean;
  connectionStatus: ToolConnectionStatus;
  connectionLabel: string;
  lastError: string | null;
};

export type ToolsOverview = {
  summary: ToolOverviewSummary;
  providerRows: ToolProviderScanRow[];
  capabilityRows: ToolCapabilityScanRow[];
  filters: {
    providerTypes: ToolProviderType[];
    statuses: ToolScanStatus[];
  };
};
