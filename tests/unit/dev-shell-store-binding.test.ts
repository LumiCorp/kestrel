import assert from "node:assert/strict";
import test from "node:test";

import { agentChildEnvironment } from "../../src/runtime/agentChildEnvironment.js";
import {
  buildDevShellStoreBindingEnvironment,
  DEV_SHELL_STORE_BINDING_REVISION_ENV,
  DEV_SHELL_STORE_DATABASE_URL_ENV,
  DEV_SHELL_STORE_DRIVER_ENV,
  readDevShellStoreBindingFromEnvironment,
  resolveLegacyDevShellStoreBinding,
} from "../../src/devshell/storeBinding.js";

test("explicit developer-shell binding ignores the application DATABASE_URL", () => {
  const binding = {
    driver: "sqlite" as const,
    revision: "binding-pglite",
  };
  const environment = {
    DATABASE_URL: "postgres://application.example/workspace",
    ...buildDevShellStoreBindingEnvironment(binding),
  };

  assert.deepEqual(
    readDevShellStoreBindingFromEnvironment(environment),
    binding,
  );
  assert.equal(
    environment.DATABASE_URL,
    "postgres://application.example/workspace",
  );
});

test("explicit Postgres binding carries the exact Local Core URL", () => {
  const binding = {
    driver: "postgres" as const,
    revision: "binding-external",
    databaseUrl: "postgres://kestrel.example/control",
  };

  assert.deepEqual(
    readDevShellStoreBindingFromEnvironment(
      buildDevShellStoreBindingEnvironment(binding),
    ),
    binding,
  );
});

test("standalone compatibility resolves legacy storage once", () => {
  const sqlite = resolveLegacyDevShellStoreBinding({
    KESTREL_STORE_DRIVER: "sqlite",
    DATABASE_URL: "postgres://application.example/workspace",
  });
  const postgres = resolveLegacyDevShellStoreBinding({
    KESTREL_STORE_DRIVER: "postgres",
    DATABASE_URL: "postgres://kestrel.example/control",
  });
  const missing = resolveLegacyDevShellStoreBinding({
    KESTREL_STORE_DRIVER: "postgres",
  });

  assert.equal(sqlite.binding?.driver, "sqlite");
  assert.equal(postgres.binding?.driver, "postgres");
  assert.equal(
    postgres.binding?.driver === "postgres"
      ? postgres.binding.databaseUrl
      : undefined,
    "postgres://kestrel.example/control",
  );
  assert.deepEqual(missing, { missingDatabaseUrl: true });
});

test("developer-shell binding values are removed from command environments", () => {
  const source = {
    DATABASE_URL: "postgres://application.example/workspace",
    [DEV_SHELL_STORE_DRIVER_ENV]: "postgres",
    [DEV_SHELL_STORE_DATABASE_URL_ENV]: "postgres://secret.example/control",
    [DEV_SHELL_STORE_BINDING_REVISION_ENV]: "binding-secret",
  };

  const environment = agentChildEnvironment(source);
  assert.equal(environment.DATABASE_URL, source.DATABASE_URL);
  assert.equal(environment[DEV_SHELL_STORE_DRIVER_ENV], undefined);
  assert.equal(environment[DEV_SHELL_STORE_DATABASE_URL_ENV], undefined);
  assert.equal(environment[DEV_SHELL_STORE_BINDING_REVISION_ENV], undefined);
});
