export const RUNTIME_HERMETIC_LANE_IDS: readonly string[];
export const RUNTIME_HERMETIC_ISOLATION: "shared-process";
export const RUNTIME_HERMETIC_WORKERS: 4;

export interface RuntimeHermeticLaneDefinition {
  isolation: typeof RUNTIME_HERMETIC_ISOLATION;
  workers: typeof RUNTIME_HERMETIC_WORKERS;
  files: string[];
}

export function validateRuntimeHermeticLaneManifest(
  manifest: unknown,
  discoveredFiles: Iterable<string>,
): Record<string, RuntimeHermeticLaneDefinition>;
