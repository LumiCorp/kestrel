import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

import "../../scripts/register-server-only.mjs";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test("Browser lifecycle reconciliation is environment-scoped, race-safe, and metered idempotently", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  Reflect.deleteProperty(process.env, "POSTGRES_URL");
  const [{ resetDbRuntimeForTests }, { HostedBrowserStore }, metering] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("@/lib/costs/metering"),
    ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const id = (kind: string, environment = "a") =>
    `browser-${kind}-${environment}-${suffix}`;
  const userId = id("user");
  const organizationId = id("org");
  const cleanup = async () => {
    await sql`DELETE FROM "browser_session_resources" WHERE "session_id" IN (${id("session", "a")}, ${id("session", "b")}, ${id("session", "c")})`;
    await sql`DELETE FROM "browser_sessions" WHERE "session_id" IN (${id("session", "a")}, ${id("session", "b")}, ${id("session", "c")})`;
    await sql`DELETE FROM "thread_turns" WHERE "id" IN (${id("turn", "a")}, ${id("turn", "b")})`;
    await sql`DELETE FROM "environment_run_executions" WHERE "id" IN (${id("run", "a")}, ${id("run", "b")})`;
    await sql`DELETE FROM "environment_workspaces" WHERE "id" IN (${id("workspace", "a")}, ${id("workspace", "b")})`;
    await sql`DELETE FROM "threads" WHERE "id" IN (${id("thread", "a")}, ${id("thread", "b")})`;
    await sql`DELETE FROM "projects" WHERE "id" IN (${id("project", "a")}, ${id("project", "b")})`;
    await sql`DELETE FROM "environments" WHERE "id" IN (${id("env", "a")}, ${id("env", "b")})`;
    await sql`DELETE FROM "member" WHERE "organizationId" = ${organizationId}`;
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
  };
  context.after(async () => {
    await cleanup();
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  const fixtureNow = new Date("2026-08-30T12:00:00.000Z");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (${userId}, 'Browser User', ${`${userId}@example.test`}, true, ${fixtureNow}, ${fixtureNow})`;
    await tx`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (${organizationId}, 'Browser Org', ${`browser-${suffix}`}, ${fixtureNow})`;
    await tx`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (${id("member")}, ${organizationId}, ${userId}, 'owner', ${fixtureNow})`;
    for (const environment of ["a", "b"] as const) {
      await tx`INSERT INTO "environments" ("id", "organization_id", "created_by_user_id", "name", "slug", "region", "status", "provider", "fly_app_name", "runtime_image") VALUES (${id("env", environment)}, ${organizationId}, ${userId}, ${`Environment ${environment}`}, ${`browser-${environment}-${suffix}`}, ${environment === "a" ? "iad" : "ord"}, 'ready', 'fly', ${`app-${environment}-${suffix}`}, 'registry.example/workspace@sha256:test')`;
      await tx`INSERT INTO "projects" ("id", "organization_id", "environment_id", "created_by_user_id", "name") VALUES (${id("project", environment)}, ${organizationId}, ${id("env", environment)}, ${userId}, ${`Project ${environment}`})`;
      await tx`INSERT INTO "project_members" ("project_id", "organization_member_id", "role") VALUES (${id("project", environment)}, ${id("member")}, 'owner')`;
      await tx`INSERT INTO "threads" ("id", "title", "created_by_user_id", "organization_id", "project_id") VALUES (${id("thread", environment)}, ${`Thread ${environment}`}, ${userId}, ${organizationId}, ${id("project", environment)})`;
      await tx`INSERT INTO "environment_workspaces" ("id", "organization_id", "environment_id", "project_id", "created_by_user_id", "name", "kind", "status", "runtime_image") VALUES (${id("workspace", environment)}, ${organizationId}, ${id("env", environment)}, ${id("project", environment)}, ${userId}, ${`Workspace ${environment}`}, 'project', 'ready', 'registry.example/workspace@sha256:test')`;
      await tx`INSERT INTO "environment_run_executions" ("id", "organization_id", "environment_id", "workspace_id", "thread_id", "project_id", "actor_id", "runtime_image", "effective_capabilities", "runtime_run_id", "status", "created_at", "updated_at") VALUES (${id("run", environment)}, ${organizationId}, ${id("env", environment)}, ${id("workspace", environment)}, ${id("thread", environment)}, ${id("project", environment)}, ${userId}, 'registry.example/runner@sha256:test', ${tx.json([])}, ${id("runtime-run", environment)}, 'running', ${fixtureNow}, ${fixtureNow})`;
      await tx`INSERT INTO "thread_turns" ("id", "organization_id", "thread_id", "author_user_id", "environment_execution_id", "requested_environment_id", "approval_id", "approval_approved", "idempotency_key", "sequence", "queue_ordinal", "status", "created_at", "updated_at") VALUES (${id("turn", environment)}, ${organizationId}, ${id("thread", environment)}, ${userId}, ${id("run", environment)}, ${id("env", environment)}, ${`browser-approval-${environment}-${suffix}`}, true, ${`browser-turn-${environment}-${suffix}`}, 1, 1, 'running', ${fixtureNow}, ${fixtureNow})`;
    }
    await tx`INSERT INTO "browser_sessions" ("session_id", "thread_id", "mode", "state", "engine_revision", "generation", "effective_allowlist_revision", "created_at", "updated_at", "last_activity_at", "idle_expires_at", "hard_expires_at") VALUES (${id("session", "a")}, ${id("thread", "a")}, 'operator', 'opening', 'engine-1', 1, 'revision-1', ${fixtureNow}, ${fixtureNow}, ${fixtureNow}, ${new Date("2026-08-30T12:30:00Z")}, ${new Date("2026-08-30T20:00:00Z")})`;
    await tx`INSERT INTO "browser_session_resources" ("session_id", "originating_turn_id", "machine_id", "machine_generation", "worker_image_digest", "proxy_authority_revision", "created_at", "updated_at") VALUES (${id("session", "a")}, ${id("turn", "a")}, ${id("machine", "a")}, 1, ${`registry.fly.io/browser@sha256:${"a".repeat(64)}`}, 'revision-1', ${fixtureNow}, ${fixtureNow})`;
    await tx`INSERT INTO "browser_sessions" ("session_id", "thread_id", "mode", "state", "engine_revision", "generation", "effective_allowlist_revision", "created_at", "updated_at", "last_activity_at", "idle_expires_at", "hard_expires_at", "terminal_reason") VALUES (${id("session", "b")}, ${id("thread", "b")}, 'operator', 'expired', 'engine-1', 1, 'revision-1', ${new Date("2026-08-30T09:00:00Z")}, ${new Date("2026-08-30T10:45:00Z")}, ${new Date("2026-08-30T09:30:00Z")}, ${new Date("2026-08-30T10:00:00Z")}, ${new Date("2026-08-30T17:00:00Z")}, 'BROWSER_SESSION_EXPIRED')`;
    await tx`INSERT INTO "browser_session_resources" ("session_id", "originating_turn_id", "machine_id", "machine_generation", "worker_image_digest", "proxy_authority_revision", "cleanup_requested_at", "cleanup_confirmed_at", "created_at", "updated_at") VALUES (${id("session", "b")}, ${id("turn", "b")}, ${id("machine", "b")}, 1, ${`registry.fly.io/browser@sha256:${"b".repeat(64)}`}, 'revision-1', ${new Date("2026-08-30T10:45:00Z")}, ${new Date("2026-08-30T10:45:00Z")}, ${new Date("2026-08-30T10:15:00Z")}, ${new Date("2026-08-30T10:45:00Z")})`;
  });

  const store = new HostedBrowserStore();
  // A delayed startup failure must recheck opening under the row lock, not
  // rely on the earlier service read. Neither ready nor terminal may be lost.
  for (const state of ["ready", "opening"] as const) {
    await sql`UPDATE browser_sessions SET state = ${state} WHERE session_id = ${id("session", "a")}`;
    if (state === "ready") {
      await assert.rejects(store.markTerminal({
        sessionId: id("session", "a"), expectedGeneration: 1,
        expectedMachineId: id("machine", "a"), expectedState: "opening",
        state: "failed", reason: "BROWSER_ENGINE_FAILURE", now: fixtureNow,
      }), /BROWSER_SESSION_LOST/u);
      const retained = await store.read(id("session", "a"));
      assert.equal(retained?.session.state, "ready");
      assert.equal(retained?.resource?.cleanupRequestedAt, null);
    }
  }
  assert.deepEqual(
    await store.resolveOrigin({
      runId: id("runtime-run", "a"),
      threadId: id("thread", "a"),
      expectedOrganizationId: organizationId,
      expectedEnvironmentId: id("env", "a"),
      expectedProjectId: id("project", "a"),
      expectedUserId: userId,
    }),
    {
      organizationId,
      environmentId: id("env", "a"),
      projectId: id("project", "a"),
      threadId: id("thread", "a"),
      runId: id("run", "a"),
      turnId: id("turn", "a"),
      userId,
    },
  );
  await sql`UPDATE "environment_run_executions" SET "runtime_run_id" = NULL WHERE "id" = ${id("run", "a")}`;
  assert.deepEqual(
    await store.resolveOrigin({
      runId: id("runtime-run", "a"),
      expectedExecutionId: id("run", "a"),
      threadId: id("thread", "a"),
      expectedOrganizationId: organizationId,
      expectedEnvironmentId: id("env", "a"),
      expectedProjectId: id("project", "a"),
      expectedUserId: userId,
    }),
    {
      organizationId,
      environmentId: id("env", "a"),
      projectId: id("project", "a"),
      threadId: id("thread", "a"),
      runId: id("run", "a"),
      turnId: id("turn", "a"),
      userId,
    },
  );
  await assert.rejects(
    store.resolveOrigin({
      runId: id("runtime-run", "a"),
      expectedExecutionId: id("run", "b"),
      threadId: id("thread", "a"),
      expectedOrganizationId: organizationId,
      expectedEnvironmentId: id("env", "a"),
      expectedProjectId: id("project", "a"),
      expectedUserId: userId,
    }),
    /BROWSER_SERVICE_UNAVAILABLE/u,
  );
  await sql`UPDATE "environment_run_executions" SET "runtime_run_id" = ${id("runtime-run", "a")} WHERE "id" = ${id("run", "a")}`;
  await assert.rejects(
    store.resolveOrigin({
      runId: id("runtime-run", "b"),
      expectedExecutionId: id("run", "a"),
      threadId: id("thread", "a"),
      expectedOrganizationId: organizationId,
      expectedEnvironmentId: id("env", "a"),
      expectedProjectId: id("project", "a"),
      expectedUserId: userId,
    }),
    /BROWSER_SERVICE_UNAVAILABLE/u,
  );
  await sql`INSERT INTO "browser_sessions" ("session_id", "thread_id", "mode", "state", "engine_revision", "generation", "effective_allowlist_revision", "created_at", "updated_at", "last_activity_at", "idle_expires_at", "hard_expires_at") VALUES (${id("session", "c")}, ${id("thread", "b")}, 'operator', 'opening', 'engine-1', 1, 'revision-1', ${fixtureNow}, ${fixtureNow}, ${fixtureNow}, ${new Date("2026-08-30T12:30:00Z")}, ${new Date("2026-08-30T20:00:00Z")})`;
  const attachment = (machineId: string) =>
    store.attachMachine({
      sessionId: id("session", "c"),
      originTurnId: id("turn", "b"),
      machineId,
      generation: 1,
      workerImageDigest: `registry.fly.io/browser@sha256:${"c".repeat(64)}`,
      proxyAuthorityRevision: "revision-1",
    });
  const attachRace = await Promise.allSettled([
    attachment(id("machine", "c1")),
    attachment(id("machine", "c2")),
  ]);
  assert.equal(
    attachRace.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attachRace.filter((result) => result.status === "rejected").length,
    1,
  );
  const [winner] = await sql<Array<{ machineId: string }>>`
    SELECT "machine_id" AS "machineId"
    FROM "browser_session_resources"
    WHERE "session_id" = ${id("session", "c")}
  `;
  assert.ok(
    [id("machine", "c1"), id("machine", "c2")].includes(winner!.machineId),
  );
  const openingViewerSession = await store.read(id("session", "c"));
  assert.ok(openingViewerSession);
  await store.updateSession({
    ...openingViewerSession.session,
    state: "ready",
  });
  const humanControl = await store.transitionViewerControl({
    sessionId: id("session", "c"),
    generation: 1,
    from: "ready",
    to: "human_control",
    now: new Date("2026-08-30T12:00:10Z"),
  });
  assert.equal(humanControl.state, "human_control");
  await assert.rejects(
    store.transitionViewerControl({
      sessionId: id("session", "c"),
      generation: 1,
      from: "ready",
      to: "human_control",
      now: new Date("2026-08-30T12:00:11Z"),
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.equal(
    (
      await store.transitionViewerControl({
        sessionId: id("session", "c"),
        generation: 1,
        from: "human_control",
        to: "ready",
        now: new Date("2026-08-30T12:00:12Z"),
      })
    ).state,
    "ready",
  );
  const scoped = await store.listForReconciliation({
    organizationId,
    environmentId: id("env", "a"),
    now: fixtureNow,
  });
  assert.deepEqual(
    scoped.map((item) => item.session.sessionId),
    [id("session", "a")],
  );
  const personal = await store.listForPersonalAuthority({
    organizationId,
    environmentId: id("env", "a"),
    userId,
  });
  assert.deepEqual(
    personal.map((item) => item.session.sessionId),
    [id("session", "a")],
  );
  assert.deepEqual(
    await store.listForPersonalAuthority({
      organizationId,
      environmentId: id("env", "a"),
      userId: id("user-other"),
    }),
    [],
  );

  const staleOpening = scoped[0]?.session;
  assert.ok(staleOpening);
  await assert.rejects(
    store.touchActivity(
      staleOpening.sessionId,
      staleOpening.generation,
      new Date("2026-08-30T12:00:30Z"),
    ),
    /BROWSER_SESSION_LOST/u,
  );
  const afterRejectedTouch = await store.read(staleOpening.sessionId);
  assert.equal(afterRejectedTouch?.session.state, "opening");
  await assert.rejects(
    store.markTerminal({
      sessionId: staleOpening.sessionId,
      expectedGeneration: staleOpening.generation,
      expectedMachineId: id("machine", "wrong"),
      state: "lost",
      reason: "BROWSER_SESSION_LOST",
      now: new Date("2026-08-30T12:00:59Z"),
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.equal((await store.read(staleOpening.sessionId))?.session.state, "opening");
  await store.markTerminal({
    sessionId: staleOpening.sessionId,
    expectedGeneration: staleOpening.generation,
    expectedMachineId: id("machine", "a"),
    state: "lost",
    reason: "BROWSER_SESSION_LOST",
    now: new Date("2026-08-30T12:01:00Z"),
  });
  await assert.rejects(
    store.updateSession({
      ...staleOpening,
      state: "ready",
      updatedAt: "2026-08-30T12:01:01.000Z",
    }),
    /BROWSER_SESSION_LOST/u,
  );
  const afterRace = await store.read(staleOpening.sessionId);
  assert.equal(afterRace?.session.state, "lost");
  assert.ok(afterRace?.resource?.cleanupRequestedAt);
  await assert.rejects(
    store.attachMachine({
      sessionId: staleOpening.sessionId,
      originTurnId: id("turn", "a"),
      machineId: id("machine", "late"),
      generation: staleOpening.generation,
      workerImageDigest: `registry.fly.io/browser@sha256:${"d".repeat(64)}`,
      proxyAuthorityRevision: "revision-1",
    }),
    /BROWSER_SESSION_LOST/u,
  );
  assert.deepEqual(
    (
      await store.listForPersonalAuthority({
        organizationId,
        environmentId: id("env", "a"),
        userId,
      })
    ).map((item) => item.session.sessionId),
    [id("session", "a")],
  );

  const hour = {
    startedAt: new Date("2026-08-30T10:00:00Z"),
    endedAt: new Date("2026-08-30T11:00:00Z"),
  };
  assert.equal(await metering.meterPersistedBrowserWorkersHour(hour), 1);
  assert.equal(await metering.meterPersistedBrowserWorkersHour(hour), 1);
  const [usage] = await sql<
    Array<{
      count: number;
      quantity: string;
      actor: string;
      project: string;
      thread: string;
      run: string;
      metadata: Record<string, unknown>;
    }>
  >`
    SELECT count(*)::int AS count, max("quantity")::text AS quantity,
      max("actor_user_id") AS actor, max("project_id") AS project,
      max("thread_id") AS thread, max("run_id") AS run,
      max("metadata"::text)::jsonb AS metadata
    FROM "organization_usage_events"
    WHERE "organization_id" = ${organizationId}
      AND "source_id" = ${`browser:${id("session", "b")}:g1`}
      AND "interval_started_at" = ${hour.startedAt}
  `;
  assert.equal(usage?.count, 1);
  assert.equal(Number(usage?.quantity), 1800);
  assert.equal(usage?.actor, userId);
  assert.equal(usage?.project, id("project", "b"));
  assert.equal(usage?.thread, id("thread", "b"));
  assert.equal(usage?.run, id("run", "b"));
  assert.deepEqual(usage?.metadata, {
    source: "browser_session_lifecycle",
    environmentId: id("env", "b"),
    sessionId: id("session", "b"),
    generation: 1,
    region: "ord",
    state: "expired",
  });
});
