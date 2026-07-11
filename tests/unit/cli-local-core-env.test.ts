import assert from "node:assert/strict";
import test from "node:test";

import {
  readDatabaseUrlSource,
  shouldKeepEnvironmentDatabaseUrl,
} from "../../cli/localCoreEnv.js";

test("readDatabaseUrlSource preserves trusted Desktop and CLI source markers", () => {
  assert.equal(
    readDatabaseUrlSource({ KESTREL_DATABASE_URL_SOURCE: "local_core_managed" }),
    "local_core_managed",
  );
  assert.equal(readDatabaseUrlSource({ KESTREL_DATABASE_URL_SOURCE: "cli_external" }), "cli_external");
  assert.equal(
    readDatabaseUrlSource({ KESTREL_DATABASE_URL_SOURCE: "desktop_external" }),
    "desktop_external",
  );
});

test("readDatabaseUrlSource falls back to environment for unknown source markers", () => {
  assert.equal(readDatabaseUrlSource({ KESTREL_DATABASE_URL_SOURCE: "unknown" }), "environment");
  assert.equal(readDatabaseUrlSource({}), "environment");
});

test("shouldKeepEnvironmentDatabaseUrl preserves only trusted sources or explicit postgres store", () => {
  assert.equal(
    shouldKeepEnvironmentDatabaseUrl({ KESTREL_DATABASE_URL_SOURCE: "local_core_managed" }),
    true,
  );
  assert.equal(shouldKeepEnvironmentDatabaseUrl({ KESTREL_DATABASE_URL_SOURCE: "cli_external" }), true);
  assert.equal(shouldKeepEnvironmentDatabaseUrl({ KESTREL_DATABASE_URL_SOURCE: "environment" }), false);
  assert.equal(shouldKeepEnvironmentDatabaseUrl({ KESTREL_STORE_DRIVER: "postgres" }), true);
});
