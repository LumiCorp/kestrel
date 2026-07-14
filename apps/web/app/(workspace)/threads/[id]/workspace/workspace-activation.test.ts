import assert from "node:assert/strict";
import test from "node:test";
import {
  type EnvironmentActivation,
  waitForWorkspaceActivation,
} from "./workspace-activation";

const pending: EnvironmentActivation = {
  stage: "environment.machine.starting",
  detail: "Waking the Workspace Machine…",
  status: "pending",
};

test("Workspace activation reports each pending stage before ready", async () => {
  const progress: EnvironmentActivation[] = [];
  const reads: EnvironmentActivation[] = [
    {
      stage: "environment.health.checking",
      detail: "Checking Workspace health…",
      status: "pending",
    },
    {
      stage: "environment.activation.ready",
      detail: "Environment ready.",
      status: "ready",
    },
  ];
  const result = await waitForWorkspaceActivation({
    initial: pending,
    read: async () => reads.shift()!,
    onProgress: (activation) => progress.push(activation),
    sleep: async () => {},
  });
  assert.equal(result?.status, "ready");
  assert.deepEqual(
    progress.map((activation) => activation.stage),
    [
      "environment.machine.starting",
      "environment.health.checking",
      "environment.activation.ready",
    ]
  );
});

test("Workspace activation stops immediately on a failed state", async () => {
  await assert.rejects(
    waitForWorkspaceActivation({
      initial: pending,
      read: async () => ({
        stage: "environment.activation.failed",
        detail: "Workspace volume could not mount.",
        status: "failed",
      }),
      onProgress: () => {},
      sleep: async () => {},
    }),
    /Workspace volume could not mount/u
  );
});

test("Workspace activation has a bounded wait and supports cancellation", async () => {
  let time = 0;
  await assert.rejects(
    waitForWorkspaceActivation({
      initial: pending,
      read: async () => pending,
      onProgress: () => {},
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
      now: () => time,
      pollIntervalMs: 500,
      timeoutMs: 1000,
    }),
    /activation timed out/u
  );

  const controller = new AbortController();
  const result = await waitForWorkspaceActivation({
    initial: pending,
    read: async () => pending,
    onProgress: () => {},
    sleep: async () => controller.abort(),
    signal: controller.signal,
  });
  assert.equal(result, null);
});
