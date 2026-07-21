import assert from "node:assert/strict";

import { MemoryLocalCoreCredentialStore } from "../../src/localCore/credentialStore.js";
import { verifyAndStoreLocalCoreExternalDatabase } from "../../src/localCore/externalDatabaseVerification.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "Local Core verifies an external database before replacing its Keychain credential", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  await store.set("data.database.external", "postgresql://user:old@old.example/kestrel");
  const candidate = "postgresql://user:new@db.example.test:5433/kestrel";
  const result = await verifyAndStoreLocalCoreExternalDatabase(candidate, {
    credentialStore: store,
    async verify(value) {
      assert.equal(value, candidate);
    },
  });
  assert.equal(await store.get("data.database.external"), candidate);
  assert.deepEqual(result.target, { host: "db.example.test", port: 5433, database: "kestrel" });
  assert.equal(JSON.stringify(result).includes("user:new"), false);
});

contractTest("runtime.hermetic", "Local Core preserves the prior external database credential when verification fails", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  const previous = "postgresql://user:old@old.example/kestrel";
  await store.set("data.database.external", previous);
  await assert.rejects(
    verifyAndStoreLocalCoreExternalDatabase("postgresql://user:bad@db.example/kestrel", {
      credentialStore: store,
      async verify() { throw new Error("connection refused"); },
    }),
    /connection refused/u,
  );
  assert.equal(await store.get("data.database.external"), previous);
});
