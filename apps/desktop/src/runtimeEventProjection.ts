import {
  parseRunnerEventV2,
  type RunnerEvent,
} from "@kestrel-agents/protocol";

/**
 * Desktop's renderer is a public presentation boundary. Runtime-private
 * correlation remains available to Local Core and the adapter, but is never
 * forwarded through IPC.
 */
export function projectDesktopRunnerEvent(
  event: RunnerEvent,
): RunnerEvent {
  return parseRunnerEventV2(removePrivateRuntimeMetadata(event));
}

function removePrivateRuntimeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removePrivateRuntimeMetadata);
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      key === "privateRuntimeMetadata"
        ? []
        : [[key, removePrivateRuntimeMetadata(nested)]],
    ),
  );
}
