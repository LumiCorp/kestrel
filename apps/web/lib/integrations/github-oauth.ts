import { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/drizzle/schema";
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
    const [connection] = await transaction
      .insert(schema.userToolConnections)
      .values({
        organizationId: input.organizationId,
        providerKey: "github",
        userId: input.userId,
        authAccountId: input.authAccountId,
        status: "connected",
        providerAccountId: input.providerAccountId,
        providerLogin: viewer.data.login,
        scopes: input.scopes,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.userToolConnections.organizationId,
          schema.userToolConnections.providerKey,
          schema.userToolConnections.userId,
        ],
        set: {
          authAccountId: input.authAccountId,
          status: "connected",
          providerAccountId: input.providerAccountId,
          providerLogin: viewer.data.login,
          scopes: input.scopes,
          failureCode: null,
          disconnectedAt: null,
          lastSyncedAt: now,
          updatedAt: now,
        },
      })
      .returning();

    if (!connection) {
      throw new Error("GitHub connection could not be recorded.");
    }

    await transaction
      .insert(schema.organizationToolConnections)
      .values({
        organizationId: input.organizationId,
        providerKey: "github",
        authSource: "oauth",
        status: "connected",
        metadata: { connectionModel: "user_oauth" },
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationToolConnections.organizationId,
          schema.organizationToolConnections.providerKey,
        ],
        set: {
          authSource: "oauth",
          status: "connected",
          accountId: null,
          credentialRef: null,
          metadata: { connectionModel: "user_oauth" },
          updatedAt: now,
        },
      });

    await transaction
      .delete(schema.userToolConnectionResources)
      .where(
        eq(schema.userToolConnectionResources.connectionId, connection.id)
      );

    for (const repository of mappedRepositories) {
      const [resource] = await transaction
        .insert(schema.toolConnectionResources)
        .values({
          organizationId: input.organizationId,
          providerKey: "github",
          externalId: repository.externalId,
          resourceType: "repository",
          label: repository.fullName,
          enabled: true,
          metadata: {
            defaultBranch: repository.defaultBranch,
            private: repository.isPrivate,
            htmlUrl: repository.htmlUrl,
          },
        })
        .onConflictDoUpdate({
          target: [
            schema.toolConnectionResources.organizationId,
            schema.toolConnectionResources.providerKey,
            schema.toolConnectionResources.externalId,
          ],
          set: {
            label: repository.fullName,
            enabled: true,
            metadata: {
              defaultBranch: repository.defaultBranch,
              private: repository.isPrivate,
              htmlUrl: repository.htmlUrl,
            },
            updatedAt: now,
          },
        })
        .returning({ id: schema.toolConnectionResources.id });
      if (!resource) {
        throw new Error("GitHub repository could not be recorded.");
      }
      await transaction.insert(schema.userToolConnectionResources).values({
        connectionId: connection.id,
        resourceId: resource.id,
        canPull: repository.canPull,
        canPush: repository.canPush,
        canAdmin: repository.canAdmin,
        lastSeenAt: now,
      });
    }

    return {
      connection,
      repositoryCount: mappedRepositories.length,
    };
  });
}

export async function disconnectGithubUserConnection(input: {
  organizationId: string;
  userId: string;
}) {
  const connection = await knowledgeDb.query.userToolConnections.findFirst({
    where: (table, operators) =>
      operators.and(
        operators.eq(table.organizationId, input.organizationId),
        operators.eq(table.providerKey, "github"),
        operators.eq(table.userId, input.userId)
      ),
  });
  if (!connection) {
    return null;
  }
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction
      .delete(schema.userToolConnectionResources)
      .where(
        eq(schema.userToolConnectionResources.connectionId, connection.id)
      );
    const [updated] = await transaction
      .update(schema.userToolConnections)
      .set({
        status: "disconnected",
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.userToolConnections.id, connection.id),
          eq(schema.userToolConnections.organizationId, input.organizationId),
          eq(schema.userToolConnections.userId, input.userId)
        )
      )
      .returning();
    const anotherConnectedUser =
      await transaction.query.userToolConnections.findFirst({
        where: (table, operators) =>
          operators.and(
            operators.eq(table.organizationId, input.organizationId),
            operators.eq(table.providerKey, "github"),
            operators.eq(table.status, "connected")
          ),
        columns: { id: true },
      });
    if (!anotherConnectedUser) {
      await transaction
        .update(schema.organizationToolConnections)
        .set({
          status: "not_configured",
          accountId: null,
          credentialRef: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(
              schema.organizationToolConnections.organizationId,
              input.organizationId
            ),
            eq(schema.organizationToolConnections.providerKey, "github")
          )
        );
    }
    return updated ?? null;
  });
}
