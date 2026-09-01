import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import type { MobileMessagePart } from "@/lib/mobile/message-parts";
import { getMobileV2ThreadSnapshot } from "@/lib/mobile/v2/snapshot";
import { getThreadForUser } from "@/lib/threads/store";
import {
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
} from "../../../src/browser/domainAuthority.js";
import {
  hostedBrowserAgentId,
  readHostedBrowserDomainAuthorityInput,
} from "@/lib/apps/browser-domain-service";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60_000;

const authorizeSchema = z.object({
  response_type: z.literal("code"),
  redirect_uri: z.string().trim().url(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  code_challenge_method: z.literal("S256"),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
});

const tokenSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(40).max(256),
    redirect_uri: z.string().trim().url(),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(40).max(256),
  }),
]);

export function parseDesktopAuthorizationRequest(
  searchParams: URLSearchParams,
) {
  const parsed = authorizeSchema.parse(Object.fromEntries(searchParams));
  validateLoopbackRedirect(parsed.redirect_uri);
  return parsed;
}

export async function createDesktopAuthorizationCode(input: {
  userId: string;
  redirectUri: string;
  codeChallenge: string;
}) {
  validateLoopbackRedirect(input.redirectUri);
  const token = createOpaqueToken();
  const now = new Date();
  await knowledgeDb.insert(schema.desktopUserAuthorizationCodes).values({
    id: token.id,
    userId: input.userId,
    secretHash: hashSecret(token.secret),
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
    createdAt: now,
  });
  return token.value;
}

export async function exchangeDesktopUserCredential(input: unknown) {
  const parsed = tokenSchema.parse(input);
  return parsed.grant_type === "authorization_code"
    ? exchangeAuthorizationCode(parsed)
    : rotateRefreshCredential(parsed.refresh_token);
}

export async function authorizeDesktopUser(request: Request) {
  const token = parseBearerToken(request);
  const credential = await findCredential(token, "access");
  if (!credential || credential.expiresAt <= new Date()) {
    throw new DesktopUserAuthorizationError("DESKTOP_USER_TOKEN_INVALID");
  }
  const user = await knowledgeDb.query.users.findFirst({
    where: (table, { eq }) => eq(table.id, credential.userId),
    columns: { id: true, name: true, email: true, image: true },
  });
  if (!user) {
    throw new DesktopUserAuthorizationError("DESKTOP_USER_TOKEN_INVALID");
  }
  return { credential, user };
}

export async function revokeDesktopUserCredentials(request: Request) {
  const token = parseBearerToken(request);
  const credential =
    (await findCredential(token, "access")) ??
    (await findCredential(token, "refresh"));
  if (!credential) return;
  await knowledgeDb
    .update(schema.desktopUserCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.desktopUserCredentials.familyId, credential.familyId),
        isNull(schema.desktopUserCredentials.revokedAt),
      ),
    );
}

export async function getDesktopAccountProjection(request: Request) {
  const { user } = await authorizeDesktopUser(request);
  const memberships = await knowledgeDb
    .select({
      memberId: schema.members.id,
      organizationId: schema.organizations.id,
      organizationName: schema.organizations.name,
      organizationSlug: schema.organizations.slug,
      organizationRole: schema.members.role,
    })
    .from(schema.members)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.members.organizationId),
    )
    .where(eq(schema.members.userId, user.id));
  const memberIds = memberships.map((membership) => membership.memberId);
  const projectRows =
    memberIds.length === 0
      ? []
      : await knowledgeDb
          .select({
            id: schema.projects.id,
            organizationId: schema.projects.organizationId,
            name: schema.projects.name,
            description: schema.projects.description,
            environmentId: schema.projects.environmentId,
            environmentProvider: schema.environments.provider,
            desktopWorkspaceRef:
              schema.desktopEnvironmentWorkspaceCatalog.workspaceRef,
            role: schema.projectMembers.role,
          })
          .from(schema.projectMembers)
          .innerJoin(
            schema.projects,
            eq(schema.projects.id, schema.projectMembers.projectId),
          )
          .innerJoin(
            schema.environments,
            eq(schema.environments.id, schema.projects.environmentId),
          )
          .leftJoin(
            schema.environmentWorkspaces,
            and(
              eq(schema.environmentWorkspaces.projectId, schema.projects.id),
              eq(
                schema.environmentWorkspaces.environmentId,
                schema.projects.environmentId,
              ),
              isNull(schema.environmentWorkspaces.deletedAt),
            ),
          )
          .leftJoin(
            schema.desktopEnvironmentWorkspaceCatalog,
            eq(
              schema.desktopEnvironmentWorkspaceCatalog.id,
              schema.environmentWorkspaces.desktopCatalogId,
            ),
          )
          .where(
            and(
              inArray(schema.projectMembers.organizationMemberId, memberIds),
              isNull(schema.projects.archivedAt),
            ),
          );
  const projects = await Promise.all(projectRows.map(async (project) => {
    const browserAuthority = await readHostedBrowserDomainAuthorityInput({
      organizationId: project.organizationId,
      environmentId: project.environmentId,
      projectId: project.id,
      userId: user.id,
      agentId: hostedBrowserAgentId(),
      qa: {
        version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
        revision: "desktop-account-projection",
        target: null,
      },
    }).then(
      (authority) => ({
        environment: authority.environment,
        project: authority.project,
      }),
      () => undefined,
    );
    return {
      ...project,
      ...(browserAuthority === undefined ? {} : { browserAuthority }),
    };
  }));
  const projectIds = projects.map((project) => project.id);
  const threadRows =
    projectIds.length === 0
      ? []
      : await knowledgeDb.query.threads.findMany({
          where: (table, { and, inArray, isNull }) =>
            and(inArray(table.projectId, projectIds), isNull(table.archivedAt)),
          orderBy: (table, { desc }) => [desc(table.updatedAt), desc(table.id)],
          columns: {
            id: true,
            projectId: true,
            title: true,
            interactionMode: true,
            activeStreamId: true,
            updatedAt: true,
          },
        });
  return {
    account: user,
    organizations: memberships.map(
      ({ memberId: _memberId, ...membership }) => membership,
    ),
    projects,
    threads: threadRows.map((thread) => ({
      ...thread,
      updatedAt: thread.updatedAt.toISOString(),
    })),
  };
}

