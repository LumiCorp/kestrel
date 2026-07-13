import { createHash } from "node:crypto";
import type { McpApprovalMode, McpCapabilityKind } from "./contracts";

export type DiscoveredMcpCapability = {
  kind: McpCapabilityKind;
  capabilityKey: string;
  displayName?: string | undefined;
  description?: string | undefined;
  definition: Record<string, unknown>;
  toolCapabilityKey?: string | undefined;
};

export type PreviousMcpCapability = DiscoveredMcpCapability & {
  id: string;
  environmentEnabled: boolean;
  approvalMode: McpApprovalMode;
};

export type PlannedMcpCapability = DiscoveredMcpCapability & {
  definitionDigest: string;
  environmentEnabled: boolean;
  approvalMode: McpApprovalMode;
  change: "added" | "changed" | "unchanged";
  previousCapabilityId?: string | undefined;
};

export type McpCapabilitySnapshotPlan = {
  capabilityDigest: string;
  status: "pending_review";
  capabilities: PlannedMcpCapability[];
  removed: PreviousMcpCapability[];
};

export function planMcpCapabilitySnapshot(input: {
  protocolVersion: string;
  serverInfo?: Record<string, unknown> | undefined;
  discovered: readonly DiscoveredMcpCapability[];
  previous?: readonly PreviousMcpCapability[] | undefined;
}): McpCapabilitySnapshotPlan {
  const previous = new Map(
    (input.previous ?? []).map((capability) => [
      capabilityIdentity(capability),
      capability,
    ])
  );
  const seen = new Set<string>();
  const capabilities = [...input.discovered]
    .sort(compareCapabilities)
    .map((capability): PlannedMcpCapability => {
      assertCapabilityProjection(capability);
      const identity = capabilityIdentity(capability);
      if (seen.has(identity)) {
        throw new Error(`Duplicate MCP capability '${identity}'.`);
      }
      seen.add(identity);
      const definitionDigest = digestCanonicalJson(capability.definition);
      const prior = previous.get(identity);
      const priorDigest = prior
        ? digestCanonicalJson(prior.definition)
        : undefined;
      const unchanged = priorDigest === definitionDigest;
      return {
        ...capability,
        definition: canonicalizeJson(capability.definition) as Record<
          string,
          unknown
        >,
        definitionDigest,
        environmentEnabled: unchanged
          ? (prior?.environmentEnabled ?? false)
          : false,
        approvalMode: unchanged ? (prior?.approvalMode ?? "deny") : "deny",
        change: unchanged ? "unchanged" : prior ? "changed" : "added",
        ...(prior ? { previousCapabilityId: prior.id } : {}),
      };
    });
  const removed = [...previous.entries()]
    .filter(([identity]) => !seen.has(identity))
    .map(([, capability]) => capability)
    .sort(compareCapabilities);
  const capabilityDigest = digestCanonicalJson({
    protocolVersion: input.protocolVersion,
    serverInfo: input.serverInfo ?? {},
    capabilities: capabilities.map((capability) => ({
      kind: capability.kind,
      capabilityKey: capability.capabilityKey,
      displayName: capability.displayName,
      description: capability.description,
      definition: capability.definition,
      toolCapabilityKey: capability.toolCapabilityKey,
    })),
  });
  return {
    capabilityDigest,
    status: "pending_review",
    capabilities,
    removed,
  };
}

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex")}`;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)])
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error("MCP capability definitions must contain JSON values only.");
}

function assertCapabilityProjection(capability: DiscoveredMcpCapability): void {
  if (!(capability.capabilityKey && capability.capabilityKey.trim())) {
    throw new Error("MCP capability key must not be empty.");
  }
  if (capability.kind === "tool" && !capability.toolCapabilityKey?.trim()) {
    throw new Error("MCP tools must project into a tool capability key.");
  }
  if (
    capability.kind !== "tool" &&
    capability.toolCapabilityKey !== undefined
  ) {
    throw new Error("Only MCP tools may project into tool capabilities.");
  }
}

function capabilityIdentity(capability: DiscoveredMcpCapability): string {
  return `${capability.kind}:${capability.capabilityKey}`;
}

function compareCapabilities(
  left: DiscoveredMcpCapability,
  right: DiscoveredMcpCapability
): number {
  return capabilityIdentity(left).localeCompare(capabilityIdentity(right));
}
