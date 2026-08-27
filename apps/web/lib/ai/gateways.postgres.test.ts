import test from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { translateOpenAiManifestModel } from "../../../../models/openai/OpenAiModelManifest";
import { createModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration";
import { withGatewayModelEconomicsProfile } from "./model-economics-profile";
import { qualifyHostedAgentLoopModel } from "./hosted-model-qualification";

const qualificationRunner: typeof qualifyHostedAgentLoopModel = async (input) =>
  qualifyHostedAgentLoopModel({
    ...input,
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const hasTools = Array.isArray(payload.tools);
      return new Response(
        JSON.stringify({
          id: "resp_qualification",
          model: input.registration.modelId,
          status: "completed",
          output: hasTools
            ? [{
                type: "function_call",
                call_id: "call_qualification",
                name: "probe_tool",
                arguments: "{}",
              }]
            : [{
                type: "message",
                content: [{ type: "output_text", text: '{"ok":true}' }],
              }],
        }),
        { status: 200 },
      );
    },
  });

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

function qualifiedOpenAiRegistration() {
  const pending = translateOpenAiManifestModel({
    registrationId: "registration:gpt-4.1-mini",
    revision: "registration-revision-1",
    modelId: "gpt-4.1-mini",
    endpoint: "responses",
    credentialRevision: "1",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openai",
      protocol: "openai",
      authentication: {
        mode: "required",
        credentialReference: { source: "gateway", id: "provider.openai.default" },
      },
      endpoint: "https://api.openai.com/v1",
      timeoutMs: 60_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
  });
  const { fingerprint: _fingerprint, ...authoring } = pending;
  const evidence = {
    source: "qualification" as const,
    observedRevision: authoring.revision,
    observedAt: "2026-08-26T00:00:00.000Z",
    adapterRevision: authoring.adapterRevision,
    credentialRevision: "1",
    qualificationRevision: "qualification-revision-1",
    retainedPayloadHash: `sha256:${"a".repeat(64)}`,
  };
  const qualified = <T extends { evidence: readonly unknown[] }>(claim: T) => ({
    ...claim,
    state: "qualified" as const,
    evidence: [...claim.evidence, evidence],
  });
  return createModelRegistrationV2({
    ...authoring,
    qualification: {
      state: "qualified",
      revision: "qualification-revision-1",
      checkedAt: "2026-08-26T00:00:00.000Z",
      probeHash: `sha256:${"b".repeat(64)}`,
    },
    capabilities: {
      ...authoring.capabilities,
      providerStrictSchema: qualified(authoring.capabilities.providerStrictSchema),
      nativeTools: qualified(authoring.capabilities.nativeTools),
      requiredToolChoice: qualified(authoring.capabilities.requiredToolChoice),
      strictToolInputs: qualified(authoring.capabilities.strictToolInputs),
    },
  });
}

