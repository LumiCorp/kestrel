import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";
import postgres from "postgres";
import { createModelRegistrationV2 } from "../../../../src/kestrel/contracts/model-registration";
import { withGatewayModelEconomicsProfile } from "@/lib/ai/model-economics-profile";
import { createHostedModelRegistration } from "@/lib/ai/hosted-model-registration";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

function qualifiedOpenRouterModelMetadata(input: {
  modelId: string;
  metadata: Record<string, unknown>;
}) {
  const pending = createHostedModelRegistration({
    registrationId: `email-trigger-route-registration:${input.modelId}`,
    revision: "email-trigger-route-registration-v1",
    observedAt: "2026-08-27T16:00:00.000Z",
    modelId: input.modelId,
    credentialRevision: "1",
    providerConfiguration: {
      version: "provider_runtime_configuration_v1",
      providerId: "openrouter",
      protocol: "openrouter",
      authentication: {
        mode: "required",
        credentialReference: { source: "gateway", id: "provider.openrouter.default" },
      },
      endpoint: "https://openrouter.ai/api/v1",
      timeoutMs: 15_000,
      allowedHeaders: [],
      dataHandling: "provider_managed",
    },
    providerEvidence: {
      provider: "openrouter",
      details: {
        id: input.modelId,
        supported_parameters: [
          "response_format",
          "structured_outputs",
          "tools",
          "tool_choice",
          "strict_tool_inputs",
        ],
        endpoints: [{
          id: "openrouter",
          supported_parameters: [
            "response_format",
            "structured_outputs",
            "tools",
            "tool_choice",
            "strict_tool_inputs",
          ],
        }],
      },
    },
  }).registration;
  const { fingerprint: _fingerprint, ...authoring } = pending;
  const evidence = {
    source: "qualification" as const,
    observedRevision: authoring.revision,
    observedAt: "2026-08-27T16:01:00.000Z",
    adapterRevision: authoring.adapterRevision,
    credentialRevision: "1",
    qualificationRevision: "hosted-agent-loop-v1",
    retainedPayloadHash: `sha256:${"a".repeat(64)}`,
  };
  const qualified = <T extends { evidence: readonly unknown[] }>(claim: T) => ({
    ...claim,
    state: "qualified" as const,
    evidence: [...claim.evidence, evidence],
  });
  return {
    ...input.metadata,
    kestrelModelRegistrationV2: createModelRegistrationV2({
      ...authoring,
      qualification: {
        state: "qualified",
        revision: "hosted-agent-loop-v1",
        checkedAt: "2026-08-27T16:01:00.000Z",
        probeHash: `sha256:${"b".repeat(64)}`,
      },
      capabilities: {
        ...authoring.capabilities,
        providerStrictSchema: qualified(authoring.capabilities.providerStrictSchema),
        nativeTools: qualified(authoring.capabilities.nativeTools),
        requiredToolChoice: qualified(authoring.capabilities.requiredToolChoice),
        strictToolInputs: qualified(authoring.capabilities.strictToolInputs),
      },
    }),
  };
}

