import type { McpCapabilityKind } from "@/lib/mcp/contracts";

export function mcpAppCapabilityKey(capabilityId: string) {
  return `mcp:${capabilityId}`;
}

export function mcpAppRuntimeName(appKey: string, capabilityKey: string) {
  return `mcp.app.${encodeURIComponent(appKey)}.${encodeURIComponent(capabilityKey)}`;
}

export function mcpAppAccessMode(
  kind: McpCapabilityKind
): "read" | "write" | "status" | "internal" {
  if (kind === "tool" || kind === "sampling" || kind === "elicitation") {
    return "write";
  }
  if (kind === "task" || kind === "logging") return "status";
  if (kind === "root") return "internal";
  return "read";
}
