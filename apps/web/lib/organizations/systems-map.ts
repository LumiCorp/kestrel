import "server-only";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { createFlyProviderClient } from "@/lib/environments/fly-connection";
import type { EnvironmentInfrastructureProvider } from "@/lib/environments/providers/contracts";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  summarizeProviderEnvironment,
  unavailableProviderState,
  type ProviderEnvironmentState,
  type ProviderMapEnvironment,
} from "./systems-map-provider-state";

export type { ProviderEnvironmentState } from "./systems-map-provider-state";

const ACTIVE_TURN_STATUSES = ["queued", "running", "waiting_for_input"] as const;

export type OrganizationSystemsMapWorkspace = {
  id: string;
  name: string;
  kind: "project" | "scratch";
  status: string;
  projectId: string | null;
  machineId: string | null;
  volumeId: string | null;
  lastHealthAt: Date | null;
  failureMessage: string | null;
};

export type OrganizationSystemsMapEnvironment = {
  id: string;
  name: string;
  region: string | null;
  status: string;
  appName: string | null;
  networkName: string | null;
  gatewayMachineId: string | null;
  lastHealthAt: Date | null;
  failureMessage: string | null;
  workspaces: OrganizationSystemsMapWorkspace[];
};

export type OrganizationSystemsMapSnapshot = {
  organization: { id: string; name: string; slug: string };
  environments: OrganizationSystemsMapEnvironment[];
  people: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    projectIds: string[];
    threadCount: number;
    activeTurnCount: number;
    failedTurnCount: number;
  }>;
  projects: Array<{
    id: string;
    name: string;
    environmentId: string;
    memberIds: string[];
    activeMemberIds: string[];
    threadCount: number;
    activeTurnCount: number;
  }>;
};

type ProviderClientFactory = (
  organizationId: string,
) => Promise<EnvironmentInfrastructureProvider>;

