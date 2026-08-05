import test from "node:test";
import assert from "node:assert/strict";
import {
  withEnvironmentOperationLock,
  withEnvironmentReconcileLock,
  withOrganizationDeletionLock,
} from "./reconcile-lock";


const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "Postgres Environment reconciliation lock excludes overlapping workers and releases",
  async () => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");

    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withEnvironmentReconcileLock({
      run: async () => {
        enterFirst();
        await firstRelease;
        return "first";
      },
    });
    await firstEntered;

    const overlapping = await withEnvironmentReconcileLock({
      run: async () => "overlapping",
    });
    assert.deepEqual(overlapping, { acquired: false, result: null });

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, result: "first" });
    assert.deepEqual(
      await withEnvironmentReconcileLock({ run: async () => "next" }),
      { acquired: true, result: "next" }
    );
  }
);

test(
  "Postgres Organization deletion locks exclude duplicate workers per operation",
  async () => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");

    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withOrganizationDeletionLock({
      operationId: "organization-operation-a",
      run: async () => {
        enterFirst();
        await firstRelease;
        return "first";
      },
    });
    await firstEntered;

    try {
      assert.deepEqual(
        await withOrganizationDeletionLock({
          operationId: "organization-operation-a",
          run: async () => "duplicate",
        }),
        { acquired: false, result: null },
      );
      assert.deepEqual(
        await withOrganizationDeletionLock({
          operationId: "organization-operation-b",
          run: async () => "different",
        }),
        { acquired: true, result: "different" },
      );
    } finally {
      releaseFirst();
    }
    assert.deepEqual(await first, { acquired: true, result: "first" });
  },
);

test(
  "Organization deletion reconciles a missing organization once and never regresses its tombstone",
  async (context) => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    process.env.POSTGRES_URL = databaseUrl;
    const [{ resetDbRuntimeForTests }, { processOrganizationDeletion }] =
      await Promise.all([
        import("@/lib/db/runtime"),
        import("@/lib/organizations/deletion"),
      ]);
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl, { max: 1 });
    const operationId = `missing-organization-${crypto.randomUUID()}`;

    context.after(async () => {
      await sql`DELETE FROM "organization_deletion_operations" WHERE "id" = ${operationId}`;
      await resetDbRuntimeForTests();
      await sql.end({ timeout: 0 });
    });
    await sql`
      INSERT INTO "organization_deletion_operations" (
        "id", "organization_id", "organization_name", "status", "stage",
        "idempotency_key"
      ) VALUES (
        ${operationId}, ${`absent-${operationId}`}, 'Absent Org', 'queued',
        'organization.deletion.requested', ${`delete:${operationId}`}
      )
    `;

    await Promise.all([
      processOrganizationDeletion(operationId),
      processOrganizationDeletion(operationId),
    ]);
    const [completed] = await sql<
      Array<{ status: string; stage: string; completedAt: Date | null }>
    >`
      SELECT "status", "stage", "completed_at" AS "completedAt"
      FROM "organization_deletion_operations"
      WHERE "id" = ${operationId}
    `;
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.stage, "organization.deleted");
    assert.ok(completed?.completedAt);

    await processOrganizationDeletion(operationId);
    const [preserved] = await sql<
      Array<{ status: string; stage: string; completedAt: Date | null }>
    >`
      SELECT "status", "stage", "completed_at" AS "completedAt"
      FROM "organization_deletion_operations"
      WHERE "id" = ${operationId}
    `;
    assert.deepEqual(preserved, completed);
  },
);

test(
  "Postgres Environment operation locks exclude all work for the same Environment",
  async () => {
    assert.ok(databaseUrl, "KESTREL_ENVIRONMENT_DB_TEST_URL is required");
    process.env.DATABASE_URL = databaseUrl;
    Reflect.deleteProperty(process.env, "POSTGRES_URL");

    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withEnvironmentOperationLock({
      environmentId: "environment-a",
      run: async () => {
        enterFirst();
        await firstRelease;
        return "first";
      },
    });
    await firstEntered;

    try {
      assert.deepEqual(
        await withEnvironmentOperationLock({
          environmentId: "environment-a",
          run: async () => "same-environment",
        }),
        { acquired: false, result: null }
      );
      assert.deepEqual(
        await withEnvironmentOperationLock({
          environmentId: "environment-b",
          run: async () => "different-environment",
        }),
        { acquired: true, result: "different-environment" }
      );
    } finally {
      releaseFirst();
    }
    assert.deepEqual(await first, { acquired: true, result: "first" });
  }
);
