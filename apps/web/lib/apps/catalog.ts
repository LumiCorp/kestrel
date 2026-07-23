import { listToolProviders } from "@/lib/tools/registry";
import type {
  ToolCapabilityDefinition,
  ToolProviderDefinition,
} from "@/lib/tools/types";
import type {
  AppCategory,
  AppAuthMethod,
  AppConnectionModel,
  AppConnectionRequirement,
  AppDelivery,
  AppInstallMode,
  AppKind,
} from "./types";

export type AppCatalogDefinition = {
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
  metadata: Record<string, unknown>;
  capabilities: Array<{
    key: string;
    runtimeName: string | null;
    displayName: string;
    description: string;
    groupKey: string;
    accessMode: ToolCapabilityDefinition["accessMode"];
    audience: "self" | "project" | "both";
    defaultEnabled: boolean;
    defaultApprovalMode: ToolCapabilityDefinition["defaultPolicy"]["approvalMode"];
    defaultLoggingMode: ToolCapabilityDefinition["defaultPolicy"]["loggingMode"];
    defaultRateLimitMode: ToolCapabilityDefinition["defaultPolicy"]["rateLimitMode"];
    defaultSettings: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }>;
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function kindFor(provider: ToolProviderDefinition): AppKind {
  if (provider.type === "built_in") return "built_in";
  if (provider.type === "custom_imported") return "custom";
  return "external";
}

function groupFor(capability: ToolCapabilityDefinition) {
  const metadata = metadataRecord(capability.metadata);
  if (typeof metadata.group === "string" && metadata.group.trim()) {
    return metadata.group;
  }
  if (capability.key.startsWith("calendar.")) return "calendar";
  if (
    /^(repository|pull_request|issue|merge|release|workflow)\./u.test(
      capability.key
    )
  ) {
    return "repositories";
  }
  return "general";
}

function audienceFor(capability: ToolCapabilityDefinition) {
  const audience = metadataRecord(capability.metadata).audience;
  if (audience === "self") return "self" as const;
  if (audience === "self_or_project") return "both" as const;
  return "project" as const;
}

function slugFor(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

function toAppDefinition(
  provider: ToolProviderDefinition
): AppCatalogDefinition {
  const metadata = metadataRecord(provider.metadata);
  const authMethods = [...provider.app.authMethods] as AppAuthMethod[];
  return {
    key: provider.key,
    slug: slugFor(provider.key),
    displayName: provider.displayName,
    description: provider.description,
    category: provider.app.category as AppCategory,
    kind: kindFor(provider),
    connectionModel: provider.app.connectionModel as AppConnectionModel,
    connectionRequirement:
      provider.app.connectionRequirement as AppConnectionRequirement,
    authMethods,
    delivery: provider.app.delivery as AppDelivery,
    installMode: provider.app.installMode as AppInstallMode,
    icon: provider.app.icon,
    configurationPath: provider.app.configurationPath ?? null,
    metadata: {
      ...metadata,
      authMethods,
      ...(provider.app.configurationPath
        ? { configurationPath: provider.app.configurationPath }
        : {}),
    },
    capabilities: provider.capabilities.map((capability) => ({
      key: capability.key,
      runtimeName: capability.runtimeName,
      displayName: capability.displayName,
      description: capability.description,
      groupKey: groupFor(capability),
      accessMode: capability.accessMode,
      audience: audienceFor(capability),
      defaultEnabled: capability.defaultPolicy.enabled,
      defaultApprovalMode: capability.defaultPolicy.approvalMode,
      defaultLoggingMode: capability.defaultPolicy.loggingMode,
      defaultRateLimitMode: capability.defaultPolicy.rateLimitMode,
      defaultSettings: capability.defaultPolicy.settings,
      metadata: metadataRecord(capability.metadata),
    })),
  };
}

export function listCoreAppDefinitions(): AppCatalogDefinition[] {
  return listToolProviders().map(toAppDefinition);
}

export function getCoreAppDefinition(appKey: string) {
  return listCoreAppDefinitions().find((app) => app.key === appKey) ?? null;
}