test("configured Email Trigger route exports enforce private Project authority", async (context) => {
  assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;

  const [{ resetDbRuntimeForTests }, collectionRoute, itemRoute, rotateRoute] =
    await Promise.all([
      import("@/lib/db/runtime"),
      import("@/app/api/projects/[id]/email-triggers/route"),
      import("@/app/api/projects/[id]/email-triggers/[triggerId]/route"),
      import("@/app/api/projects/[id]/email-triggers/[triggerId]/rotate/route"),
    ]);
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = crypto.randomUUID();
  const now = new Date("2026-08-27T16:00:00.000Z");
  const sessionNow = new Date();
  const expiresAt = new Date(sessionNow.getTime() + 10 * 60_000);
  const ids = {
    organization: `trigger-route-org-${suffix}`,
    otherOrganization: `trigger-route-other-org-${suffix}`,
    environment: `trigger-route-environment-${suffix}`,
    otherEnvironment: `trigger-route-other-environment-${suffix}`,
    project: `trigger-route-project-${suffix}`,
    otherProject: `trigger-route-other-project-${suffix}`,
    owner: `trigger-route-owner-${suffix}`,
    editor: `trigger-route-editor-${suffix}`,
    member: `trigger-route-member-${suffix}`,
    outsider: `trigger-route-outsider-${suffix}`,
    ownerMember: `trigger-route-owner-member-${suffix}`,
    editorMember: `trigger-route-editor-member-${suffix}`,
    memberMember: `trigger-route-member-member-${suffix}`,
    outsiderMember: `trigger-route-outsider-member-${suffix}`,
    gateway: `trigger-route-gateway-${suffix}`,
    model: `trigger-route-model-${suffix}`,
    connection: `trigger-route-connection-${suffix}`,
  };
  const sessions = {
    editor: `trigger-route-editor-session-${suffix}`,
    member: `trigger-route-member-session-${suffix}`,
    outsider: `trigger-route-outsider-session-${suffix}`,
  };
  const modelMetadata = withGatewayModelEconomicsProfile({
    metadata: { context_length: 32_768, max_completion_tokens: 8192 },
    provider: "openrouter",
    model: "email-trigger-route-model",
    approved: true,
    modality: "language",
  });
  assert.ok(modelMetadata);
  const qualifiedModelMetadata = qualifiedOpenRouterModelMetadata({
    modelId: "email-trigger-route-model",
    metadata: modelMetadata,
  });

  context.after(async () => {
    await sql`DELETE FROM "organization" WHERE "id" IN (${ids.organization}, ${ids.otherOrganization})`;
    await sql`DELETE FROM "user" WHERE "id" IN (${ids.owner}, ${ids.editor}, ${ids.member}, ${ids.outsider})`;
    await resetDbRuntimeForTests();
    await sql.end({ timeout: 0 });
  });

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO "user" (
        "id", "name", "email", "emailVerified", "createdAt", "updatedAt"
      ) VALUES
        (${ids.owner}, 'Trigger Route Owner', ${`${ids.owner}@example.test`}, true, ${now}, ${now}),
        (${ids.editor}, 'Trigger Route Editor', ${`${ids.editor}@example.test`}, true, ${now}, ${now}),
        (${ids.member}, 'Trigger Route Member', ${`${ids.member}@example.test`}, true, ${now}, ${now}),
        (${ids.outsider}, 'Trigger Route Outsider', ${`${ids.outsider}@example.test`}, true, ${now}, ${now})
    `;
    await transaction`
      INSERT INTO "organization" ("id", "name", "slug", "createdAt")
      VALUES
        (${ids.organization}, 'Trigger Route Org', ${`trigger-route-org-${suffix}`}, ${now}),
        (${ids.otherOrganization}, 'Trigger Route Other Org', ${`trigger-route-other-org-${suffix}`}, ${now})
    `;
    await transaction`
      INSERT INTO "member" (
        "id", "organizationId", "userId", "role", "createdAt"
      ) VALUES
        (${ids.ownerMember}, ${ids.organization}, ${ids.owner}, 'member', ${now}),
        (${ids.editorMember}, ${ids.organization}, ${ids.editor}, 'member', ${now}),
        (${ids.memberMember}, ${ids.organization}, ${ids.member}, 'member', ${now}),
        (${ids.outsiderMember}, ${ids.otherOrganization}, ${ids.outsider}, 'member', ${now})
    `;
    await transaction`
      INSERT INTO "environments" (
        "id", "organization_id", "created_by_user_id", "name", "slug",
        "provider", "region", "status", "is_default", "created_at",
        "updated_at"
      ) VALUES
        (
          ${ids.environment}, ${ids.organization}, ${ids.editor},
          'Trigger Route Environment', 'default', 'fly', 'iad', 'ready', true,
          ${now}, ${now}
        ),
        (
          ${ids.otherEnvironment}, ${ids.otherOrganization}, ${ids.outsider},
          'Trigger Route Other Environment', 'default', 'fly', 'iad', 'ready', true,
          ${now}, ${now}
        )
    `;
    await transaction`
      INSERT INTO "projects" (
        "id", "organization_id", "environment_id", "created_by_user_id", "name"
      ) VALUES
        (${ids.project}, ${ids.organization}, ${ids.environment}, ${ids.editor}, 'Trigger Route Project'),
        (${ids.otherProject}, ${ids.otherOrganization}, ${ids.otherEnvironment}, ${ids.outsider}, 'Other Trigger Route Project')
    `;
    await transaction`
      INSERT INTO "project_members" (
        "project_id", "organization_member_id", "role"
      ) VALUES
        (${ids.project}, ${ids.ownerMember}, 'owner'),
        (${ids.project}, ${ids.editorMember}, 'editor'),
        (${ids.project}, ${ids.memberMember}, 'member'),
        (${ids.otherProject}, ${ids.outsiderMember}, 'owner')
    `;
    await transaction`
      INSERT INTO "session" (
        "id", "expiresAt", "token", "createdAt", "updatedAt", "userId",
        "activeOrganizationId"
      ) VALUES
        (${crypto.randomUUID()}, ${expiresAt}, ${sessions.editor}, ${sessionNow}, ${sessionNow}, ${ids.editor}, ${ids.organization}),
        (${crypto.randomUUID()}, ${expiresAt}, ${sessions.member}, ${sessionNow}, ${sessionNow}, ${ids.member}, ${ids.organization}),
        (${crypto.randomUUID()}, ${expiresAt}, ${sessions.outsider}, ${sessionNow}, ${sessionNow}, ${ids.outsider}, ${ids.otherOrganization})
    `;
    await transaction`
      INSERT INTO "ai_gateways" (
        "id", "organization_id", "environment_id", "provider", "display_name",
        "credential_status", "credential_validated_at"
      ) VALUES (
        ${ids.gateway}, ${ids.organization}, ${ids.environment}, 'openrouter', 'Trigger Route Gateway',
        'ready', ${now}
      )
    `;
    await transaction`
      INSERT INTO "ai_gateway_models" (
        "id", "organization_id", "gateway_id", "raw_model_id", "modality",
        "approved", "is_default", "metadata"
      ) VALUES (
        ${ids.model}, ${ids.organization}, ${ids.gateway},
        'email-trigger-route-model', 'language', true, true,
        ${transaction.json(JSON.parse(JSON.stringify(qualifiedModelMetadata)))}
      )
    `;
    await transaction`
      INSERT INTO "organization_receiving_connections" (
        "id", "organization_id", "encrypted_api_key", "credential_status",
        "credential_validated_at", "receiving_domain_id", "receiving_domain",
        "receiving_domain_status", "mx_status", "domain_checked_at",
        "route_locator", "provider_webhook_id", "encrypted_signing_secret",
        "webhook_status", "inbound_enabled", "last_health_checked_at",
        "created_at", "updated_at"
      ) VALUES (
        ${ids.connection}, ${ids.organization}, 'encrypted-key', 'full_access',
        ${now}, 'trigger-route-domain', 'inbound.example.test', 'verified',
        'verified', ${now}, ${`trigger-route-locator-${suffix}`},
        ${`trigger-route-webhook-${suffix}`}, 'encrypted-secret', 'active', true,
        ${now}, ${now}, ${now}
      )
    `;
  });

  const collectionUrl = `http://localhost/api/projects/${ids.project}/email-triggers`;
  const collectionContext = { params: Promise.resolve({ id: ids.project }) };
  const unauthenticatedGet = await collectionRoute.GET(
    asNextRequest(request(collectionUrl, "GET")),
    collectionContext,
  );
  assert.equal(unauthenticatedGet.status, 401);
  assert.deepEqual(await unauthenticatedGet.json(), { error: "Unauthorized" });

  const unauthenticatedMutations = [
    {
      name: "create",
      invoke: (candidate: Request) =>
        collectionRoute.POST(asNextRequest(candidate), collectionContext),
      url: collectionUrl,
      method: "POST",
    },
    {
      name: "update",
      invoke: (candidate: Request) =>
        itemRoute.PATCH(
          asNextRequest(candidate),
          itemContext(ids.project, "missing"),
        ),
      url: `${collectionUrl}/missing`,
      method: "PATCH",
    },
    {
      name: "delete",
      invoke: (candidate: Request) =>
        itemRoute.DELETE(
          asNextRequest(candidate),
          itemContext(ids.project, "missing"),
        ),
      url: `${collectionUrl}/missing`,
      method: "DELETE",
    },
    {
      name: "rotate",
      invoke: (candidate: Request) =>
        rotateRoute.POST(
          asNextRequest(candidate),
          itemContext(ids.project, "missing"),
        ),
      url: `${collectionUrl}/missing/rotate`,
      method: "POST",
    },
  ];
  for (const mutation of unauthenticatedMutations) {
    const tracked = trackedJsonRequest({
      url: mutation.url,
      method: mutation.method,
      body: { unauthorized: true },
    });
    const response = await mutation.invoke(tracked.request);
    assert.equal(response.status, 401, mutation.name);
    assert.deepEqual(
      await response.json(),
      { error: "Unauthorized" },
      mutation.name,
    );
    assert.equal(tracked.readCount(), 0, mutation.name);
  }

  const malformed = trackedMalformedJsonRequest({
    url: collectionUrl,
    method: "POST",
    token: sessions.editor,
  });
  const malformedResponse = await collectionRoute.POST(
    asNextRequest(malformed.request),
    collectionContext,
  );
  assert.equal(malformedResponse.status, 400);
  assert.equal(malformed.readCount(), 1);

  const createBody = {
    name: "Invoice intake",
    instruction: "Process each invoice using current Project instructions.",
    modelId: "openrouter/email-trigger-route-model",
    claimedFromFilter: "billing@example.test",
  };
  for (const smuggled of [
    { ...createBody, accessMode: "public" },
    { ...createBody, executionOwnerUserId: ids.outsider },
  ]) {
    const response = await collectionRoute.POST(
      asNextRequest(request(collectionUrl, "POST", sessions.editor, smuggled)),
      collectionContext,
    );
    assert.equal(response.status, 400);
  }
  assert.equal(await triggerCount(sql, ids.organization), 0);

  const createdResponse = await collectionRoute.POST(
    asNextRequest(request(collectionUrl, "POST", sessions.editor, createBody)),
    collectionContext,
  );
  assert.equal(createdResponse.status, 201);
  const createdBody = (await createdResponse.json()) as {
    trigger: {
      id: string;
      address: string;
      revision: number;
      enabled: boolean;
    };
  };
  const trigger = createdBody.trigger;
  assert.equal(trigger.revision, 1);
  assert.equal(trigger.enabled, true);
  assert.match(trigger.address, /^[a-f0-9]{32}@inbound\.example\.test$/u);

  const memberGet = await collectionRoute.GET(
    asNextRequest(request(collectionUrl, "GET", sessions.member)),
    collectionContext,
  );
  assert.equal(memberGet.status, 200);
  const memberBody = (await memberGet.json()) as {
    triggers: Array<{ id: string; address: string }>;
  };
  assert.equal(memberBody.triggers[0]?.id, trigger.id);
  assert.equal(memberBody.triggers[0]?.address, trigger.address);

  const outsiderGet = await collectionRoute.GET(
    asNextRequest(request(collectionUrl, "GET", sessions.outsider)),
    collectionContext,
  );
  assert.equal(outsiderGet.status, 404);
  assert.doesNotMatch(
    JSON.stringify(await outsiderGet.json()),
    new RegExp(trigger.address, "u"),
  );

  const triggerUrl = `${collectionUrl}/${trigger.id}`;
  const triggerContext = itemContext(ids.project, trigger.id);
  const memberMutations = [
    () =>
      collectionRoute.POST(
        asNextRequest(
          request(collectionUrl, "POST", sessions.member, createBody),
        ),
        collectionContext,
      ),
    () =>
      itemRoute.PATCH(
        asNextRequest(
          request(triggerUrl, "PATCH", sessions.member, {
            expectedRevision: 1,
            name: "Member rewrite",
          }),
        ),
        triggerContext,
      ),
    () =>
      rotateRoute.POST(
        asNextRequest(
          request(`${triggerUrl}/rotate`, "POST", sessions.member, {
            expectedRevision: 1,
          }),
        ),
        triggerContext,
      ),
    () =>
      itemRoute.DELETE(
        asNextRequest(
          request(triggerUrl, "DELETE", sessions.member, {
            expectedRevision: 1,
          }),
        ),
        triggerContext,
      ),
  ];
  for (const mutate of memberMutations) {
    assert.equal((await mutate()).status, 403);
  }
  assert.deepEqual(await triggerState(sql, trigger.id), {
    enabled: true,
    revision: 1,
    deleted: false,
  });

  const crossOrganizationPatch = await itemRoute.PATCH(
    asNextRequest(
      request(triggerUrl, "PATCH", sessions.outsider, {
        expectedRevision: 1,
        name: "Cross-Organization rewrite",
      }),
    ),
    triggerContext,
  );
  assert.equal(crossOrganizationPatch.status, 404);
  assert.doesNotMatch(
    JSON.stringify(await crossOrganizationPatch.json()),
    new RegExp(trigger.address, "u"),
  );

  const strictItemAttempts = [
    () =>
      itemRoute.PATCH(
        asNextRequest(
          request(triggerUrl, "PATCH", sessions.editor, {
            expectedRevision: 1,
            accessMode: "public",
          }),
        ),
        triggerContext,
      ),
    () =>
      itemRoute.PATCH(
        asNextRequest(
          request(triggerUrl, "PATCH", sessions.editor, {
            expectedRevision: 1,
            executionOwnerUserId: ids.outsider,
          }),
        ),
        triggerContext,
      ),
    () =>
      rotateRoute.POST(
        asNextRequest(
          request(`${triggerUrl}/rotate`, "POST", sessions.editor, {
            expectedRevision: 1,
            accessMode: "public",
          }),
        ),
        triggerContext,
      ),
    () =>
      itemRoute.DELETE(
        asNextRequest(
          request(triggerUrl, "DELETE", sessions.editor, {
            expectedRevision: 1,
            executionOwnerUserId: ids.outsider,
          }),
        ),
        triggerContext,
      ),
  ];
  for (const attempt of strictItemAttempts) {
    assert.equal((await attempt()).status, 400);
  }
  assert.deepEqual(await triggerState(sql, trigger.id), {
    enabled: true,
    revision: 1,
    deleted: false,
  });

  const updatedResponse = await itemRoute.PATCH(
    asNextRequest(
      request(triggerUrl, "PATCH", sessions.editor, {
        expectedRevision: 1,
        instruction: "Use the revised Project invoice process.",
      }),
    ),
    triggerContext,
  );
  assert.equal(updatedResponse.status, 200);
  assert.equal(
    ((await updatedResponse.json()) as { trigger: { revision: number } })
      .trigger.revision,
    2,
  );

  const stalePatch = await itemRoute.PATCH(
    asNextRequest(
      request(triggerUrl, "PATCH", sessions.editor, {
        expectedRevision: 1,
        name: "Stale update",
      }),
    ),
    triggerContext,
  );
  await assertConflict(stalePatch);

  const rotatedResponse = await rotateRoute.POST(
    asNextRequest(
      request(`${triggerUrl}/rotate`, "POST", sessions.editor, {
        expectedRevision: 2,
      }),
    ),
    triggerContext,
  );
  assert.equal(rotatedResponse.status, 200);
  const rotatedBody = (await rotatedResponse.json()) as {
    trigger: { address: string; revision: number };
  };
  assert.equal(rotatedBody.trigger.revision, 3);
  assert.notEqual(rotatedBody.trigger.address, trigger.address);

  const staleRotate = await rotateRoute.POST(
    asNextRequest(
      request(`${triggerUrl}/rotate`, "POST", sessions.editor, {
        expectedRevision: 2,
      }),
    ),
    triggerContext,
  );
  await assertConflict(staleRotate);

  const staleDelete = await itemRoute.DELETE(
    asNextRequest(
      request(triggerUrl, "DELETE", sessions.editor, {
        expectedRevision: 2,
      }),
    ),
    triggerContext,
  );
  await assertConflict(staleDelete);

  const deletedResponse = await itemRoute.DELETE(
    asNextRequest(
      request(triggerUrl, "DELETE", sessions.editor, {
        expectedRevision: 3,
      }),
    ),
    triggerContext,
  );
  assert.equal(deletedResponse.status, 200);
  assert.deepEqual(await deletedResponse.json(), { success: true });
  assert.deepEqual(await triggerState(sql, trigger.id), {
    enabled: false,
    revision: 4,
    deleted: true,
  });
  const memberAfterDelete = await collectionRoute.GET(
    asNextRequest(request(collectionUrl, "GET", sessions.member)),
    collectionContext,
  );
  assert.equal(memberAfterDelete.status, 200);
  assert.deepEqual(await memberAfterDelete.json(), { triggers: [] });
});

