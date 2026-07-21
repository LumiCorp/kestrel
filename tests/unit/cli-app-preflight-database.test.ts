import assert from "node:assert/strict";

import { DEFAULT_KESTREL_DB_PORT } from "../../src/config/localDev.js";
import {
  resolveDatabasePreflightTargetForTests,
  resolveDatabaseSelfHealPolicyForTests,
  resolveDockerCommandForSelfHealForTests,
  shouldLaunchDockerDesktopForSelfHealForTests,
} from "../../cli/app/App.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "resolveDatabasePreflightTargetForTests parses local kestrel database URL", () => {
  const target = resolveDatabasePreflightTargetForTests(
    `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
  );

  assert.deepEqual(target, {
    host: "localhost",
    port: DEFAULT_KESTREL_DB_PORT,
    database: "kestrel",
    isLocalHarnessDefault: true,
  });
});

contractTest("runtime.hermetic", "resolveDatabasePreflightTargetForTests rejects non-postgres protocols", () => {
  assert.throws(
    () => {
      resolveDatabasePreflightTargetForTests("mysql://root@localhost:3306/demo");
    },
    /must use postgres/u,
  );
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests skips self-heal by default", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
    failureCode: "ECONNREFUSED",
  });

  assert.deepEqual(policy, {
    canAttempt: false,
    reason: "disabled",
  });
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests can default-enable local self-heal", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
    failureCode: "ECONNREFUSED",
    defaultEnabled: true,
  });

  assert.deepEqual(policy, {
    canAttempt: true,
    reason: "enabled_local_refused",
  });
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests enables local self-heal when explicitly opted in", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
    failureCode: "ECONNREFUSED",
    envValue: "true",
  });

  assert.deepEqual(policy, {
    canAttempt: true,
    reason: "enabled_local_refused",
  });
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests respects explicit self-heal disable flag", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
    failureCode: "ECONNREFUSED",
    envValue: "false",
  });

  assert.deepEqual(policy, {
    canAttempt: false,
    reason: "disabled",
  });
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests skips non-local targets", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: "postgres://kestrel:kestrel@db.internal:5432/kestrel",
    failureCode: "ECONNREFUSED",
    envValue: "true",
  });

  assert.deepEqual(policy, {
    canAttempt: false,
    reason: "non_local_target",
  });
});

contractTest("runtime.hermetic", "resolveDatabaseSelfHealPolicyForTests only retries supported failure codes", () => {
  const policy = resolveDatabaseSelfHealPolicyForTests({
    databaseUrl: `postgres://kestrel:kestrel@localhost:${DEFAULT_KESTREL_DB_PORT}/kestrel`,
    failureCode: "ETIMEDOUT",
    envValue: "true",
  });

  assert.deepEqual(policy, {
    canAttempt: false,
    reason: "unsupported_failure_code",
  });
});

contractTest("runtime.hermetic", "resolveDockerCommandForSelfHealForTests falls back to Docker Desktop on macOS", () => {
  const docker = resolveDockerCommandForSelfHealForTests({
    env: {},
    platform: "darwin",
    fileExists: (target) => target === "/Applications/Docker.app/Contents/Resources/bin/docker",
  });
  assert.equal(docker, "/Applications/Docker.app/Contents/Resources/bin/docker");
});

contractTest("runtime.hermetic", "resolveDockerCommandForSelfHealForTests respects KCHAT_DOCKER_BIN override", () => {
  const docker = resolveDockerCommandForSelfHealForTests({
    env: { KCHAT_DOCKER_BIN: " /custom/docker " },
    platform: "darwin",
    fileExists: () => false,
  });
  assert.equal(docker, "/custom/docker");
});

contractTest("runtime.hermetic", "shouldLaunchDockerDesktopForSelfHealForTests only launches Docker.app on macOS", () => {
  const shouldLaunch = shouldLaunchDockerDesktopForSelfHealForTests({
    command: "/Applications/Docker.app/Contents/Resources/bin/docker",
    platform: "darwin",
    fileExists: (target) =>
      target === "/Applications/Docker.app" || target === "/usr/bin/open",
  });

  assert.equal(shouldLaunch, true);
});

contractTest("runtime.hermetic", "shouldLaunchDockerDesktopForSelfHealForTests skips custom docker commands", () => {
  const shouldLaunch = shouldLaunchDockerDesktopForSelfHealForTests({
    command: "/custom/docker",
    platform: "darwin",
    fileExists: () => true,
  });

  assert.equal(shouldLaunch, false);
});