export async function getDesktopThreadProjection(input: {
  threadId: string;
  userId: string;
}) {
  const candidate = await knowledgeDb.query.threads.findFirst({
    where: (table, { eq }) => eq(table.id, input.threadId),
    columns: { organizationId: true },
  });
  if (!candidate) return null;
  const thread = await getThreadForUser(
    input.threadId,
    input.userId,
    candidate.organizationId,
  );
  if (!thread || thread.mode !== "chat") return null;
  const snapshot = await getMobileV2ThreadSnapshot({
    threadId: input.threadId,
    organizationId: candidate.organizationId,
    userId: input.userId,
  });
  if (!snapshot) return null;
  return {
    snapshotVersion: snapshot.snapshotVersion,
    thread: {
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title ?? "Untitled Thread",
      interactionMode: thread.interactionMode,
      updatedAt: thread.updatedAt.toISOString(),
    },
    messages: snapshot.messageWindow.items.map((message) => ({
      id: message.id,
      turnId: message.turnId,
      role: message.role,
      createdAt: message.createdAt,
      parts: message.parts
        .flatMap(desktopThreadMessagePart)
        .filter((part) => part.text.trim().length > 0),
    })),
    turns: snapshot.turns.map((turn) => ({
      id: turn.id,
      sequence: turn.sequence,
      status: turn.status,
      stage: turn.activity.stage,
      updatedAt: turn.activity.updatedAt,
      failure: turn.failure,
    })),
    queue: {
      state: snapshot.queue.state,
      activeTurnId: snapshot.queue.activeTurnId,
      queuedTurnIds: snapshot.queue.orderedQueuedTurnIds,
    },
  };
}

function desktopThreadMessagePart(
  part: MobileMessagePart,
): Array<{ kind: string; label: string; text: string }> {
  switch (part.type) {
    case "text":
      return [{ kind: "text", label: "Message", text: part.text }];
    case "progress":
      return [{ kind: "progress", label: part.label, text: part.text }];
    case "tool_status":
      return [
        {
          kind: "tool",
          label: part.toolName,
          text: part.state.replaceAll("_", " "),
        },
      ];
    case "artifact":
      return [
        {
          kind: "artifact",
          label: part.title,
          text: part.kind,
        },
      ];
    case "citation":
      return [
        {
          kind: "citation",
          label: part.title,
          text: part.excerpt ?? part.url ?? "Citation",
        },
      ];
    case "source_url":
      return [
        {
          kind: "source",
          label: part.title ?? "Source",
          text: part.url,
        },
      ];
    case "source_document":
      return [
        {
          kind: "source",
          label: part.title,
          text: part.filename ?? part.mediaType,
        },
      ];
    case "interaction_status":
      return [
        {
          kind: "interaction",
          label: part.kind === "approval" ? "Approval" : "Question",
          text: part.prompt,
        },
      ];
    case "assistant_status":
      return part.message
        ? [
            {
              kind: "status",
              label: part.status,
              text: part.message,
            },
          ]
        : [];
  }
}

