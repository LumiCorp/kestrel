import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  assertFlyOwnedAuthorityPresent,
  assertPreparationDatabaseState,
  assertProspectiveWebConfiguration,
  assertProductionBranchPolicy,
  assertStagedWorkerSecretInventory,
  assertVercelProductionEnvironmentInventory,
  classifyWorkerSecretInventory,
  requireProductionDatabaseUrl,
  selectWorkerConfiguration,
  serializeWorkerConfiguration,
} from "./production-delivery-prepare";

const encryptionKey = Buffer.alloc(32, 4).toString("base64");

test("preparation selects only the control-worker contract", () => {
  const source = controlSource();
  const selected = selectWorkerConfiguration("control-worker", source);
  assert.equal(selected.CRON_SECRET, undefined);
  assert.equal(selected.FLY_API_TOKEN, undefined);
  assert.equal(selected.KESTREL_FLY_ORGANIZATION_SLUG, undefined);
  assert.equal(selected.KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID, undefined);
  assert.equal(selected.KESTREL_APP_CREDENTIAL_KEYS, undefined);
  assert.equal(selected.POSTGRES_URL, source.POSTGRES_URL);
  assert.deepEqual(
    classifyWorkerSecretInventory(
      "control-worker",
      [
        "CRON_SECRET",
        "FLY_API_TOKEN",
        "KESTREL_FLY_ORGANIZATION_SLUG",
        "POSTGRES_URL",
      ],
      selected,
    ).removals,
    ["CRON_SECRET"],
  );
});

test("preparation refuses unknown and provider-owned managed secrets", () => {
  assert.throws(
    () =>
      classifyWorkerSecretInventory(
        "turn-worker",
        ["KESTREL_UNDECLARED_AUTHORITY"],
        {},
      ),
    /unknown managed secrets/u,
  );
  assert.throws(
    () =>
      classifyWorkerSecretInventory(
        "runpod-worker",
        ["RUNPOD_API_KEY"],
        {},
      ),
    /forbidden provider authority/u,
  );
  assert.throws(
    () => assertFlyOwnedAuthorityPresent("control-worker", ["FLY_API_TOKEN"]),
    /KESTREL_FLY_ORGANIZATION_SLUG/u,
  );
});

test("preparation serializes values for stdin and verifies staged names", () => {
  assert.equal(
    serializeWorkerConfiguration({ BETA: "line one\nline two", ALPHA: "plain" }),
    'ALPHA="plain"\nBETA="line one\\nline two"\n',
  );
  assert.doesNotThrow(() =>
    assertStagedWorkerSecretInventory({
      selectedNames: ["ALPHA"],
      removalNames: ["CRON_SECRET"],
      inventory: [
        { name: "ALPHA", status: "staged" },
        { name: "CRON_SECRET", status: "pending" },
      ],
    }),
  );
});

test("preparation permits active canary backups to drain", () => {
  const result = assertPreparationDatabaseState({
    migrationApplied: false,
    canaryEnvironmentId: "environment-1",
    canaryReady: true,
    activeReleaseCount: 0,
    nonterminalTargetCount: 0,
    queuedReleaseJobCount: 0,
    activeCanaryOperations: [
      {
        id: "backup-1",
        type: "workspace.backup",
        status: "queued",
        stage: "workspace.backup.queued",
      },
      {
        id: "backup-2",
        type: "workspace.backup",
        status: "running",
        stage: "workspace.backup.uploading",
      },
    ],
  });
  assert.deepEqual(
    result.allowedBackupOperations.map((operation) => operation.id),
    ["backup-1", "backup-2"],
  );
});

test("preparation reports exact non-backup canary operation blockers", () => {
  assert.throws(
    () =>
      assertPreparationDatabaseState({
        migrationApplied: false,
        canaryEnvironmentId: "environment-1",
        canaryReady: true,
        activeReleaseCount: 0,
        nonterminalTargetCount: 0,
        queuedReleaseJobCount: 0,
        activeCanaryOperations: [
          {
            id: "backup-1",
            type: "workspace.backup",
            status: "queued",
            stage: "workspace.backup.queued",
          },
          {
            id: "update-1",
            type: "environment.update",
            status: "running",
            stage: "environment.update.router",
          },
        ],
      }),
    /update-1 \(environment\.update, running, environment\.update\.router\)/u,
  );
});

