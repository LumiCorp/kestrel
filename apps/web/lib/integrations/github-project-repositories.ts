import "server-only";

import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  listProjectAppConfigurations,
  selectEffectiveConnection,
} from "@/lib/apps/project-service";
import {
  parseGitHubRepositoryGrants,
  readGitHubRepositoryEmpty,
  readGitHubRepositoryId,
  readGitHubRepositoryPrivate,
  withGitHubRepositoryGrants,
} from "./github-repository-grants";
import { readGithubDefaultBranch } from "./github-agent-push-contract";

export class GitHubProjectRepositoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitHubProjectRepositoryError";
  }
}

export type GitHubProjectRepository = {
  resourceId: string;
  repositoryId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string | null;
  isEmpty: boolean | null;
  canPull: boolean;
  canPush: boolean;
  canAdmin: boolean;
  granted: boolean;
  source: boolean;
};

export async function listGitHubProjectRepositories(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  workspaceId?: string | null | undefined;
}) {
  const { connectionId, settings } = await requireGitHubProjectContext(input);
  const [resources, workspaces] = await Promise.all([
    knowledgeDb.query.appConnectionResources.findMany({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.connectionId, connectionId),
          operators.eq(table.resourceType, "repository"),
          operators.eq(table.enabled, true),
        ),
      orderBy: (table, operators) => [operators.asc(table.label)],
    }),
    input.workspaceId === null
      ? Promise.resolve([])
      : knowledgeDb.query.environmentWorkspaces.findMany({
          where: (table, operators) =>
            operators.and(
              operators.eq(table.projectId, input.projectId),
              ...(input.workspaceId
                ? [operators.eq(table.id, input.workspaceId)]
                : []),
              operators.isNull(table.deletedAt),
            ),
          columns: { sourceResourceId: true },
        }),
  ]);
  const sourceResourceIds = new Set(
    workspaces.flatMap((workspace) =>
      workspace.sourceResourceId ? [workspace.sourceResourceId] : [],
    ),
  );
  const sourceResources = await Promise.all(
    [...sourceResourceIds].map((resourceId) =>
      knowledgeDb.query.appConnectionResources.findFirst({
        where: (table, operators) => operators.eq(table.id, resourceId),
        columns: { metadata: true },
      }),
    ),
  );
  const sourceRepositoryIds = new Set(
    sourceResources.flatMap((resource) => {
      const repositoryId = readGitHubRepositoryId(resource?.metadata);
      return repositoryId ? [repositoryId] : [];
    }),
  );
  const grants = parseGitHubRepositoryGrants(settings);
  const grantedIds = new Set(grants.map((grant) => grant.repositoryId));
  return {
    repositories: resources.flatMap((resource) => {
      const repositoryId = readGitHubRepositoryId(resource.metadata);
      if (!repositoryId) return [];
      return [
        {
          resourceId: resource.id,
          repositoryId,
          fullName: resource.label,
          isPrivate: readGitHubRepositoryPrivate(resource.metadata),
          defaultBranch: readGithubDefaultBranch(resource.metadata),
          isEmpty: readGitHubRepositoryEmpty(resource.metadata),
          canPull: resource.permissions?.pull ?? false,
          canPush: resource.permissions?.push ?? false,
          canAdmin: resource.permissions?.admin ?? false,
          granted: grantedIds.has(repositoryId),
          source:
            sourceResourceIds.has(resource.id) ||
            sourceRepositoryIds.has(repositoryId),
        } satisfies GitHubProjectRepository,
      ];
    }),
    grants,
  };
}

export async function replaceGitHubProjectRepositoryGrants(input: {
  organizationId: string;
  projectId: string;
  userId: string;
  repositoryIds: string[];
}) {
  const context = await requireGitHubProjectContext(input);
  const resources = await knowledgeDb.query.appConnectionResources.findMany({
    where: and(
      eq(schema.appConnectionResources.connectionId, context.connectionId),
      eq(schema.appConnectionResources.resourceType, "repository"),
      eq(schema.appConnectionResources.enabled, true),
    ),
  });
  const resourceByRepositoryId = new Map(
    resources.flatMap((resource) => {
      const repositoryId = readGitHubRepositoryId(resource.metadata);
      return repositoryId ? [[repositoryId, resource] as const] : [];
    }),
  );
  const uniqueIds = [...new Set(input.repositoryIds)];
  const previousGrants = parseGitHubRepositoryGrants(context.settings);
  const previousGrantById = new Map(
    previousGrants.map((grant) => [grant.repositoryId, grant]),
  );
  const missing = uniqueIds.filter(
    (id) =>
      !(previousGrantById.has(id) || resourceByRepositoryId.has(id)),
  );
  if (missing.length) {
    throw new GitHubProjectRepositoryError(
      "GITHUB_REPOSITORY_NOT_SYNCED",
      "Refresh GitHub repositories before granting this repository.",
    );
  }
  const grants = uniqueIds.map((repositoryId) => ({
    repositoryId,
    fullName:
      resourceByRepositoryId.get(repositoryId)?.label ??
      previousGrantById.get(repositoryId)!.fullName,
  }));
  const now = new Date();
  const [saved] = await knowledgeDb
    .update(schema.projectApps)
    .set({
      settings: withGitHubRepositoryGrants(context.settings, grants),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.projectApps.projectId, input.projectId),
        eq(schema.projectApps.appKey, "github"),
      ),
    )
    .returning({ settings: schema.projectApps.settings });
  if (!saved) {
    throw new GitHubProjectRepositoryError(
      "GITHUB_PROJECT_APP_UNAVAILABLE",
      "Enable GitHub for this Project before granting repositories.",
    );
  }
  return {
    grants: parseGitHubRepositoryGrants(saved.settings),
    previousGrants,
  };
}

async function requireGitHubProjectContext(input: {
  organizationId: string;
  projectId: string;
  userId: string;
}) {
  const configurations = await listProjectAppConfigurations(input);
  const configuration = configurations.find(
    (candidate) => candidate.app.key === "github" && candidate.enabled,
  );
  const connection = configuration
    ? selectEffectiveConnection({
        connectionModel: configuration.app.connectionModel,
        connections: configuration.attachedConnections,
      })
    : null;
  if (!(configuration && connection)) {
    throw new GitHubProjectRepositoryError(
      "GITHUB_CONNECTION_UNAVAILABLE",
      "Attach your GitHub connection to this Project first.",
    );
  }
  const projectApp = await knowledgeDb.query.projectApps.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.projectId, input.projectId),
        operators.eq(table.appKey, "github"),
      ),
    columns: { settings: true },
  });
  if (!projectApp) {
    throw new GitHubProjectRepositoryError(
      "GITHUB_PROJECT_APP_UNAVAILABLE",
      "Enable GitHub for this Project before granting repositories.",
    );
  }
  return { connectionId: connection.id, settings: projectApp.settings };
}