async function exchangeAuthorizationCode(
  input: Extract<
    z.infer<typeof tokenSchema>,
    { grant_type: "authorization_code" }
  >,
) {
  validateLoopbackRedirect(input.redirect_uri);
  const token = parseOpaqueToken(input.code);
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-user-code:${token.id}`}, 0))`,
    );
    const code =
      await transaction.query.desktopUserAuthorizationCodes.findFirst({
        where: (table, { eq }) => eq(table.id, token.id),
      });
    const challenge = createHash("sha256")
      .update(input.code_verifier)
      .digest("base64url");
    if (
      !code ||
      code.consumedAt ||
      code.expiresAt <= now ||
      code.redirectUri !== input.redirect_uri ||
      code.codeChallenge !== challenge ||
      !secretMatches(token.secret, code.secretHash)
    ) {
      throw new DesktopUserAuthorizationError(
        "DESKTOP_AUTHORIZATION_CODE_INVALID",
      );
    }
    await transaction
      .update(schema.desktopUserAuthorizationCodes)
      .set({ consumedAt: now })
      .where(eq(schema.desktopUserAuthorizationCodes.id, code.id));
    return issueCredentialPair(transaction, {
      userId: code.userId,
      familyId: crypto.randomUUID(),
      now,
    });
  });
}

async function rotateRefreshCredential(value: string) {
  const token = parseOpaqueToken(value);
  const now = new Date();
  const result = await knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-user-refresh:${token.id}`}, 0))`,
    );
    const credential = await transaction.query.desktopUserCredentials.findFirst(
      {
        where: (table, { eq }) => eq(table.id, token.id),
      },
    );
    if (
      !credential ||
      credential.kind !== "refresh" ||
      credential.expiresAt <= now ||
      !secretMatches(token.secret, credential.secretHash)
    ) {
      throw new DesktopUserAuthorizationError("DESKTOP_REFRESH_TOKEN_INVALID");
    }
    if (credential.revokedAt) {
      await transaction
        .update(schema.desktopUserCredentials)
        .set({ revokedAt: now })
        .where(eq(schema.desktopUserCredentials.familyId, credential.familyId));
      return { reused: true as const };
    }
    await transaction
      .update(schema.desktopUserCredentials)
      .set({ revokedAt: now, lastUsedAt: now })
      .where(
        and(
          eq(schema.desktopUserCredentials.familyId, credential.familyId),
          isNull(schema.desktopUserCredentials.revokedAt),
        ),
      );
    return {
      reused: false as const,
      credentials: await issueCredentialPair(transaction, {
        userId: credential.userId,
        familyId: credential.familyId,
        now,
      }),
    };
  });
  if (result.reused) {
    throw new DesktopUserAuthorizationError("DESKTOP_REFRESH_TOKEN_REUSED");
  }
  return result.credentials;
}

async function issueCredentialPair(
  transaction: Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0],
  input: { userId: string; familyId: string; now: Date },
) {
  const access = createOpaqueToken();
  const refresh = createOpaqueToken();
  await transaction.insert(schema.desktopUserCredentials).values([
    {
      id: access.id,
      userId: input.userId,
      familyId: input.familyId,
      kind: "access",
      secretHash: hashSecret(access.secret),
      expiresAt: new Date(input.now.getTime() + ACCESS_TOKEN_TTL_MS),
      createdAt: input.now,
    },
    {
      id: refresh.id,
      userId: input.userId,
      familyId: input.familyId,
      kind: "refresh",
      secretHash: hashSecret(refresh.secret),
      expiresAt: new Date(input.now.getTime() + REFRESH_TOKEN_TTL_MS),
      createdAt: input.now,
    },
  ]);
  return {
    token_type: "Bearer" as const,
    access_token: access.value,
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refresh.value,
  };
}

async function findCredential(tokenValue: string, kind: "access" | "refresh") {
  const token = parseOpaqueToken(tokenValue);
  const credential = await knowledgeDb.query.desktopUserCredentials.findFirst({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.id, token.id),
        eq(table.kind, kind),
        isNull(table.revokedAt),
      ),
  });
  return credential && secretMatches(token.secret, credential.secretHash)
    ? credential
    : null;
}

function validateLoopbackRedirect(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/oauth\/callback\/[A-Za-z0-9_-]{24}$/u.test(url.pathname)
  ) {
    throw new Error(
      "Desktop authorization requires an exact loopback callback.",
    );
  }
}

function parseBearerToken(request: Request) {
  const value = request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!value) {
    throw new DesktopUserAuthorizationError("DESKTOP_USER_TOKEN_INVALID");
  }
  return value;
}

function createOpaqueToken() {
  const id = crypto.randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, value: `${id}.${secret}` };
}

function parseOpaqueToken(value: string) {
  const [id, secret, ...extra] = value.split(".");
  if (
    !id ||
    !secret ||
    extra.length ||
    !/^[0-9a-f-]{36}$/u.test(id) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(secret)
  ) {
    throw new DesktopUserAuthorizationError("DESKTOP_USER_TOKEN_INVALID");
  }
  return { id, secret };
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function secretMatches(value: string, expectedHash: string) {
  const actual = Buffer.from(hashSecret(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class DesktopUserAuthorizationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "DesktopUserAuthorizationError";
    this.code = code;
  }
}
