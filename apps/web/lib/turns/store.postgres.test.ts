import test from "node:test";
import assert from "node:assert/strict";
import { PgBoss } from "pg-boss";
import postgres from "postgres";
import "../../scripts/register-server-only.mjs";
import { evaluationReviewInteractionFixture } from "../../../../tests/fixtures/structured-review-contract";


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

test(
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
    const structuredReviewThreadId = `turn-structured-review-${suffix}`;
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
          ),
          (
            ${structuredReviewThreadId}, 'Structured Review Turn', ${userId},
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
          "id", "organization_id", "environment_id", "personal_owner_user_id",
          "created_by_user_id", "name", "kind", "status", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${userId},
          ${userId}, 'Turn Workspace', 'scratch', 'ready', 'runtime:test'
        )
      `;
      await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "environment_id", "provider", "display_name",
          "credential_status", "credential_validated_at"
        ) VALUES (
          ${gatewayId}, ${organizationId}, ${environmentId}, 'openai', 'Turn Gateway',
          'ready', now()
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
          "thread_id", "gateway_id", "raw_model_id", "gateway_model_id",
          "gateway_credential_revision", "status"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${successfulThreadId}, ${gatewayId}, 'turn-model', ${modelId}, 1, 'active'
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

    const credentialFailure = await createTurn(
      successfulThreadId,
      "credential-failure"
    );
    assert.ok(await store.claimDurableThreadTurn(credentialFailure.turn.id));
    const credentialFailureExecutionId = `turn-auth-execution-${suffix}`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id", "thread_id",
          "actor_id", "runtime_image", "effective_capabilities", "status"
        ) VALUES (
          ${credentialFailureExecutionId}, ${organizationId}, ${environmentId},
          ${workspaceId}, ${successfulThreadId}, ${userId}, 'runtime:test',
          '[]'::jsonb, 'running'
        )
      `;
      await transaction`
        UPDATE "thread_turns"
        SET "environment_execution_id" = ${credentialFailureExecutionId}
        WHERE "id" = ${credentialFailure.turn.id}
      `;
      await transaction`
        INSERT INTO "environment_model_grants" (
          "run_id", "organization_id", "environment_id", "workspace_id",
          "thread_id", "gateway_id", "raw_model_id", "gateway_model_id",
          "gateway_credential_revision", "status"
        ) VALUES (
          ${credentialFailureExecutionId}, ${organizationId}, ${environmentId},
          ${workspaceId}, ${successfulThreadId}, ${gatewayId}, 'turn-model',
          ${modelId}, 1, 'active'
        )
      `;
    });
    await store.completeDurableThreadTurn({
      turnId: credentialFailure.turn.id,
      status: "failed",
      failureCode: "MODEL_AUTH_ERROR",
      failureMessage: "The provider rejected the credential.",
    });
    const [invalidatedCredential] = await sql<
      Array<{
        credentialStatus: string;
        credentialValidatedAt: Date | null;
        credentialRevision: number;
      }>
    >`
      SELECT
        "credential_status" AS "credentialStatus",
        "credential_validated_at" AS "credentialValidatedAt",
        "credential_revision" AS "credentialRevision"
      FROM "ai_gateways"
      WHERE "id" = ${gatewayId}
    `;
    assert.deepEqual(invalidatedCredential, {
      credentialStatus: "invalid",
      credentialValidatedAt: null,
      credentialRevision: 1,
    });

    const waiting = await createTurn(interactionThreadId, "waiting");
    assert.ok(await store.claimDurableThreadTurn(waiting.turn.id));
    const interactionExecutionId = `turn-interaction-execution-${suffix}`;
    const interactionRuntimeRunId = `turn-interaction-runtime-run-${suffix}`;
    await sql`
      INSERT INTO "environment_run_executions" (
        "id", "organization_id", "environment_id", "workspace_id", "thread_id",
        "actor_id", "runtime_image", "effective_capabilities", "runtime_run_id", "status"
      ) VALUES (
        ${interactionExecutionId}, ${organizationId}, ${environmentId}, ${workspaceId},
        ${interactionThreadId}, ${userId}, 'runtime:test', '[]'::jsonb,
        ${interactionRuntimeRunId}, 'running'
      )
    `;
    await sql`
      UPDATE "thread_turns"
      SET "environment_execution_id" = ${interactionExecutionId}
      WHERE "id" = ${waiting.turn.id}
    `;
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
                inputSchema: {
                  type: "object",
                  properties: {
                    workspace: { type: "array", items: { type: "string" }, minItems: 1 },
                  },
                  required: ["workspace"],
                  additionalProperties: false,
                },
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
        inputSchema: {
          type: "object",
          properties: {
            workspace: { type: "array", items: { type: "string" }, minItems: 1 },
          },
          required: ["workspace"],
          additionalProperties: false,
        },
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
    const [committedResumeWindow] = await sql<
      Array<{
        interactionStatus: string;
        queueState: string;
        resumedAt: Date | null;
        turnStatus: string;
      }>
    >`
      SELECT
        interaction."status" AS "interactionStatus",
        queue_state."state" AS "queueState",
        interaction."resumed_at" AS "resumedAt",
        turn."status" AS "turnStatus"
      FROM "thread_interactions" interaction
      JOIN "thread_turns" turn ON turn."id" = interaction."turn_id"
      JOIN "thread_turn_queue_state" queue_state
        ON queue_state."thread_id" = turn."thread_id"
      WHERE interaction."request_id" = ${requestId}
    `;
    assert.deepEqual(committedResumeWindow, {
      interactionStatus: "processing",
      queueState: "running",
      resumedAt: null,
      turnStatus: "waiting_for_input",
    });
    const [pendingDelivery] = await sql<
      Array<{
        state: string;
        acknowledgedAt: Date | null;
        attempt: number;
        bindingId: string;
        environmentExecutionId: string;
        runtimeRunId: string;
      }>
    >`
      SELECT
        "state",
        "acknowledged_at" AS "acknowledgedAt",
        "attempt",
        "binding_id" AS "bindingId",
        "environment_execution_id" AS "environmentExecutionId",
        "runtime_run_id" AS "runtimeRunId"
      FROM "runtime_interaction_deliveries"
      WHERE "request_id" = ${requestId}
    `;
    assert.equal(pendingDelivery?.state, "delivering");
    assert.equal(pendingDelivery?.acknowledgedAt, null);
    assert.equal(pendingDelivery?.attempt, 1);

    // Simulate process death after the answer transaction commits but before
    // the route enqueues the worker that delivers it to the native runtime.
    await queue.reconcileDurableThreadTurnQueue();
    await queue.reconcileDurableThreadTurnQueue();
    const [reconciledResumeJobs] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM "pgboss"."job"
      WHERE
        "name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
        AND "data" ->> 'turnId' = ${waiting.turn.id}
        AND "state" IN ('created', 'retry', 'active')
    `;
    assert.equal(
      reconciledResumeJobs?.count,
      1,
      "reconciliation must restore exactly one resumed delivery after the resolution/enqueue crash window",
    );
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
      answers: { workspace: ["Workspace A"] },
    });
    const resumedExecutionId = `turn-interaction-resume-execution-${suffix}`;
    const resumedRuntimeRunId = `turn-interaction-resume-runtime-run-${suffix}`;
    await sql`
      INSERT INTO "environment_run_executions" (
        "id", "organization_id", "environment_id", "workspace_id", "thread_id",
        "actor_id", "runtime_image", "effective_capabilities", "runtime_run_id", "status"
      ) VALUES (
        ${resumedExecutionId}, ${organizationId}, ${environmentId}, ${workspaceId},
        ${interactionThreadId}, ${userId}, 'runtime:test', '[]'::jsonb,
        ${resumedRuntimeRunId}, 'running'
      )
    `;
    await store.bindDurableTurnExecution({
      turnId: waiting.turn.id,
      executionId: resumedExecutionId,
    });
    await store.bindDurableRuntimeInteractionDeliveryExecution({
      turnId: waiting.turn.id,
      requestId,
      bindingId: pendingDelivery!.bindingId,
      environmentExecutionId: resumedExecutionId,
      runtimeRunId: resumedRuntimeRunId,
    });
    await store.bindDurableRuntimeInteractionDeliveryExecution({
      turnId: waiting.turn.id,
      requestId,
      bindingId: pendingDelivery!.bindingId,
      environmentExecutionId: resumedExecutionId,
      runtimeRunId: resumedRuntimeRunId,
    });
    await assert.rejects(
      () => store.bindDurableRuntimeInteractionDeliveryExecution({
        turnId: waiting.turn.id,
        requestId,
        bindingId: pendingDelivery!.bindingId,
        environmentExecutionId: pendingDelivery!.environmentExecutionId,
        runtimeRunId: pendingDelivery!.runtimeRunId,
      }),
      (error: unknown) =>
        error instanceof store.DurableTurnError && error.code === "TURN_CONFLICT",
    );
    const acknowledgement = {
      turnId: waiting.turn.id,
      requestId,
      bindingId: pendingDelivery!.bindingId,
      environmentExecutionId: resumedExecutionId,
      runtimeRunId: resumedRuntimeRunId,
      acknowledgementEventId: `event-${suffix}`,
    };
    await assert.rejects(
      () => store.acknowledgeDurableRuntimeInteractionDelivery({
        ...acknowledgement,
        runtimeRunId: `foreign-run-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof store.DurableTurnError && error.code === "TURN_CONFLICT",
    );
    await store.acknowledgeDurableRuntimeInteractionDelivery(acknowledgement);
    await store.acknowledgeDurableRuntimeInteractionDelivery(acknowledgement);
    await assert.rejects(
      () => store.acknowledgeDurableRuntimeInteractionDelivery({
        ...acknowledgement,
        acknowledgementEventId: `different-event-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof store.DurableTurnError && error.code === "TURN_CONFLICT",
    );
    const [acknowledgedDelivery] = await sql<
      Array<{ state: string; acknowledgedAt: Date | null }>
    >`
      SELECT "state", "acknowledged_at" AS "acknowledgedAt"
      FROM "runtime_interaction_deliveries"
      WHERE "request_id" = ${requestId}
    `;
    assert.equal(acknowledgedDelivery?.state, "delivered");
    assert.ok(acknowledgedDelivery?.acknowledgedAt instanceof Date);
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

    const reviewTurn = await createTurn(
      structuredReviewThreadId,
      "structured-review",
    );
    assert.ok(await store.claimDurableThreadTurn(reviewTurn.turn.id));
    const reviewExecutionId = `turn-review-execution-${suffix}`;
    await sql`
      INSERT INTO "environment_run_executions" (
        "id", "organization_id", "environment_id", "workspace_id", "thread_id",
        "actor_id", "runtime_image", "effective_capabilities", "runtime_run_id", "status"
      ) VALUES (
        ${reviewExecutionId}, ${organizationId}, ${environmentId}, ${workspaceId},
        ${structuredReviewThreadId}, ${userId}, 'runtime:test', '[]'::jsonb,
        ${`turn-review-runtime-run-${suffix}`}, 'running'
      )
    `;
    await sql`
      UPDATE "thread_turns"
      SET "environment_execution_id" = ${reviewExecutionId}
      WHERE "id" = ${reviewTurn.turn.id}
    `;
    const reviewRequestId = `structured-review-${suffix}`;
    const reviewEnvelope = {
      ...structuredClone(evaluationReviewInteractionFixture),
      requestId: reviewRequestId,
      source: "runtime" as const,
      status: "pending" as const,
    };
    await store.persistDurableAssistantOutcome({
      turnId: reviewTurn.turn.id,
      messages: [{
        id: `assistant-structured-review-${suffix}`,
        parts: [{
          type: "data-kestrel-interaction",
          id: `interaction:${reviewRequestId}`,
          data: reviewEnvelope,
        }],
        model: "kestrel-one",
        source: "mobile",
        projectContextRevisionId: null,
      }],
      interaction: reviewEnvelope,
    });
    await assert.rejects(
      store.resolveDurableRuntimeInteraction({
        threadId: structuredReviewThreadId,
        organizationId,
        userId,
        requestId: reviewRequestId,
        eventType: "user.reply",
        message: "Try again",
        messageId: `review-free-text-${suffix}`,
        source: "mobile",
      }),
      /must select one exact allowed recovery option/u,
    );
    const pendingReview = await store.listThreadInteractionsForUser({
      threadId: structuredReviewThreadId,
      organizationId,
      userId,
    });
    assert.equal(pendingReview[0]?.status, "pending");
    const resolvedReview = await store.resolveDurableRuntimeInteraction({
      threadId: structuredReviewThreadId,
      organizationId,
      userId,
      requestId: reviewRequestId,
      eventType: "user.reply",
      message: "Try again",
      recoveryOptionId: "evaluation.accept_once",
      messageId: `review-option-${suffix}`,
      source: "mobile",
    });
    assert.equal(resolvedReview.shouldDispatch, true);

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
      [
        "turn.queued",
        "turn.running",
        "turn.activity",
        "turn.activity",
        "turn.failed",
      ],
    );
    assert.deepEqual(
      recoveryEvents
        .filter((event) => event.type === "turn.activity")
        .map((event) => event.data),
      [
        { message: "Reading context", stage: "reading_context" },
        {
          code: "TITLE_GENERATION_FAILED",
          stage: "thread.title.failed",
        },
      ],
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

test(
  "live reasoning and heartbeats never enter thread_turn_events",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [
      { resetDbRuntimeForTests },
      store,
      runtimePersistence,
    ] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("@/lib/agent/kestrel-runtime-persistence"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `runtime-persistence-org-${suffix}`;
    const userId = `runtime-persistence-user-${suffix}`;
    const environmentId = `runtime-persistence-environment-${suffix}`;
    const threadId = `runtime-persistence-thread-${suffix}`;
    const now = new Date();

    context.after(async () => {
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
          ${userId}, 'Runtime Persistence User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Runtime Persistence Org',
          ${`runtime-persistence-org-${suffix}`}, ${now}
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
        ) VALUES (
          ${threadId}, 'Runtime Persistence', ${userId},
          ${organizationId}, 'mobile'
        )
      `;
    });

    const created = await store.createDurableThreadTurn({
      threadId,
      organizationId,
      authorUserId: userId,
      messageId: `runtime-persistence-message-${suffix}`,
      messageParts: [{ type: "text", text: "Test persistence." }],
      idempotencyKey: `runtime-persistence-idempotency-${suffix}`,
      requestedEnvironmentId: environmentId,
      source: "mobile",
    });
    const appendRuntimeChunk = (chunk: unknown) =>
      runtimePersistence.appendKestrelUiChunkIfDurable(
        chunk,
        async (durableChunk) => {
          await store.appendDurableTurnEvent({
            turnId: created.turn.id,
            type: "ui.message",
            data: durableChunk,
          });
        },
      );

    assert.equal(
      await appendRuntimeChunk({
        type: "data-kestrel-provider-reasoning",
        data: {
          assistantMessageId: `assistant-reasoning-${suffix}`,
          delta: `private-provider-reasoning-${suffix}`,
        },
      }),
      false,
    );
    assert.equal(
      await appendRuntimeChunk({
        type: "data-kestrel-progress",
        data: {
          assistantMessageId: `assistant-reasoning-${suffix}`,
          code: "RUN_STILL_ACTIVE",
          persist: false,
          text: `live-heartbeat-${suffix}`,
        },
      }),
      false,
    );
    assert.equal(
      await appendRuntimeChunk({
        type: "data-kestrel-progress",
        data: {
          assistantMessageId: `assistant-reasoning-${suffix}`,
          code: "MODEL_ATTEMPT_RETRYING",
          persist: true,
          text: `durable-retry-${suffix}`,
        },
      }),
      true,
    );

    const persistedRuntimeEvents = await store.listDurableTurnEvents({
      turnId: created.turn.id,
    });
    const persistedRuntimeData = JSON.stringify(
      persistedRuntimeEvents.map((event) => event.data),
    );
    assert.equal(
      persistedRuntimeData.includes(`private-provider-reasoning-${suffix}`),
      false,
      "provider reasoning must never enter thread_turn_events",
    );
    assert.equal(
      persistedRuntimeData.includes(`live-heartbeat-${suffix}`),
      false,
      "non-persistent progress must never enter thread_turn_events",
    );
    assert.equal(
      persistedRuntimeData.includes(`durable-retry-${suffix}`),
      true,
      "persistent retry progress must enter thread_turn_events",
    );
  },
);

