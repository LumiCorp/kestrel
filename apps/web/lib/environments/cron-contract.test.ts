import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeEnvironmentReconcileCron,
  EnvironmentReconcileCronError,
} from "./cron-contract";

test("Environment reconciliation cron requires its dedicated bearer", () => {
  assert.doesNotThrow(() =>
    authorizeEnvironmentReconcileCron({
      authorization: "Bearer cron-secret",
      expectedSecret: "cron-secret",
    })
  );
  assert.throws(
    () =>
      authorizeEnvironmentReconcileCron({
        authorization: "Bearer wrong-secret",
        expectedSecret: "cron-secret",
      }),
    (error: unknown) =>
      error instanceof EnvironmentReconcileCronError &&
      error.code === "ENVIRONMENT_RECONCILE_CRON_UNAUTHORIZED" &&
      error.status === 401
  );
  assert.throws(
    () =>
      authorizeEnvironmentReconcileCron({
        authorization: null,
        expectedSecret: undefined,
      }),
    (error: unknown) =>
      error instanceof EnvironmentReconcileCronError &&
      error.code === "ENVIRONMENT_RECONCILE_CRON_NOT_CONFIGURED" &&
      error.status === 503
  );
});
