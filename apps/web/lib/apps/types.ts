import type {
  ToolAccessMode,
  ToolApprovalMode,
  ToolLoggingMode,
  ToolRateLimitMode,
} from "@/lib/tools/types";
import type { BrowserPublicDomainAuthorityV1 } from "../../../../src/browser/domainAuthority.js";
import type { BrowserMode } from "../../../../src/browser/contracts.js";

export type BrowserEnvironmentAppSettings = {
  enabledModes: readonly BrowserMode[];
  personalGrantsEnabled: boolean;
  configuredPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
  blockedPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
};

export type BrowserProjectAppSettings = {
  enabledModes: readonly BrowserMode[];
  personalGrantsEnabled: boolean;
  blockedPublicDomains: readonly BrowserPublicDomainAuthorityV1[];
};

export type AppCategory =
  | "kestrel"
  | "search_research"
  | "productivity"
  | "engineering"
  | "communication"
  /** Persisted database compatibility; no executable App uses this category. */
  | "workflow"
  | "custom";

export type AppKind = "built_in" | "external" | "custom";
export type AppConnectionModel =
  | "none"
  | "organization"
  | "personal"
  | "environment"
  | "hybrid";
export type AppConnectionRequirement = "none" | "optional" | "required";
export type AppAuthMethod =
  | "none"
  | "api_key"
  | "agent_token"
  | "oauth_personal"
  | "oauth_environment"
  | "deployment_managed";
export type AppDelivery =
  | "native"
  | "lifecycle"
  | "oauth"
  | "api_key"
  | "mcp"
  | "webhook"
  | "source";
export type AppInstallMode = "inherited" | "explicit";
export type AppInstallationStatus = "installed" | "disabled" | "not_installed";
export type AppReadiness =
  | "ready"
  | "setup_required"
  | "install_required"
  | "degraded"
  | "disabled";

export type AppCapability = {
  key: string;
  runtimeName: string | null;
  displayName: string;
  description: string;
  groupKey: string;
  accessMode: ToolAccessMode;
  audience: "self" | "project" | "both";
  defaultEnabled: boolean;
  defaultApprovalMode: ToolApprovalMode;
  minimumApprovalMode: Exclude<ToolApprovalMode, "deny">;
  defaultLoggingMode: ToolLoggingMode;
  defaultRateLimitMode: ToolRateLimitMode;
  metadata: Record<string, unknown>;
};

export type AppConnectionSummary = {
  id: string;
  name: string;
  ownerType:
    | "system"
    | "organization"
    | "personal"
    | "environment"
    | "deployment_managed";
  status: "connected" | "degraded" | "disconnected";
  environmentId: string | null;
  isMine: boolean;
  lastHealthAt: string | null;
};

export type AppCatalogItem = {
  key: string;
  slug: string;
  displayName: string;
  description: string;
  category: AppCategory;
  kind: AppKind;
  connectionModel: AppConnectionModel;
  connectionRequirement: AppConnectionRequirement;
  authMethods: AppAuthMethod[];
  delivery: AppDelivery;
  installMode: AppInstallMode;
  icon: string | null;
  configurationPath: string | null;
  installationStatus: AppInstallationStatus;
  readiness: AppReadiness;
  capabilityCount: number;
  capabilityGroups: string[];
  connectionCount: number;
  canManageInstallation: boolean;
};

export type AppDetail = AppCatalogItem & {
  capabilities: AppCapability[];
  connections: AppConnectionSummary[];
  metadata: Record<string, unknown>;
};

export type AppsOverview = {
  apps: AppCatalogItem[];
  categories: AppCategory[];
  canManageOrganization: boolean;
  canCreateCustomApp: boolean;
  userId: string;
};

export type EnvironmentAppCapability = AppCapability & {
  enabled: boolean;
  approvalMode: ToolApprovalMode;
  loggingMode: ToolLoggingMode;
  rateLimitMode: ToolRateLimitMode;
  inheritedDefault: boolean;
  browserSettings?: BrowserEnvironmentAppSettings | null;
};

export type EnvironmentAppCapabilityReview = {
  connectionId: string;
  connectionName: string;
  snapshotId: string;
  capabilities: Array<{
    key: string;
    displayName: string;
    description: string;
    group: string;
  }>;
};

export type EnvironmentAppConfiguration = {
  environmentId: string;
  app: Pick<
    AppCatalogItem,
    | "key"
    | "slug"
    | "displayName"
    | "description"
    | "category"
    | "connectionModel"
    | "connectionRequirement"
    | "authMethods"
    | "delivery"
    | "icon"
    | "configurationPath"
    | "installationStatus"
    | "readiness"
  > & {
    connectionCapabilityPacks: Array<{
      key: string;
      name: string;
      description: string;
    }>;
  };
  connections: AppConnectionSummary[];
  capabilities: EnvironmentAppCapability[];
  capabilityReviews: EnvironmentAppCapabilityReview[];
};
