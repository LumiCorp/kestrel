import "server-only";

import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { GitHubCapability } from "./github-policy-contract";
import {
  parseGitHubRepositoryGrants,
  readGitHubRepositoryId,
} from "./github-repository-grants";

export async function listAuthorizedGitHubResources(input: {
  projectId: string;
  connectionId: string;
}) {
  const [workspaces, projectApp, resources] = await Promise.all([
    knowledgeDb.query.environmentWorkspaces.findMany({
      where: (table, operators) =>
        operators.and(
          operators.eq(table.projectId, input.projectId),
          operators.isNull(table.deletedAt),
        ),
      columns: { sourceResourceId: true },
    }),
    knowledgeDb.query.projectApps.findFirst({
      where: and(
        eq(schema.projectApps.projectId, input.projectId),
        eq(schema.projectApps.appKey, "github"),
        eq(schema.projectApps.enabled, true),
      ),
      columns: { settings: true },
    }),
    knowledgeDb.query.appConnectionResources.findMany({
      where: and(
        eq(schema.appConnectionResources.connectionId, input.connectionId),
        eq(schema.appConnectionResources.resourceType, "repository"),
        eq(schema.appConnectionResources.enabled, true),
      ),
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
        where: eq(schema.appConnectionResources.id, resourceId),
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
  const grantedIds = new Set(
    parseGitHubRepositoryGrants(projectApp?.settings).map(
      (grant) => grant.repositoryId,
    ),
  );
  return resources.filter((resource) => {
    const repositoryId = readGitHubRepositoryId(resource.metadata);
    return sourceResourceIds.has(resource.id) || (
      repositoryId !== null &&
      (sourceRepositoryIds.has(repositoryId) || grantedIds.has(repositoryId))
    );
  });
}

export function githubCapabilityHasReadyResource(
  capability: GitHubCapability,
  resources: Array<{
    permissions: Record<string, boolean> | null;
  }>,
) {
  if (capability === "repository.read") {
    return resources.some((resource) => resource.permissions?.pull === true);
  }
  if (
    capability === "repository.push_agent_branch" ||
    capability === "repository.initialize"
  ) {
    return resources.some((resource) => resource.permissions?.push === true);
  }
  return true;
}
