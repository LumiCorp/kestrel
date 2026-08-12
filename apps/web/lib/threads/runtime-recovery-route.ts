export type ForeignRuntimeRecoveryRoute = {
  capabilityDigest: string;
  environmentId: string;
  selectedModelId: string;
};

/**
 * A recovery fork is a new binding, so its Environment comes from the fresh
 * readiness result. Runtime and model selection remain immutable across a
 * same-Runtime live-wait recovery; the degraded source Environment is not a
 * target-admission constraint.
 */
export function selectForeignRuntimeRecoveryRoute(input: {
  targetRuntimeId: "codex" | "claude";
  sourceRuntimeId: "kestrel" | "codex" | "claude";
  sourceSelectedModelId: string | null;
  resolution: ForeignRuntimeRecoveryRoute;
}): ForeignRuntimeRecoveryRoute | null {
  if (
    input.sourceRuntimeId !== input.targetRuntimeId ||
    input.sourceSelectedModelId === null ||
    input.resolution.selectedModelId !== input.sourceSelectedModelId
  ) {
    return null;
  }
  return input.resolution;
}
