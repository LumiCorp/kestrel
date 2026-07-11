import type {
  ResolvedToolCapability,
  ResolvedToolProvider,
  ToolCapabilityScanRow,
  ToolOverviewSummaryCounts,
  ToolProviderScanRow,
  ToolScanStatus,
  ToolsOverview,
} from "./types";

function getProviderAvailability(provider: ResolvedToolProvider) {
  return provider.capabilities.length === 0
    ? provider.enabled && provider.connection.isReady
    : provider.enabled &&
        provider.capabilities.some((capability) => capability.isAvailable);
}

export function getProviderScanStatus(
  provider: ResolvedToolProvider
): ToolScanStatus {
  if (getProviderAvailability(provider)) {
    return "available";
  }

  if (provider.enabled && !provider.connection.isReady) {
    return "setup_required";
  }

  return "unavailable";
}

export function getCapabilityScanStatus(
  provider: ResolvedToolProvider,
  capability: ResolvedToolCapability
): ToolScanStatus {
  if (capability.isAvailable) {
    return "available";
  }

  if (
    provider.enabled &&
    capability.policy.enabled &&
    !provider.connection.isReady
  ) {
    return "setup_required";
  }

  return "unavailable";
}

function summarizeRows<T extends { enabled: boolean; status: ToolScanStatus }>(
  rows: T[]
): ToolOverviewSummaryCounts {
  return {
    total: rows.length,
    enabled: rows.filter((row) => row.enabled).length,
    available: rows.filter((row) => row.status === "available").length,
    setupRequired: rows.filter((row) => row.status === "setup_required").length,
  };
}

export function buildToolsOverview(
  providers: ResolvedToolProvider[]
): ToolsOverview {
  const providerRows: ToolProviderScanRow[] = providers.map((provider) => {
    const status = getProviderScanStatus(provider);

    return {
      key: provider.key,
      displayName: provider.displayName,
      description: provider.description,
      type: provider.type,
      authType: provider.authType,
      enabled: provider.enabled,
      status,
      isReady: provider.connection.isReady,
      isAvailable: status === "available",
      actionRequired: status === "setup_required",
      connectionStatus: provider.connection.status,
      connectionLabel: provider.connection.label,
      capabilityCount: provider.counts.total,
      enabledCapabilityCount: provider.counts.enabled,
      availableCapabilityCount: provider.counts.available,
      lastError: provider.connection.lastError,
    };
  });

  const capabilityRows: ToolCapabilityScanRow[] = providers.flatMap(
    (provider) =>
      provider.capabilities.map((capability) => {
        const status = getCapabilityScanStatus(provider, capability);

        return {
          providerKey: provider.key,
          providerDisplayName: provider.displayName,
          providerType: provider.type,
          authType: provider.authType,
          capabilityKey: capability.key,
          runtimeName: capability.runtimeName,
          displayName: capability.displayName,
          description: capability.description,
          accessMode: capability.accessMode,
          enabled: provider.enabled && capability.policy.enabled,
          approvalMode: capability.policy.approvalMode,
          status,
          isAvailable: capability.isAvailable,
          actionRequired: status === "setup_required",
          connectionStatus: provider.connection.status,
          connectionLabel: provider.connection.label,
          lastError: provider.connection.lastError,
        };
      })
  );

  return {
    summary: {
      providers: summarizeRows(providerRows),
      capabilities: summarizeRows(capabilityRows),
    },
    providerRows,
    capabilityRows,
    filters: {
      providerTypes: [...new Set(providers.map((provider) => provider.type))],
      statuses: ["available", "setup_required", "unavailable"],
    },
  };
}
