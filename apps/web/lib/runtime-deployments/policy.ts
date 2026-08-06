export type PlatformRolloutPhase =
  | "ready"
  | "canary"
  | "fanout"
  | "degraded"
  | "blocked"
  | "rejected"
  | "maintenance_pending"
  | "maintenance";

export function selectRuntimeDeploymentScope<T extends { id: string }>(input: {
  status: PlatformRolloutPhase;
  canaryEnvironmentId: string | null;
  environments: readonly T[];
}) {
  const canaryOnly = ["canary", "maintenance"].includes(input.status);
  return {
    canaryOnly,
    environments: canaryOnly
      ? input.environments.filter(
          (environment) => environment.id === input.canaryEnvironmentId,
        )
      : [...input.environments],
  };
}

export function shouldAssignRuntimeTarget(input: {
  status: PlatformRolloutPhase;
  targetGeneration: number | null;
  generation: number;
  targetSourceRevision: string | null;
  desiredSourceRevision: string;
  targetRouterImage: string | null;
  desiredRouterImage: string;
  targetRuntimeImage: string | null;
  desiredRuntimeImage: string;
}) {
  if (input.targetGeneration !== input.generation) return true;
  if (!["canary", "maintenance", "fanout"].includes(input.status)) {
    return false;
  }
  return (
    input.targetSourceRevision !== input.desiredSourceRevision ||
    input.targetRouterImage !== input.desiredRouterImage ||
    input.targetRuntimeImage !== input.desiredRuntimeImage
  );
}

export function fanoutStatus(input: {
  blockedResourceCount: number;
  convergedEnvironmentCount: number;
  eligibleEnvironmentCount: number;
}): "degraded" | "ready" | "fanout" {
  if (input.blockedResourceCount > 0) return "degraded";
  if (input.convergedEnvironmentCount === input.eligibleEnvironmentCount) {
    return "ready";
  }
  return "fanout";
}