test("preparation refuses after migration 0073 and accepts only production", () => {
  assert.throws(
    () =>
      assertPreparationDatabaseState({
        migrationApplied: true,
        canaryEnvironmentId: "environment-1",
        canaryReady: true,
        activeReleaseCount: 0,
        nonterminalTargetCount: 0,
        queuedReleaseJobCount: 0,
        activeCanaryOperations: [],
      }),
    /after migration 0073 is live/u,
  );
  assert.doesNotThrow(() =>
    assertProductionBranchPolicy({
      branch_policies: [{ name: "production" }],
    }),
  );
  assert.throws(
    () =>
      assertProductionBranchPolicy({ branch_policies: [{ name: "main" }] }),
    /allow only the production branch/u,
  );
});

test("preparation binds its database preflight to pulled production configuration", () => {
  assert.equal(
    requireProductionDatabaseUrl({
      POSTGRES_URL_NON_POOLING: "postgres://production-unpooled",
    }),
    "postgres://production-unpooled",
  );
  assert.throws(
    () => requireProductionDatabaseUrl({}),
    /Vercel Production requires POSTGRES_URL_NON_POOLING or DATABASE_URL_UNPOOLED/u,
  );
});

test("preparation validates the prospective Web contract before mutation", () => {
  const source = {
    ...controlSource(),
    CRON_SECRET: "cron",
    FLY_API_TOKEN: "web-fly-token",
    KESTREL_FLY_ORGANIZATION_SLUG: "lumi-kestrel",
    KESTREL_ENVIRONMENT_ROUTER_IMAGE: "legacy-router",
    KESTREL_WORKSPACE_RUNTIME_IMAGE: "legacy-runtime",
  };
  assert.doesNotThrow(() => assertProspectiveWebConfiguration(source));
  assert.throws(
    () =>
      assertProspectiveWebConfiguration({
        ...source,
        FLY_API_TOKEN: "",
        KESTREL_FLY_ORGANIZATION_SLUG: "",
      }),
    /web configuration is incomplete: KESTREL_FLY_ORGANIZATION_SLUG, FLY_API_TOKEN/u,
  );
});

test("preparation verifies sensitive Vercel token metadata without pulling its value", () => {
  assert.doesNotThrow(() =>
    assertVercelProductionEnvironmentInventory({
      envs: [
        {
          key: "PRODUCTION_IMAGE_DEPLOY_TOKEN",
          type: "sensitive",
          target: ["production"],
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertVercelProductionEnvironmentInventory({
        envs: [
          {
            key: "PRODUCTION_IMAGE_DEPLOY_TOKEN",
            type: "encrypted",
            target: ["production"],
          },
        ],
      }),
    /production delivery token verification failed/u,
  );
  assert.throws(
    () =>
      assertVercelProductionEnvironmentInventory({
        envs: [
          {
            key: "PRODUCTION_IMAGE_DEPLOY_TOKEN",
            type: "sensitive",
            target: ["production"],
          },
          {
            key: "KESTREL_WORKSPACE_RUNTIME_IMAGE",
            type: "encrypted",
            target: ["production"],
          },
        ],
      }),
    /legacy image removal verification failed: KESTREL_WORKSPACE_RUNTIME_IMAGE/u,
  );
});

function controlSource() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    POSTGRES_URL: "postgres://database",
    CRON_SECRET: "web-only",
    FLY_API_TOKEN: "fly-owned",
    KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_APP_CREDENTIAL_KEYS: JSON.stringify({ primary: encryptionKey }),
    KESTREL_ENVIRONMENTS_ENABLED: "true",
    KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY: publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    KESTREL_FLY_ORGANIZATION_SLUG: "fly-owned",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "primary",
    KESTREL_GATEWAY_CREDENTIAL_KEYS: JSON.stringify({ primary: encryptionKey }),
    KESTREL_ONE_APP_URL: "https://kestrel.example",
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "broker",
    KESTREL_ONE_TOOL_TOKEN: "tool",
    KESTREL_WORKSPACE_BACKUP_KEY: encryptionKey,
    KESTREL_WORKSPACE_BACKUP_KEY_ID: "backup-v1",
    STORAGE_ACCESS_KEY_ID: "access",
    STORAGE_BUCKET: "bucket",
    STORAGE_ENDPOINT: "https://storage.example",
    STORAGE_PROVIDER: "s3",
    STORAGE_SECRET_ACCESS_KEY: "secret",
  };
}
