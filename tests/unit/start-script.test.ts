import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableDatabaseError,
  parseStartArgs,
  resolveDatabaseStopCommand,
  resolveDockerCommandForTests,
  resolveStartCommands,
} from "../../scripts/start.js";

test("parseStartArgs defaults to tui without skipping migrations", () => {
  assert.deepEqual(parseStartArgs([]), {
    target: "tui",
    skipMigrate: false,
  });
});

test("parseStartArgs accepts explicit target and skip-migrate", () => {
  assert.deepEqual(parseStartArgs(["--target", "web", "--skip-migrate"]), {
    target: "web",
    skipMigrate: true,
  });
});

test("resolveStartCommands launches canonical Kestrel One for the web target", () => {
  const commands = resolveStartCommands("web");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.id, "web");
  assert.equal(commands[0]?.label, "Kestrel One");
  assert.deepEqual(commands[0]?.args, ["--filter", "@kestrel/kestrel-one", "dev"]);
});

test("resolveDockerCommandForTests honors KCHAT_DOCKER_BIN override", () => {
  const docker = resolveDockerCommandForTests({
    env: { KCHAT_DOCKER_BIN: "/tmp/docker-custom " },
    platform: "darwin",
    fileExists: () => false,
  });

  assert.equal(docker, "/tmp/docker-custom");
});

test("resolveDockerCommandForTests falls back to Docker.app on macOS", () => {
  const docker = resolveDockerCommandForTests({
    env: {},
    platform: "darwin",
    fileExists: (target) => target === "/Applications/Docker.app/Contents/Resources/bin/docker",
  });

  assert.equal(docker, "/Applications/Docker.app/Contents/Resources/bin/docker");
});

test("resolveDockerCommandForTests keeps docker on non-macOS", () => {
  const docker = resolveDockerCommandForTests({
    env: {},
    platform: "linux",
    fileExists: () => false,
  });

  assert.equal(docker, "docker");
});

test("resolveDatabaseStopCommand stops only the supervised postgres service", () => {
  assert.deepEqual(resolveDatabaseStopCommand("docker"), {
    id: "db-down",
    label: "postgres container shutdown",
    command: "docker",
    args: ["compose", "stop", "postgres"],
  });
});

test("isRetryableDatabaseError recognizes connection-refused aggregate failures", () => {
  const error = {
    errors: [{ code: "ECONNREFUSED" }],
  };

  assert.equal(isRetryableDatabaseError(error), true);
});

test("isRetryableDatabaseError does not hide authentication failures", () => {
  const error = {
    code: "28P01",
    message: "password authentication failed for user 'kestrel'",
  };

  assert.equal(isRetryableDatabaseError(error), false);
});
