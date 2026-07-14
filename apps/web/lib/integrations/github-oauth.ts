import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
import { ensureCoreAppCatalog } from "@/lib/apps/service";
import { knowledgeDb } from "@/lib/knowledge/db";

export type GithubRepositoryAccess = {
  externalId: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  canPull: boolean;
  canPush: boolean;
  canAdmin: boolean;
};

type GithubRepository = {
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  };
};

export function mapGithubRepository(
  repository: GithubRepository
): GithubRepositoryAccess {
  return {
    externalId: `repository:${repository.full_name}`,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
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
  await ensureCoreAppCatalog();
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
  const mappedRepositories = repositories.map(mapGithubRepository);
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

    await transaction
      .delete(schema.appConnectionResources)
      .where(eq(schema.appConnectionResources.connectionId, connectionId));

    for (const repository of mappedRepositories) {
      await transaction.insert(schema.appConnectionResources).values({
        connectionId,
        externalId: repository.externalId,
        resourceType: "repository",
        label: repository.fullName,
        enabled: true,
        permissions: {
          pull: repository.canPull,
          push: repository.canPush,
          admin: repository.canAdmin,
        },
        metadata: {
          defaultBranch: repository.defaultBranch,
          private: repository.isPrivate,
          htmlUrl: repository.htmlUrl,
        },
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      connection: appConnection,
      repositoryCount: mappedRepositories.length,
    };
  });
}

export async function disconnectGithubUserConnection(input: {
  organizationId: string;
  userId: string;
}) {
  const connection = await knowledgeDb.query.appConnections.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.organizationId, input.organizationId),
        operators.eq(table.appKey, "github"),
        operators.eq(table.ownerType, "personal"),
        operators.eq(table.userId, input.userId)
      ),
  });
  if (!connection) {
    return null;
  }
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction
      .delete(schema.appConnectionResources)
      .where(eq(schema.appConnectionResources.connectionId, connection.id));
    const [updated] = await transaction
      .update(schema.appConnections)
      .set({
        status: "disconnected",
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.appConnections.id, connection.id))
      .returning();
    return updated ?? null;
  });
}
