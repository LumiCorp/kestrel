import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Project prompt schedules preserve authority, occurrence, and materialization contracts", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  const previousDrizzleMaxConnections =
    process.env.DB_DRIZZLE_MAX_CONNECTIONS;
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.env.DB_DRIZZLE_MAX_CONNECTIONS = "1";

  const [{ resetDbRuntimeForTests }, schedules, projects, environments] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./store"),
    import("@/lib/projects/store"),
    import("@/lib/environments/store"),
  ]);
  const { materializeProjectPromptScheduleRun } = await import("./runtime");
  const sql = postgres(databaseUrl, { max: 6 });
  const suffix = crypto.randomUUID();
  const ids = {
    organization: `schedule-org-${suffix}`,
    environment: `schedule-environment-${suffix}`,
    targetEnvironment: `schedule-target-environment-${suffix}`,
    project: `schedule-project-${suffix}`,
    rebindProject: `schedule-rebind-project-${suffix}`,
    context: `schedule-context-${suffix}`,
    rebindContext: `schedule-rebind-context-${suffix}`,
    gateway: `schedule-gateway-${suffix}`,
    scopedGateway: `schedule-scoped-gateway-${suffix}`,
    model: `schedule-model-${suffix}`,
    scopedModel: `schedule-scoped-model-${suffix}`,
    owner: `schedule-owner-${suffix}`,
    creator: `schedule-creator-${suffix}`,
    member: `schedule-member-${suffix}`,
    lifecycleCreator: `schedule-lifecycle-creator-${suffix}`,
    ownerMember: `schedule-owner-member-${suffix}`,
    creatorMember: `schedule-creator-member-${suffix}`,
    memberMember: `schedule-member-member-${suffix}`,
    lifecycleCreatorMember: `schedule-lifecycle-creator-member-${suffix}`,
  };
  const now = new Date("2026-08-13T16:30:00.000Z");

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${ids.organization}`;
    await sql`DELETE FROM "user" WHERE "id" IN (${ids.owner}, ${ids.creator}, ${ids.member}, ${ids.lifecycleCreator})`;
    await resetDbRuntimeForTests();
    if (previousDrizzleMaxConnections === undefined) {
      delete process.env.DB_DRIZZLE_MAX_CONNECTIONS;
    } else {
      process.env.DB_DRIZZLE_MAX_CONNECTIONS = previousDrizzleMaxConnections;
    }
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${ids.owner}, 'Schedule Owner', ${`${ids.owner}@example.test`}, true, ${now}, ${now}),
        (${ids.creator}, 'Schedule Creator', ${`${ids.creator}@example.test`}, true, ${now}, ${now}),
        (${ids.member}, 'Schedule Member', ${`${ids.member}@example.test`}, true, ${now}, ${now}),
        (${ids.lifecycleCreator}, 'Schedule Lifecycle Creator', ${`${ids.lifecycleCreator}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${ids.organization}, 'Schedule Org', ${ids.organization}, ${now})
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (${ids.ownerMember}, ${ids.organization}, ${ids.owner}, 'owner', ${now}),
        (${ids.creatorMember}, ${ids.organization}, ${ids.creator}, 'member', ${now}),
        (${ids.memberMember}, ${ids.organization}, ${ids.member}, 'member', ${now}),
        (${ids.lifecycleCreatorMember}, ${ids.organization}, ${ids.lifecycleCreator}, 'member', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "region", "status", "is_default", "fly_app_name", "router_url"
      ) VALUES
        (
          ${ids.environment}, ${ids.organization}, ${ids.owner},
          'Schedule Environment', 'schedule', 'iad', 'ready', true,
          ${`schedule-app-${suffix}`}, 'https://environment.example'
        ),
        (
          ${ids.targetEnvironment}, ${ids.organization}, ${ids.owner},
          'Schedule Target Environment', 'schedule-target', 'iad', 'ready', false,
          ${`schedule-target-app-${suffix}`}, 'https://target-environment.example'
        )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES
        (
          ${ids.project}, ${ids.organization}, ${ids.environment},
          ${ids.owner}, 'Schedule Project'
        ),
        (
          ${ids.rebindProject}, ${ids.organization}, ${ids.environment},
          ${ids.owner}, 'Schedule Rebind Project'
        )
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${ids.project}, ${ids.ownerMember}, 'owner'),
        (${ids.project}, ${ids.creatorMember}, 'editor'),
        (${ids.project}, ${ids.memberMember}, 'member'),
        (${ids.project}, ${ids.lifecycleCreatorMember}, 'editor'),
        (${ids.rebindProject}, ${ids.ownerMember}, 'owner'),
        (${ids.rebindProject}, ${ids.creatorMember}, 'editor')
    `;
    await transaction`
      INSERT INTO "project_context_revisions" (
        "id", "project_id", "revision", "project_name", "instructions",
        "created_by_user_id", "created_at"
      ) VALUES
        (
          ${ids.context}, ${ids.project}, 1, 'Schedule Project',
          'Answer scheduled requests concisely.', ${ids.owner}, ${now}
        ),
        (
          ${ids.rebindContext}, ${ids.rebindProject}, 1, 'Schedule Rebind Project',
          'Keep scheduled model selections valid.', ${ids.owner}, ${now}
        )
    `;
    await transaction`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "environment_id", "provider", "display_name"
      ) VALUES
        (
          ${ids.gateway}, ${ids.organization}, NULL,
          'openrouter', 'Schedule Gateway'
        ),
        (
          ${ids.scopedGateway}, ${ids.organization}, ${ids.environment},
          'openrouter', 'Environment-scoped Schedule Gateway'
        )
    `;
    await transaction`
      INSERT INTO "ai_gateway_models" (
        "id", "organization_id", "gateway_id", "raw_model_id", "modality",
        "approved", "is_default"
      ) VALUES
        (
          ${ids.model}, ${ids.organization}, ${ids.gateway},
          'test-schedule-model', 'language', true, true
        ),
        (
          ${ids.scopedModel}, ${ids.organization}, ${ids.scopedGateway},
          'environment-only-schedule-model', 'language', true, false
        )
    `;
  });

  let releaseArchive = () => {};
  const archiveGate = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  let markArchiveReady = () => {};
  const archiveReady = new Promise<void>((resolve) => {
    markArchiveReady = resolve;
  });
  const heldArchive = sql.begin(async (transaction) => {
    await transaction`
      UPDATE "projects"
      SET "archived_at" = ${now}, "updated_at" = ${now}
      WHERE "id" = ${ids.project}
    `;
    await transaction`
      UPDATE "project_prompt_schedules"
      SET "enabled" = false, "pause_reason" = 'project_archived',
          "next_run_at" = NULL, "updated_at" = ${now}
      WHERE "project_id" = ${ids.project}
    `;
    markArchiveReady();
    await archiveGate;
  });
  await archiveReady;
  let archiveCreationSettled = false;
  const archiveCreation = schedules
    .createProjectPromptSchedule({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.lifecycleCreator,
      title: "Archive race",
      cronExpression: "0 * * * *",
      timeZone: "UTC",
      prompt: "Must not be created while the Project is being archived.",
      modelId: "openrouter/test-schedule-model",
    })
    .then(
      (value) => {
        archiveCreationSettled = true;
        return { status: "fulfilled" as const, value };
      },
      (error: unknown) => {
        archiveCreationSettled = true;
        return { status: "rejected" as const, error };
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    archiveCreationSettled,
    false,
    "schedule creation waits for an in-flight Project archive",
  );
  releaseArchive();
  await heldArchive;
  const archiveCreationResult = await archiveCreation;
  assert.equal(archiveCreationResult.status, "rejected");
  assert.match(
    archiveCreationResult.status === "rejected" &&
      archiveCreationResult.error instanceof Error
      ? archiveCreationResult.error.message
      : "",
    /Project not found or unavailable/u,
  );
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: false,
  });

  await assert.rejects(
    schedules.createProjectPromptSchedule({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.creator,
      title: "Unavailable model",
      cronExpression: "0 * * * *",
      timeZone: "UTC",
      prompt: "Do not persist an unavailable model.",
      modelId: "openrouter/not-approved-for-this-environment",
    }),
    /model is not available in this Project Environment/u,
  );

  let releaseMembershipRemoval = () => {};
  const membershipRemovalGate = new Promise<void>((resolve) => {
    releaseMembershipRemoval = resolve;
  });
  let markMembershipRemovalReady = () => {};
  const membershipRemovalReady = new Promise<void>((resolve) => {
    markMembershipRemovalReady = resolve;
  });
  const heldMembershipRemoval = sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM "project_members"
      WHERE "project_id" = ${ids.project}
        AND "organization_member_id" = ${ids.lifecycleCreatorMember}
    `;
    markMembershipRemovalReady();
    await membershipRemovalGate;
  });
  await membershipRemovalReady;
  let membershipCreationSettled = false;
  const membershipCreation = schedules
    .createProjectPromptSchedule({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.lifecycleCreator,
      title: "Membership race",
      cronExpression: "0 * * * *",
      timeZone: "UTC",
      prompt: "Must not survive concurrent membership removal.",
      modelId: "openrouter/test-schedule-model",
    })
    .then(
      (value) => {
        membershipCreationSettled = true;
        return { status: "fulfilled" as const, value };
      },
      (error: unknown) => {
        membershipCreationSettled = true;
        return { status: "rejected" as const, error };
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const membershipCreationSettledWhileRemovalWasOpen =
    membershipCreationSettled;
  releaseMembershipRemoval();
  await heldMembershipRemoval;
  const membershipCreationResult = await membershipCreation;
  assert.equal(
    membershipCreationSettledWhileRemovalWasOpen,
    false,
    "schedule creation waits for in-flight Project membership removal",
  );
  assert.equal(membershipCreationResult.status, "rejected");
  assert.match(
    membershipCreationResult.status === "rejected" &&
      membershipCreationResult.error instanceof Error
      ? membershipCreationResult.error.message
      : "",
    /Project not found or unavailable/u,
  );

  const created = await schedules.createProjectPromptSchedule({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.creator,
    title: "Scheduled review",
    cronExpression: "*/5 * * * *",
    timeZone: "America/New_York",
    prompt: "Prepare the scheduled review.",
    modelId: "openrouter/test-schedule-model",
  });

  let allowArchiveScheduleUpdate = () => {};
  const archiveScheduleUpdateGate = new Promise<void>((resolve) => {
    allowArchiveScheduleUpdate = resolve;
  });
  let markTestArchiveProjectLocked = () => {};
  const testArchiveProjectLocked = new Promise<void>((resolve) => {
    markTestArchiveProjectLocked = resolve;
  });
  let markTestArchiveScheduleUpdated = () => {};
  const testArchiveScheduleUpdated = new Promise<void>((resolve) => {
    markTestArchiveScheduleUpdated = resolve;
  });
  let releaseTestArchive = () => {};
  const testArchiveGate = new Promise<void>((resolve) => {
    releaseTestArchive = resolve;
  });
  const heldTestArchive = sql
    .begin(async (transaction) => {
      await transaction`
        UPDATE "projects"
        SET "archived_at" = ${now}, "updated_at" = ${now}
        WHERE "id" = ${ids.project}
      `;
      markTestArchiveProjectLocked();
      await archiveScheduleUpdateGate;
      await transaction`
        UPDATE "project_prompt_schedules"
        SET "enabled" = false, "pause_reason" = 'project_archived',
            "next_run_at" = NULL, "updated_at" = ${now}
        WHERE "project_id" = ${ids.project}
      `;
      markTestArchiveScheduleUpdated();
      await testArchiveGate;
    })
    .then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  await testArchiveProjectLocked;
  let archiveTestSettled = false;
  const archiveTest = schedules
    .createProjectPromptScheduleTestRun({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      requestId: crypto.randomUUID(),
    })
    .then(
      (value) => {
        archiveTestSettled = true;
        return { status: "fulfilled" as const, value };
      },
      (error: unknown) => {
        archiveTestSettled = true;
        return { status: "rejected" as const, error };
      },
    );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    archiveTestSettled,
    false,
    "test creation waits for the Project row before locking the schedule",
  );
  allowArchiveScheduleUpdate();
  let archiveProgressTimeout: ReturnType<typeof setTimeout> | undefined;
  const archiveProgress = await Promise.race([
    testArchiveScheduleUpdated.then(() => "schedule-updated" as const),
    heldTestArchive.then(() => "archive-settled" as const),
    new Promise<"timeout">((resolve) => {
      archiveProgressTimeout = setTimeout(() => resolve("timeout"), 2500);
    }),
  ]);
  if (archiveProgressTimeout) clearTimeout(archiveProgressTimeout);
  releaseTestArchive();
  const [heldTestArchiveResult, archiveTestResult] = await Promise.all([
    heldTestArchive,
    archiveTest,
  ]);
  assert.equal(
    archiveProgress,
    "schedule-updated",
    "Project archival must not deadlock with schedule test creation",
  );
  assert.equal(heldTestArchiveResult.status, "fulfilled");
  assert.equal(archiveTestResult.status, "rejected");
  assert.match(
    archiveTestResult.status === "rejected" &&
      archiveTestResult.error instanceof Error
      ? archiveTestResult.error.message
      : "",
    /Restore the Project before testing/u,
  );
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: false,
  });
  await schedules.updateProjectPromptSchedule({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    enabled: true,
  });

  await assert.rejects(
    schedules.createProjectPromptSchedule({
      organizationId: ids.organization,
      projectId: ids.project,
      userId: ids.creator,
      title: "   ",
      cronExpression: "0 * * * *",
      timeZone: "UTC",
      prompt: "A title is required.",
      modelId: "openrouter/test-schedule-model",
    }),
    /title is required/u,
  );
  const [memberView] = await schedules.listProjectPromptSchedulesForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.member,
  });
  assert.equal(memberView?.title, "Scheduled review");
  assert.equal(memberView?.prompt, "Prepare the scheduled review.");
  assert.equal(memberView?.modelId, "openrouter/test-schedule-model");
  await assert.rejects(
    schedules.updateProjectPromptSchedule({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      modelId: "openrouter/not-approved-for-this-environment",
    }),
    /model is not available in this Project Environment/u,
  );
  assert.deepEqual(memberView?.permissions, {
    canEdit: false,
    canTest: false,
    canEnable: false,
    canPause: false,
    canDelete: false,
  });
  const [ownerView] = await schedules.listProjectPromptSchedulesForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.owner,
  });
  assert.equal(ownerView?.permissions.canEdit, false);
  assert.equal(ownerView?.permissions.canTest, false);
  assert.equal(ownerView?.permissions.canPause, true);
  assert.equal(ownerView?.permissions.canDelete, true);
  await assert.rejects(
    schedules.updateProjectPromptSchedule({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      prompt: "An owner must not replace the creator prompt.",
    }),
    /Only the schedule creator can edit/u,
  );
  await assert.rejects(
    schedules.updateProjectPromptSchedule({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.member,
      enabled: false,
    }),
    /creator or a Project owner/u,
  );
  const paused = await schedules.updateProjectPromptSchedule({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    enabled: false,
  });
  assert.equal(paused.nextRunAt, null);
  await assert.rejects(
    schedules.createProjectPromptScheduleTestRun({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
      requestId: crypto.randomUUID(),
    }),
    /Only the schedule creator can test/u,
  );
  const testRequestId = crypto.randomUUID();
  const testReceipt = new Date();
  const testRun = await schedules.createProjectPromptScheduleTestRun({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    requestId: testRequestId,
    receivedAt: testReceipt,
  });
  const duplicateTestRun = await schedules.createProjectPromptScheduleTestRun({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    requestId: testRequestId,
    receivedAt: testReceipt,
  });
  assert.deepEqual(duplicateTestRun, testRun);
  await sql`
    UPDATE "project_prompt_schedules"
    SET "model_id" = 'openrouter/no-longer-available'
    WHERE "id" = ${created.id}
  `;
  const replayAfterModelChange =
    await schedules.createProjectPromptScheduleTestRun({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      requestId: testRequestId,
      receivedAt: testReceipt,
    });
  assert.deepEqual(replayAfterModelChange, testRun);
  await sql`
    UPDATE "project_prompt_schedules"
    SET "model_id" = 'openrouter/test-schedule-model'
    WHERE "id" = ${created.id}
  `;
  const independentTestRun =
    await schedules.createProjectPromptScheduleTestRun({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      requestId: crypto.randomUUID(),
      receivedAt: testReceipt,
    });
  assert.notEqual(independentTestRun.runId, testRun.runId);
  assert.notEqual(independentTestRun.threadId, testRun.threadId);
  const [testIdentityCounts] = await sql<
    Array<{ runs: number; auditEvents: number }>
  >`
    SELECT
      (
        SELECT count(*)::int
        FROM "project_prompt_schedule_runs"
        WHERE "schedule_id" = ${created.id} AND "trigger" = 'test'
      ) AS "runs",
      (
        SELECT count(*)::int
        FROM "project_audit_events"
        WHERE "project_id" = ${ids.project}
          AND "target_id" = ${created.id}
          AND "action" = 'project.schedule.tested'
      ) AS "auditEvents"
  `;
  assert.deepEqual(testIdentityCounts, { runs: 2, auditEvents: 2 });
  const [testOccurrences] = await sql<
    Array<{ first: Date; second: Date }>
  >`
    SELECT
      (SELECT "scheduled_for" FROM "project_prompt_schedule_runs" WHERE "id" = ${testRun.runId}) AS "first",
      (SELECT "scheduled_for" FROM "project_prompt_schedule_runs" WHERE "id" = ${independentTestRun.runId}) AS "second"
  `;
  assert.equal(testOccurrences.first.getTime(), testReceipt.getTime());
  assert.equal(testOccurrences.second.getTime(), testReceipt.getTime() + 1);
  const testTurnId = await materializeProjectPromptScheduleRun(testRun.runId);
  const independentTestTurnId = await materializeProjectPromptScheduleRun(
    independentTestRun.runId,
  );
  assert.ok(testTurnId);
  assert.ok(independentTestTurnId);
  await sql`
    UPDATE "thread_turns"
    SET
      "status" = CASE
        WHEN "id" = ${testTurnId} THEN 'waiting_for_input'
        ELSE 'failed'
      END,
      "failure_code" = CASE
        WHEN "id" = ${independentTestTurnId} THEN 'TEST_RUNTIME_FAILED'
        ELSE NULL
      END,
      "failure_message" = CASE
        WHEN "id" = ${independentTestTurnId} THEN 'The test runtime failed.'
        ELSE NULL
      END,
      "finished_at" = CASE
        WHEN "id" = ${independentTestTurnId} THEN now()
        ELSE NULL
      END
    WHERE "id" IN (${testTurnId}, ${independentTestTurnId})
  `;
  const [overlappingView] = await schedules.listProjectPromptSchedulesForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.creator,
  });
  assert.equal(overlappingView?.activeStatus, "waiting_for_input");
  assert.equal(overlappingView?.latestRun?.id, independentTestRun.runId);
  assert.equal(overlappingView?.latestRun?.turnStatus, "failed");
  assert.deepEqual(overlappingView?.latestRun?.failure, {
    code: "TEST_RUNTIME_FAILED",
    message: "The test runtime failed.",
  });
  await sql`
    UPDATE "thread_turns"
    SET "status" = 'completed', "failure_code" = NULL,
        "failure_message" = NULL, "finished_at" = now()
    WHERE "id" = ${testTurnId}
  `;
  const [materializedTest] = await sql<
    Array<{
      enabled: boolean;
      nextRunAt: Date | null;
      trigger: string;
      requestId: string | null;
      titleSnapshot: string;
      requestedInteractionMode: string;
      turnSource: string;
      messageSource: string;
      noninteractive: boolean;
      interactionMode: string;
      threadMode: string;
      threadTitle: string;
    }>
  >`
    SELECT
      schedules."enabled",
      schedules."next_run_at" AS "nextRunAt",
      runs."trigger",
      runs."request_id" AS "requestId",
      runs."title_snapshot" AS "titleSnapshot",
      turns."requested_interaction_mode" AS "requestedInteractionMode",
      turns."source" AS "turnSource",
      messages."source" AS "messageSource",
      (
        SELECT (events."data"->>'noninteractive')::boolean
        FROM "thread_turn_events" events
        WHERE events."turn_id" = turns."id" AND events."type" = 'turn.queued'
      ) AS "noninteractive",
      threads."interaction_mode" AS "interactionMode",
      threads."mode" AS "threadMode",
      threads."title" AS "threadTitle"
    FROM "project_prompt_schedule_runs" runs
    JOIN "project_prompt_schedules" schedules ON schedules."id" = runs."schedule_id"
    JOIN "thread_turns" turns ON turns."id" = runs."turn_id"
    JOIN "thread_messages" messages ON messages."id" = turns."input_message_id"
    JOIN "threads" threads ON threads."id" = runs."thread_id"
    WHERE runs."id" = ${testRun.runId}
  `;
  assert.deepEqual(
    {
      enabled: materializedTest.enabled,
      nextRunAt: materializedTest.nextRunAt,
      trigger: materializedTest.trigger,
      requestId: materializedTest.requestId,
      titleSnapshot: materializedTest.titleSnapshot,
      requestedInteractionMode: materializedTest.requestedInteractionMode,
      turnSource: materializedTest.turnSource,
      messageSource: materializedTest.messageSource,
      noninteractive: materializedTest.noninteractive,
      interactionMode: materializedTest.interactionMode,
      threadMode: materializedTest.threadMode,
    },
    {
      enabled: false,
      nextRunAt: null,
      trigger: "test",
      requestId: testRequestId,
      titleSnapshot: "Scheduled review",
      requestedInteractionMode: "build",
      turnSource: "web",
      messageSource: "web",
      noninteractive: true,
      interactionMode: "build",
      threadMode: "chat",
    },
  );
  assert.match(
    materializedTest.threadTitle,
    /^Scheduled review · Test · /u,
  );
  await assert.rejects(
    schedules.updateProjectPromptSchedule({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      modelId: "openrouter/not-approved-while-paused",
    }),
    /model is not available in this Project Environment/u,
  );
  const enabled = await schedules.updateProjectPromptSchedule({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    enabled: true,
  });
  assert.ok(enabled.nextRunAt && enabled.nextRunAt.getTime() > Date.now());

  const firstDueAt = new Date(now.getTime() - 20 * 60_000);
  await sql`
    UPDATE "project_prompt_schedules"
    SET "next_run_at" = ${firstDueAt}
    WHERE "id" = ${created.id}
  `;
  const claims = await Promise.all([
    schedules.claimDueProjectPromptScheduleRuns(now),
    schedules.claimDueProjectPromptScheduleRuns(now),
  ]);
  const runIds = claims.flat();
  assert.equal(runIds.length, 1, "concurrent dispatchers claim one occurrence");
  const [claimed] = await sql<
    Array<{
      id: string;
      scheduledFor: Date;
      catchUpFrom: Date | null;
      titleSnapshot: string;
      promptSnapshot: string;
      modelIdSnapshot: string | null;
      trigger: string;
      threadId: string;
    }>
  >`
    SELECT
      "id", "scheduled_for" AS "scheduledFor", "catch_up_from" AS "catchUpFrom",
      "title_snapshot" AS "titleSnapshot",
      "prompt_snapshot" AS "promptSnapshot",
      "model_id_snapshot" AS "modelIdSnapshot", "trigger",
      "thread_id" AS "threadId"
    FROM "project_prompt_schedule_runs"
    WHERE "id" = ${runIds[0]}
  `;
  assert.ok(claimed);
  assert.equal(claimed.titleSnapshot, "Scheduled review");
  assert.equal(claimed.promptSnapshot, "Prepare the scheduled review.");
  assert.equal(claimed.modelIdSnapshot, "openrouter/test-schedule-model");
  assert.equal(claimed.trigger, "scheduled");
  assert.equal(claimed.catchUpFrom?.getTime(), firstDueAt.getTime());
  assert.ok(claimed.scheduledFor.getTime() > firstDueAt.getTime());

  await schedules.updateProjectPromptSchedule({
    scheduleId: created.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    title: "Renamed scheduled review",
  });
  const firstTurnId = await materializeProjectPromptScheduleRun(claimed.id);
  const retriedTurnId = await materializeProjectPromptScheduleRun(claimed.id);
  assert.ok(firstTurnId);
  assert.equal(retriedTurnId, firstTurnId);
  const [materialized] = await sql<
    Array<{
      threads: number;
      messages: number;
      turns: number;
      requestedModelId: string | null;
      requestedInteractionMode: string;
      interactionMode: string;
      threadMode: string;
      threadTitle: string;
    }>
  >`
    SELECT
      (SELECT count(*)::int FROM "threads" WHERE "id" = ${claimed.threadId}) AS "threads",
      (SELECT count(*)::int FROM "thread_messages" WHERE "thread_id" = ${claimed.threadId}) AS "messages",
      (SELECT count(*)::int FROM "thread_turns" WHERE "thread_id" = ${claimed.threadId}) AS "turns",
      (SELECT "requested_model_id" FROM "thread_turns" WHERE "thread_id" = ${claimed.threadId}) AS "requestedModelId",
      (SELECT "requested_interaction_mode" FROM "thread_turns" WHERE "thread_id" = ${claimed.threadId}) AS "requestedInteractionMode",
      (SELECT "interaction_mode" FROM "threads" WHERE "id" = ${claimed.threadId}) AS "interactionMode",
      (SELECT "mode" FROM "threads" WHERE "id" = ${claimed.threadId}) AS "threadMode",
      (SELECT "title" FROM "threads" WHERE "id" = ${claimed.threadId}) AS "threadTitle"
  `;
  assert.deepEqual(materialized, {
    threads: 1,
    messages: 1,
    turns: 1,
    requestedModelId: "openrouter/test-schedule-model",
    requestedInteractionMode: "build",
    interactionMode: "build",
    threadMode: "chat",
    threadTitle: materialized.threadTitle,
  });
  assert.match(materialized.threadTitle, /^Scheduled review · /u);
  assert.doesNotMatch(materialized.threadTitle, /Renamed/u);

  const failedRunId = `schedule-failed-run-${suffix}`;
  const reservedFailedThreadId = `schedule-failed-thread-${suffix}`;
  await sql`
    INSERT INTO "project_prompt_schedule_runs" (
      "id", "schedule_id", "scheduled_for", "title_snapshot", "prompt_snapshot",
      "thread_id", "message_id", "status", "failure_code",
      "failure_message", "finished_at", "created_at", "updated_at"
    ) VALUES (
      ${failedRunId}, ${created.id}, ${new Date(Date.now() + 60_000)},
      'Renamed scheduled review', 'Failed before materialization.', ${reservedFailedThreadId},
      ${`schedule-failed-message-${suffix}`}, 'failed',
      'SCHEDULE_ENVIRONMENT_UNAVAILABLE',
      'Project Environment is unavailable.', ${now}, ${now}, ${now}
    )
  `;
  const [failedView] = await schedules.listProjectPromptSchedulesForUser({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.member,
  });
  assert.equal(
    failedView?.latestRun?.threadId,
    null,
    "a reserved ID is not exposed as a materialized Thread",
  );
  assert.deepEqual(failedView?.latestRun?.failure, {
    code: "SCHEDULE_ENVIRONMENT_UNAVAILABLE",
    message: "Project Environment is unavailable.",
  });

  let releaseMaterializationLock = () => {};
  const materializationGate = new Promise<void>((resolve) => {
    releaseMaterializationLock = resolve;
  });
  let materializationLockStarted = () => {};
  const materializationLockReady = new Promise<void>((resolve) => {
    materializationLockStarted = resolve;
  });
  const heldMaterialization = schedules.withLockedProjectPromptScheduleRun(
    claimed.id,
    async () => {
      materializationLockStarted();
      await materializationGate;
      return null;
    },
  );
  await materializationLockReady;
  let deleteSettled = false;
  const concurrentDelete = schedules
    .deleteProjectPromptSchedule({
      scheduleId: created.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.owner,
    })
    .then((result) => {
      deleteSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    deleteSettled,
    false,
    "delete waits for in-flight occurrence materialization",
  );
  releaseMaterializationLock();
  await heldMaterialization;
  await concurrentDelete;
  const [preservedThread] = await sql<
    [{ count: number; noninteractive: boolean }]
  >`
    SELECT
      count(*)::int AS "count",
      (
        SELECT (events."data"->>'noninteractive')::boolean
        FROM "thread_turn_events" events
        WHERE events."turn_id" = ${firstTurnId} AND events."type" = 'turn.queued'
      ) AS "noninteractive"
    FROM "threads"
    WHERE "id" = ${claimed.threadId}
  `;
  assert.equal(preservedThread.count, 1);
  assert.equal(
    preservedThread.noninteractive,
    true,
    "deleting a schedule preserves autonomous identity on its durable turn",
  );

  const archivedSchedule = await schedules.createProjectPromptSchedule({
    organizationId: ids.organization,
    projectId: ids.project,
    userId: ids.creator,
    title: "Archive behavior",
    cronExpression: "0 * * * *",
    timeZone: "UTC",
    prompt: "Archive behavior.",
    modelId: "openrouter/test-schedule-model",
  });
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: true,
  });
  await projects.setProjectArchived({
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.owner,
    archived: false,
  });
  const [afterRestore] = await sql<
    Array<{ enabled: boolean; pauseReason: string; nextRunAt: Date | null }>
  >`
    SELECT "enabled", "pause_reason" AS "pauseReason", "next_run_at" AS "nextRunAt"
    FROM "project_prompt_schedules" WHERE "id" = ${archivedSchedule.id}
  `;
  assert.deepEqual(afterRestore, {
    enabled: false,
    pauseReason: "project_archived",
    nextRunAt: null,
  });

  await schedules.updateProjectPromptSchedule({
    scheduleId: archivedSchedule.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    enabled: true,
  });

  let releaseConcurrentPause = () => {};
  const concurrentPauseGate = new Promise<void>((resolve) => {
    releaseConcurrentPause = resolve;
  });
  let concurrentPauseStarted = () => {};
  const concurrentPauseReady = new Promise<void>((resolve) => {
    concurrentPauseStarted = resolve;
  });
  const concurrentPause = sql.begin(async (transaction) => {
    await transaction`
      UPDATE "project_prompt_schedules"
      SET "enabled" = false, "pause_reason" = 'manual', "next_run_at" = NULL
      WHERE "id" = ${archivedSchedule.id}
    `;
    concurrentPauseStarted();
    await concurrentPauseGate;
  });
  await concurrentPauseReady;
  let editSettled = false;
  const concurrentEdit = schedules
    .updateProjectPromptSchedule({
      scheduleId: archivedSchedule.id,
      projectId: ids.project,
      organizationId: ids.organization,
      userId: ids.creator,
      prompt: "Edited while an owner pause commits.",
    })
    .then((result) => {
      editSettled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(editSettled, false, "the edit waits for the schedule row");
  releaseConcurrentPause();
  await concurrentPause;
  const editedAfterPause = await concurrentEdit;
  assert.equal(
    editedAfterPause.enabled,
    false,
    "a prompt edit must not overwrite a concurrent pause",
  );

  const portableSchedule = await schedules.createProjectPromptSchedule({
    organizationId: ids.organization,
    projectId: ids.rebindProject,
    userId: ids.creator,
    title: "Portable schedule",
    cronExpression: "0 * * * *",
    timeZone: "UTC",
    prompt: "Remain enabled because this model is organization-scoped.",
    modelId: "openrouter/test-schedule-model",
  });
  const environmentScopedSchedule =
    await schedules.createProjectPromptSchedule({
      organizationId: ids.organization,
      projectId: ids.rebindProject,
      userId: ids.creator,
      title: "Environment-scoped schedule",
      cronExpression: "0 * * * *",
      timeZone: "UTC",
      prompt: "Pause after the Project leaves this model's Environment.",
      modelId: "openrouter/environment-only-schedule-model",
    });
  await environments.bindProjectToEnvironment({
    organizationId: ids.organization,
    projectId: ids.rebindProject,
    environmentId: ids.targetEnvironment,
    userId: ids.creator,
  });
  const [afterEnvironmentMove] = await sql<
    Array<{ enabled: boolean; pauseReason: string; nextRunAt: Date | null }>
  >`
    SELECT "enabled", "pause_reason" AS "pauseReason", "next_run_at" AS "nextRunAt"
    FROM "project_prompt_schedules"
    WHERE "id" = ${environmentScopedSchedule.id}
  `;
  assert.deepEqual(afterEnvironmentMove, {
    enabled: false,
    pauseReason: "environment_model_unavailable",
    nextRunAt: null,
  });
  const [portableAfterEnvironmentMove] = await sql<
    Array<{ enabled: boolean; pauseReason: string | null }>
  >`
    SELECT "enabled", "pause_reason" AS "pauseReason"
    FROM "project_prompt_schedules"
    WHERE "id" = ${portableSchedule.id}
  `;
  assert.deepEqual(portableAfterEnvironmentMove, {
    enabled: true,
    pauseReason: null,
  });
  await assert.rejects(
    schedules.createProjectPromptScheduleTestRun({
      scheduleId: environmentScopedSchedule.id,
      projectId: ids.rebindProject,
      organizationId: ids.organization,
      userId: ids.creator,
      requestId: crypto.randomUUID(),
    }),
    /model is not available in this Project Environment/u,
  );
  const [unavailableAfterRejectedTest] = await sql<
    Array<{ enabled: boolean; nextRunAt: Date | null; testRuns: number }>
  >`
    SELECT
      schedules."enabled",
      schedules."next_run_at" AS "nextRunAt",
      (
        SELECT count(*)::int
        FROM "project_prompt_schedule_runs" runs
        WHERE runs."schedule_id" = schedules."id"
          AND runs."trigger" = 'test'
      ) AS "testRuns"
    FROM "project_prompt_schedules" schedules
    WHERE schedules."id" = ${environmentScopedSchedule.id}
  `;
  assert.deepEqual(unavailableAfterRejectedTest, {
    enabled: false,
    nextRunAt: null,
    testRuns: 0,
  });

  await schedules.updateProjectPromptSchedule({
    scheduleId: archivedSchedule.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    enabled: true,
  });
  await projects.removeProjectMember({
    projectId: ids.project,
    organizationId: ids.organization,
    actorUserId: ids.owner,
    organizationMemberId: ids.creatorMember,
  });
  const [afterRemoval] = await sql<
    Array<{ enabled: boolean; pauseReason: string; nextRunAt: Date | null }>
  >`
    SELECT "enabled", "pause_reason" AS "pauseReason", "next_run_at" AS "nextRunAt"
    FROM "project_prompt_schedules" WHERE "id" = ${archivedSchedule.id}
  `;
  assert.deepEqual(afterRemoval, {
    enabled: false,
    pauseReason: "creator_access_lost",
    nextRunAt: null,
  });

  await sql`
    INSERT INTO "project_members" (
      "project_id", "organization_member_id", "role"
    ) VALUES (${ids.project}, ${ids.creatorMember}, 'editor')
  `;
  await schedules.updateProjectPromptSchedule({
    scheduleId: archivedSchedule.id,
    projectId: ids.project,
    organizationId: ids.organization,
    userId: ids.creator,
    enabled: true,
  });
  await sql`DELETE FROM "member" WHERE "id" = ${ids.creatorMember}`;
  const [afterOrganizationRemoval] = await sql<
    Array<{ enabled: boolean; pauseReason: string; nextRunAt: Date | null }>
  >`
    SELECT "enabled", "pause_reason" AS "pauseReason", "next_run_at" AS "nextRunAt"
    FROM "project_prompt_schedules" WHERE "id" = ${archivedSchedule.id}
  `;
  assert.deepEqual(afterOrganizationRemoval, {
    enabled: false,
    pauseReason: "creator_access_lost",
    nextRunAt: null,
  });

  const authorityLossRunId = `schedule-authority-loss-run-${suffix}`;
  await sql`
    UPDATE "project_prompt_schedules"
    SET "created_by_user_id" = NULL, "enabled" = true,
        "pause_reason" = NULL, "next_run_at" = ${now}
    WHERE "id" = ${archivedSchedule.id}
  `;
  await sql`
    INSERT INTO "project_prompt_schedule_runs" (
      "id", "schedule_id", "scheduled_for", "title_snapshot", "prompt_snapshot",
      "thread_id", "message_id", "status", "created_at", "updated_at"
    ) VALUES (
      ${authorityLossRunId}, ${archivedSchedule.id}, ${new Date(now.getTime() + 120_000)},
      'Archive behavior', 'Must not execute without a creator.', ${`schedule-authority-thread-${suffix}`},
      ${`schedule-authority-message-${suffix}`}, 'queued', ${now}, ${now}
    )
  `;
  assert.equal(
    await materializeProjectPromptScheduleRun(authorityLossRunId),
    null,
  );
  const [afterMissingCreator] = await sql<
    Array<{ enabled: boolean; pauseReason: string; runStatus: string }>
  >`
    SELECT
      schedules."enabled",
      schedules."pause_reason" AS "pauseReason",
      runs."status" AS "runStatus"
    FROM "project_prompt_schedules" schedules
    JOIN "project_prompt_schedule_runs" runs
      ON runs."schedule_id" = schedules."id"
    WHERE schedules."id" = ${archivedSchedule.id}
      AND runs."id" = ${authorityLossRunId}
  `;
  assert.deepEqual(afterMissingCreator, {
    enabled: false,
    pauseReason: "creator_access_lost",
    runStatus: "cancelled",
  });
});
