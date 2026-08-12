import "server-only";

import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { HOSTED_ENVIRONMENTS_FEATURE_KEY } from "@/lib/environments/config";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertValidSignupAccessCode,
  hashSignupAccessCode,
  SignupAccessCodePolicyError,
  normalizeSignupEmail,
  signupAccessCodeHint,
} from "./signup-access-code-policy";
import {
  SIGNUP_ACCESS_CODE_HEADER,
  SIGNUP_ACCESS_CODE_RESERVATION_MS,
} from "./signup-access-code-shared";

type SignupAccessCodeReservation = {
  id: string;
  accessCodeId: string;
  normalizedEmail: string;
  userId: string | null;
  reservationExpiresAt: Date;
  redeemedAt: Date | null;
  onboardingCompletedAt: Date | null;
};

export class SignupOnboardingCompletionError extends Error {
  readonly code = "SIGNUP_ONBOARDING_NOT_READY" as const;

  constructor(
    readonly missingRequirements: readonly (
      | "identity"
      | "model"
      | "fly"
      | "rollout"
      | "environment"
    )[] = [],
  ) {
    super("Signup onboarding requirements are not complete.");
    this.name = "SignupOnboardingCompletionError";
  }
}

function unavailable(): never {
  throw new SignupAccessCodePolicyError();
}

function reservationLockKey(codeHash: string) {
  return `kestrel:signup-access-code:${codeHash}`;
}

function emailLockKey(normalizedEmail: string) {
  return `kestrel:signup-access-email:${normalizedEmail}`;
}