test(
  "ambiguous and missing dispatch preserve durable queue authority",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, store, queue] = await Promise.all([
      import("@/lib/db/runtime"),
      import("./store"),
      import("./queue"),
    ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `dispatch-recovery-org-${suffix}`;
    const userId = `dispatch-recovery-user-${suffix}`;
    const environmentId = `dispatch-recovery-environment-${suffix}`;
    const initialThreadId = `dispatch-recovery-initial-${suffix}`;
    const successorThreadId = `dispatch-recovery-successor-${suffix}`;
    const missingThreadId = `dispatch-recovery-missing-${suffix}`;
    const now = new Date();
    const originalSend = PgBoss.prototype.send;
    const jobTurnIds: string[] = [];

    context.after(async () => {
      PgBoss.prototype.send = originalSend;
      await queue.stopDurableThreadTurnWorker();
      if (jobTurnIds.length > 0) {
        await sql`
          DELETE FROM "pgboss"."job"
          WHERE "data" ->> 'turnId' IN ${sql(jobTurnIds)}
        `;
      }
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
          ${userId}, 'Dispatch Recovery User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Dispatch Recovery Org',
          ${`dispatch-recovery-org-${suffix}`}, ${now}
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
            ${initialThreadId}, 'Ambiguous Initial Dispatch', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${successorThreadId}, 'Ambiguous Successor Dispatch', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${missingThreadId}, 'Missing Dispatch', ${userId},
            ${organizationId}, 'mobile'
          )
      `;
    });

    const createTurn = (threadId: string, label: string) =>
      store.createDurableThreadTurn({
        threadId,
        organizationId,
        authorUserId: userId,
        messageId: `dispatch-recovery-message-${label}-${suffix}`,
        messageParts: [{ type: "text", text: label }],
        idempotencyKey: `dispatch-recovery-idempotency-${label}-${suffix}`,
        requestedEnvironmentId: environmentId,
        source: "mobile",
      });
    const readSnapshot = async (turnId: string) => {
      const [snapshot] = await sql<
        Array<{
          activeTurnId: string | null;
          failureCode: string | null;
          jobs: number;
          pauseReason: string | null;
          queueState: string;
          status: string;
        }>
      >`
        SELECT
          turn."status",
          turn."failure_code" AS "failureCode",
          queue."active_turn_id" AS "activeTurnId",
          queue."state" AS "queueState",
          queue."pause_reason" AS "pauseReason",
          (
            SELECT count(*)::int
            FROM "pgboss"."job" job
            WHERE
              job."name" = ${queue.DURABLE_THREAD_TURN_QUEUE}
              AND job."data" ->> 'turnId' = ${turnId}
              AND job."state" IN ('created', 'retry', 'active')
          ) AS "jobs"
        FROM "thread_turns" turn
        INNER JOIN "thread_turn_queue_state" queue
          ON queue."thread_id" = turn."thread_id"
        WHERE turn."id" = ${turnId}
      `;
      return snapshot;
    };
    const claimOnce = async (turnId: string) => {
      const claims = await Promise.all(
        Array.from({ length: 4 }, () =>
          store.claimDurableThreadTurn(turnId),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1);
    };
    const throwAfterCommittedSend = (targetTurnId: string, message: string) => {
      PgBoss.prototype.send = (async function (
        this: PgBoss,
        ...args: unknown[]
      ) {
        const jobId = await Reflect.apply(originalSend, this, args);
        const data = args[1];
        if (
          data &&
          typeof data === "object" &&
          "turnId" in data &&
          data.turnId === targetTurnId
        ) {
          throw new Error(message);
        }
        return jobId;
      }) as typeof PgBoss.prototype.send;
    };

    const initial = await createTurn(initialThreadId, "initial");
    jobTurnIds.push(initial.turn.id);
    throwAfterCommittedSend(initial.turn.id, "ambiguous initial dispatch");
    await queue.enqueueDurableThreadTurn(initial.turn.id);
    PgBoss.prototype.send = originalSend;
    assert.deepEqual(await readSnapshot(initial.turn.id), {
      activeTurnId: initial.turn.id,
      failureCode: null,
      jobs: 1,
      pauseReason: null,
      queueState: "running",
      status: "queued",
    });
    await claimOnce(initial.turn.id);

    const current = await createTurn(successorThreadId, "current");
    const successor = await createTurn(successorThreadId, "successor");
    jobTurnIds.push(successor.turn.id);
    assert.ok(await store.claimDurableThreadTurn(current.turn.id));
    const completed = await store.completeDurableThreadTurn({
      turnId: current.turn.id,
      status: "completed",
    });
    assert.equal(completed.nextTurnId, successor.turn.id);
    throwAfterCommittedSend(successor.turn.id, "ambiguous successor dispatch");
    await queue.enqueueDurableThreadTurn(successor.turn.id);
    PgBoss.prototype.send = originalSend;
    assert.deepEqual(await readSnapshot(successor.turn.id), {
      activeTurnId: successor.turn.id,
      failureCode: null,
      jobs: 1,
      pauseReason: null,
      queueState: "running",
      status: "queued",
    });
    await claimOnce(successor.turn.id);

    const missing = await createTurn(missingThreadId, "missing");
    jobTurnIds.push(missing.turn.id);
    PgBoss.prototype.send = (async (
      _name: string,
      data: { turnId?: unknown },
    ) => {
      if (data?.turnId === missing.turn.id) {
        throw new Error("dispatch failed before commit");
      }
      return null;
    }) as typeof PgBoss.prototype.send;
    await assert.rejects(
      queue.enqueueDurableThreadTurn(missing.turn.id),
      /dispatch failed before commit/u,
    );
    PgBoss.prototype.send = originalSend;
    assert.deepEqual(await readSnapshot(missing.turn.id), {
      activeTurnId: missing.turn.id,
      failureCode: null,
      jobs: 0,
      pauseReason: null,
      queueState: "running",
      status: "queued",
    });
    await queue.reconcileDurableThreadTurnQueue();
    await queue.reconcileDurableThreadTurnQueue();
    assert.deepEqual(await readSnapshot(missing.turn.id), {
      activeTurnId: missing.turn.id,
      failureCode: null,
      jobs: 1,
      pauseReason: null,
      queueState: "running",
      status: "queued",
    });
    await claimOnce(missing.turn.id);
  },
);

test(
  "terminal presentation commits with terminal state and queue authority",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_TURN_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;

    const [{ resetDbRuntimeForTests }, store, processRuntime, mobileSnapshot] =
      await Promise.all([
        import("@/lib/db/runtime"),
        import("./store"),
        import("./process-runtime"),
        import("@/lib/mobile/snapshot"),
      ]);
    const sql = postgres(databaseUrl, { max: 2 });
    const suffix = crypto.randomUUID();
    const organizationId = `terminal-history-org-${suffix}`;
    const userId = `terminal-history-user-${suffix}`;
    const environmentId = `terminal-history-environment-${suffix}`;
    const successThreadId = `terminal-history-success-${suffix}`;
    const terminalFaultThreadId = `terminal-history-terminal-fault-${suffix}`;
    const releaseFaultThreadId = `terminal-history-release-fault-${suffix}`;
    const failedThreadId = `terminal-history-failed-${suffix}`;
    const cancelledThreadId = `terminal-history-cancelled-${suffix}`;
    const now = new Date();

    const dropTerminalFault = async () => {
      await sql`
        DROP TRIGGER IF EXISTS "issue_235_fail_terminal_commit"
        ON "thread_turn_events"
      `;
      await sql`
        DROP FUNCTION IF EXISTS "issue_235_fail_terminal_commit"()
      `;
    };
    const dropReleaseFault = async () => {
      await sql`
        DROP TRIGGER IF EXISTS "issue_235_fail_successor_release_commit"
        ON "thread_turn_queue_state"
      `;
      await sql`
        DROP FUNCTION IF EXISTS "issue_235_fail_successor_release_commit"()
      `;
    };
    const dropFaults = async () => {
      await dropTerminalFault();
      await dropReleaseFault();
    };

    context.after(async () => {
      await dropFaults();
      await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
      await sql`DELETE FROM "user" WHERE "id" = ${userId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });

    await dropFaults();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO "user" (
          "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
        ) VALUES (
          ${userId}, 'Terminal History User', ${`${userId}@example.test`},
          true, ${now}, ${now}
        )
      `;
      await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (
          ${organizationId}, 'Terminal History Org',
          ${`terminal-history-org-${suffix}`}, ${now}
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
            ${successThreadId}, 'Terminal Success', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${terminalFaultThreadId}, 'Terminal Commit Fault', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${releaseFaultThreadId}, 'Successor Release Fault', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${failedThreadId}, 'Terminal Failure', ${userId},
            ${organizationId}, 'mobile'
          ),
          (
            ${cancelledThreadId}, 'Terminal Cancellation', ${userId},
            ${organizationId}, 'mobile'
          )
      `;
    });

    const createTurn = (threadId: string, label: string) =>
      store.createDurableThreadTurn({
        threadId,
        organizationId,
        authorUserId: userId,
        messageId: `terminal-history-message-${label}-${suffix}`,
        messageParts: [{ type: "text", text: label }],
        idempotencyKey: `terminal-history-idempotency-${label}-${suffix}`,
        requestedEnvironmentId: environmentId,
        source: "mobile",
      });
    const presentation = (label: string) => [
      {
        id: `terminal-history-assistant-${label}-${suffix}`,
        parts: [{ type: "text", text: `Outcome: ${label}` }],
        model: "terminal-history-model",
        source: "mobile" as const,
        projectContextRevisionId: null,
      },
    ];
    const terminalReplayChunks = (
      label: string,
      status: "completed" | "failed" | "cancelled",
    ) => [
      {
        type: "data-kestrel-status",
        data: { status },
      },
      {
        type: "text-delta",
        id: `terminal-history-text-${label}-${suffix}`,
        delta: `Outcome: ${label}`,
      },
      {
        type: "text-end",
        id: `terminal-history-text-${label}-${suffix}`,
      },
      {
        type: "message-metadata",
        messageMetadata: { kestrelTerminalStatus: status },
      },
      { type: "finish", finishReason: "stop" },
    ];
    const readQueue = async (threadId: string) => {
      const [state] = await sql<
        Array<{
          activeTurnId: string | null;
          pauseReason: string | null;
          state: string;
          version: number;
        }>
      >`
        SELECT
          "active_turn_id" AS "activeTurnId",
          "pause_reason" AS "pauseReason",
          "state",
          "version"
        FROM "thread_turn_queue_state"
        WHERE "thread_id" = ${threadId}
      `;
      return state;
    };
    const eventTypes = async (turnId: string) =>
      (await store.listDurableTurnEvents({ turnId })).map(
        (event) => event.type,
      );
    const assistantMessageIds = async (turnId: string) => {
      const messages = await sql<Array<{ id: string }>>`
        SELECT "id"
        FROM "thread_messages"
        WHERE "turn_id" = ${turnId} AND "role" = 'assistant'
        ORDER BY "created_at", "id"
      `;
      return messages.map((message) => message.id);
    };
    const replayChunksForTurn = async (turnId: string) =>
      (await store.listDurableTurnEvents({ turnId, limit: 500 }))
        .filter((event) => event.type === "ui.message")
        .map((event) => event.data as Record<string, unknown>);
    const appendOpenReplayScaffold = async (turnId: string, label: string) => {
      for (const data of [
        {
          type: "start",
          messageId: `terminal-history-assistant-${label}-${suffix}`,
        },
        {
          type: "text-start",
          id: `terminal-history-text-${label}-${suffix}`,
        },
        {
          type: "data-kestrel-progress",
          data: { persist: true, text: "Still working." },
        },
      ]) {
        await store.appendDurableTurnEvent({
          turnId,
          type: "ui.message",
          data,
        });
      }
    };

    const successful = await createTurn(successThreadId, "success");
    const successfulNext = await createTurn(successThreadId, "success-next");
    assert.ok(await store.claimDurableThreadTurn(successful.turn.id));
    const successfulMessages = presentation("success");
    const successfulCompletion = await store.completeDurableThreadTurn({
      turnId: successful.turn.id,
      status: "completed",
      messages: successfulMessages,
      replayChunks: terminalReplayChunks("success", "completed"),
    });
    assert.equal(successfulCompletion.nextTurnId, successfulNext.turn.id);
    assert.deepEqual(await eventTypes(successful.turn.id), [
      "turn.queued",
      "turn.running",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "turn.completed",
    ]);
    assert.deepEqual(await assistantMessageIds(successful.turn.id), [
      successfulMessages[0]?.id,
    ]);
    assert.ok(
      (await store.getDurableTurnReplayBoundary(successful.turn.id)) > 0,
    );
    assert.deepEqual(await readQueue(successThreadId), {
      activeTurnId: successfulNext.turn.id,
      pauseReason: null,
      state: "running",
      version: 3,
    });
    const successfulMobile = await mobileSnapshot.getMobileThreadSnapshot({
      threadId: successThreadId,
      organizationId,
      userId,
    });
    assert.equal(
      successfulMobile?.turns.find((turn) => turn.id === successful.turn.id)
        ?.status,
      "completed",
    );
    assert.equal(
      successfulMobile?.messages.some(
        (message) => message.id === successfulMessages[0]?.id,
      ),
      true,
    );
    assert.equal(successfulMobile?.queue.activeTurnId, successfulNext.turn.id);

    const ignoredOppositeMessage = presentation("ignored-opposite");
    const idempotentCompletion = await store.completeDurableThreadTurn({
      turnId: successful.turn.id,
      status: "failed",
      failureCode: "SHOULD_NOT_REPLACE_COMPLETION",
      messages: ignoredOppositeMessage,
      replayChunks: terminalReplayChunks("ignored-opposite", "failed"),
    });
    assert.equal(idempotentCompletion.turn.status, "completed");
    assert.deepEqual(await assistantMessageIds(successful.turn.id), [
      successfulMessages[0]?.id,
    ]);
    assert.deepEqual(await eventTypes(successful.turn.id), [
      "turn.queued",
      "turn.running",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "turn.completed",
    ]);

    const terminalFault = await createTurn(
      terminalFaultThreadId,
      "terminal-fault",
    );
    assert.ok(await store.claimDurableThreadTurn(terminalFault.turn.id));
    await appendOpenReplayScaffold(terminalFault.turn.id, "terminal-fault");
    await sql`
      CREATE FUNCTION "issue_235_fail_terminal_commit"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'issue 235 terminal commit fault';
      END;
      $function$
    `;
    await sql`
      CREATE CONSTRAINT TRIGGER "issue_235_fail_terminal_commit"
      AFTER INSERT ON "thread_turn_events"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW."type" = 'turn.completed')
      EXECUTE FUNCTION "issue_235_fail_terminal_commit"()
    `;
    await assert.rejects(
      store.completeDurableThreadTurn({
        turnId: terminalFault.turn.id,
        status: "completed",
        messages: presentation("terminal-fault"),
        replayChunks: terminalReplayChunks("terminal-fault", "completed"),
      }),
      /issue 235 terminal commit fault/u,
    );
    assert.equal(
      (await store.getDurableTurn(terminalFault.turn.id))?.status,
      "running",
    );
    assert.deepEqual(await assistantMessageIds(terminalFault.turn.id), []);
    assert.equal(
      await store.getDurableTurnReplayBoundary(terminalFault.turn.id),
      0,
    );
    assert.deepEqual(
      (await replayChunksForTurn(terminalFault.turn.id)).map(
        (chunk) => chunk.type,
      ),
      ["start", "text-start", "data-kestrel-progress"],
    );
    assert.deepEqual(await readQueue(terminalFaultThreadId), {
      activeTurnId: terminalFault.turn.id,
      pauseReason: null,
      state: "running",
      version: 1,
    });
    await dropTerminalFault();
    await processRuntime.processDurableThreadTurn(terminalFault.turn.id, {
      retryCount: 1,
    });
    const recoveredTerminalFault = await store.getDurableTurn(
      terminalFault.turn.id,
    );
    assert.equal(recoveredTerminalFault?.status, "failed");
    assert.equal(
      recoveredTerminalFault?.failureCode,
      "TURN_WORKER_INTERRUPTED",
    );
    assert.equal(
      (await assistantMessageIds(terminalFault.turn.id)).length,
      1,
    );
    assert.ok(
      (await store.getDurableTurnReplayBoundary(terminalFault.turn.id)) > 0,
    );
    const recoveredTerminalReplay = await replayChunksForTurn(
      terminalFault.turn.id,
    );
    assert.equal(
      recoveredTerminalReplay.some(
        (chunk) =>
          chunk.type === "text-delta" &&
          chunk.delta === "Outcome: terminal-fault",
      ),
      false,
    );
    assert.equal(
      recoveredTerminalReplay.some(
        (chunk) =>
          chunk.type === "data-kestrel-status" &&
          (chunk.data as { status?: unknown })?.status === "failed",
      ),
      true,
    );

    const releaseFault = await createTurn(
      releaseFaultThreadId,
      "release-fault",
    );
    const releaseFaultNext = await createTurn(
      releaseFaultThreadId,
      "release-fault-next",
    );
    assert.ok(await store.claimDurableThreadTurn(releaseFault.turn.id));
    await appendOpenReplayScaffold(releaseFault.turn.id, "release-fault");
    await sql`
      CREATE FUNCTION "issue_235_fail_successor_release_commit"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'issue 235 successor release commit fault';
      END;
      $function$
    `;
    await sql`
      CREATE CONSTRAINT TRIGGER "issue_235_fail_successor_release_commit"
      AFTER UPDATE OF "active_turn_id" ON "thread_turn_queue_state"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (
        OLD."active_turn_id" IS DISTINCT FROM NEW."active_turn_id"
        AND NEW."active_turn_id" IS NOT NULL
      )
      EXECUTE FUNCTION "issue_235_fail_successor_release_commit"()
    `;
    await assert.rejects(
      store.completeDurableThreadTurn({
        turnId: releaseFault.turn.id,
        status: "completed",
        messages: presentation("release-fault"),
        replayChunks: terminalReplayChunks("release-fault", "completed"),
      }),
      /issue 235 successor release commit fault/u,
    );
    assert.equal(
      (await store.getDurableTurn(releaseFault.turn.id))?.status,
      "running",
    );
    assert.equal(
      (await store.getDurableTurn(releaseFaultNext.turn.id))?.status,
      "queued",
    );
    assert.deepEqual(await assistantMessageIds(releaseFault.turn.id), []);
    assert.equal(
      await store.getDurableTurnReplayBoundary(releaseFault.turn.id),
      0,
    );
    assert.deepEqual(
      (await replayChunksForTurn(releaseFault.turn.id)).map(
        (chunk) => chunk.type,
      ),
      ["start", "text-start", "data-kestrel-progress"],
    );
    await dropReleaseFault();
    await processRuntime.processDurableThreadTurn(releaseFault.turn.id, {
      retryCount: 1,
    });
    assert.equal(
      (await store.getDurableTurn(releaseFault.turn.id))?.failureCode,
      "TURN_WORKER_INTERRUPTED",
    );
    assert.deepEqual(await readQueue(releaseFaultThreadId), {
      activeTurnId: null,
      pauseReason: "turn_failed",
      state: "paused",
      version: 3,
    });
    assert.equal(
      (await store.getDurableTurn(releaseFaultNext.turn.id))?.status,
      "queued",
    );
    assert.equal((await assistantMessageIds(releaseFault.turn.id)).length, 1);
    assert.ok(
      (await store.getDurableTurnReplayBoundary(releaseFault.turn.id)) > 0,
    );
    assert.equal(
      (await replayChunksForTurn(releaseFault.turn.id)).some(
        (chunk) =>
          chunk.type === "text-delta" &&
          chunk.delta === "Outcome: release-fault",
      ),
      false,
    );

    const failed = await createTurn(failedThreadId, "failed");
    assert.ok(await store.claimDurableThreadTurn(failed.turn.id));
    const failedMessages = presentation("failed");
    await store.completeDurableThreadTurn({
      turnId: failed.turn.id,
      status: "failed",
      failureCode: "TURN_WORKER_FAILED",
      failureMessage: "The agent failed.",
      messages: failedMessages,
      replayChunks: terminalReplayChunks("failed", "failed"),
    });
    assert.deepEqual(await assistantMessageIds(failed.turn.id), [
      failedMessages[0]?.id,
    ]);
    assert.deepEqual(await eventTypes(failed.turn.id), [
      "turn.queued",
      "turn.running",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "turn.failed",
    ]);
    assert.deepEqual(await readQueue(failedThreadId), {
      activeTurnId: null,
      pauseReason: "turn_failed",
      state: "paused",
      version: 2,
    });
    const failedMobile = await mobileSnapshot.getMobileThreadSnapshot({
      threadId: failedThreadId,
      organizationId,
      userId,
    });
    assert.equal(failedMobile?.turns[0]?.status, "failed");
    assert.equal(
      failedMobile?.messages.some(
        (message) => message.id === failedMessages[0]?.id,
      ),
      true,
    );
    assert.equal(failedMobile?.queue.pauseReason, "turn_failed");

    const cancelled = await createTurn(cancelledThreadId, "cancelled");
    assert.ok(await store.claimDurableThreadTurn(cancelled.turn.id));
    const cancelledMessages = presentation("cancelled");
    await store.completeDurableThreadTurn({
      turnId: cancelled.turn.id,
      status: "cancelled",
      failureCode: "TURN_STOPPED",
      messages: cancelledMessages,
      replayChunks: terminalReplayChunks("cancelled", "cancelled"),
    });
    assert.deepEqual(await assistantMessageIds(cancelled.turn.id), [
      cancelledMessages[0]?.id,
    ]);
    assert.deepEqual(await eventTypes(cancelled.turn.id), [
      "turn.queued",
      "turn.running",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "ui.message",
      "turn.cancelled",
    ]);
    assert.deepEqual(await readQueue(cancelledThreadId), {
      activeTurnId: null,
      pauseReason: "turn_cancelled",
      state: "paused",
      version: 2,
    });
  },
);
