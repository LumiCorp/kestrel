import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
import {
  disconnectPersonalAppConnection,
  requireInstalledAppForOrganization,
} from "@/lib/apps/service";
import { knowledgeDb } from "@/lib/knowledge/db";

export type GithubRepositoryAccess = {
  repositoryId: string;
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  isEmpty: boolean;
  isPrivate: boolean;
  htmlUrl: string;
  canPull: boolean;
  canPush: boolean;
  canAdmin: boolean;
};

type GithubRepository = {
  id: number;
  node_id: string;
  full_name: string;
  default_branch: string | null;
  private: boolean;
  html_url: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
};

export function mapGithubRepository(
  repository: GithubRepository,
  isEmpty: boolean,
): GithubRepositoryAccess {
  return {
    repositoryId: String(repository.id),
    externalId: `repository-id:${repository.id}`,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    isEmpty,
    isPrivate: repository.private,
    htmlUrl: repository.html_url,
    canPull: repository.permissions?.pull ?? true,
    canPush: repository.permissions?.push ?? false,
    canAdmin: repository.permissions?.admin ?? false,
  };
}

export async function findGithubAuthAccount(userId: string) {
  return knowledgeDb.query.accounts.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.userId, userId),
        operators.eq(table.providerId, "github")
      ),
    columns: {
      id: true,
      accountId: true,
      scope: true,
    },
  });
}

