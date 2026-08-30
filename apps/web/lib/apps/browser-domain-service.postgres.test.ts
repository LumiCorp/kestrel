import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import {
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
} from "../../../../src/browser/domainAuthority.js";

const databaseUrl = process.env.KESTREL_APPS_DB_TEST_URL?.trim();

test("hosted personal Browser grants serialize one user and Environment revision", async (context) => {
  assert.ok(databaseUrl, "KESTREL_APPS_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const [
    { resetDbRuntimeForTests },
    appService,
    projectAppService,
    browserDomains,
    turnStore,
    toolService,
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./service"),
    import("./project-service"),
    import("./browser-domain-service"),
    import("../turns/store"),
    import("../tools/service"),
  ]);
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const organizationId = `browser-domain-org-${suffix}`;
  const userId = `browser-domain-user-${suffix}`;
  const otherUserId = `browser-domain-other-user-${suffix}`;
  const memberId = `browser-domain-member-${suffix}`;
  const otherMemberId = `browser-domain-other-member-${suffix}`;
  const environmentId = `browser-domain-environment-${suffix}`;
  const otherEnvironmentId = `browser-domain-other-environment-${suffix}`;
  const projectId = `browser-domain-project-${suffix}`;
  const secondProjectId = `browser-domain-project-b-${suffix}`;
  const threadId = `browser-domain-thread-${suffix}`;
  const turnId = `browser-domain-turn-${suffix}`;
  const interactionId = `browser-domain-interaction-${suffix}`;
  const deniedApprovalThreadId = `browser-domain-denied-approval-thread-${suffix}`;
  const qaApprovalThreadId = `browser-domain-qa-approval-thread-${suffix}`;
  const mismatchedApprovalThreadId = `browser-domain-mismatched-approval-thread-${suffix}`;
  const now = new Date("2026-08-29T12:00:00.000Z");
  const publicDomain = (canonicalDomain: string) => ({
    version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
    scheme: "https" as const,
    canonicalDomain,
    includeSubdomains: true as const,
    port: 443 as const,
  });
  const environmentSettings = {
    enabledModes: ["operator"],
    personalGrantsEnabled: true,
    configuredPublicDomains: [publicDomain("configured.com")],
    blockedPublicDomains: [],
  };
  const projectSettings = {
    enabledModes: ["operator"],
    personalGrantsEnabled: true,
    blockedPublicDomains: [],
  };

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" IN (${userId}, ${otherUserId})`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await appService.ensureCoreAppCatalog();
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${userId}, 'Browser User', ${`${userId}@example.test`}, true, ${now}, ${now}),
        (${otherUserId}, 'Other Browser User', ${`${otherUserId}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Browser Domain Org', ${organizationId}, ${now})
    `;
    await transaction`
      INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
      VALUES
        (${memberId}, ${organizationId}, ${userId}, 'owner', ${now}),
        (${otherMemberId}, ${organizationId}, ${otherUserId}, 'member', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug", "region"
      ) VALUES
        (${environmentId}, ${organizationId}, ${userId}, 'Browser Env', ${`browser-${suffix}`}, 'iad'),
        (${otherEnvironmentId}, ${organizationId}, ${userId}, 'Other Browser Env', ${`browser-other-${suffix}`}, 'iad')
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES
        (${projectId}, ${organizationId}, ${environmentId}, ${userId}, 'Browser Project'),
        (${secondProjectId}, ${organizationId}, ${environmentId}, ${userId}, 'Second Browser Project')
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${projectId}, ${memberId}, 'owner'),
        (${secondProjectId}, ${memberId}, 'owner')
    `;
    await transaction`
      INSERT INTO "project_apps" (
        "project_id", "app_key", "enabled", "added_by_user_id", "settings"
      ) VALUES
        (${projectId}, 'built_in.browser', true, ${userId}, '{}'::jsonb),
        (${secondProjectId}, 'built_in.browser', true, ${userId}, '{}'::jsonb)
    `;
    await transaction`
      INSERT INTO "environment_app_capability_grants" (
        "environment_id", "app_key", "capability_key", "enabled",
        "approval_mode", "logging_mode", "rate_limit_mode", "settings"
      ) VALUES
        (${environmentId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${transaction.json(environmentSettings)}),
        (${otherEnvironmentId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${transaction.json(environmentSettings)})
    `;
    await transaction`
      INSERT INTO "project_app_capability_policies" (
        "project_id", "app_key", "capability_key", "enabled",
        "approval_mode", "logging_mode", "rate_limit_mode", "settings"
      ) VALUES
        (${projectId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${transaction.json(projectSettings)}),
        (${secondProjectId}, 'built_in.browser', 'request_grant', true, 'auto', 'metadata_only', 'off', ${transaction.json(projectSettings)})
    `;
    await transaction`
      INSERT INTO "threads" (
        "id", "created_by_user_id", "organization_id", "project_id"
      ) VALUES
        (${threadId}, ${userId}, ${organizationId}, ${projectId}),
        (${deniedApprovalThreadId}, ${userId}, ${organizationId}, NULL),
        (${qaApprovalThreadId}, ${userId}, ${organizationId}, NULL),
        (${mismatchedApprovalThreadId}, ${userId}, ${organizationId}, NULL)
    `;
    await transaction`
      INSERT INTO "thread_turns" (
        "id", "organization_id", "thread_id", "author_user_id",
        "approval_id", "approval_approved", "requested_environment_id",
        "idempotency_key", "sequence", "queue_ordinal", "status", "finished_at"
      ) VALUES (
        ${turnId}, ${organizationId}, ${threadId}, ${userId},
        ${`browser-domain-approval-${suffix}`}, true, ${environmentId},
        ${`browser-domain-${suffix}`}, 1, 1, 'completed', ${now}
      )
    `;
    await transaction`
      INSERT INTO "thread_interactions" (
        "id", "request_id", "organization_id", "thread_id", "turn_id",
        "source", "kind", "event_type", "prompt", "status", "request_envelope"
      ) VALUES (
        ${interactionId}, ${`browser-domain-request-${suffix}`}, ${organizationId},
        ${threadId}, ${turnId}, 'runtime', 'approval', 'user.approval',
        'Allow example.com apex and subdomains?', 'resolved', '{}'::jsonb
      )
    `;
  });
  assert.ok(
    await toolService.getResolvedToolProvider({
      organizationId,
      providerKey: "built_in.browser",
    }),
  );

  const savedEnvironmentSettings = {
    enabledModes: ["operator"] as ("qa" | "operator")[],
    personalGrantsEnabled: true,
    configuredPublicDomains: [publicDomain("configured.com")],
    blockedPublicDomains: [publicDomain("example.net")],
  };
  await appService.saveEnvironmentAppCapabilityGrant({
    organizationId,
    environmentId,
    appKey: "built_in.browser",
    capabilityKey: "request_grant",
    grant: {
      enabled: true,
      approvalMode: "auto",
      loggingMode: "metadata_only",
      rateLimitMode: "off",
      settings: savedEnvironmentSettings,
    },
  });
  const environmentConfiguration =
    await appService.getEnvironmentAppConfiguration({
      organizationId,
      environmentId,
      appKey: "built_in.browser",
    });
  assert.deepEqual(
    environmentConfiguration.capabilities.find(
      (capability) => capability.key === "request_grant",
    )?.browserSettings,
    savedEnvironmentSettings,
  );

  const savedProjectSettings = {
    enabledModes: ["operator"] as ("qa" | "operator")[],
    personalGrantsEnabled: false,
    blockedPublicDomains: [publicDomain("example.org")],
  };
  await projectAppService.saveProjectAppCapabilityPolicy({
    organizationId,
    projectId,
    appKey: "built_in.browser",
    capabilityKey: "request_grant",
    actorUserId: userId,
    enabled: true,
    approvalMode: "auto",
    browserSettings: savedProjectSettings,
  });
  const projectConfiguration = (
    await projectAppService.listProjectAppConfigurations({
      organizationId,
      projectId,
      userId,
    })
  ).find((configuration) => configuration.app.key === "built_in.browser");
  const browserCapability = projectConfiguration?.capabilities.find(
    (capability) => capability.key === "request_grant",
  );
  assert.deepEqual(browserCapability?.browserSettings, savedProjectSettings);
  assert.deepEqual(
    browserCapability?.environmentBrowserSettings,
    savedEnvironmentSettings,
  );
  assert.doesNotMatch(
    JSON.stringify({ environmentConfiguration, projectConfiguration }),
    /sourcePreparedInvocationId|approvalId|userId.*canonicalDomain/u,
  );
  const [storedPolicies] = await sql<
    { environmentSettings: unknown; projectSettings: unknown }[]
  >`
    SELECT
      environment_policy."settings" AS "environmentSettings",
      project_policy."settings" AS "projectSettings"
    FROM "environment_app_capability_grants" environment_policy
    JOIN "project_app_capability_policies" project_policy
      ON project_policy."app_key" = environment_policy."app_key"
      AND project_policy."capability_key" = environment_policy."capability_key"
    WHERE environment_policy."environment_id" = ${environmentId}
      AND project_policy."project_id" = ${projectId}
      AND environment_policy."app_key" = 'built_in.browser'
      AND environment_policy."capability_key" = 'request_grant'
  `;
  assert.deepEqual(
    storedPolicies?.environmentSettings,
    savedEnvironmentSettings,
  );
  assert.deepEqual(storedPolicies?.projectSettings, savedProjectSettings);
  assert.equal(
    Object.hasOwn(
      storedPolicies?.projectSettings ?? {},
      "configuredPublicDomains",
    ),
    false,
  );

  await assert.rejects(
    projectAppService.saveProjectAppCapabilityPolicy({
      organizationId,
      projectId,
      appKey: "built_in.browser",
      capabilityKey: "request_grant",
      actorUserId: userId,
      enabled: true,
      approvalMode: "auto",
      browserSettings: {
        enabledModes: ["qa", "operator"],
        personalGrantsEnabled: true,
        blockedPublicDomains: [],
      },
    }),
    (error: unknown) =>
      error instanceof projectAppService.ProjectAppError &&
      error.code === "APP_POLICY_WIDENS_ENVIRONMENT",
  );

  const provenance = {
    approvalId: `approval-${suffix}`,
    sourceInteractionId: interactionId,
    sourcePreparedInvocationId: `prepared-${suffix}`,
    approvalAuthorityRevision: `authority-${suffix}`,
  };
  const scope = { organizationId, environmentId, userId };
  const [first, retry] = await Promise.all([
    browserDomains.createOrReactivateHostedBrowserPersonalDomain({
      ...scope,
      destination: "https://www.example.com/path?not-persisted=yes",
      ...provenance,
      now,
    }),
    browserDomains.createOrReactivateHostedBrowserPersonalDomain({
      ...scope,
      destination: "https://sub.example.com/other",
      ...provenance,
      now,
    }),
  ]);
  assert.deepEqual([first.changed, retry.changed].sort(), [false, true]);
  assert.equal(first.personalRevision, 1);
  assert.equal(retry.personalRevision, 1);
  assert.equal(
    await browserDomains.readHostedBrowserPersonalDomainRevision(scope),
    1,
  );

  const list = await browserDomains.listHostedBrowserPersonalDomains(scope);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.canonicalDomain, "example.com");
  assert.deepEqual(
    await browserDomains.listHostedBrowserPersonalDomains({
      organizationId,
      environmentId,
      userId: otherUserId,
    }),
    [],
  );
  assert.deepEqual(
    await browserDomains.listHostedBrowserPersonalDomains({
      organizationId,
      environmentId: otherEnvironmentId,
      userId,
    }),
    [],
  );

  const qa = {
    version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
    revision: "qa-none",
    target: null,
  } as const;
  const narrowedAuthority =
    await browserDomains.resolveHostedBrowserDomainAuthority({
      ...scope,
      projectId,
      agentId: "kestrel-one",
      qa,
    });
  assert.equal(
    narrowedAuthority.publicDomains.some(
      (entry) => entry.canonicalDomain === "example.com",
    ),
    false,
  );
  const eligibleProjectAuthority =
    await browserDomains.resolveHostedBrowserDomainAuthority({
      ...scope,
      projectId: secondProjectId,
      agentId: "kestrel-one",
      qa,
    });
  assert.ok(
    eligibleProjectAuthority.publicDomains.some(
      (entry) => entry.canonicalDomain === "example.com",
    ),
  );

  const revoked = await browserDomains.revokeHostedBrowserPersonalDomain({
    ...scope,
    destination: "https://example.com",
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.personalRevision, 2);
  const repeatedRevoke = await browserDomains.revokeHostedBrowserPersonalDomain(
    {
      ...scope,
      destination: "https://example.com/again",
      now: new Date(now.getTime() + 2_000),
    },
  );
  assert.equal(repeatedRevoke.changed, false);
  assert.equal(repeatedRevoke.personalRevision, 2);
  const reactivated =
    await browserDomains.createOrReactivateHostedBrowserPersonalDomain({
      ...scope,
      destination: "https://www.example.com/new",
      approvalId: `approval-reactivated-${suffix}`,
      sourceInteractionId: interactionId,
      sourcePreparedInvocationId: `prepared-reactivated-${suffix}`,
      approvalAuthorityRevision: `authority-reactivated-${suffix}`,
      now: new Date(now.getTime() + 3_000),
    });
  assert.equal(reactivated.changed, true);
  assert.equal(reactivated.personalRevision, 3);

  async function publishBrowserGrantApproval(input: {
    threadId: string;
    label: string;
    canonicalDomain: string;
    stableAuthorityRevision: string;
    presentedAuthorityRevision?: string | undefined;
    sessionMode?: "qa" | "operator" | undefined;
  }) {
    const created = await turnStore.createDurableThreadTurn({
      threadId: input.threadId,
      organizationId,
      authorUserId: userId,
      messageId: `browser-domain-message-${input.label}-${suffix}`,
      messageParts: [{ type: "text", text: `Open ${input.canonicalDomain}` }],
      idempotencyKey: `browser-domain-turn-${input.label}-${suffix}`,
      requestedEnvironmentId: environmentId,
      source: "web",
    });
    assert.ok(await turnStore.claimDurableThreadTurn(created.turn.id));
    const requestId = `browser-domain-approval-${input.label}-${suffix}`;
    const interaction = {
      version: "runner_hosted_tool_approval_interaction_v4" as const,
      requestId,
      kind: "approval" as const,
      eventType: "user.approval" as const,
      prompt: "Review this Browser domain before it is allowed.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false as const,
        required: ["decision"] as ["decision"],
        properties: {
          decision: {
            type: "string" as const,
            enum: ["decline", "approve_once", "remember_approval"] as [
              "decline",
              "approve_once",
              "remember_approval",
            ],
          },
        },
      },
      approval: {
        preparedInvocationId: `browser-prepared-${input.label}-${suffix}`,
        toolName: "browser.request_grant",
        stableToolIdentity: {
          version: "stable_tool_approval_identity_v1" as const,
          toolId: "browser.request_grant",
          descriptorContractRevision: "browser-request-grant-v1",
          approvalAuthorityRevision: input.stableAuthorityRevision,
        },
        requestingActor: {
          actorType: "end_user" as const,
          actorId: userId,
          tenantId: organizationId,
        },
        rememberedApprovalScope: { kind: "tool_identity" as const },
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        presentation: {
          title: "Allow this Browser domain",
          summary: "Allow this HTTPS apex and its subdomains.",
          fields: [
            { label: "Domain", value: input.canonicalDomain },
            { label: "Person", value: userId },
            { label: "Environment", value: environmentId },
          ],
          warnings: [],
          policy: {
            mode: "ask" as const,
            reasonCode: "environment_policy" as const,
            explanation: "Environment policy requires approval.",
            authorityKind: "hosted_app_policy" as const,
            authorityRevision: input.stableAuthorityRevision,
            rememberApprovalEligible: false,
          },
          browserDomainGrant: {
            version: "browser_domain_grant_approval_v1" as const,
            sessionId: `browser-session-${input.label}-${suffix}`,
            sessionMode: input.sessionMode ?? "operator",
            canonicalDomain: input.canonicalDomain,
            scheme: "https" as const,
            scope: "apex_and_subdomains" as const,
            includeSubdomains: true as const,
            port: 443 as const,
            ownerEffect: "requesting_person" as const,
            environmentEffect:
              "future_eligible_projects_in_environment" as const,
            sessionEffect: "immediate" as const,
            actionLabel: "Allow and remember" as const,
            requestingActorId: userId,
            environmentId,
            approvalAuthorityRevision:
              input.presentedAuthorityRevision ?? input.stableAuthorityRevision,
          },
        },
      },
      source: "runtime" as const,
      status: "pending" as const,
    };
    await turnStore.persistDurableAssistantOutcome({
      turnId: created.turn.id,
      messages: [{
        id: `browser-domain-assistant-${input.label}-${suffix}`,
        parts: [{
          type: "data-kestrel-interaction",
          id: `interaction:${requestId}`,
          data: interaction,
        }],
        model: "kestrel-one",
        source: "web",
        projectContextRevisionId: null,
      }],
      interaction,
    });
    await sql`
      UPDATE "threads"
      SET "project_id" = ${secondProjectId}
      WHERE "id" = ${input.threadId}
    `;
    return { requestId, turnId: created.turn.id };
  }

  const deniedApproval = await publishBrowserGrantApproval({
    threadId: deniedApprovalThreadId,
    label: "subject-denied",
    canonicalDomain: "denied-example.net",
    stableAuthorityRevision: "browser-authority-subject-denied",
  });
  await sql`
    INSERT INTO "environment_capability_subject_restrictions" (
      "id", "organization_id", "environment_id", "subject_type",
      "subject_id", "provider_key", "capability_key", "resource_id",
      "enabled", "approval_mode"
    ) VALUES (
      ${`browser-domain-restriction-${suffix}`}, ${organizationId},
      ${environmentId}, 'actor', ${userId}, 'built_in.browser',
      'request_grant', NULL, false, 'deny'
    )
  `;
  const deniedResolution = await turnStore.resolveDurableRuntimeInteraction({
    threadId: deniedApprovalThreadId,
    organizationId,
    userId,
    requestId: deniedApproval.requestId,
    eventType: "user.approval",
    turnId: deniedApproval.turnId,
    message: "Allow and remember",
    decision: "approve_once",
    messageId: `browser-domain-denied-response-${suffix}`,
    source: "web",
  });
  assert.equal(deniedResolution.shouldDispatch, true);
  const [deniedState] = await sql<Array<{
    domainCount: number;
    personalRevision: number;
    responseEnvelope: Record<string, unknown>;
  }>>`
    SELECT
      (
        SELECT count(*)::int FROM "browser_personal_domains"
        WHERE "organization_id" = ${organizationId}
          AND "environment_id" = ${environmentId}
          AND "user_id" = ${userId}
          AND "canonical_domain" = 'denied-example.net'
      ) AS "domainCount",
      revision_set."revision" AS "personalRevision",
      interaction."response_envelope" AS "responseEnvelope"
    FROM "browser_personal_domain_revision_sets" revision_set
    JOIN "thread_interactions" interaction
      ON interaction."request_id" = ${deniedApproval.requestId}
    WHERE revision_set."organization_id" = ${organizationId}
      AND revision_set."environment_id" = ${environmentId}
      AND revision_set."user_id" = ${userId}
  `;
  assert.equal(deniedState?.domainCount, 0);
  assert.equal(deniedState?.personalRevision, 3);
  assert.equal(
    (
      deniedState?.responseEnvelope.preparedApprovalCleanup as
        | Record<string, unknown>
        | undefined
    )?.failureCode,
    "EXTERNAL_APPROVAL_POLICY_CHANGED",
  );

  await sql`
    DELETE FROM "environment_capability_subject_restrictions"
    WHERE "organization_id" = ${organizationId}
      AND "environment_id" = ${environmentId}
      AND "subject_type" = 'actor'
      AND "subject_id" = ${userId}
      AND "provider_key" = 'built_in.browser'
      AND "capability_key" = 'request_grant'
  `;
  const qaApproval = await publishBrowserGrantApproval({
    threadId: qaApprovalThreadId,
    label: "qa-session",
    canonicalDomain: "qa-example.dev",
    stableAuthorityRevision: "browser-authority-qa-session",
    sessionMode: "qa",
  });
  await assert.rejects(
    turnStore.resolveDurableRuntimeInteraction({
      threadId: qaApprovalThreadId,
      organizationId,
      userId,
      requestId: qaApproval.requestId,
      eventType: "user.approval",
      turnId: qaApproval.turnId,
      message: "Allow and remember",
      decision: "approve_once",
      messageId: `browser-domain-qa-response-${suffix}`,
      source: "web",
    }),
    /Browser domain approval presentation is invalid/u,
  );
  const [qaState] = await sql<Array<{
    domainCount: number;
    personalRevision: number;
  }>>`
    SELECT
      (
        SELECT count(*)::int FROM "browser_personal_domains"
        WHERE "organization_id" = ${organizationId}
          AND "environment_id" = ${environmentId}
          AND "user_id" = ${userId}
          AND "canonical_domain" = 'qa-example.dev'
      ) AS "domainCount",
      revision_set."revision" AS "personalRevision"
    FROM "browser_personal_domain_revision_sets" revision_set
    WHERE revision_set."organization_id" = ${organizationId}
      AND revision_set."environment_id" = ${environmentId}
      AND revision_set."user_id" = ${userId}
  `;
  assert.equal(qaState?.domainCount, 0);
  assert.equal(qaState?.personalRevision, 3);

  const mismatchedApproval = await publishBrowserGrantApproval({
    threadId: mismatchedApprovalThreadId,
    label: "authority-mismatch",
    canonicalDomain: "mismatch-example.org",
    stableAuthorityRevision: "browser-authority-current",
    presentedAuthorityRevision: "browser-authority-forged",
  });
  await assert.rejects(
    turnStore.resolveDurableRuntimeInteraction({
      threadId: mismatchedApprovalThreadId,
      organizationId,
      userId,
      requestId: mismatchedApproval.requestId,
      eventType: "user.approval",
      turnId: mismatchedApproval.turnId,
      message: "Allow and remember",
      decision: "approve_once",
      messageId: `browser-domain-mismatched-response-${suffix}`,
      source: "web",
    }),
    /Browser domain approval presentation is invalid/u,
  );
  const [mismatchedState] = await sql<Array<{
    domainCount: number;
    personalRevision: number;
  }>>`
    SELECT
      (
        SELECT count(*)::int FROM "browser_personal_domains"
        WHERE "organization_id" = ${organizationId}
          AND "environment_id" = ${environmentId}
          AND "user_id" = ${userId}
          AND "canonical_domain" = 'mismatch-example.org'
      ) AS "domainCount",
      "revision" AS "personalRevision"
    FROM "browser_personal_domain_revision_sets"
    WHERE "organization_id" = ${organizationId}
      AND "environment_id" = ${environmentId}
      AND "user_id" = ${userId}
  `;
  assert.deepEqual(mismatchedState, {
    domainCount: 0,
    personalRevision: 3,
  });

  const [stored] = await sql<
    {
      approvalId: string;
      preparedId: string;
      authorityRevision: string;
      canonicalDomain: string;
    }[]
  >`
    SELECT
      "approval_id" AS "approvalId",
      "source_prepared_invocation_id" AS "preparedId",
      "approval_authority_revision" AS "authorityRevision",
      "canonical_domain" AS "canonicalDomain"
    FROM "browser_personal_domains"
    WHERE "organization_id" = ${organizationId}
      AND "environment_id" = ${environmentId}
      AND "user_id" = ${userId}
  `;
  assert.deepEqual(stored, {
    approvalId: `approval-reactivated-${suffix}`,
    preparedId: `prepared-reactivated-${suffix}`,
    authorityRevision: `authority-reactivated-${suffix}`,
    canonicalDomain: "example.com",
  });
});