export async function getOrganizationSystemsMapSnapshot(input: {
  organizationId: string;
}): Promise<OrganizationSystemsMapSnapshot | null> {
  const [organization, environments, workspaces, members, projects, projectMembers, threads, currentTurns] =
    await Promise.all([
      knowledgeDb.query.organizations.findFirst({
        where: eq(schema.organizations.id, input.organizationId),
        columns: { id: true, name: true, slug: true },
      }),
      knowledgeDb.query.environments.findMany({
        where: and(
          eq(schema.environments.organizationId, input.organizationId),
          isNull(schema.environments.archivedAt),
        ),
        orderBy: (table) => [asc(table.name), asc(table.id)],
      }),
      knowledgeDb.query.environmentWorkspaces.findMany({
        where: and(
          eq(schema.environmentWorkspaces.organizationId, input.organizationId),
          isNull(schema.environmentWorkspaces.deletedAt),
        ),
        orderBy: (table) => [asc(table.name), asc(table.id)],
      }),
      knowledgeDb
        .select({
          id: schema.members.id,
          role: schema.members.role,
          userId: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
        })
        .from(schema.members)
        .innerJoin(schema.users, eq(schema.members.userId, schema.users.id))
        .where(eq(schema.members.organizationId, input.organizationId))
        .orderBy(asc(schema.users.name), asc(schema.users.id)),
      knowledgeDb.query.projects.findMany({
        where: and(
          eq(schema.projects.organizationId, input.organizationId),
          isNull(schema.projects.archivedAt),
        ),
        columns: { id: true, name: true, environmentId: true, createdByUserId: true },
        orderBy: (table) => [asc(table.name), asc(table.id)],
      }),
      knowledgeDb
        .select({
          projectId: schema.projectMembers.projectId,
          userId: schema.members.userId,
        })
        .from(schema.projectMembers)
        .innerJoin(
          schema.members,
          eq(schema.projectMembers.organizationMemberId, schema.members.id),
        )
        .innerJoin(
          schema.projects,
          eq(schema.projectMembers.projectId, schema.projects.id),
        )
        .where(
          and(
            eq(schema.members.organizationId, input.organizationId),
            eq(schema.projects.organizationId, input.organizationId),
            isNull(schema.projects.archivedAt),
          ),
        ),
      knowledgeDb.query.threads.findMany({
        where: and(
          eq(schema.threads.organizationId, input.organizationId),
          isNull(schema.threads.archivedAt),
        ),
        columns: { id: true, projectId: true, createdByUserId: true },
      }),
      knowledgeDb
        .select({
          authorUserId: schema.threadTurns.authorUserId,
          projectId: schema.threads.projectId,
          status: schema.threadTurns.status,
        })
        .from(schema.threadTurns)
        .innerJoin(
          schema.threads,
          eq(schema.threadTurns.threadId, schema.threads.id),
        )
        .where(
          and(
            eq(schema.threadTurns.organizationId, input.organizationId),
            eq(schema.threads.organizationId, input.organizationId),
            isNull(schema.threads.archivedAt),
            inArray(schema.threadTurns.status, [...ACTIVE_TURN_STATUSES, "failed"]),
          ),
        ),
    ]);

  if (!organization) return null;

  const workspacesByEnvironment = new Map<string, OrganizationSystemsMapWorkspace[]>();
  for (const workspace of workspaces) {
    const items = workspacesByEnvironment.get(workspace.environmentId) ?? [];
    items.push({
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      status: workspace.status,
      projectId: workspace.projectId,
      machineId: workspace.flyMachineId,
      volumeId: workspace.flyVolumeId,
      lastHealthAt: workspace.lastHealthAt,
      failureMessage: workspace.failureMessage,
    });
    workspacesByEnvironment.set(workspace.environmentId, items);
  }

  const memberIdsByProject = new Map<string, string[]>();
  const projectIdsByMember = new Map<string, string[]>();
  for (const membership of projectMembers) {
    const projectMemberIds = memberIdsByProject.get(membership.projectId) ?? [];
    projectMemberIds.push(membership.userId);
    memberIdsByProject.set(membership.projectId, projectMemberIds);
    const memberProjectIds = projectIdsByMember.get(membership.userId) ?? [];
    memberProjectIds.push(membership.projectId);
    projectIdsByMember.set(membership.userId, memberProjectIds);
  }
  for (const project of projects) {
    if (!project.createdByUserId) continue;
    const projectMemberIds = memberIdsByProject.get(project.id) ?? [];
    if (!projectMemberIds.includes(project.createdByUserId)) {
      projectMemberIds.push(project.createdByUserId);
      memberIdsByProject.set(project.id, projectMemberIds);
    }
    const memberProjectIds = projectIdsByMember.get(project.createdByUserId) ?? [];
    if (!memberProjectIds.includes(project.id)) {
      memberProjectIds.push(project.id);
      projectIdsByMember.set(project.createdByUserId, memberProjectIds);
    }
  }

  const threadCountByProject = new Map<string, number>();
  const threadCountByMember = new Map<string, number>();
  for (const thread of threads) {
    if (thread.createdByUserId) {
      threadCountByMember.set(
        thread.createdByUserId,
        (threadCountByMember.get(thread.createdByUserId) ?? 0) + 1,
      );
    }
    if (!thread.projectId) continue;
    threadCountByProject.set(
      thread.projectId,
      (threadCountByProject.get(thread.projectId) ?? 0) + 1,
    );
  }

  const activeTurnCountByProject = new Map<string, number>();
  const activeTurnCountByMember = new Map<string, number>();
  const failedTurnCountByMember = new Map<string, number>();
  const activeMemberIdsByProject = new Map<string, string[]>();
  for (const turn of currentTurns) {
    if (turn.status === "failed") {
      failedTurnCountByMember.set(
        turn.authorUserId,
        (failedTurnCountByMember.get(turn.authorUserId) ?? 0) + 1,
      );
      continue;
    }
    activeTurnCountByMember.set(
      turn.authorUserId,
      (activeTurnCountByMember.get(turn.authorUserId) ?? 0) + 1,
    );
    if (!turn.projectId) continue;
    activeTurnCountByProject.set(
      turn.projectId,
      (activeTurnCountByProject.get(turn.projectId) ?? 0) + 1,
    );
    const activeMemberIds = activeMemberIdsByProject.get(turn.projectId) ?? [];
    if (!activeMemberIds.includes(turn.authorUserId)) {
      activeMemberIds.push(turn.authorUserId);
      activeMemberIdsByProject.set(turn.projectId, activeMemberIds);
    }
  }

  return {
    organization,
    environments: environments.map((environment) => ({
      id: environment.id,
      name: environment.name,
      region: environment.region,
      status: environment.status,
      appName: environment.flyAppName,
      networkName: environment.flyNetworkName,
      gatewayMachineId: environment.flyGatewayMachineId,
      lastHealthAt: environment.lastHealthAt,
      failureMessage: environment.failureMessage,
      workspaces: workspacesByEnvironment.get(environment.id) ?? [],
    })),
    people: members.map((member) => ({
      id: member.userId,
      name: member.name,
      email: member.email,
      role: member.role,
      projectIds: projectIdsByMember.get(member.userId) ?? [],
      threadCount: threadCountByMember.get(member.userId) ?? 0,
      activeTurnCount: activeTurnCountByMember.get(member.userId) ?? 0,
      failedTurnCount: failedTurnCountByMember.get(member.userId) ?? 0,
    })),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      environmentId: project.environmentId,
      memberIds: memberIdsByProject.get(project.id) ?? [],
      activeMemberIds: activeMemberIdsByProject.get(project.id) ?? [],
      threadCount: threadCountByProject.get(project.id) ?? 0,
      activeTurnCount: activeTurnCountByProject.get(project.id) ?? 0,
    })),
  };
}

export async function getProviderEstateState(input: {
  organizationId: string;
  environments: ProviderMapEnvironment[];
  environmentId?: string | null;
  createClient?: ProviderClientFactory;
}): Promise<ProviderEnvironmentState[]> {
  const environments = input.environmentId
    ? input.environments.filter((environment) => environment.id === input.environmentId)
    : input.environments;
  const checkedAt = new Date().toISOString();
  const providerEnvironments = environments.filter((environment) => environment.appName);

  if (providerEnvironments.length === 0) {
    return environments.map((environment) => unavailableProviderState({
      environment,
      checkedAt,
      status: "not_configured",
      message: "No managed provider application is configured for this environment.",
    }));
  }

  let provider: EnvironmentInfrastructureProvider;
  try {
    provider = await (input.createClient ?? createFlyProviderClient)(input.organizationId);
  } catch {
    return environments.map((environment) => unavailableProviderState({
      environment,
      checkedAt,
      status: "not_configured",
      message: "The organization provider connection is not available.",
    }));
  }

  const states: ProviderEnvironmentState[] = [];
  for (const environment of environments) {
    if (!environment.appName) {
      states.push(
        unavailableProviderState({
          environment,
          checkedAt,
          status: "not_configured",
          message: "No managed provider application is configured for this environment.",
        }),
      );
      continue;
    }
    try {
      const inventory = await provider.listEnvironmentResources({
        appName: environment.appName,
      });
      states.push(
        summarizeProviderEnvironment({
          environment,
          inventory,
          checkedAt,
        }),
      );
    } catch {
      states.push(
        unavailableProviderState({
          environment,
          checkedAt,
          status: "unavailable",
          message: "The provider could not be reached. Showing Kestrel's last known estate.",
        }),
      );
    }
  }
  return states;
}
