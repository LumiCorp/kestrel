import assert from "node:assert/strict";
import test from "node:test";
import {
  withEnvironmentOperationLock,
  withEnvironmentReconcileLock,
} from "./reconcile-lock";

const databaseUrl = process.env.KESTREL_ENVIRONMENT_DB_TEST_URL?.trim();

test(
  "Postgres Environment reconciliation lock excludes overlapping workers and releases",
  {
    skip: databaseUrl
      ? false
      : "KESTREL_ENVIRONMENT_DB_TEST_URL is not configured",
  },
  async () => {
    assert.ok(databaseUrl);
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
  "Postgres Environment operation locks exclude only the same operation",
  {
    skip: databaseUrl
      ? false
      : "KESTREL_ENVIRONMENT_DB_TEST_URL is not configured",
  },
  async () => {
    assert.ok(databaseUrl);
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
      operationId: "operation-a",
      run: async () => {
        enterFirst();
        await firstRelease;
        return "first";
      },
    });
    await firstEntered;

    assert.deepEqual(
      await withEnvironmentOperationLock({
        operationId: "operation-a",
        run: async () => "same-operation",
      }),
      { acquired: false, result: null }
    );
    assert.deepEqual(
      await withEnvironmentOperationLock({
        operationId: "operation-b",
        run: async () => "different-operation",
      }),
      { acquired: true, result: "different-operation" }
    );

    releaseFirst();
    assert.deepEqual(await first, { acquired: true, result: "first" });
  }
);