test("hosted registration evidence commits with economics and default intent or rolls back together", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [{ resetDbRuntimeForTests }, { saveGatewayModel }] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./gateways"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const organizationId = `registration-org-${suffix}`;
  const gatewayId = `registration-gateway-${suffix}`;
  const now = new Date();
  const metadata = withGatewayModelEconomicsProfile({
    metadata: {
      context_length: 32_768,
      max_completion_tokens: 8_192,
      kestrelModelRegistrationV2: { browser: "must-not-persist" },
    },
    provider: "openai",
    model: "gpt-4.1-mini",
    approved: true,
    modality: "language",
  });
  assert.ok(metadata);

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });
  await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'Registration Org', ${`registration-${suffix}`}, ${now})
    `;
  await sql`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "provider", "display_name", "credential_revision",
        "credential_status", "credential_validated_at"
      ) VALUES (
        ${gatewayId}, ${organizationId}, 'openai', 'Registration Gateway', 4,
        'ready', now()
      )
    `;

  const saved = await saveGatewayModel({
    organizationId,
    gatewayId,
    rawModelId: "gpt-4.1-mini",
    modality: "language",
    approved: true,
    isDefault: true,
    metadata,
    providerEvidence: {
      provider: "openai",
      catalogRecord: { id: "gpt-4.1-mini" },
    },
    qualificationRunner,
  });
  const [persisted] = await sql<
    Array<{ metadata: Record<string, unknown>; isDefault: boolean }>
  >`
      SELECT "metadata", "is_default" AS "isDefault"
      FROM "ai_gateway_models"
      WHERE "id" = ${saved.id}
    `;
  assert.equal(persisted?.isDefault, true);
  assert.equal(
    (persisted?.metadata.kestrelModelRegistrationV2 as { modelId: string })
      .modelId,
    "gpt-4.1-mini",
  );
  assert.equal(
    (
      persisted?.metadata.kestrelModelQualificationProjectionV1 as {
        state: string;
      }
    ).state,
    "qualified",
  );
  assert.notEqual(
    (persisted?.metadata.kestrelModelRegistrationV2 as { browser?: string })
      .browser,
    "must-not-persist",
  );

  const refreshed = await saveGatewayModel({
    organizationId,
    id: saved.id,
    gatewayId,
    rawModelId: "gpt-4.1-mini",
    modality: "language",
    approved: true,
    isDefault: true,
    metadata: {
      ...metadata,
      kestrelModelRegistrationV2: { browser: "must-not-replace-server-proof" },
    },
    preserveHostedRegistration: true,
  });
  assert.equal(refreshed.id, saved.id);
  const [preserved] = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT "metadata"
      FROM "ai_gateway_models"
      WHERE "id" = ${saved.id}
    `;
  assert.equal(
    (
      preserved?.metadata.kestrelModelRegistrationV2 as {
        fingerprint: string;
      }
    ).fingerprint,
    (persisted?.metadata.kestrelModelRegistrationV2 as { fingerprint: string })
      .fingerprint,
  );

  await assert.rejects(
    saveGatewayModel({
      organizationId,
      id: saved.id,
      gatewayId,
      rawModelId: "gpt-4.1-mini",
      modality: "language",
      approved: true,
      isDefault: true,
      metadata,
      providerEvidence: {
        provider: "openai",
        catalogRecord: { id: "gpt-other" },
      },
    }),
    /does not match the requested exact model identity/u,
  );
  await assert.rejects(
    saveGatewayModel({
      organizationId,
      id: saved.id,
      gatewayId,
      rawModelId: "gpt-4.1-mini",
      modality: "language",
      approved: true,
      isDefault: true,
      metadata,
      expectedModelUpdatedAt: new Date(0),
      providerEvidence: {
        provider: "openai",
        catalogRecord: { id: "gpt-4.1-mini" },
      },
      qualificationRunner,
    }),
    /changed while provider evidence was resolving/u,
  );
  const [afterFailures] = await sql<Array<{ id: string }>>`
      SELECT "id"
      FROM "ai_gateway_models"
      WHERE "organization_id" = ${organizationId} AND "is_default" = true
    `;
  assert.equal(afterFailures?.id, saved.id);
});

