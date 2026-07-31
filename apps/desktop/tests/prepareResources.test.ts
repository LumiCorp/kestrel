import test from "node:test";
import assert from "node:assert/strict";

import {
  DESKTOP_RESOURCE_DIRECTORIES,
  shouldCopyDesktopResourceEntry,
} from "../../../scripts/prepare-desktop-resources.ts";


test("desktop runtime resources include database migrations", () => {
  assert.ok(DESKTOP_RESOURCE_DIRECTORIES.includes("db/migrations"));
  assert.equal(DESKTOP_RESOURCE_DIRECTORIES.includes("apps/web"), false);
  assert.equal(DESKTOP_RESOURCE_DIRECTORIES.includes("packages/protocol"), false);
});

test("desktop runtime resources continue to exclude local env files", () => {
  assert.equal(shouldCopyDesktopResourceEntry("/repo/.env"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/repo/.env.local"), false);
  assert.equal(shouldCopyDesktopResourceEntry("/repo/db/migrations/018_dev_shell_processes.sql"), true);
});
