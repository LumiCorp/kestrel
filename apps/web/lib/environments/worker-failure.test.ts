import test from "node:test";
import assert from "node:assert/strict";
import {
  describeEnvironmentWorkerFailure,
  parseEnvironmentWorkerAttempt,
} from "./worker-failure";

test(
  "Environment worker retry metadata maps every attempt to the same bounded operation",
  () => {
    assert.deepEqual(
      parseEnvironmentWorkerAttempt({ retryCount: 0, retryLimit: 20 }),
      {
        attempt: 1,
        canRetry: true,
        retryCount: 0,
        retryLimit: 20,
      },
    );
    assert.deepEqual(
      parseEnvironmentWorkerAttempt({ retryCount: 20, retryLimit: 20 }),
      {
        attempt: 21,
        canRetry: false,
        retryCount: 20,
        retryLimit: 20,
      },
    );
  },
);

test(
  "Environment worker failures preserve validated service codes for platform diagnostics",
  () => {
    const failure = describeEnvironmentWorkerFailure({
      error: Object.assign(new Error("Credential key is unavailable."), {
        code: "GATEWAY_CREDENTIAL_KEY_UNKNOWN",
      }),
      fallbackCode: "WORKSPACE_BACKUP_FAILED",
      fallbackMessage: "Workspace backup failed.",
    });
    assert.deepEqual(failure, {
      code: "GATEWAY_CREDENTIAL_KEY_UNKNOWN",
      message: "Credential key is unavailable.",
    });

    assert.deepEqual(
      describeEnvironmentWorkerFailure({
        error: { code: "not a safe code", message: "Provider failed." },
        fallbackCode: "WORKSPACE_BACKUP_FAILED",
        fallbackMessage: "Workspace backup failed.",
      }),
      {
        code: "WORKSPACE_BACKUP_FAILED",
        message: "Provider failed.",
      },
    );
  },
);