test("default model assignment is atomic and serialized per organization modality", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;

  const [{ resetDbRuntimeForTests }, { saveGatewayModel }] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./gateways"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const organizationId = `default-model-org-${suffix}`;
  const gatewayId = `default-model-gateway-${suffix}`;
  const modelAId = `default-model-a-${suffix}`;
  const modelBId = `default-model-b-${suffix}`;
  const now = new Date();
  const modelAMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8_192 },
    provider: "openai",
    model: "model-a",
    approved: true,
    modality: "language",
  });
  const modelBMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8_192 },
    provider: "openai",
    model: "model-b",
    approved: true,
    modality: "language",
  });
  assert.ok(modelAMetadata);
  assert.ok(modelBMetadata);

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Default Model Org', ${`default-model-${suffix}`}, ${now})
      `;
    await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "provider", "display_name"
        ) VALUES (
          ${gatewayId}, ${organizationId}, 'lumi', 'Default Model Gateway'
        )
      `;
    await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality",
          "approved", "is_default", "metadata"
        ) VALUES
          (${modelAId}, ${organizationId}, ${gatewayId}, 'model-a', 'language', true, true, ${transaction.json(JSON.parse(JSON.stringify(modelAMetadata)))}),
          (${modelBId}, ${organizationId}, ${gatewayId}, 'model-b', 'language', true, false, ${transaction.json(JSON.parse(JSON.stringify(modelBMetadata)))})
      `;
  });

  await assert.rejects(
    saveGatewayModel({
      organizationId,
      id: `missing-${suffix}`,
      gatewayId,
      rawModelId: "missing-model",
      modality: "language",
      approved: true,
      isDefault: true,
    }),
    /Gateway model not found/u,
  );
  const [afterStaleWrite] = await sql<
    Array<{ id: string }>
  >`SELECT "id" FROM "ai_gateway_models" WHERE "organization_id" = ${organizationId} AND "is_default" = true`;
  assert.equal(afterStaleWrite?.id, modelAId);

  await Promise.all([
    saveGatewayModel({
      organizationId,
      id: modelAId,
      gatewayId,
      rawModelId: "model-a",
      modality: "language",
      approved: true,
      isDefault: true,
      metadata: modelAMetadata,
    }),
    saveGatewayModel({
      organizationId,
      id: modelBId,
      gatewayId,
      rawModelId: "model-b",
      modality: "language",
      approved: true,
      isDefault: true,
      metadata: modelBMetadata,
    }),
  ]);

  const defaults = await sql<Array<{ id: string }>>`
      SELECT "id"
      FROM "ai_gateway_models"
      WHERE "organization_id" = ${organizationId}
        AND "modality" = 'language'
        AND "is_default" = true
    `;
  assert.equal(defaults.length, 1);
  assert.ok([modelAId, modelBId].includes(defaults[0]?.id ?? ""));
});

test("gateway credential health is revision guarded across sync outcomes", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const previousKeyId = process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID;
  const previousKeys = process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS;
  const previousFetch = globalThis.fetch;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    test: Buffer.alloc(32, 23).toString("base64"),
  });
  const [
    { resetDbRuntimeForTests },
    { createGateway, syncGatewayModels, updateGateway },
  ] = await Promise.all([import("@/lib/db/runtime"), import("./gateways")]);
  const sql = postgres(databaseUrl, { max: 2 });
  const suffix = crypto.randomUUID();
  const organizationId = `credential-health-org-${suffix}`;
  const now = new Date();

  context.after(async () => {
    globalThis.fetch = previousFetch;
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    if (previousKeyId === undefined) {
      Reflect.deleteProperty(
        process.env,
        "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
      );
    } else {
      process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = previousKeyId;
    }
    if (previousKeys === undefined) {
      Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_KEYS");
    } else {
      process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = previousKeys;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (
        ${organizationId}, 'Credential Health Org',
        ${`credential-health-${suffix}`}, ${now}
      )
    `;
  const gateway = await createGateway({
    organizationId,
    provider: "openai",
    apiKey: "first-secret",
  });
  assert.equal(gateway.credentialStatus, "unverified");
  assert.equal(gateway.credentialRevision, 1);

  globalThis.fetch = (async () =>
    new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    syncGatewayModels(organizationId, gateway.id),
    /Gateway model sync failed \(401\)/u,
  );
  const readHealth = async () => {
    const [health] = await sql<
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
        WHERE "id" = ${gateway.id}
      `;
    return health;
  };
  assert.deepEqual(await readHealth(), {
    credentialStatus: "invalid",
    credentialValidatedAt: null,
    credentialRevision: 1,
  });

  await updateGateway(organizationId, gateway.id, {
    apiKey: "second-secret",
  });
  let resolveFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => {
    resolveFetchStarted = resolve;
  });
  let resolveStaleFetch!: (response: Response) => void;
  const staleFetch = new Promise<Response>((resolve) => {
    resolveStaleFetch = resolve;
  });
  globalThis.fetch = (async () => {
    resolveFetchStarted();
    return staleFetch;
  }) as unknown as typeof fetch;
  const staleSync = syncGatewayModels(organizationId, gateway.id);
  await fetchStarted;
  await updateGateway(organizationId, gateway.id, {
    apiKey: "third-secret",
  });
  resolveStaleFetch(
    Response.json({ data: [{ id: "gpt-test", object: "model" }] }),
  );
  await assert.rejects(staleSync, /credential changed during model sync/u);
  assert.deepEqual(await readHealth(), {
    credentialStatus: "unverified",
    credentialValidatedAt: null,
    credentialRevision: 3,
  });

  globalThis.fetch = (async () =>
    new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(
    syncGatewayModels(organizationId, gateway.id),
    /Gateway model sync failed \(503\)/u,
  );
  assert.deepEqual(await readHealth(), {
    credentialStatus: "unverified",
    credentialValidatedAt: null,
    credentialRevision: 3,
  });

  globalThis.fetch = (async () =>
    Response.json({
      data: [{ id: "gpt-test", object: "model" }],
    })) as unknown as typeof fetch;
  await syncGatewayModels(organizationId, gateway.id);
  const ready = await readHealth();
  assert.equal(ready?.credentialStatus, "ready");
  assert.ok(ready?.credentialValidatedAt instanceof Date);
  assert.equal(ready?.credentialRevision, 3);
});

test("closed model grants retain evidence while live gateway resources are deleted", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const [
    { resetDbRuntimeForTests },
    { deleteGateway },
    { activateEnvironmentModelGrant },
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./gateways"),
    import("@/lib/environments/execution-route"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const organizationId = `grant-org-${suffix}`;
  const userId = `grant-user-${suffix}`;
  const environmentId = `grant-environment-${suffix}`;
  const workspaceId = `grant-workspace-${suffix}`;
  const threadId = `grant-thread-${suffix}`;
  const executionId = `grant-execution-${suffix}`;
  const gatewayId = `grant-gateway-${suffix}`;
  const modelId = `grant-model-${suffix}`;
  const otherModelId = `grant-other-model-${suffix}`;
  const now = new Date();
  const modelMetadata = {
    kestrelModelRegistrationV2: qualifiedOpenAiRegistration(),
  };
  const routeBinding = {
    version: "model_credential_route_binding_v2" as const,
    status: "qualified" as const,
    provider: "openai" as const,
    rawModelId: "gpt-4.1-mini",
    registrationId: "registration:gpt-4.1-mini",
    registrationRevision: "registration-revision-1",
    registrationFingerprint: `sha256:${"a".repeat(64)}`,
    qualificationRevision: "qualification-revision-1",
    apiEndpoint: "https://api.openai.com/v1",
    endpointCodec: "openai.responses.v2",
    routingPolicyFingerprint: `sha256:${"b".repeat(64)}`,
    requiredRole: "agent.loop",
    credentialRevision: 1,
  };

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
          ${userId}, 'Grant User', ${`${userId}@example.test`}, true, ${now}, ${now}
        )
      `;
    await transaction`
        INSERT INTO "organization" ("id", "name", "slug", "createdAt")
        VALUES (${organizationId}, 'Grant Org', ${`grant-org-${suffix}`}, ${now})
      `;
    await transaction`
        INSERT INTO "environments" (
          "id", "organization_id", "created_by_user_id", "name", "slug",
          "region", "status", "is_default"
        ) VALUES (
          ${environmentId}, ${organizationId}, ${userId}, 'Grant Environment',
          'grant', 'iad', 'ready', true
        )
      `;
    await transaction`
        INSERT INTO "threads" (
          "id", "title", "created_by_user_id", "organization_id", "origin"
        ) VALUES (${threadId}, 'Grant Thread', ${userId}, ${organizationId}, 'web')
      `;
    await transaction`
        INSERT INTO "environment_workspaces" (
          "id", "organization_id", "environment_id", "personal_owner_user_id",
          "created_by_user_id", "name", "kind", "status", "runtime_image"
        ) VALUES (
          ${workspaceId}, ${organizationId}, ${environmentId}, ${userId},
          ${userId}, 'Grant Workspace', 'scratch', 'ready', 'runtime:test'
        )
      `;
    await transaction`
        INSERT INTO "ai_gateways" (
          "id", "organization_id", "environment_id", "provider", "display_name",
          "api_key", "credential_status", "credential_validated_at"
        ) VALUES (
          ${gatewayId}, ${organizationId}, ${environmentId}, 'openai', 'Grant Gateway',
          'encrypted-test-key', 'ready', now()
        )
      `;
    await transaction`
        INSERT INTO "ai_gateway_models" (
          "id", "organization_id", "gateway_id", "raw_model_id", "modality", "approved", "metadata"
        ) VALUES
          (${modelId}, ${organizationId}, ${gatewayId}, 'gpt-4.1-mini', 'language', true, ${JSON.stringify(modelMetadata)}::jsonb),
          (${otherModelId}, ${organizationId}, ${gatewayId}, 'grant-other-model', 'language', false, '{}'::jsonb)
      `;
    await transaction`
        INSERT INTO "environment_run_executions" (
          "id", "organization_id", "environment_id", "workspace_id", "thread_id",
          "actor_id", "runtime_image", "effective_capabilities", "status"
        ) VALUES (
          ${executionId}, ${organizationId}, ${environmentId}, ${workspaceId},
          ${threadId}, ${userId}, 'runtime:test', '[]'::jsonb, 'running'
        )
      `;
  });
  await activateEnvironmentModelGrant({
    organizationId,
    environmentId,
    workspaceId,
    threadId,
    runId: executionId,
    gatewayId,
    rawModelId: "gpt-4.1-mini",
    routeBinding,
  });

  await assert.rejects(
    deleteGateway(organizationId, gatewayId),
    /active Environment execution/u,
  );
  await sql`
      UPDATE "environment_model_grants"
      SET "status" = 'closed', "closed_at" = now()
      WHERE "run_id" = ${executionId}
    `;
  await assert.rejects(
    activateEnvironmentModelGrant({
      organizationId,
      environmentId,
      workspaceId,
      threadId,
      runId: executionId,
      gatewayId,
      rawModelId: "grant-other-model",
    }),
    /historical model identity is immutable/u,
  );
  await activateEnvironmentModelGrant({
    organizationId,
    environmentId,
    workspaceId,
    threadId,
    runId: executionId,
    gatewayId,
    rawModelId: "gpt-4.1-mini",
    routeBinding,
  });
  const [reactivated] = await sql<
    Array<{
      gatewayModelId: string | null;
      gatewayCredentialRevision: number | null;
      routeBindingStatus: string | null;
      modelRegistrationRevision: string | null;
      modelQualificationRevision: string | null;
      modelEndpointCodec: string | null;
      status: string;
    }>
  >`
      SELECT "gateway_model_id" AS "gatewayModelId",
        "gateway_credential_revision" AS "gatewayCredentialRevision",
        "route_binding_status" AS "routeBindingStatus",
        "model_registration_revision" AS "modelRegistrationRevision",
        "model_qualification_revision" AS "modelQualificationRevision",
        "model_endpoint_codec" AS "modelEndpointCodec", "status"
      FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
  assert.deepEqual(reactivated, {
    gatewayModelId: modelId,
    gatewayCredentialRevision: 1,
    routeBindingStatus: "qualified",
    modelRegistrationRevision: "registration-revision-1",
    modelQualificationRevision: "qualification-revision-1",
    modelEndpointCodec: "openai.responses.v2",
    status: "active",
  });
  await sql`
      UPDATE "environment_model_grants"
      SET "status" = 'closed', "closed_at" = now()
      WHERE "run_id" = ${executionId}
    `;
  assert.equal((await deleteGateway(organizationId, gatewayId))?.id, gatewayId);
  const [preserved] = await sql<
    Array<{
      gatewayId: string;
      rawModelId: string;
      gatewayModelId: string | null;
      status: string;
    }>
  >`
      SELECT "gateway_id" AS "gatewayId", "raw_model_id" AS "rawModelId",
        "gateway_model_id" AS "gatewayModelId", "status"
      FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
  assert.deepEqual(preserved, {
    gatewayId,
    rawModelId: "gpt-4.1-mini",
    gatewayModelId: null,
    status: "closed",
  });
  await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
  const [remaining] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS "count" FROM "environment_model_grants"
      WHERE "run_id" = ${executionId}
    `;
  assert.equal(remaining?.count, 0);
});

test("recorded RunPod cleanup connections remain usable after disablement", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  const previousKeyId = process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID;
  const previousKeys = process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS;
  process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = "test";
  process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = JSON.stringify({
    test: Buffer.alloc(32, 19).toString("base64"),
  });
  const [
    { resetDbRuntimeForTests },
    { encryptGatewayCredential },
    { createRunPodControlPlaneClientByConnectionId },
  ] = await Promise.all([
    import("@/lib/db/runtime"),
    import("./gateway-credential-crypto"),
    import("./managed-runpod-connection"),
  ]);
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = crypto.randomUUID();
  const organizationId = `runpod-cleanup-org-${suffix}`;
  const connectionId = `runpod-cleanup-connection-${suffix}`;
  const now = new Date();

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" = ${organizationId}`;
    if (previousKeyId === undefined) {
      Reflect.deleteProperty(
        process.env,
        "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
      );
    } else {
      process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID = previousKeyId;
    }
    if (previousKeys === undefined) {
      Reflect.deleteProperty(process.env, "KESTREL_GATEWAY_CREDENTIAL_KEYS");
    } else {
      process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS = previousKeys;
    }
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });
  await sql`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES (${organizationId}, 'RunPod Cleanup Org', ${`runpod-cleanup-${suffix}`}, ${now})
    `;
  await sql`
      INSERT INTO "ai_provider_connections" (
        "id", "organization_id", "provider", "scope", "display_name",
        "api_key", "enabled", "status"
      ) VALUES (
        ${connectionId}, ${organizationId}, 'runpod', 'organization', 'RunPod',
        ${encryptGatewayCredential({
          gatewayId: connectionId,
          plaintext: "runpod-cleanup-secret",
        })}, false, 'ready'
      )
    `;
  await assert.rejects(
    createRunPodControlPlaneClientByConnectionId({ connectionId }),
    /disabled/u,
  );
  let authorization: string | null = null;
  const { client } = await createRunPodControlPlaneClientByConnectionId({
    connectionId,
    allowDisabledForCleanup: true,
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json([]);
    },
  });
  await client.listEndpoints();
  assert.equal(authorization, "Bearer runpod-cleanup-secret");
});
