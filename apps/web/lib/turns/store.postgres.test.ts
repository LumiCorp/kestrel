import assert from "node:assert/strict";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const databaseUrl = process.env.KESTREL_TURN_DB_TEST_URL?.trim();

async function waitFor<T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (settled(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the durable turn to settle.");
}

contractTest(
  ["web.interaction-request-identity", "web.worker-claim-recovery"],
  "durable turns converge across claims, dispatch failure, and worker recovery",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [
      { resetDbRuntimeForTests },
      store,
      queue,
      environmentReconcile,
      processRuntime,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./queue"),
      import("@/lib/environments/reconcile"),
      import("./process-runtime"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `turn-org-${suffix}`;
    const userId = `turn-user-${suffix}`;
    const environmentId = `turn-environment-${suffix}`;
    const successfulThreadId = `turn-success-${suffix}`;
    const dispatchFailureThreadId = `turn-dispatch-failure-${suffix}`;
    const orphanedThreadId = `turn-orphaned-${suffix}`;
    const recoveryThreadId = `turn-recovery-${suffix}`;
    const retriedThreadId = `turn-retried-${suffix}`;
    const retriedStoppedThreadId = `turn-retried-stopped-${suffix}`;
    const resumedThreadId = `turn-resumed-${suffix}`;
    const interactionThreadId = `turn-interaction-${suffix}`;
    const now = new Date();

    context.after(async () => {
      await queue.stopDurableThreadTurnWorker();
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Turn Worker User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Turn Worker Org',
          ${`turn-worker-org-${suffix}`}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'Default', 'default',
          'iad', 'ready', true
        )
      `;
      await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES
          (
            ${successfulThreadId}, 'Successful Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${dispatchFailureThreadId}, 'Dispatch Failure', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${orphanedThreadId}, 'Orphaned Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${recoveryThreadId}, 'Recovery Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${retriedThreadId}, 'Retried Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${retriedStoppedThreadId}, 'Retried Stopped Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${resumedThreadId}, 'Resumed Turn', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${interactionThreadId}, 'Interaction Turn', ${userId},
            ${organizationId}, 'mobile'
          )
      `;
    });

    const createTurn = (threadId: string, label: string) =>
      store.createDurableThreadTurn({
        threadId,
        organizationId,
        authorUserId: userId,
        messageId: `message-${label}-${suffix}`,
        messageParts: [{ type: "text", text: label }],
        idempotencyKey: `idempotency-${label}-${suffix}`,
        requestedEnvironmentId: environmentId,
        source: "mobile",
      });

    const successful = await createTurn(successfulThreadId, "success");
    assert.equal(successful.created, true);
    assert.equal(successful.shouldDispatch, true);
    assert.equal(successful.dispatchTurnId, successful.turn.id);
    const duplicate = await createTurn(successfulThreadId, "success");
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.turn.id, successful.turn.id);

    const claims = await Promise.all([
      store.claimDurableThreadTurn(successful.turn.id),
      store.claimDurableThreadTurn(successful.turn.id),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const workspaceId = `turn-workspace-${suffix}`;
    const executionId = `turn-execution-${suffix}`;
    const gatewayId = `turn-gateway-${suffix}`;
    const modelId = `turn-model-${suffix}`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "standalone_thread_id",
          "created_by_user_id", "name", "kind", "status", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${successfulThreadId},
          ${userId}, 'Turn Workspace', 'scratch', 'ready', 'runtime:test'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "environment_id", "provider", "display_name"
        ) VALUES (
          ${gatewayId}, ${organizationId}, ${environmentId}, 'openai', 'Turn Gateway'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality"
        ) VALUES (
          ${modelId}, ${organizationId}, ${gatewayId}, 'turn-model', 'language'
        )
      `;
      await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id", "thread_id",
          "actor_id", "runtime_image", "effective_capabilities", "status"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${successfulThreadId}, ${userId}, 'runtime:test', '[]'::jsonb, 'running'
        )
      `;
      await transaction`
        UPDATE "thread_turns"
        SET "environment_execution_id" = ${executionId}
        WHERE "id" = ${successful.turn.id}
      `;
      await transaction`
        INSERT INTO "environment_model_grants" (
          "run_id", "organization_id", "environment_id", "workspace_id",
          "thread_id", "gateway_id", "raw_model_id", "status"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${successfulThreadId}, ${gatewayId}, 'turn-model', 'active'
        )
      `;
      await transaction`
        INSERT INTO "mcp_run_grants" (
          "id", "run_execution_id", "organization_id", "environment_id",
          "thread_id", "policy_digest", "effective_capabilities",
          "effective_policy", "status", "expires_at"
        ) VALUES (
          ${`turn-mcp-grant-${suffix}`}, ${executionId}, ${organizationId},
          ${environmentId}, ${successfulThreadId}, 'digest', '[]'::jsonb,
          '[]'::jsonb, 'active', ${new Date(Date.now() + 60_000)}
        )
      `;
    });
    const completed = await store.completeDurableThreadTurn({
      turnId: successful.turn.id,
      status: "completed",
    });
    assert.equal(completed.turn.status, "completed");
    const [executionLifecycle] = await sql<
      Array<{ execution: string; modelGrant: string; mcpGrant: string }>
    >`
      SELECT
        execution."status" AS "execution",
        model_grant."status" AS "modelGrant",
        mcp_grant."status" AS "mcpGrant"
      FROM "environment_run_executions" execution
      JOIN "environment_model_grants" model_grant
        ON model_grant."run_id" = execution."id"
      JOIN "mcp_run_grants" mcp_grant
        ON mcp_grant."run_execution_id" = execution."id"
      WHERE execution."id" = ${executionId}
    `;
    assert.deepEqual(executionLifecycle, {
      execution: "completed",
      modelGrant: "closed",
      mcpGrant: "revoked",
    });
    await sql`
      UPDATE "environment_run_executions"
      SET "status" = 'failed'
      WHERE "id" = ${executionId}
    `;
    await store.completeDurableThreadTurn({
      turnId: successful.turn.id,
      status: "completed",
    });
    const [preservedExecution] = await sql<Array<{ status: string }>>`
      SELECT "status" FROM "environment_run_executions" WHERE "id" = ${executionId}
    `;
    assert.equal(preservedExecution?.status, "failed");
    await sql`
      UPDATE "environment_run_executions"
      SET "status" = 'running', "completed_at" = NULL
      WHERE "id" = ${executionId}
    `;
    await sql`
      UPDATE "environment_model_grants"
      SET "status" = 'active', "closed_at" = NULL
      WHERE "run_id" = ${executionId}
    `;
    await sql`
      UPDATE "mcp_run_grants"
      SET "status" = 'active', "revoked_at" = NULL
      WHERE "run_execution_id" = ${executionId}
    `;
    assert.ok(
      (await environmentReconcile.reconcileTerminalTurnExecutions()) >= 1,
    );
    const [reconciledExecution] = await sql<
      Array<{ execution: string; modelGrant: string; mcpGrant: string }>
    >`
      SELECT
        execution."status" AS "execution",
        model_grant."status" AS "modelGrant",
        mcp_grant."status" AS "mcpGrant"
      FROM "environment_run_executions" execution
      JOIN "environment_model_grants" model_grant ON model_grant."run_id" = execution."id"
      JOIN "mcp_run_grants" mcp_grant ON mcp_grant."run_execution_id" = execution."id"
      WHERE execution."id" = ${executionId}
    `;
    assert.deepEqual(reconciledExecution, {
      execution: "completed",
      modelGrant: "closed",
      mcpGrant: "revoked",
    });
    const [successfulQueue] = await sql<
      Array<{ activeTurnId: string | null; state: string }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${successfulThreadId}
    `;
    assert.deepEqual(successfulQueue, {
      activeTurnId: null,
      state: "running",
    });

    const waiting = await createTurn(interactionThreadId, "waiting");
    assert.ok(await store.claimDurableThreadTurn(waiting.turn.id));
    const requestId = `opaque-request-${suffix}`;
    const assistantMessageId = `assistant-waiting-${suffix}`;
    await store.persistDurableAssistantOutcome({
      turnId: waiting.turn.id,
      messages: [
        {
          id: assistantMessageId,
          parts: [
            {
              type: "data-kestrel-interaction",
              id: `interaction:${requestId}`,
              data: {
                version: "v1",
                requestId,
                kind: "user_input",
                eventType: "user.reply",
                prompt: "Which workspace should I inspect?",
                source: "runtime",
                status: "pending",
              },
            },
            { type: "text", text: "Which workspace should I inspect?" },
          ],
          model: "kestrel-one",
          source: "mobile",
          projectContextRevisionId: null,
        },
      ],
      interaction: {
        version: "v1",
        requestId,
        kind: "user_input",
        eventType: "user.reply",
        prompt: "Which workspace should I inspect?",
        source: "runtime",
        status: "pending",
      },
    });
    assert.equal(
      (await store.getDurableTurn(waiting.turn.id))?.status,
      "waiting_for_input",
    );
    const interactions = await store.listThreadInteractionsForUser({
      threadId: interactionThreadId,
      organizationId,
      userId,
    });
    assert.equal(interactions[0]?.requestId, requestId);
    assert.equal(interactions[0]?.assistantMessageId, assistantMessageId);
    assert.equal(interactions[0]?.status, "pending");

    const queuedWhileWaiting = await createTurn(
      interactionThreadId,
      "queued-while-waiting",
    );
    assert.equal(queuedWhileWaiting.shouldDispatch, false);
    assert.equal(queuedWhileWaiting.turn.status, "queued");
    await assert.rejects(
      store.resolveDurableRuntimeInteraction({
        threadId: interactionThreadId,
        organizationId,
        userId,
        requestId,
        eventType: "wrong.event",
        message: "Workspace A",
        messageId: `wrong-response-${suffix}`,
        source: "mobile",
      }),
      /event type does not match/u,
    );
    const resolved = await store.resolveDurableRuntimeInteraction({
      threadId: interactionThreadId,
      organizationId,
      userId,
      requestId,
      eventType: "user.reply",
      message: "Workspace A",
      messageId: `interaction-response-${suffix}`,
      source: "mobile",
    });
    assert.equal(resolved.turnId, waiting.turn.id);
    assert.equal(resolved.shouldDispatch, true);
    assert.ok(resolved.replayAfterSequence > 0);
    const resolvedInteractions = await store.listThreadInteractionsForUser({
      threadId: interactionThreadId,
      organizationId,
      userId,
    });
    assert.equal(
      resolvedInteractions[0]?.responseMessageId,
      `interaction-response-${suffix}`,
    );
    assert.equal(
      resolvedInteractions[0]?.responseEnvelope?.messageId,
      `interaction-response-${suffix}`,
    );
    const [responseMessage] = await sql<Array<{ turnId: string | null }>>`
      SELECT "turn_id" AS "turnId"
      FROM "thread_messages"
      WHERE "id" = ${`interaction-response-${suffix}`}
    `;
    assert.equal(responseMessage?.turnId, waiting.turn.id);
    assert.equal(
      await store.getDurableTurnReplayBoundary(waiting.turn.id),
      0,
      "an interaction event is not a completed UI stream segment",
    );
    const duplicateResolution = await store.resolveDurableRuntimeInteraction({
      threadId: interactionThreadId,
      organizationId,
      userId,
      requestId,
      eventType: "user.reply",
      message: "Workspace A",
      messageId: `interaction-response-duplicate-${suffix}`,
      source: "mobile",
    });
    assert.deepEqual(duplicateResolution, {
      turnId: waiting.turn.id,
      shouldDispatch: false,
      replayAfterSequence: resolved.replayAfterSequence,
    });
    await store.appendDurableTurnEvent({
      turnId: waiting.turn.id,
      type: "ui.message",
      data: { type: "finish", finishReason: "stop" },
    });
    assert.ok(
      (await store.getDurableTurnReplayBoundary(waiting.turn.id)) >
        resolved.replayAfterSequence,
    );
    const resumed = await store.claimDurableThreadTurn(waiting.turn.id);
    assert.deepEqual(resumed?.interactionResponse, {
      requestId,
      eventType: "user.reply",
      message: "Workspace A",
    });
    await store.persistDurableAssistantOutcome({
      turnId: waiting.turn.id,
      interaction: null,
      messages: [
        {
          id: `assistant-completed-${suffix}`,
          parts: [{ type: "text", text: "I inspected Workspace A." }],
          model: "kestrel-one",
          source: "mobile",
          projectContextRevisionId: null,
        },
      ],
    });
    const resumedCompletion = await store.completeDurableThreadTurn({
      turnId: waiting.turn.id,
      status: "completed",
    });
    assert.equal(resumedCompletion.nextTurnId, queuedWhileWaiting.turn.id);

    const dispatchFailure = await createTurn(
      dispatchFailureThreadId,
      "dispatch-failure",
    );
    assert.equal(
      await queue.finalizeExhaustedDurableTurnJob({
        turnId: dispatchFailure.turn.id,
        retryCount: 2,
        retryLimit: 3,
      }),
      false,
    );
    assert.equal(
      (await store.getDurableTurn(dispatchFailure.turn.id))?.status,
      "queued",
    );
    assert.equal(
      await queue.finalizeExhaustedDurableTurnJob({
        turnId: dispatchFailure.turn.id,
        retryCount: 3,
        retryLimit: 3,
      }),
      true,
    );
    const failedDispatch = await store.getDurableTurn(dispatchFailure.turn.id);
    assert.equal(failedDispatch?.status, "failed");
    assert.equal(failedDispatch?.failureCode, "TURN_DISPATCH_FAILED");
    const [failedQueue] = await sql<
      Array<{
        activeTurnId: string | null;
        pauseReason: string | null;
        state: string;
      }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "pause_reason" AS "pauseReason",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${dispatchFailureThreadId}
    `;
    assert.deepEqual(failedQueue, {
      activeTurnId: null,
      pauseReason: "turn_failed",
      state: "paused",
    });

    const failedBeforeResume = await createTurn(
      resumedThreadId,
      "failure-before-resume",
    );
    assert.ok(await store.claimDurableThreadTurn(failedBeforeResume.turn.id));
    await store.completeDurableThreadTurn({
      turnId: failedBeforeResume.turn.id,
      status: "failed",
      failureCode: "RUNTIME_FAILED",
      failureMessage: "Synthetic failure before an explicit user retry.",
    });
    const resumedByUserMessage = await createTurn(
      resumedThreadId,
      "explicit-user-retry",
    );
    assert.equal(resumedByUserMessage.shouldDispatch, true);
    assert.equal(
      resumedByUserMessage.dispatchTurnId,
      resumedByUserMessage.turn.id,
    );
    const [resumedQueue] = await sql<
      Array<{
        activeTurnId: string | null;
        pauseReason: string | null;
        state: string;
      }>
    >`
      SELECT
        "active_turn_id" AS "activeTurnId",
        "pause_reason" AS "pauseReason",
        "state"
      FROM "thread_turn_queue_state"
      WHERE "thread_id" = ${resumedThreadId}
    `;
    assert.deepEqual(resumedQueue, {
      activeTurnId: resumedByUserMessage.turn.id,
      pauseReason: null,
      state: "running",
    });

    const orphaned = await createTurn(orphanedThreadId, "orphaned");
    assert.ok(await store.claimDurableThreadTurn(orphaned.turn.id));
    await queue.reconcileDurableThreadTurnQueue();
    const failedOrphaned = await store.getDurableTurn(orphaned.turn.id);
    assert.equal(failedOrphaned?.status, "failed");
    assert.equal(failedOrphaned?.failureCode, "TURN_WORKER_INTERRUPTED");

    const retried = await createTurn(retriedThreadId, "retried");
    assert.ok(await store.claimDurableThreadTurn(retried.turn.id));
    await processRuntime.processDurableThreadTurn(retried.turn.id, {
      retryCount: 1,
    });
    const failedRetry = await store.getDurableTurn(retried.turn.id);
    assert.equal(failedRetry?.status, "failed");
    assert.equal(failedRetry?.failureCode, "TURN_WORKER_INTERRUPTED");

    const retriedStopped = await createTurn(
      retriedStoppedThreadId,
      "retried-stopped",
    );
    assert.ok(await store.claimDurableThreadTurn(retriedStopped.turn.id));
    await store.requestDurableTurnStop({
      turnId: retriedStopped.turn.id,
      organizationId,
      userId,
    });
    await processRuntime.processDurableThreadTurn(retriedStopped.turn.id, {
      retryCount: 1,
    });
    const cancelledRetry = await store.getDurableTurn(retriedStopped.turn.id);
    assert.equal(cancelledRetry?.status, "cancelled");
    assert.equal(cancelledRetry?.failureCode, "TURN_STOPPED");

    const recovery = await createTurn(recoveryThreadId, "recovery");
    assert.equal(recovery.shouldDispatch, true);
    await queue.reconcileDurableThreadTurnQueue();
    await queue.reconcileDurableThreadTurnQueue();
    const [recoveryJobCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${recovery.turn.id}
        AND "state" IN ('created', 'retry', 'active')
    `;
    assert.equal(recoveryJobCount?.count, 1);
    const [recoveryLease] = await sql<
      Array<{ expireSeconds: number; heartbeatSeconds: number | null }>
    >`
      SELECT
        "expire_seconds" AS "expireSeconds",
        "heartbeat_seconds" AS "heartbeatSeconds"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${recovery.turn.id}
        AND "state" IN ('created', 'retry', 'active')
      LIMIT 1
    `;
    assert.deepEqual(recoveryLease, {
      expireSeconds: 12 * 60 * 60,
      heartbeatSeconds: 60,
    });
    await queue.startDurableThreadTurnWorker();
    const recovered = await waitFor(
      () => store.getDurableTurn(recovery.turn.id),
      (turn) =>
        Boolean(
          turn && ["completed", "failed", "cancelled"].includes(turn.status),
        ),
    );
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.failureCode, "TURN_WORKER_FAILED");
    assert.equal(
      recovered?.failureMessage,
      "No approved gateway model is configured for the chat surface.",
    );
    const recoveryEvents = await store.listDurableTurnEvents({
      turnId: recovery.turn.id,
    });
    assert.deepEqual(
      recoveryEvents
        .map((event) => event.type)
        .filter((type) => type !== "ui.message"),
      ["turn.queued", "turn.running", "turn.activity", "turn.failed"],
    );
    assert.deepEqual(
      recoveryEvents.find((event) => event.type === "turn.activity")?.data,
      { message: "Reading context", stage: "reading_context" },
    );

    await Promise.all([
      queue.enqueueDurableThreadTurn(recovery.turn.id),
      queue.enqueueDurableThreadTurn(recovery.turn.id),
    ]);
    const [deliveryCount] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${recovery.turn.id}
    `;
    assert.ok(deliveryCount && deliveryCount.count >= 3);
  },
);
