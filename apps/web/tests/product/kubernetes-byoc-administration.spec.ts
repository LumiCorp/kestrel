import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { generateConnectorCredentialEncryptionKeyPair } from "@lumi/kestrel-environment-auth";
import postgres from "postgres";
import {
  KUBERNETES_QUALIFICATION_CHECK_IDS,
  kubernetesConnectionInfrastructureRevision,
} from "../../lib/environments/kubernetes-connector-contracts";
import { installTestStableRuntimeBundle } from "../../lib/environments/test-runtime-channel";

const databaseUrl = process.env.KESTREL_PRODUCT_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("KESTREL_PRODUCT_DATABASE_URL is required for product tests.");
}

const sql = postgres(databaseUrl, { max: 1 });
const suffix = randomUUID();
const environmentName = `BYOC product ${suffix.slice(0, 8)}`;
let organizationId = "";
let userId = "";
let connectionId = "";
let environmentId = "";
let restoreRuntime: (() => Promise<void>) | undefined;

test.setTimeout(120_000);

test.beforeAll(async () => {
  const [admin] = await sql<
    Array<{ organizationId: string; userId: string }>
  >`
    SELECT member."organizationId" AS "organizationId", "user".id AS "userId"
    FROM member
    INNER JOIN "user" ON "user".id = member."userId"
    WHERE "user".email = 'admin@dev.local' AND member.role = 'admin'
    LIMIT 1
  `;
  if (!admin) throw new Error("The product fixture administrator is unavailable.");
  organizationId = admin.organizationId;
  userId = admin.userId;
  restoreRuntime = await installTestStableRuntimeBundle(databaseUrl, suffix);
  await sql`
    INSERT INTO organization_feature_flags (
      organization_id, key, enabled, updated_by_user_id
    ) VALUES (${organizationId}, 'hosted_environments', true, ${userId})
    ON CONFLICT (organization_id, key) DO UPDATE SET
      enabled = true,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
  `;
});

test.afterAll(async () => {
  if (connectionId) {
    await sql`
      DELETE FROM environments WHERE provider_connection_id = ${connectionId}
    `;
  }
  if (environmentId) {
    await sql`DELETE FROM environments WHERE id = ${environmentId}`;
  }
  if (connectionId) {
    await sql`
      DELETE FROM environment_provider_connections
      WHERE id = ${connectionId}
    `;
  }
  await sql`
    DELETE FROM infrastructure_connector_enrollment_requests
    WHERE cluster_metadata ->> 'identityId' = ${`product-${suffix}`}
  `;
  await sql`
    DELETE FROM admin_event_logs
    WHERE organization_id = ${organizationId}
      AND created_at >= now() - interval '20 minutes'
      AND (
        target_id = ${connectionId || "none"}
        OR target_id = ${environmentId || "none"}
        OR action = 'kubernetes_byoc.rollout.updated'
      )
  `;
  await sql`
    DELETE FROM organization_feature_flags
    WHERE organization_id = ${organizationId} AND key = 'kubernetes_byoc'
  `;
  await restoreRuntime?.();
  await sql.end({ timeout: 0 });
});

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(response.ok()).toBe(true);
});

