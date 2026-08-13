export type SignupEnvironmentDependencies = {
  getRollout(input: { organizationId: string }): Promise<{
    deploymentEnabled: boolean;
    organizationConfigured: boolean;
    organizationEnabled: boolean;
  }>;
  enableRollout(input: {
    organizationId: string;
    actorUserId: string;
    enabled: true;
  }): Promise<unknown>;
  ensureDefault(input: {
    organizationId: string;
    userId: string;
  }): Promise<{
    environment: { id: string };
    operation: { id: string } | null;
  }>;
  enqueue(operationId: string): Promise<unknown>;
  recoverDefault(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<unknown>;
};

export async function startOrRecoverSignupEnvironment(
  input: { organizationId: string; userId: string },
  dependencies: SignupEnvironmentDependencies,
) {
  const rollout = await dependencies.getRollout({
    organizationId: input.organizationId,
  });
  if (!rollout.deploymentEnabled) {
    return { action: "deployment_disabled" as const };
  }
  if (!(rollout.organizationConfigured && rollout.organizationEnabled)) {
    await dependencies.enableRollout({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      enabled: true,
    });
  }

  const ensured = await dependencies.ensureDefault({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (ensured.operation) {
    await dependencies.enqueue(ensured.operation.id);
    return {
      action: "created" as const,
      environmentId: ensured.environment.id,
      operationId: ensured.operation.id,
    };
  }

  await dependencies.recoverDefault({
    organizationId: input.organizationId,
    actorUserId: input.userId,
  });
  return {
    action: "recovered" as const,
    environmentId: ensured.environment.id,
  };
}
