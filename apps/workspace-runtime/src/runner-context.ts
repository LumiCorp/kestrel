import type {
  KestrelRequestContext,
  RunnerProfile,
} from "@kestrel-agents/sdk/runner";

export async function createWorkspaceRunnerContext(input: {
  actorId: string;
  organizationId: string;
  loadProfile?: (
    context: KestrelRequestContext,
  ) => Promise<RunnerProfile> | undefined;
}): Promise<KestrelRequestContext> {
  const context: KestrelRequestContext = {
    actor: {
      actorId: input.actorId,
      actorType: "end_user",
      tenantId: input.organizationId,
    },
    tenantId: input.organizationId,
  };
  if (!input.loadProfile) return context;
  return {
    ...context,
    profile: await input.loadProfile(context),
  };
}
