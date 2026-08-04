import {
  parseToolDescriptorV1,
  type ToolDescriptorV1,
  type ToolSourceKindV1,
} from "./tool-contract.js";

/**
 * Every executable tool source family that must traverse the shared
 * conformance harness. This list is intentionally closed: adding a supported
 * source requires adding its conformance fixture in the same change.
 */
export const TOOL_REGISTRY_SOURCE_FAMILIES_V1 = Object.freeze([
  "builtin",
  "embedded",
  "mcp.local",
  "mcp.hosted",
  "app.provider-overlay",
] as const);

export type ToolRegistrySourceFamilyV1 =
  (typeof TOOL_REGISTRY_SOURCE_FAMILIES_V1)[number];

export interface ToolRegistrySourceAdapterV1 {
  readonly adapterId: string;
  readonly sourceKind: ToolSourceKindV1;
  readonly sourceId: string;
  compileDescriptors(): readonly ToolDescriptorV1[];
  hasHandler(handlerId: string): boolean;
  hasResultNormalizer(resultNormalizerId: string): boolean;
}

export interface CompiledToolRegistryV1 {
  readonly descriptors: readonly ToolDescriptorV1[];
  getDescriptor(toolId: string): ToolDescriptorV1 | undefined;
}

/** Compile all supported sources into one collision-free canonical registry. */
export function compileToolRegistryV1(
  adapters: readonly ToolRegistrySourceAdapterV1[],
): CompiledToolRegistryV1 {
  const adapterIds = new Set<string>();
  const descriptors = new Map<string, ToolDescriptorV1>();

  for (const adapter of adapters) {
    requireNonEmpty(adapter.adapterId, "tool registry adapterId");
    requireNonEmpty(adapter.sourceId, "tool registry sourceId");
    if (adapterIds.has(adapter.adapterId)) {
      throw new Error(`Duplicate tool registry adapter '${adapter.adapterId}'`);
    }
    adapterIds.add(adapter.adapterId);

    for (const candidate of adapter.compileDescriptors()) {
      const descriptor = parseToolDescriptorV1(candidate);
      if (
        descriptor.source.kind !== adapter.sourceKind ||
        descriptor.source.sourceId !== adapter.sourceId
      ) {
        throw new Error(
          `Tool '${descriptor.toolId}' source does not match adapter '${adapter.adapterId}'`,
        );
      }
      if (!adapter.hasHandler(descriptor.execution.handlerId)) {
        throw new Error(
          `Tool '${descriptor.toolId}' is missing handler '${descriptor.execution.handlerId}'`,
        );
      }
      if (
        !adapter.hasResultNormalizer(
          descriptor.execution.resultNormalizerId,
        )
      ) {
        throw new Error(
          `Tool '${descriptor.toolId}' is missing result normalizer '${descriptor.execution.resultNormalizerId}'`,
        );
      }
      const existing = descriptors.get(descriptor.toolId);
      if (existing !== undefined) {
        const classification =
          existing.source.kind === descriptor.source.kind &&
          existing.source.sourceId === descriptor.source.sourceId
            ? "duplicate identity"
            : "cross-source collision";
        throw new Error(
          `Tool '${descriptor.toolId}' has a ${classification}`,
        );
      }
      descriptors.set(descriptor.toolId, descriptor);
    }
  }

  const ordered = Object.freeze(
    [...descriptors.values()].sort((left, right) =>
      left.toolId.localeCompare(right.toolId),
    ),
  );
  return Object.freeze({
    descriptors: ordered,
    getDescriptor(toolId: string) {
      return descriptors.get(toolId);
    },
  });
}

function requireNonEmpty(value: string, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
}