export async function reserveSignupAccessCode(input: {
  code: unknown;
  email: unknown;
  now?: Date;
}): Promise<SignupAccessCodeReservation> {
  const normalizedEmail = normalizeSignupEmail(input.email);
  if (!normalizedEmail) {
    return unavailable();
  }

  let codeHash: string;
  try {
    codeHash = hashSignupAccessCode(input.code);
  } catch {
    return unavailable();
  }

  const now = input.now ?? new Date();
  const reservationExpiresAt = new Date(
    now.getTime() + SIGNUP_ACCESS_CODE_RESERVATION_MS,
  );

  return knowledgeDb.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${reservationLockKey(codeHash)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${emailLockKey(normalizedEmail)}, 0))`,
    );

    const existingUser = await transaction.query.users.findFirst({
      where: (table, { eq }) => eq(table.email, normalizedEmail),
      columns: { id: true },
    });
    if (existingUser) {
      return unavailable();
    }

    const code = await transaction.query.signupAccessCodes.findFirst({
      where: (table, { eq }) => eq(table.codeHash, codeHash),
    });
    if (!code) {
      return unavailable();
    }

    const existing =
      await transaction.query.signupAccessCodeRedemptions.findFirst({
        where: (table, { eq }) =>
          eq(table.normalizedEmail, normalizedEmail),
      });

    if (existing) {
      if (existing.redeemedAt) {
        return existing.accessCodeId === code.id ? existing : unavailable();
      }
      if (existing.reservationExpiresAt > now) {
        return existing.accessCodeId === code.id ? existing : unavailable();
      }
    }

    if (
      !code.enabled ||
      (code.expiresAt && code.expiresAt.getTime() <= now.getTime())
    ) {
      return unavailable();
    }

    const [{ committed }] = await transaction
      .select({ committed: sql<number>`count(*)::int` })
      .from(schema.signupAccessCodeRedemptions)
      .where(
        and(
          eq(schema.signupAccessCodeRedemptions.accessCodeId, code.id),
          or(
            isNotNull(schema.signupAccessCodeRedemptions.redeemedAt),
            gt(
              schema.signupAccessCodeRedemptions.reservationExpiresAt,
              now,
            ),
          ),
        ),
      );

    if (committed >= code.maxRedemptions) {
      return unavailable();
    }

    if (existing) {
      const [updated] = await transaction
        .update(schema.signupAccessCodeRedemptions)
        .set({
          accessCodeId: code.id,
          reservationExpiresAt,
          updatedAt: now,
        })
        .where(eq(schema.signupAccessCodeRedemptions.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await transaction
      .insert(schema.signupAccessCodeRedemptions)
      .values({
        id: crypto.randomUUID(),
        accessCodeId: code.id,
        normalizedEmail,
        reservationExpiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created;
  });
}

export async function reserveSignupAccessCodeFromHeaders(input: {
  headers: Headers | undefined;
  email: unknown;
}) {
  return reserveSignupAccessCode({
    code: input.headers?.get(SIGNUP_ACCESS_CODE_HEADER),
    email: input.email,
  });
}

export async function getSignupAccessCodeRedemptionForUser(input: {
  userId: string;
}) {
  const [redemption] = await knowledgeDb
    .select({ redemption: schema.signupAccessCodeRedemptions })
    .from(schema.users)
    .innerJoin(
      schema.signupAccessCodeRedemptions,
      eq(
        schema.signupAccessCodeRedemptions.id,
        schema.users.signupAccessCodeRedemptionId,
      ),
    )
    .where(eq(schema.users.id, input.userId))
    .limit(1);
  return redemption?.redemption ?? null;
}

export async function getSignupAccessCodeIdentityForUser(userId: string) {
  const [identity] = await knowledgeDb
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      emailVerified: schema.users.emailVerified,
      redemption: schema.signupAccessCodeRedemptions,
    })
    .from(schema.users)
    .innerJoin(
      schema.signupAccessCodeRedemptions,
      eq(
        schema.signupAccessCodeRedemptions.id,
        schema.users.signupAccessCodeRedemptionId,
      ),
    )
    .where(eq(schema.users.id, userId))
    .limit(1);
  return identity ?? null;
}

export async function personalOrganizationRequiresSignupOnboarding(
  organizationId: string,
) {
  const redemption = await knowledgeDb
    .select({ id: schema.signupAccessCodeRedemptions.id })
    .from(schema.signupAccessCodeRedemptions)
    .innerJoin(
      schema.users,
      eq(
        schema.users.signupAccessCodeRedemptionId,
        schema.signupAccessCodeRedemptions.id,
      ),
    )
    .innerJoin(
      schema.members,
      eq(schema.members.userId, schema.users.id),
    )
    .where(
      and(
        eq(schema.members.organizationId, organizationId),
        eq(schema.members.role, "owner"),
      ),
    )
    .limit(1);
  return redemption.length > 0;
}

export async function shouldDeferPersonalEnvironmentCreation(input: {
  organizationId: string;
  userId: string;
}) {
  const rows = await knowledgeDb
    .select({ id: schema.signupAccessCodeRedemptions.id })
    .from(schema.signupAccessCodeRedemptions)
    .innerJoin(
      schema.users,
      eq(
        schema.users.signupAccessCodeRedemptionId,
        schema.signupAccessCodeRedemptions.id,
      ),
    )
    .innerJoin(
      schema.members,
      eq(schema.members.userId, schema.users.id),
    )
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.members.organizationId),
    )
    .where(
      and(
        eq(schema.members.organizationId, input.organizationId),
        eq(schema.members.userId, input.userId),
        eq(schema.members.role, "owner"),
        sql`${schema.organizations.slug} LIKE 'personal-%'`,
        sql`${schema.signupAccessCodeRedemptions.onboardingCompletedAt} IS NULL`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function replaceExpiredSignupAccessCodeReservation(input: {
  userId: string;
  email: string;
  code: unknown;
  now?: Date;
}) {
  let codeHash: string;
  try {
    codeHash = hashSignupAccessCode(input.code);
  } catch {
    return unavailable();
  }
  const now = input.now ?? new Date();
  const reservationExpiresAt = new Date(
    now.getTime() + SIGNUP_ACCESS_CODE_RESERVATION_MS,
  );

  return knowledgeDb.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({
        email: schema.users.email,
        emailVerified: schema.users.emailVerified,
        redemption: schema.signupAccessCodeRedemptions,
      })
      .from(schema.users)
      .innerJoin(
        schema.signupAccessCodeRedemptions,
        eq(
          schema.signupAccessCodeRedemptions.id,
          schema.users.signupAccessCodeRedemptionId,
        ),
      )
      .where(eq(schema.users.id, input.userId))
      .limit(1);
    if (!identity) {
      return unavailable();
    }
    const normalizedEmail = normalizeSignupEmail(identity.email);
    if (normalizedEmail !== normalizeSignupEmail(input.email)) {
      return unavailable();
    }

    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${reservationLockKey(codeHash)}, 0))`,
    );
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${emailLockKey(normalizedEmail)}, 0))`,
    );

    const [lockedUser] = await transaction
      .select({
        email: schema.users.email,
        emailVerified: schema.users.emailVerified,
        redemptionId: schema.users.signupAccessCodeRedemptionId,
      })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .for("update");
    if (
      !lockedUser ||
      lockedUser.redemptionId !== identity.redemption.id ||
      normalizeSignupEmail(lockedUser.email) !== normalizedEmail
    ) {
      return unavailable();
    }
    const [current] = await transaction
      .select()
      .from(schema.signupAccessCodeRedemptions)
      .where(eq(schema.signupAccessCodeRedemptions.id, identity.redemption.id))
      .for("update");
    if (
      !current ||
      current.userId !== input.userId ||
      current.redeemedAt ||
      current.reservationExpiresAt > now
    ) {
      return unavailable();
    }

    const emailConflict =
      await transaction.query.signupAccessCodeRedemptions.findFirst({
        where: (table, { eq }) => eq(table.normalizedEmail, normalizedEmail),
        columns: { id: true },
      });
    if (emailConflict && emailConflict.id !== current.id) {
      return unavailable();
    }

    const code = await transaction.query.signupAccessCodes.findFirst({
      where: (table, { eq }) => eq(table.codeHash, codeHash),
    });
    if (
      !code?.enabled ||
      (code.expiresAt && code.expiresAt.getTime() <= now.getTime())
    ) {
      return unavailable();
    }

    const [{ committed }] = await transaction
      .select({ committed: sql<number>`count(*)::int` })
      .from(schema.signupAccessCodeRedemptions)
      .where(
        and(
          eq(schema.signupAccessCodeRedemptions.accessCodeId, code.id),
          or(
            isNotNull(schema.signupAccessCodeRedemptions.redeemedAt),
            gt(
              schema.signupAccessCodeRedemptions.reservationExpiresAt,
              now,
            ),
          ),
        ),
      );
    if (committed >= code.maxRedemptions) {
      return unavailable();
    }

    const [updated] = await transaction
      .update(schema.signupAccessCodeRedemptions)
      .set({
        accessCodeId: code.id,
        normalizedEmail,
        reservationExpiresAt,
        redeemedAt: lockedUser.emailVerified ? now : null,
        updatedAt: now,
      })
      .where(eq(schema.signupAccessCodeRedemptions.id, current.id))
      .returning();
    if (!updated) {
      return unavailable();
    }
    return updated;
  });
}

export async function markSignupOnboardingComplete(input: {
  userId: string;
  sessionId: string;
  organizationId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return knowledgeDb.transaction(async (transaction) => {
    const [identity] = await transaction
      .select({
        redemption: schema.signupAccessCodeRedemptions,
        memberId: schema.members.id,
      })
      .from(schema.users)
      .innerJoin(
        schema.signupAccessCodeRedemptions,
        eq(
          schema.signupAccessCodeRedemptions.id,
          schema.users.signupAccessCodeRedemptionId,
        ),
      )
      .innerJoin(
        schema.members,
        and(
          eq(schema.members.userId, schema.users.id),
          eq(schema.members.role, "owner"),
          eq(schema.members.organizationId, input.organizationId),
        ),
      )
      .innerJoin(
        schema.organizations,
        and(
          eq(schema.organizations.id, schema.members.organizationId),
          sql`${schema.organizations.slug} LIKE 'personal-%'`,
        ),
      )
      .where(eq(schema.users.id, input.userId))
      .limit(1);
    if (!identity?.redemption.redeemedAt) {
      throw new SignupOnboardingCompletionError(["identity"]);
    }

    const activatePersonalWorkspace = async () => {
      const [session] = await transaction
        .update(schema.sessions)
        .set({ activeOrganizationId: input.organizationId, updatedAt: now })
        .where(
          and(
            eq(schema.sessions.id, input.sessionId),
            eq(schema.sessions.userId, input.userId),
          ),
        )
        .returning({ id: schema.sessions.id });
      if (!session) {
        throw new Error("The onboarding session is no longer active.");
      }
    };

    if (identity.redemption.onboardingCompletedAt) {
      await activatePersonalWorkspace();
      return identity.redemption;
    }

    const [[model], [fly], [rollout], [environment]] = await Promise.all([
      transaction
        .select({ id: schema.aiGatewayModels.id })
        .from(schema.aiGatewayModels)
        .innerJoin(
          schema.aiGateways,
          eq(schema.aiGateways.id, schema.aiGatewayModels.gatewayId),
        )
        .where(
          and(
            eq(schema.aiGateways.organizationId, input.organizationId),
            eq(schema.aiGateways.enabled, true),
            sql`${schema.aiGateways.environmentId} IS NULL`,
            sql`${schema.aiGateways.provider} IN ('openai', 'anthropic', 'openrouter')`,
            sql`length(btrim(COALESCE(${schema.aiGateways.apiKey}, ''))) > 0`,
            eq(schema.aiGateways.credentialStatus, "ready"),
            isNotNull(schema.aiGateways.credentialValidatedAt),
            eq(schema.aiGatewayModels.organizationId, input.organizationId),
            eq(schema.aiGatewayModels.approved, true),
            eq(schema.aiGatewayModels.isDefault, true),
            eq(schema.aiGatewayModels.modality, "language"),
          ),
        )
        .limit(1),
      transaction
        .select({ id: schema.aiProviderConnections.id })
        .from(schema.aiProviderConnections)
        .where(
          and(
            eq(
              schema.aiProviderConnections.organizationId,
              input.organizationId,
            ),
            eq(schema.aiProviderConnections.provider, "fly"),
            eq(schema.aiProviderConnections.enabled, true),
            eq(schema.aiProviderConnections.status, "ready"),
            isNotNull(schema.aiProviderConnections.lastTestedAt),
            sql`length(btrim(COALESCE(${schema.aiProviderConnections.apiKey}, ''))) > 0`,
            sql`length(btrim(COALESCE(${schema.aiProviderConnections.metadata} ->> 'organizationSlug', ''))) > 0`,
          ),
        )
        .limit(1),
      transaction
        .select({ organizationId: schema.organizationFeatureFlags.organizationId })
        .from(schema.organizationFeatureFlags)
        .where(
          and(
            eq(
              schema.organizationFeatureFlags.organizationId,
              input.organizationId,
            ),
            eq(
              schema.organizationFeatureFlags.key,
              HOSTED_ENVIRONMENTS_FEATURE_KEY,
            ),
            eq(schema.organizationFeatureFlags.enabled, true),
          ),
        )
        .limit(1),
      transaction
        .select({ id: schema.environments.id })
        .from(schema.environments)
        .where(
          and(
            eq(schema.environments.organizationId, input.organizationId),
            eq(schema.environments.isDefault, true),
            eq(schema.environments.status, "ready"),
            sql`${schema.environments.archivedAt} IS NULL`,
          ),
        )
        .limit(1),
    ]);
    if (!(model && fly && rollout && environment)) {
      throw new SignupOnboardingCompletionError([
        ...(model ? [] : ["model" as const]),
        ...(fly ? [] : ["fly" as const]),
        ...(rollout ? [] : ["rollout" as const]),
        ...(environment ? [] : ["environment" as const]),
      ]);
    }

    await activatePersonalWorkspace();

    const [updated] = await transaction
      .update(schema.signupAccessCodeRedemptions)
      .set({
        onboardingCompletedAt:
          identity.redemption.onboardingCompletedAt ?? now,
        updatedAt: now,
      })
      .where(eq(schema.signupAccessCodeRedemptions.id, identity.redemption.id))
      .returning();
    return updated ?? null;
  }, { isolationLevel: "serializable", accessMode: "read write" });
}

export type SignupAccessCodeAdminRow = {
  id: string;
  codeHint: string;
  label: string;
  enabled: boolean;
  maxRedemptions: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; email: string; name: string } | null;
  activeReservations: number;
  verifiedRedemptions: number;
  completedOnboardings: number;
  committedUsage: number;
  status: "active" | "disabled" | "expired" | "exhausted";
};

export async function listSignupAccessCodes(
  now: Date = new Date(),
): Promise<SignupAccessCodeAdminRow[]> {
  const [codes, redemptions, creators] = await Promise.all([
    knowledgeDb.query.signupAccessCodes.findMany({
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    }),
    knowledgeDb.query.signupAccessCodeRedemptions.findMany(),
    knowledgeDb.query.users.findMany({
      columns: { id: true, email: true, name: true },
    }),
  ]);
  const creatorsById = new Map(creators.map((creator) => [creator.id, creator]));
  return codes.map((code) => {
    const uses = redemptions.filter((item) => item.accessCodeId === code.id);
    const activeReservations = uses.filter(
      (item) => !item.redeemedAt && item.reservationExpiresAt > now,
    ).length;
    const verifiedRedemptions = uses.filter((item) => item.redeemedAt).length;
    const completedOnboardings = uses.filter(
      (item) => item.onboardingCompletedAt,
    ).length;
    const committedUsage = activeReservations + verifiedRedemptions;
    const status = code.enabled
      ? code.expiresAt && code.expiresAt <= now
        ? "expired" as const
        : committedUsage >= code.maxRedemptions
          ? "exhausted" as const
          : "active" as const
      : "disabled" as const;
    const creator = code.createdByUserId
      ? creatorsById.get(code.createdByUserId)
      : null;
    return {
      id: code.id,
      codeHint: code.codeHint,
      label: code.label,
      enabled: code.enabled,
      maxRedemptions: code.maxRedemptions,
      expiresAt: code.expiresAt?.toISOString() ?? null,
      createdAt: code.createdAt.toISOString(),
      updatedAt: code.updatedAt.toISOString(),
      createdBy: creator
        ? { id: creator.id, email: creator.email, name: creator.name }
        : null,
      activeReservations,
      verifiedRedemptions,
      completedOnboardings,
      committedUsage,
      status,
    };
  });
}

export async function createSignupAccessCode(input: {
  code: unknown;
  label: string;
  maxRedemptions: number;
  expiresAt?: Date | null;
  createdByUserId: string;
}) {
  const rawCode = assertValidSignupAccessCode(input.code);
  const codeHash = hashSignupAccessCode(rawCode);
  const label = input.label.trim();
  if (!label) throw new Error("A label is required.");
  if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions <= 0) {
    throw new Error("Maximum uses must be a positive whole number.");
  }
  const now = new Date();
  if (input.expiresAt && input.expiresAt <= now) {
    throw new Error("Expiration must be in the future.");
  }

  const existing = await knowledgeDb.query.signupAccessCodes.findFirst({
    where: (table, { eq }) => eq(table.codeHash, codeHash),
    columns: { id: true },
  });
  if (existing) throw new Error("That invite code already exists.");

  const [created] = await knowledgeDb
    .insert(schema.signupAccessCodes)
    .values({
      id: crypto.randomUUID(),
      codeHash,
      codeHint: signupAccessCodeHint(rawCode),
      label,
      enabled: true,
      maxRedemptions: input.maxRedemptions,
      expiresAt: input.expiresAt ?? null,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) throw new Error("Invite code was not created.");
  return { rawCode, id: created.id };
}

export async function updateSignupAccessCode(input: {
  id: string;
  enabled?: boolean;
  maxRedemptions?: number;
  expiresAt?: Date | null;
}) {
  const now = new Date();
  return knowledgeDb.transaction(async (transaction) => {
    let code = await transaction.query.signupAccessCodes.findFirst({
      where: (table, { eq }) => eq(table.id, input.id),
    });
    if (!code) throw new Error("Invite code not found.");
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${reservationLockKey(code.codeHash)}, 0))`,
    );
    code =
      (await transaction.query.signupAccessCodes.findFirst({
        where: (table, { eq }) => eq(table.id, input.id),
      })) ?? code;

    const uses =
      await transaction.query.signupAccessCodeRedemptions.findMany({
        where: (table, { eq }) => eq(table.accessCodeId, input.id),
      });
    const committedUsage = uses.filter(
      (item) => item.redeemedAt || item.reservationExpiresAt > now,
    ).length;
    const maxRedemptions = input.maxRedemptions ?? code.maxRedemptions;
    if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
      throw new Error("Maximum uses must be a positive whole number.");
    }
    if (maxRedemptions < committedUsage) {
      throw new Error(
        `Maximum uses cannot be below current committed usage (${committedUsage}).`,
      );
    }

    const [updated] = await transaction
      .update(schema.signupAccessCodes)
      .set({
        enabled: input.enabled ?? code.enabled,
        maxRedemptions,
        expiresAt:
          input.expiresAt === undefined ? code.expiresAt : input.expiresAt,
        updatedAt: now,
      })
      .where(eq(schema.signupAccessCodes.id, input.id))
      .returning();
    return updated;
  });
}