function request(url: string, method: string, token?: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function trackedJsonRequest(input: {
  url: string;
  method: string;
  body: unknown;
  token?: string;
}) {
  const candidate = request(input.url, input.method, input.token, input.body);
  let reads = 0;
  candidate.json = async () => {
    reads += 1;
    return input.body;
  };
  return { request: candidate, readCount: () => reads };
}

function trackedMalformedJsonRequest(input: {
  url: string;
  method: string;
  token: string;
}) {
  const candidate = request(input.url, input.method, input.token, {});
  let reads = 0;
  candidate.json = async () => {
    reads += 1;
    throw new SyntaxError("Malformed JSON body.");
  };
  return { request: candidate, readCount: () => reads };
}

function asNextRequest(candidate: Request) {
  return candidate as NextRequest;
}

function itemContext(projectId: string, triggerId: string) {
  return { params: Promise.resolve({ id: projectId, triggerId }) };
}

async function triggerCount(sql: postgres.Sql, organizationId: string) {
  const [row] = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS "count"
    FROM "project_email_triggers"
    WHERE "organization_id" = ${organizationId}
  `;
  return row?.count ?? 0;
}

async function triggerState(sql: postgres.Sql, triggerId: string) {
  const [row] = await sql<
    Array<{ enabled: boolean; revision: number; deleted: boolean }>
  >`
    SELECT "enabled", "revision", "deleted_at" IS NOT NULL AS "deleted"
    FROM "project_email_triggers"
    WHERE "id" = ${triggerId}
  `;
  return row;
}

async function assertConflict(response: Response) {
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "The Email Trigger changed. Refresh it and try again.",
  });
}
