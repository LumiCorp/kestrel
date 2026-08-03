import test from "node:test";
import assert from "node:assert/strict";
import {
  withEnvironmentOperationLock,
  withEnvironmentReconcileLock,
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
