import { KESTREL_STANDARD_APP_MANIFESTS, type KestrelAppManifest } from "@kestrel-agents/protocol";
import type { DesktopMcpServerConfig } from "../../src/contracts";

export interface DesktopWorkflowDependencyView {
  role: string;
  ready: boolean;
  readyNames: string[];
  alternativeNames: string[];
  alternativeIds: string[];
}

export function getDesktopWorkflowDependencies(
  app: KestrelAppManifest,
  servers: readonly DesktopMcpServerConfig[],
): DesktopWorkflowDependencyView[] {
  const capabilityPacksByAppId = new Map<string, Set<string>>();
  for (const server of servers) {
    if (server.enabled && server.appId !== undefined && (server.toolCount ?? 0) > 0) {
      const manifest = KESTREL_STANDARD_APP_MANIFESTS.find((candidate) => candidate.id === server.appId);
      capabilityPacksByAppId.set(
        server.appId,
        new Set(server.capabilityPacks ?? manifest?.capabilityPacks.map((pack) => pack.key) ?? []),
      );
    }
  }
  return (app.dependencies ?? []).map((dependency) => {
    const readyIds = dependency.appIds.filter((appId) => {
      const configuredPacks = capabilityPacksByAppId.get(appId);
      if (configuredPacks === undefined) return false;
      const requiredPacks = dependency.requiredCapabilityPacks?.[appId];
      return !requiredPacks?.length || requiredPacks.some((pack) => configuredPacks.has(pack));
    });
    const nameFor = (appId: string) =>
      KESTREL_STANDARD_APP_MANIFESTS.find((manifest) => manifest.id === appId)?.name ?? appId;
    return {
      role: dependency.role,
      ready: readyIds.length >= dependency.minimum,
      readyNames: readyIds.map(nameFor),
      alternativeNames: dependency.appIds.map(nameFor),
      alternativeIds: [...dependency.appIds],
    };
  });
}

export function isDesktopWorkflowReady(
  app: KestrelAppManifest,
  servers: readonly DesktopMcpServerConfig[],
): boolean {
  return getDesktopWorkflowDependencies(app, servers).every((dependency) => dependency.ready);
}
