import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("signup access codes preserve atomic ownership and capacity contracts", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.BETTER_AUTH_SECRET = `signup-code-test-${crypto.randomUUID()}`;
  process.env.KESTREL_PRODUCT_CONTRACT = "true";

  const [
    { resetDbRuntimeForTests },
    accessCodes,
    { auth },
    { createEmailVerificationToken },
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./signup-access-codes"),
    import("./auth"),
    import("better-auth/api"),
  ]);
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const creatorId = `signup-code-creator-${suffix}`;
  const createdCodeIds: string[] = [];
  const createdOrganizationIds: string[] = [];
  const createdUserIds = new Set<string>([creatorId]);
  const now = new Date();

  context.after(async () => {
    const userIds = [...createdUserIds];
    await sql`DELETE FROM "session" WHERE "userId" = ANY(${userIds})`;
    await sql`DELETE FROM "account" WHERE "userId" = ANY(${userIds})`;
    await sql`DELETE FROM "member" WHERE "userId" = ANY(${userIds})`;
    if (createdOrganizationIds.length > 0) {
      await sql`DELETE FROM "organization" WHERE "id" = ANY(${createdOrganizationIds})`;
    }
    await sql`DELETE FROM "user" WHERE "id" = ANY(${userIds})`;
    if (createdCodeIds.length > 0) {
      await sql`DELETE FROM "signup_access_code_redemptions" WHERE "access_code_id" = ANY(${createdCodeIds})`;
      await sql`DELETE FROM "signup_access_codes" WHERE "id" = ANY(${createdCodeIds})`;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (
      ${creatorId}, 'Code Creator', ${`${creatorId}@example.test`}, true, ${now}, ${now}
    )
  `;

  async function createCode(code: string, maxRedemptions: number) {
    const created = await accessCodes.createSignupAccessCode({
      code,
      label: code,
      maxRedemptions,
      createdByUserId: creatorId,
    });
    createdCodeIds.push(created.id);
    return created;
  }

  const finalSlot = await createCode(`FINAL-${suffix}`, 1);
  const finalSlotResults = await Promise.allSettled([
    accessCodes.reserveSignupAccessCode({
      code: finalSlot.rawCode,
      email: `one-${suffix}@example.test`,
      now,
    }),
    accessCodes.reserveSignupAccessCode({
      code: finalSlot.rawCode,
      email: `two-${suffix}@example.test`,
      now,
    }),
  ]);
  assert.equal(
    finalSlotResults.filter((result) => result.status === "fulfilled").length,
    1,
    "concurrent final-slot reservations must serialize",
  );

  const retryCode = await createCode(`RETRY-${suffix}`, 2);
  const retryEmail = `retry-${suffix}@example.test`;
  const firstRetry = await accessCodes.reserveSignupAccessCode({
    code: retryCode.rawCode,
    email: retryEmail,
    now,
  });
  const secondRetry = await accessCodes.reserveSignupAccessCode({
    code: retryCode.rawCode,
    email: retryEmail.toUpperCase(),
    now: new Date(now.getTime() + 1000),
  });
  assert.equal(secondRetry.id, firstRetry.id);
  assert.equal(
    secondRetry.reservationExpiresAt.getTime(),
    firstRetry.reservationExpiresAt.getTime(),
  );

  const expiryCode = await createCode(`EXPIRY-${suffix}`, 1);
  await accessCodes.reserveSignupAccessCode({
    code: expiryCode.rawCode,
    email: `expired-${suffix}@example.test`,
    now,
  });
  const replacement = await accessCodes.reserveSignupAccessCode({
    code: expiryCode.rawCode,
    email: `replacement-${suffix}@example.test`,
    now: new Date(now.getTime() + 2 * 60 * 60 * 1000),
  });
  assert.equal(
    replacement.normalizedEmail,
    `replacement-${suffix}@example.test`,
  );

  const existingUserId = `existing-code-user-${suffix}`;
  const existingEmail = `${existingUserId}@example.test`;
  createdUserIds.add(existingUserId);
  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (${existingUserId}, 'Existing User', ${existingEmail}, true, ${now}, ${now})
  `;
  const existingUserCode = await createCode(`EXISTING-${suffix}`, 2);
  await assert.rejects(
    auth.api.signUpEmail({
      body: {
        email: existingEmail,
        name: "Existing User",
        password: "correct-horse-battery-staple",
      },
      headers: new Headers({
        "x-kestrel-signup-code": existingUserCode.rawCode,
      }),
    }),
  );
  const [existingReservationCount] = await sql<[{ count: number }]>`
    SELECT count(*)::int AS "count"
    FROM "signup_access_code_redemptions"
    WHERE "normalized_email" = ${existingEmail}
  `;
  assert.equal(existingReservationCount.count, 0);

  const unboundCode = await createCode(`UNBOUND-${suffix}`, 2);
  const unboundEmail = `unbound-${suffix}@example.test`;
  const unboundReservation = await accessCodes.reserveSignupAccessCode({
    code: unboundCode.rawCode,
    email: unboundEmail,
    now,
  });
  const unboundUserId = `unbound-user-${suffix}`;
  createdUserIds.add(unboundUserId);
  await sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
    ) VALUES (${unboundUserId}, 'Unbound User', ${unboundEmail}, false, ${now}, ${now})
  `;
  assert.equal(
    await accessCodes.getSignupAccessCodeRedemptionForUser({
      userId: unboundUserId,
    }),
    null,
    "an email-matched reservation must never attach itself to an existing user",
  );
  const [stillUnbound] = await sql<[{ userId: string | null }]>`
    SELECT "user_id" AS "userId"
    FROM "signup_access_code_redemptions"
    WHERE "id" = ${unboundReservation.id}
  `;
  assert.equal(stillUnbound.userId, null);

  const signupCode = await createCode(`SIGNUP-${suffix}`, 1);
  const signupEmail = `signup-${suffix}@example.test`;
  await assert.rejects(
    auth.api.signUpEmail({
      body: {
        email: signupEmail,
        name: "Signup User",
        password: "correct-horse-battery-staple",
        signupAccessCodeRedemptionId: unboundReservation.id,
      } as never,
      headers: new Headers({
        "x-kestrel-signup-code": signupCode.rawCode,
      }),
    }),
    /not allowed to be set/u,
    "Better Auth rejects client input for the hidden ownership pointer",
  );
  const signupResult = await auth.api.signUpEmail({
    body: {
      email: signupEmail,
      name: "Signup User",
      password: "correct-horse-battery-staple",
    },
    headers: new Headers({
      "x-kestrel-signup-code": signupCode.rawCode,
    }),
  });
  const signupUserId = signupResult.user.id;
  createdUserIds.add(signupUserId);
  assert.equal(
    "signupAccessCodeRedemptionId" in signupResult.user,
    false,
    "the ownership pointer must not be returned by Better Auth",
  );
  const [signupUser] = await sql<
    [{ redemptionId: string; emailVerified: boolean }]
  >`
    SELECT
      "signup_access_code_redemption_id" AS "redemptionId",
      "emailVerified" AS "emailVerified"
    FROM "user"
    WHERE "id" = ${signupUserId}
  `;
  assert.ok(signupUser.redemptionId);
  assert.notEqual(
    signupUser.redemptionId,
    unboundReservation.id,
    "client input cannot select the hidden ownership pointer",
  );
  assert.equal(signupUser.emailVerified, false);
  const [bound] = await sql<[{ userId: string; redeemedAt: Date | null }]>`
    SELECT "user_id" AS "userId", "redeemed_at" AS "redeemedAt"
    FROM "signup_access_code_redemptions"
    WHERE "id" = ${signupUser.redemptionId}
  `;
  assert.equal(bound.userId, signupUserId);
  assert.equal(bound.redeemedAt, null);

  await sql`
    UPDATE "signup_access_codes"
    SET "enabled" = false
    WHERE "id" = ${signupCode.id}
  `;
  const verificationToken = await createEmailVerificationToken(
    process.env.BETTER_AUTH_SECRET,
    signupEmail,
  );
  await auth.api.verifyEmail({ query: { token: verificationToken } });
  const [verifiedRedemption] = await sql<[{ redeemedAt: Date | null }]>`
    SELECT "redeemed_at" AS "redeemedAt"
    FROM "signup_access_code_redemptions"
    WHERE "id" = ${signupUser.redemptionId}
  `;
  assert.ok(
    verifiedRedemption.redeemedAt,
    "the real verification endpoint must redeem without rechecking code status",
  );

  const personalOrganizationId = `personal-org-${suffix}`;
  const personalMemberId = `personal-member-${suffix}`;
  const onboardingSessionId = `onboarding-session-${suffix}`;
  const onboardingGatewayId = `onboarding-gateway-${suffix}`;
  const onboardingModelId = `onboarding-model-${suffix}`;
  const onboardingFlyId = `onboarding-fly-${suffix}`;
  const onboardingEnvironmentId = `onboarding-environment-${suffix}`;
  createdOrganizationIds.push(personalOrganizationId);
  await sql`
    INSERT INTO "organization" ("id", "name", "slug", "createdAt")
    VALUES (
      ${personalOrganizationId}, 'Personal Workspace',
      ${`personal-${suffix}`}, ${now}
    )
  `;
  await sql`
    INSERT INTO "member" (
      "id", "organizationId", "userId", "role", "createdAt"
    ) VALUES (
      ${personalMemberId}, ${personalOrganizationId}, ${signupUserId},
      'owner', ${now}
    )
  `;
  await sql`
    INSERT INTO "session" (
      "id", "expiresAt", "token", "createdAt", "updatedAt", "userId"
    ) VALUES (
      ${onboardingSessionId}, ${new Date(now.getTime() + 60 * 60 * 1000)},
      ${`onboarding-token-${suffix}`}, ${now}, ${now}, ${signupUserId}
    )
  `;
  await sql`
    INSERT INTO "ai_gateways" (
      "id", "organization_id", "environment_id", "provider",
      "display_name", "api_key", "credential_status",
      "credential_validated_at", "credential_revision", "enabled",
      "created_at", "updated_at"
    ) VALUES (
      ${onboardingGatewayId}, ${personalOrganizationId}, NULL, 'openai',
      'OpenAI', 'encrypted-provider-key', 'ready', ${now}, 1, true,
      ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "ai_gateway_models" (
      "id", "organization_id", "gateway_id", "raw_model_id", "modality",
      "approved", "is_default", "created_at", "updated_at"
    ) VALUES (
      ${onboardingModelId}, ${personalOrganizationId}, ${onboardingGatewayId},
      'gpt-test', 'language', true, true, ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "ai_provider_connections" (
      "id", "organization_id", "provider", "scope", "display_name",
      "api_key", "enabled", "status", "last_tested_at", "metadata",
      "created_at", "updated_at"
    ) VALUES (
      ${onboardingFlyId}, ${personalOrganizationId}, 'fly', 'organization',
      'Fly.io', 'encrypted-fly-token', true, 'ready', ${now},
      ${sql.json({ organizationSlug: `fly-${suffix}` })},
      ${now}, ${now}
    )
  `;
  const [flyReadiness] = await sql<
    [{ enabled: boolean; status: string; tested: boolean; hasKey: boolean; slug: string | null }]
  >`
    SELECT
      "enabled" AS "enabled",
      "status" AS "status",
      "last_tested_at" IS NOT NULL AS "tested",
      length(btrim(COALESCE("api_key", ''))) > 0 AS "hasKey",
      "metadata" ->> 'organizationSlug' AS "slug"
    FROM "ai_provider_connections"
    WHERE "id" = ${onboardingFlyId}
  `;
  assert.deepEqual(flyReadiness, {
    enabled: true,
    status: "ready",
    tested: true,
    hasKey: true,
    slug: `fly-${suffix}`,
  });
  await sql`
    INSERT INTO "organization_feature_flags" (
      "organization_id", "key", "enabled", "updated_by_user_id",
      "created_at", "updated_at"
    ) VALUES (
      ${personalOrganizationId}, 'hosted_environments', true, ${signupUserId},
      ${now}, ${now}
    )
  `;
  await sql`
    INSERT INTO "environments" (
      "id", "organization_id", "created_by_user_id", "name", "slug",
      "provider", "region", "status", "is_default", "created_at", "updated_at"
    ) VALUES (
      ${onboardingEnvironmentId}, ${personalOrganizationId}, ${signupUserId},
      'Default', 'default', 'fly', 'iad', 'provisioning', true, ${now}, ${now}
    )
  `;

  await assert.rejects(
    accessCodes.markSignupOnboardingComplete({
      userId: signupUserId,
      sessionId: onboardingSessionId,
      organizationId: personalOrganizationId,
      now,
    }),
    (error: unknown) =>
      error instanceof accessCodes.SignupOnboardingCompletionError,
  );
  const [notCompleted] = await sql<
    [{ completedAt: Date | null; activeOrganizationId: string | null }]
  >`
    SELECT
      redemption."onboarding_completed_at" AS "completedAt",
      auth_session."activeOrganizationId" AS "activeOrganizationId"
    FROM "signup_access_code_redemptions" AS redemption
    CROSS JOIN "session" AS auth_session
    WHERE redemption."id" = ${signupUser.redemptionId}
      AND auth_session."id" = ${onboardingSessionId}
  `;
  assert.equal(notCompleted.completedAt, null);
  assert.equal(notCompleted.activeOrganizationId, null);

  await sql`
    UPDATE "environments"
    SET "status" = 'ready'
    WHERE "id" = ${onboardingEnvironmentId}
  `;
  const completed = await accessCodes.markSignupOnboardingComplete({
    userId: signupUserId,
    sessionId: onboardingSessionId,
    organizationId: personalOrganizationId,
    now,
  });
  assert.ok(completed?.onboardingCompletedAt);
  await sql`
    UPDATE "environments"
    SET "status" = 'degraded'
    WHERE "id" = ${onboardingEnvironmentId}
  `;
  await sql`
    UPDATE "session"
    SET "activeOrganizationId" = NULL
    WHERE "id" = ${onboardingSessionId}
  `;
  const completedAgain = await accessCodes.markSignupOnboardingComplete({
    userId: signupUserId,
    sessionId: onboardingSessionId,
    organizationId: personalOrganizationId,
    now: new Date(now.getTime() + 1000),
  });
  assert.equal(
    completedAgain?.onboardingCompletedAt?.getTime(),
    completed?.onboardingCompletedAt?.getTime(),
    "completion stays idempotent after later readiness changes",
  );
  const [activeSession] = await sql<[{ activeOrganizationId: string | null }]>`
    SELECT "activeOrganizationId" AS "activeOrganizationId"
    FROM "session"
    WHERE "id" = ${onboardingSessionId}
  `;
  assert.equal(activeSession.activeOrganizationId, personalOrganizationId);

  const mismatchCode = await createCode(`MISMATCH-${suffix}`, 1);
  const mismatchEmail = `mismatch-${suffix}@example.test`;
  const mismatchReservation = await accessCodes.reserveSignupAccessCode({
    code: mismatchCode.rawCode,
    email: mismatchEmail,
  });
  const mismatchUserId = `mismatch-user-${suffix}`;
  createdUserIds.add(mismatchUserId);
  await assert.rejects(sql`
    INSERT INTO "user" (
      "id", "name", "email", "emailVerified",
      "signup_access_code_redemption_id", "createdAt", "updatedAt"
    ) VALUES (
      ${mismatchUserId}, 'Mismatch User', ${`wrong-${mismatchEmail}`}, false,
      ${mismatchReservation.id}, ${now}, ${now}
    )
  `);
  const [mismatchUserCount] = await sql<[{ count: number }]>`
    SELECT count(*)::int AS "count" FROM "user" WHERE "id" = ${mismatchUserId}
  `;
  assert.equal(mismatchUserCount.count, 0, "failed binding rolls back user creation");

  async function createBoundExpiredUser(input: {
    label: string;
    verifiedAfterExpiry: boolean;
  }) {
    const oldCode = await createCode(`OLD-${input.label}-${suffix}`, 1);
    const email = `${input.label}-${suffix}@example.test`;
    const reservation = await accessCodes.reserveSignupAccessCode({
      code: oldCode.rawCode,
      email,
    });
    const userId = `${input.label}-user-${suffix}`;
    createdUserIds.add(userId);
    await sql`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified",
        "signup_access_code_redemption_id", "createdAt", "updatedAt"
      ) VALUES (
        ${userId}, 'Expired User', ${email}, false,
        ${reservation.id}, ${now}, ${now}
      )
    `;
    await sql`
      UPDATE "signup_access_code_redemptions"
      SET "reservation_expires_at" = ${new Date(now.getTime() - 1000)}
      WHERE "id" = ${reservation.id}
    `;
    if (input.verifiedAfterExpiry) {
      await sql`
        UPDATE "user" SET "emailVerified" = true WHERE "id" = ${userId}
      `;
      const [expired] = await sql<[{ redeemedAt: Date | null }]>`
        SELECT "redeemed_at" AS "redeemedAt"
        FROM "signup_access_code_redemptions"
        WHERE "id" = ${reservation.id}
      `;
      assert.equal(expired.redeemedAt, null);
    }
    return { email, reservation, userId };
  }

  const unverifiedExpired = await createBoundExpiredUser({
    label: "unverified-replace",
    verifiedAfterExpiry: false,
  });
  const unverifiedReplacementCode = await createCode(
    `NEW-UNVERIFIED-${suffix}`,
    1,
  );
  const unverifiedReplacement =
    await accessCodes.replaceExpiredSignupAccessCodeReservation({
      userId: unverifiedExpired.userId,
      email: unverifiedExpired.email,
      code: unverifiedReplacementCode.rawCode,
    });
  assert.equal(unverifiedReplacement.id, unverifiedExpired.reservation.id);
  assert.equal(unverifiedReplacement.redeemedAt, null);

  const verifiedExpired = await createBoundExpiredUser({
    label: "verified-replace",
    verifiedAfterExpiry: true,
  });
  const verifiedReplacementCode = await createCode(
    `NEW-VERIFIED-${suffix}`,
    1,
  );
  const verifiedReplacement =
    await accessCodes.replaceExpiredSignupAccessCodeReservation({
      userId: verifiedExpired.userId,
      email: verifiedExpired.email,
      code: verifiedReplacementCode.rawCode,
    });
  assert.equal(verifiedReplacement.id, verifiedExpired.reservation.id);
  assert.ok(verifiedReplacement.redeemedAt);

  const concurrentExpired = await createBoundExpiredUser({
    label: "concurrent-replace",
    verifiedAfterExpiry: false,
  });
  const concurrentReplacementCode = await createCode(
    `NEW-CONCURRENT-${suffix}`,
    1,
  );
  await Promise.all([
    sql`
      UPDATE "user"
      SET "emailVerified" = true
      WHERE "id" = ${concurrentExpired.userId}
    `,
    accessCodes.replaceExpiredSignupAccessCodeReservation({
      userId: concurrentExpired.userId,
      email: concurrentExpired.email,
      code: concurrentReplacementCode.rawCode,
    }),
  ]);
  const [concurrentReplacement] = await sql<[{ redeemedAt: Date | null }]>`
    SELECT "redeemed_at" AS "redeemedAt"
    FROM "signup_access_code_redemptions"
    WHERE "id" = ${concurrentExpired.reservation.id}
  `;
  assert.ok(
    concurrentReplacement.redeemedAt,
    "verification and replacement serialize to a redeemed reservation",
  );

  const rollbackUser = await createBoundExpiredUser({
    label: "verification-rollback",
    verifiedAfterExpiry: false,
  });
  await sql`
    UPDATE "signup_access_code_redemptions"
    SET "user_id" = ${creatorId}
    WHERE "id" = ${rollbackUser.reservation.id}
  `;
  await assert.rejects(sql`
    UPDATE "user" SET "emailVerified" = true WHERE "id" = ${rollbackUser.userId}
  `);
  const [rolledBackVerification] = await sql<[{ emailVerified: boolean }]>`
    SELECT "emailVerified" AS "emailVerified"
    FROM "user"
    WHERE "id" = ${rollbackUser.userId}
  `;
  assert.equal(
    rolledBackVerification.emailVerified,
    false,
    "an ownership mismatch rolls back the verification transition",
  );
});
