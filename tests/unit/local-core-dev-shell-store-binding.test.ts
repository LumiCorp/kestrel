import assert from "node:assert/strict";
import test from "node:test";

import { createLocalCoreDevShellStoreBinding } from "../../src/localCore/executionRuntime.js";
import type { LocalCoreStoreHandle } from "../../src/localCore/store.js";

test("Local Core derives a SQLite developer-shell binding from its PGlite handle", () => {
  const binding = createLocalCoreDevShellStoreBinding(
    { mode: "pglite" } as LocalCoreStoreHandle,
    "binding-pglite",
  );

  assert.deepEqual(binding, {
    driver: "sqlite",
    revision: "binding-pglite",
  });
});

test("Local Core derives an exact Postgres developer-shell binding from its external handle", () => {
  const binding = createLocalCoreDevShellStoreBinding(
    {
      mode: "external",
      databaseUrl: "postgres://kestrel.example/control",
    } as LocalCoreStoreHandle,
    "binding-external",
  );

  assert.deepEqual(binding, {
    driver: "postgres",
    revision: "binding-external",
    databaseUrl: "postgres://kestrel.example/control",
  });
});

test("Local Core rejects an external handle without its opened database URL", () => {
  assert.throws(
    () =>
      createLocalCoreDevShellStoreBinding(
        { mode: "external" } as LocalCoreStoreHandle,
        "binding-external",
      ),
    /missing its configured database URL/u,
  );
});
