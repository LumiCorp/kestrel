import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth, type InstallationAuthOptions } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

type GitHubSetupState = {
  organizationId: string;
  actorUserId: string;
  nonce: string;
  expiresAt: number;
};

export function createGitHubInstallationUrl(input: {
  organizationId: string;
  actorUserId: string;
}) {
  const state = signSetupState({
    ...input,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + 10 * 60_000,
  });
  const url = new URL(
    `https://github.com/apps/${encodeURIComponent(requiredEnv("GITHUB_APP_SLUG"))}/installations/new`
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export function verifyGitHubSetupState(input: {
  state: string;
  organizationId: string;
  actorUserId: string;
}) {
  const [encoded, supplied] = input.state.split(".");
  if (!(encoded && supplied)) throw invalidState();
  const expected = createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalidState();
  let state: GitHubSetupState;
  try {
    state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw invalidState();
  }
  if (
    state.organizationId !== input.organizationId ||
    state.actorUserId !== input.actorUserId ||
    !state.nonce ||
    state.expiresAt <= Date.now()
  ) {
    throw invalidState();
  }
  return state;
}

export async function bindGitHubInstallation(input: {
  organizationId: string;
  installationId: number;
}) {
  const installationExternalId = `installation:${input.installationId}`;
  const conflicting = await knowledgeDb.query.toolConnectionResources.findFirst(
    {
      where: (table, { and, eq, ne }) =>
        and(
          eq(table.providerKey, "github"),
          eq(table.externalId, installationExternalId),
          ne(table.organizationId, input.organizationId)
        ),
      columns: { organizationId: true },
    }
  );
  if (conflicting) {
    throw new Error(
      "This GitHub App installation is already assigned to another organization."
    );
  }
  const app = githubAppClient();
  const installation = await app.apps.getInstallation({
    installation_id: input.installationId,
  });
  const auth = await installationAuth(input.installationId);
  const client = new Octokit({ auth: auth.token });
  const repositories = await client.paginate(
    client.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 }
  );
  const now = new Date();
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .insert(schema.organizationToolConnections)
      .values({
        organizationId: input.organizationId,
        providerKey: "github",
        authSource: "oauth",
        status: "connected",
        accountId: String(
          installation.data.account?.id ?? input.installationId
        ),
        credentialRef: installationExternalId,
        metadata: {
          installationId: input.installationId,
          repositorySelection: installation.data.repository_selection,
        },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.organizationToolConnections.organizationId,
          schema.organizationToolConnections.providerKey,
        ],
        set: {
          authSource: "oauth",
          status: "connected",
          accountId: String(
            installation.data.account?.id ?? input.installationId
          ),
          credentialRef: installationExternalId,
          metadata: {
            installationId: input.installationId,
            repositorySelection: installation.data.repository_selection,
          },
          updatedAt: now,
        },
      });
    await upsertResource(transaction, {
      organizationId: input.organizationId,
      externalId: installationExternalId,
      resourceType: "installation",
      label: readInstallationLabel(
        installation.data.account,
        input.installationId
      ),
      metadata: { installationId: input.installationId },
      updatedAt: now,
    });
    await transaction
      .update(schema.toolConnectionResources)
      .set({ enabled: false, updatedAt: now })
      .where(
        and(
          eq(
            schema.toolConnectionResources.organizationId,
            input.organizationId
          ),
          eq(schema.toolConnectionResources.providerKey, "github"),
          eq(schema.toolConnectionResources.resourceType, "repository")
        )
      );
    for (const repository of repositories) {
      await upsertResource(transaction, {
        organizationId: input.organizationId,
        externalId: `repository:${repository.full_name}`,
        resourceType: "repository",
        label: repository.full_name,
        metadata: {
          installationId: input.installationId,
          private: repository.private,
          defaultBranch: repository.default_branch,
          htmlUrl: repository.html_url,
        },
        updatedAt: now,
      });
    }
  });
  return {
    installationId: input.installationId,
    repositoryCount: repositories.length,
  };
}

type EnvironmentTransaction = Parameters<
  Parameters<typeof knowledgeDb.transaction>[0]
>[0];

async function upsertResource(
  transaction: EnvironmentTransaction,
  input: {
    organizationId: string;
    externalId: string;
    resourceType: string;
    label: string;
    metadata: Record<string, unknown>;
    updatedAt: Date;
  }
) {
  await transaction
    .insert(schema.toolConnectionResources)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      providerKey: "github",
      externalId: input.externalId,
      resourceType: input.resourceType,
      label: input.label,
      metadata: input.metadata,
      enabled: true,
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.toolConnectionResources.organizationId,
        schema.toolConnectionResources.providerKey,
        schema.toolConnectionResources.externalId,
      ],
      set: {
        label: input.label,
        metadata: input.metadata,
        enabled: true,
        updatedAt: input.updatedAt,
      },
    });
}

export async function mintGitHubInstallationToken(input: {
  installationId: number;
  repository: string;
  capability:
    | "repository.read"
    | "repository.push_agent_branch"
    | "pull_request.write"
    | "issue.write"
    | "merge.write"
    | "release.write"
    | "workflow.dispatch";
}) {
  const repositoryName = input.repository.split("/")[1];
  if (!repositoryName) throw new Error("GitHub repository is invalid.");
  const auth = await createAppAuth(githubAppCredentials())({
    type: "installation",
    installationId: input.installationId,
    repositoryNames: [repositoryName],
    permissions: githubPermissions(input.capability),
  });
  return { token: auth.token, expiresAt: auth.expiresAt };
}

function githubPermissions(
  capability:
    | "repository.read"
    | "repository.push_agent_branch"
    | "pull_request.write"
    | "issue.write"
    | "merge.write"
    | "release.write"
    | "workflow.dispatch"
): NonNullable<InstallationAuthOptions["permissions"]> {
  if (capability === "repository.read") return { contents: "read" as const };
  if (capability === "repository.push_agent_branch") {
    return { contents: "write" as const };
  }
  if (capability === "pull_request.write" || capability === "merge.write") {
    return { contents: "write" as const, pull_requests: "write" as const };
  }
  if (capability === "issue.write") return { issues: "write" as const };
  if (capability === "workflow.dispatch") {
    return { actions: "write" as const };
  }
  return { contents: "write" as const };
}

function githubAppClient() {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: githubAppCredentials(),
  });
}

async function installationAuth(installationId: number) {
  return createAppAuth(githubAppCredentials())({
    type: "installation",
    installationId,
  });
}

function githubAppCredentials() {
  return {
    appId: requiredEnv("GITHUB_APP_ID"),
    privateKey: requiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/gu, "\n"),
  };
}

function readInstallationLabel(account: unknown, installationId: number) {
  if (
    typeof account === "object" &&
    account !== null &&
    "login" in account &&
    typeof account.login === "string"
  ) {
    return account.login;
  }
  return `GitHub installation ${installationId}`;
}

function signSetupState(state: GitHubSetupState) {
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url"
  );
  return `${encoded}.${createHmac("sha256", stateSecret())
    .update(encoded)
    .digest("base64url")}`;
}

function stateSecret() {
  const value = requiredEnv("GITHUB_APP_SETUP_STATE_SECRET");
  if (value.length < 32) {
    throw new Error(
      "GITHUB_APP_SETUP_STATE_SECRET must contain at least 32 characters."
    );
  }
  return value;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function invalidState() {
  return new Error(
    "GitHub setup state is expired or belongs to another organization."
  );
}