test("organization admin completes the Kubernetes BYOC administration lifecycle", async ({
  page,
  request,
}) => {
  await page.goto("/organization/connections");
  await expect(
    page.getByRole("heading", { name: "Infrastructure connections" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Enable pre-release" }).click();
  await expect(page.getByText("Kubernetes BYOC enabled.")).toBeVisible();

  const signing = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const encryption = generateConnectorCredentialEncryptionKeyPair();
  const enrollmentResponse = await request.post(
    "/api/runtime/infrastructure-connectors/enrollments",
    {
      data: {
        connectorName: `Product cluster ${suffix.slice(0, 8)}`,
        connectorVersion: "0.8.0-product",
        signingPublicKey: signing.publicKey,
        encryptionPublicKey: encryption.publicKey,
        commandVersions: ["infrastructure-connector-command-v1"],
        resultVersions: ["infrastructure-connector-result-v1"],
        clusterMetadata: { identityId: `product-${suffix}` },
      },
    },
  );
  expect(enrollmentResponse.status()).toBe(201);
  const enrollment = (await enrollmentResponse.json()) as {
    requestId: string;
    requestSecret: string;
    fingerprint: string;
    verificationPath: string;
  };

  await page.goto(enrollment.verificationPath);
  await expect(page.getByText(enrollment.fingerprint)).toBeVisible();
  const approve = page.getByRole("button", {
    name: "Approve matching fingerprint",
  });
  await expect(approve).toBeDisabled();
  await page.getByLabel("Fingerprint from Helm").fill(enrollment.fingerprint);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page).toHaveURL(/\/organization\/connections$/u);

  const consumeResponse = await request.get(
    `/api/runtime/infrastructure-connectors/enrollments/${enrollment.requestId}`,
    { headers: { "x-kestrel-enrollment-secret": enrollment.requestSecret } },
  );
  expect(consumeResponse.ok()).toBe(true);
  const consumed = (await consumeResponse.json()) as { connectionId: string };
  connectionId = consumed.connectionId;
  const [connectionScope] = await sql<Array<{ organizationId: string }>>`
    SELECT organization_id AS "organizationId"
    FROM environment_provider_connections WHERE id = ${connectionId}
  `;
  if (!connectionScope) throw new Error("Connector organization is unavailable.");
  organizationId = connectionScope.organizationId;
  await sql`
    INSERT INTO organization_feature_flags (
      organization_id, key, enabled, updated_by_user_id
    ) VALUES (${organizationId}, 'hosted_environments', true, ${userId})
    ON CONFLICT (organization_id, key) DO UPDATE SET
      enabled = true,
      updated_by_user_id = EXCLUDED.updated_by_user_id,
      updated_at = now()
  `;
  await sql`
    UPDATE infrastructure_connector_connections
    SET last_seen_at = now(), updated_at = now()
    WHERE provider_connection_id = ${connectionId}
  `;

  await page.reload();
  await expect(page.getByText("Configuration: required")).toBeVisible();
  await page.getByText("Connection configuration").click();
  await page.getByLabel("Display name").fill("Product cluster");
  await page.getByLabel("Namespace prefix").fill("kestrel");
  await page.getByLabel("Qualified base domain").fill("byoc.example.test");
  await page.getByLabel("StorageClass").fill("standard-rwo");
  await page.getByLabel("VolumeSnapshotClass").fill("snapshots");
  await page.getByLabel("Controller namespace").fill("ingress-system");
  await page
    .getByLabel("Controller selector (key=value)")
    .fill("app=ingress-controller");
  await page.getByLabel("Compute profile").fill("managed");
  await page.getByLabel("NetworkPolicy provider").fill("calico");
  await page.getByLabel("Storage CSI driver").fill("csi.example.test");
  await page.getByLabel("Snapshot CSI driver").fill("csi.example.test");
  await page.getByLabel("Edge controller").fill("nginx");
  await page
    .getByLabel("Runtime templates (comma-separated)")
    .fill("kestrel-standard-v1");
  await page
    .getByLabel("Qualification image digest")
    .fill(`example/probe@sha256:${"a".repeat(64)}`);
  await page
    .getByLabel("Attestation evidence note")
    .fill("Product test administrator attestation.");
  await page.getByLabel("Edge mode").selectOption("ingress");
  await page.getByLabel("Ingress class name").fill("nginx");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(
    page.getByText("Kubernetes connection configuration saved."),
  ).toBeVisible();
  await expect(page.getByText("Configuration: editable")).toBeVisible();

  await page.getByRole("button", { name: "Qualify" }).click();
  await expect(page.getByText("Qualification started.")).toBeVisible();
  const [qualification] = await sql<
    Array<{ commandId: string; configRevision: string; runId: string }>
  >`
    SELECT id AS "runId", command_id AS "commandId",
      config_revision AS "configRevision"
    FROM infrastructure_connector_qualification_runs
    WHERE provider_connection_id = ${connectionId}
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!qualification) throw new Error("Qualification command was not queued.");
  const now = new Date();
  const report = {
    contract: "kubernetes-qualification-report-v1",
    runId: qualification.runId,
    connectionId,
    configurationRevision: qualification.configRevision,
    clusterFingerprint: "b".repeat(64),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    evidenceClass: "isolated_provider",
    observed: {
      kubernetesVersion: "v1.32.0",
      distribution: "other",
      storageDriver: "csi.example.test",
      snapshotDriver: "csi.example.test",
      edgeController: "nginx",
      edgeMode: "ingress",
    },
    checks: KUBERNETES_QUALIFICATION_CHECK_IDS.map((id) => ({
      id,
      status: "passed",
      evidenceClass: id.startsWith("active.")
        ? "isolated_provider"
        : "cluster_preflight",
      detail: `${id} passed in the product fixture.`,
    })),
    cleanup: {
      status: "passed",
      namespace: "kestrel-qualification-product",
      residualResources: [],
    },
  };
  expect(report.configurationRevision).toBe(
    kubernetesConnectionInfrastructureRevision(await configuredConnection()),
  );
  await sql.begin(async (transaction) => {
    await transaction`
      UPDATE infrastructure_connector_commands
      SET status = 'completed', result = ${transaction.json({
        contract: "infrastructure-connector-result-v1",
        commandId: qualification.commandId,
        connectionId,
        commandType: "qualify_connection",
        status: "succeeded",
        observedRevision: qualification.configRevision,
        resources: [],
        evidence: [{ level: "isolated_provider", phase: "qualification.complete" }],
      })}, completed_at = now(), updated_at = now()
      WHERE id = ${qualification.commandId}
    `;
    await transaction`
      UPDATE infrastructure_connector_qualification_runs
      SET status = 'passed', result = ${transaction.json(report)},
        completed_at = now(), updated_at = now()
      WHERE id = ${qualification.runId}
    `;
    await transaction`
      UPDATE environment_provider_connections
      SET status = 'ready', support_status = 'qualified',
        qualification_evidence = ${transaction.json([report])},
        qualified_by_user_id = ${userId}, qualified_at = now(),
        last_qualified_at = now(), updated_at = now()
      WHERE id = ${connectionId}
    `;
  });

  await page.goto("/organization");
  await page.getByRole("button", { name: "New environment" }).click();
  await page.locator("#organization-environment-provider").click();
  await page.getByRole("option", { name: "Kubernetes BYOC" }).click();
  await page.locator("#organization-environment-name").fill(environmentName);
  await expect(page.locator("#organization-environment-connection")).not.toHaveText(
    "Select a qualified connection",
  );
  await page.getByLabel("Workspace limit").fill("3");
  await page.getByRole("button", { name: "Create Environment" }).click();
  await expect(page.getByText(environmentName)).toBeVisible();

  const [created] = await sql<
    Array<{
      id: string;
      provider: string;
      providerConnectionId: string;
      region: string | null;
      runtimeImage: string | null;
      routerImage: string | null;
      workspaceLimit: number;
    }>
  >`
    SELECT id, provider, provider_connection_id AS "providerConnectionId",
      region, runtime_image AS "runtimeImage", router_image AS "routerImage",
      workspace_limit AS "workspaceLimit"
    FROM environments
    WHERE organization_id = ${organizationId} AND name = ${environmentName}
  `;
  if (!created) throw new Error("Kubernetes Environment was not created.");
  environmentId = created.id;
  expect(created).toMatchObject({
    provider: "kubernetes",
    providerConnectionId: connectionId,
    region: null,
    workspaceLimit: 3,
  });
  expect(created.runtimeImage).toBeTruthy();
  expect(created.routerImage).toBeTruthy();

  await sql`
    UPDATE environments SET status = 'ready', updated_at = now()
    WHERE id = ${environmentId}
  `;
  await page.goto(`/organization/environments/${environmentId}`);
  await page.getByRole("button", { name: "Reconcile now" }).click();
  await expect(
    page.getByText("Environment reconciliation queued."),
  ).toBeVisible();

  const diagnostics = await request.get(
    `/api/organization/infrastructure/kubernetes/connections/${connectionId}/diagnostics`,
  );
  expect(diagnostics.ok()).toBe(true);
  expect(diagnostics.headers()["content-disposition"]).toContain("attachment");
  const diagnosticText = await diagnostics.text();
  expect(diagnosticText).toContain("kubernetes-byoc-diagnostic-v1");
  for (const forbidden of [
    "currentCredentialHash",
    "previousCredentialHash",
    "encryptedSecrets",
    "kubeconfig",
    '"envelope"',
  ]) {
    expect(diagnosticText).not.toContain(forbidden);
  }

  await expectAuditActions([
    "kubernetes_byoc.rollout.updated",
    "kubernetes_connector.enrollment.approved",
    "kubernetes_connection.configured",
    "kubernetes_connection.qualification.started",
    "environment.create.requested",
    "environment.reconcile.requested",
  ]);

  await sql`DELETE FROM environments WHERE id = ${environmentId}`;
  environmentId = "";
  const inventoryResult = {
    contract: "infrastructure-connector-result-v1",
    commandId: qualification.commandId,
    connectionId,
    commandType: "list_environment_resources",
    status: "succeeded",
    observedRevision: qualification.configRevision,
    resources: [],
    evidence: [{ level: "implementation", phase: "inventory.empty" }],
    output: { resourceObservations: [] },
  };
  await sql`
    UPDATE infrastructure_connector_commands
    SET command_type = 'list_environment_resources', status = 'completed',
      result = ${sql.json(inventoryResult)}, completed_at = now(),
      created_at = now(), updated_at = now()
    WHERE id = ${qualification.commandId}
  `;
  await sql`
    UPDATE infrastructure_connector_connections
    SET last_seen_at = now(), updated_at = now()
    WHERE provider_connection_id = ${connectionId}
  `;
  await page.goto("/organization/connections");
  const revoke = page.getByRole("button", { name: "Revoke" });
  await expect(revoke).toBeEnabled();
  await revoke.click();
  await expect(page.getByText("Connection revoked.")).toBeVisible();
  await expectAuditActions(["kubernetes_connection.revoked"]);

  const events = await sql<
    Array<{ actorUserId: string | null; metadata: unknown; organizationId: string }>
  >`
    SELECT actor_user_id AS "actorUserId", organization_id AS "organizationId",
      metadata
    FROM admin_event_logs
    WHERE target_id = ${connectionId}
  `;
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.organizationId).toBe(organizationId);
    expect(event.actorUserId).toBe(userId);
    const serialized = JSON.stringify(event.metadata ?? {});
    expect(serialized).not.toMatch(
      /credential|privateKey|requestSecret|kubeconfig|encryptedSecrets|envelope/iu,
    );
  }
});

async function configuredConnection() {
  const [row] = await sql<Array<{ configuration: unknown }>>`
    SELECT configuration FROM environment_provider_connections
    WHERE id = ${connectionId}
  `;
  if (!row) throw new Error("Configured connection is unavailable.");
  return row.configuration;
}

async function expectAuditActions(expected: string[]) {
  const events = await sql<Array<{ action: string }>>`
    SELECT action FROM admin_event_logs
    WHERE organization_id = ${organizationId}
      AND created_at >= now() - interval '10 minutes'
  `;
  const actions = new Set(events.map((event) => event.action));
  for (const action of expected) expect(actions.has(action), action).toBe(true);
}
