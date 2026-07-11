import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_RESOURCE_DIRECTORIES,
  shouldInstallDesktopRuntimeDependencies,
  shouldCopyDesktopResourceEntry,
} from "../../../scripts/prepare-desktop-resources.ts";
import { resolveRuntimeDependencyInstallArgs } from "../../../scripts/runtime-package-dependencies.ts";

test("desktop runtime resources include database migrations", () => {
  assert.ok(DESKTOP_RESOURCE_DIRECTORIES.includes("db"));
  assert.equal(DESKTOP_RESOURCE_DIRECTORIES.includes("apps/web"), false);
  assert.equal(DESKTOP_RESOURCE_DIRECTORIES.includes("packages/protocol"), false);
});

test("desktop runtime resources continue to exclude local env files", () => {
  assert.equal(shouldCopyDesktopResourceEntry("/repo/.env"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/repo/.env.local"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/repo/db/migrations/018_dev_shell_processes.sql"), true);
});

test("desktop dev resource prep does not install runtime dependency trees", () => {
  assert.equal(shouldInstallDesktopRuntimeDependencies({ packageStage: false }), false);
  assert.equal(shouldInstallDesktopRuntimeDependencies({ packageStage: true }), true);
});

test("desktop package dependency install can consume packed public packages without changing the manifest", () => {
  assert.deepEqual(resolveRuntimeDependencyInstallArgs(), ["install", "--omit=dev"]);
  assert.deepEqual(resolveRuntimeDependencyInstallArgs(["/tmp/protocol.tgz"]), [
    "install",
    "--omit=dev",
    "--no-save",
    "/tmp/protocol.tgz",
  ]);
});
