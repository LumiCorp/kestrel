import assert from "node:assert/strict";
import test from "node:test";
import {
  getSignupEnvironmentExperience,
  getSignupEnvironmentMilestones,
} from "./signup-onboarding-progress";

function statuses(stage: string | null, environmentReady = false) {
  return getSignupEnvironmentMilestones({
    environmentReady,
    operationStage: stage,
  }).map((milestone) => milestone.status);
}

test("signup progress follows the durable Environment operation stages", () => {
  assert.deepEqual(statuses("environment.activation.requested"), [
    "active",
    "upcoming",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
  assert.deepEqual(statuses("environment.machine.starting"), [
    "completed",
    "completed",
    "active",
    "upcoming",
    "upcoming",
  ]);
  assert.deepEqual(statuses("environment.health.checking"), [
    "completed",
    "completed",
    "completed",
    "active",
    "upcoming",
  ]);
});

test("signup progress opens the first Thread only after the Environment is ready", () => {
  assert.deepEqual(statuses("environment.activation.ready", true), [
    "completed",
    "completed",
    "completed",
    "completed",
    "active",
  ]);
});

test("unknown queued stages stay at the truthful preparation milestone", () => {
  assert.deepEqual(statuses("environment.provider.retrying"), [
    "active",
    "upcoming",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
});

test("signup Environment experience distinguishes progress from recovery", () => {
  assert.deepEqual(getSignupEnvironmentExperience("provisioning"), {
    kind: "progress",
  });
  assert.deepEqual(getSignupEnvironmentExperience("ready"), {
    kind: "progress",
  });
  assert.deepEqual(getSignupEnvironmentExperience("failed"), {
    kind: "action",
    actionLabel: "Retry Environment setup",
    busyLabel: "Retrying…",
    title: "Environment setup needs attention",
  });
  for (const status of ["missing_environment", "rollout_disabled"]) {
    assert.deepEqual(getSignupEnvironmentExperience(status), {
      kind: "action",
      actionLabel: "Continue Environment setup",
      busyLabel: "Continuing…",
      title: "Environment setup is paused",
    });
  }
});

test("signup Environment experience never retries blocked states", () => {
  assert.deepEqual(getSignupEnvironmentExperience("deployment_disabled"), {
    kind: "blocked",
    title: "Hosted Environments are unavailable",
  });
  assert.deepEqual(getSignupEnvironmentExperience("degraded"), {
    kind: "blocked",
    title: "Environment setup needs administrator attention",
  });
  assert.deepEqual(getSignupEnvironmentExperience("unexpected_state"), {
    kind: "blocked",
    title: "Environment setup is paused",
  });
});
