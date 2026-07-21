import type { RunnerInteractionMode } from "@kestrel-agents/protocol";

export const KESTREL_ONE_INTERACTION_MODES = [
  "chat",
  "plan",
  "build",
] as const satisfies readonly RunnerInteractionMode[];

export type KestrelOneInteractionMode =
  (typeof KESTREL_ONE_INTERACTION_MODES)[number];

export const DEFAULT_KESTREL_ONE_INTERACTION_MODE: KestrelOneInteractionMode =
  "chat";

export function isKestrelOneInteractionMode(
  value: unknown
): value is KestrelOneInteractionMode {
  return KESTREL_ONE_INTERACTION_MODES.some((mode) => mode === value);
}