export async function syncGithubUserConnection(input: {
  organizationId: string;
  userId: string;
  authAccountId: string;
  providerAccountId: string;
  accessToken: string;
  scopes: string[];
}) {
  await requireInstalledAppForOrganization({
    organizationId: input.organizationId,
    appKey: "github",
  });
  const octokit = new Octokit({ auth: input.accessToken });
  const [viewer, repositories] = await Promise.all([
    octokit.rest.users.getAuthenticated(),
    octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      affiliation: "owner,collaborator,organization_member",
      per_page: 100,
      sort: "full_name",
      visibility: "all",
    }),
  ]);
  const emptyStates = await readGithubRepositoryEmptyStates(
    octokit,
    repositories,
  );
  const mappedRepositories = repositories.map((repository) =>
    mapGithubRepository(repository, emptyStates.get(repository.node_id)!),
  );
  const now = new Date();

  return knowledgeDb.transaction(async (transaction) => {
    const existingConnection = await transaction.query.appConnections.findFirst(
      {
        where: (table, operators) =>
          operators.and(
            operators.eq(table.organizationId, input.organizationId),
            operators.eq(table.appKey, "github"),
            operators.eq(table.ownerType, "personal"),
            operators.eq(table.userId, input.userId)
          ),
      }
    );
    const connectionId = existingConnection?.id ?? crypto.randomUUID();
    const [appConnection] = await transaction
      .insert(schema.appConnections)
      .values({
        id: connectionId,
        organizationId: input.organizationId,
        appKey: "github",
        ownerType: "personal",
        userId: input.userId,
        authAccountId: input.authAccountId,
        name: viewer.data.login,
        status: "connected",
        externalAccountId: input.providerAccountId,
        externalAccountLabel: viewer.data.login,
        scopes: input.scopes,
        deliveryConfig: {},
        lastHealthAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.appConnections.id,
        set: {
          authAccountId: input.authAccountId,
          name: viewer.data.login,
          status: "connected",
          externalAccountId: input.providerAccountId,
          externalAccountLabel: viewer.data.login,
          scopes: input.scopes,
          failureCode: null,
          failureMessage: null,
          disconnectedAt: null,
          lastHealthAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (!appConnection) {
      throw new Error("GitHub App connection could not be recorded.");
    }

    const existingResources =
      await transaction.query.appConnectionResources.findMany({
        where: (table, operators) =>
          operators.and(
            operators.eq(table.connectionId, connectionId),
            operators.eq(table.resourceType, "repository"),
          ),
      });
    const reconciliation = planGithubRepositoryReconciliation({
      existingResources,
      repositories: mappedRepositories,
    });
    for (const { repository, existing } of reconciliation.upserts) {
      const values = {
        externalId: repository.externalId,
        label: repository.fullName,
        enabled: true,
        permissions: {
          pull: repository.canPull,
          push: repository.canPush,
          admin: repository.canAdmin,
        },
        metadata: {
          repositoryId: repository.repositoryId,
          defaultBranch: repository.defaultBranch,
          isEmpty: repository.isEmpty,
          private: repository.isPrivate,
          htmlUrl: repository.htmlUrl,
        },
        updatedAt: now,
      };
      if (existing) {
        await transaction
          .update(schema.appConnectionResources)
          .set(values)
          .where(eq(schema.appConnectionResources.id, existing.id));
      } else {
        const [created] = await transaction
          .insert(schema.appConnectionResources)
          .values({
            connectionId,
            resourceType: "repository",
            ...values,
            createdAt: now,
          })
          .returning({ id: schema.appConnectionResources.id });
        if (!created) {
          throw new Error("GitHub repository resource could not be recorded.");
        }
      }
    }
    for (const resourceId of reconciliation.disableResourceIds) {
      await transaction
        .update(schema.appConnectionResources)
        .set({ enabled: false, updatedAt: now })
        .where(eq(schema.appConnectionResources.id, resourceId));
    }

    return {
      connection: appConnection,
      repositoryCount: mappedRepositories.length,
    };
  });
}

async function readGithubRepositoryEmptyStates(
  octokit: Octokit,
  repositories: GithubRepository[],
) {
  const states = new Map<string, boolean>();
  for (let offset = 0; offset < repositories.length; offset += 50) {
    const ids = repositories
      .slice(offset, offset + 50)
      .map((repository) => repository.node_id);
    const response = await octokit.graphql<{
      nodes: Array<{ id: string; isEmpty: boolean } | null>;
    }>(
      `query KestrelGitHubRepositoryStates($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Repository {
            id
            isEmpty
          }
        }
      }`,
      { ids },
    );
    for (const node of response.nodes) {
      if (node) states.set(node.id, node.isEmpty);
    }
  }
  const missing = repositories.filter(
    (repository) => !states.has(repository.node_id),
  );
  if (missing.length) {
    throw new Error("GitHub repository state synchronization was incomplete.");
  }
  return states;
}

export function planGithubRepositoryReconciliation<
  T extends {
    id: string;
    externalId: string;
    label: string;
    metadata: unknown;
  },
>(input: {
  existingResources: T[];
  repositories: GithubRepositoryAccess[];
}) {
  const existingByRepositoryId = new Map(
    input.existingResources.flatMap((resource) => {
      const repositoryId = readRepositoryId(resource.metadata);
      return repositoryId ? [[repositoryId, resource] as const] : [];
    }),
  );
  const existingByExternalId = new Map(
    input.existingResources.map((resource) => [resource.externalId, resource]),
  );
  const existingByFullName = new Map(
    input.existingResources.map((resource) => [resource.label, resource]),
  );
  const upserts = input.repositories.map((repository) => ({
    repository,
    existing:
      existingByRepositoryId.get(repository.repositoryId) ??
      existingByExternalId.get(repository.externalId) ??
      existingByFullName.get(repository.fullName) ??
      null,
  }));
  const observedResourceIds = new Set(
    upserts.flatMap(({ existing }) => (existing ? [existing.id] : [])),
  );
  return {
    upserts,
    disableResourceIds: input.existingResources
      .filter((resource) => !observedResourceIds.has(resource.id))
      .map((resource) => resource.id),
  };
}

function readRepositoryId(metadata: unknown) {
  if (!(metadata && typeof metadata === "object" && !Array.isArray(metadata))) {
    return null;
  }
  const repositoryId = (metadata as Record<string, unknown>).repositoryId;
  if (typeof repositoryId === "string" && repositoryId.trim()) {
    return repositoryId.trim();
  }
  if (typeof repositoryId === "number" && Number.isSafeInteger(repositoryId)) {
    return String(repositoryId);
  }
  return null;
}

export async function disconnectGithubUserConnection(input: {
  organizationId: string;
  userId: string;
}) {
  return disconnectPersonalAppConnection({
    organizationId: input.organizationId,
    userId: input.userId,
    appKey: "github",
  });
}
