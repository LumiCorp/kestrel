import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_CORE_CREDENTIAL_IDS,
  LocalCoreCredentialStoreUnavailableError,
  LocalCoreCredentialValidationError,
  MemoryLocalCoreCredentialStore,
  UnavailableLocalCoreCredentialStore,
  parseLocalCoreCredentialId,
  parseLocalCoreCredentialSecret,
  parseLocalCoreCredentialStoreStatus,
  readLocalCoreCredentialStoreStatus,
  type LocalCoreCredentialId,
} from "../../src/localCore/credentialStore.js";

test("Local Core credential IDs are stable and parsed exactly", () => {
  assert.deepEqual(LOCAL_CORE_CREDENTIAL_IDS, [
    "provider.openrouter.default",
    "provider.openai.default",
    "provider.anthropic.default",
    "tool.tavily.default",
  ]);
  for (const id of LOCAL_CORE_CREDENTIAL_IDS) {
    assert.equal(parseLocalCoreCredentialId(id), id);
  }
  for (const invalid of [
    "provider.openrouter",
    " provider.openrouter.default",
    "provider.openrouter.default ",
    "PROVIDER.OPENROUTER.DEFAULT",
    "tool.tavily.default.extra",
    "",
    null,
  ]) {
    assert.throws(
      () => parseLocalCoreCredentialId(invalid),
      LocalCoreCredentialValidationError,
    );
  }
});

test("Local Core credential values are preserved but reject unsafe boundary input", () => {
  assert.equal(parseLocalCoreCredentialSecret("sk-provider_123-ABC"), "sk-provider_123-ABC");
  for (const invalid of ["", " ", " secret", "secret ", "secret\n", "secret\r", "sec\u0000ret", "sec\tret", null]) {
    assert.throws(
      () => parseLocalCoreCredentialSecret(invalid),
      LocalCoreCredentialValidationError,
    );
  }
});

test("Memory credential store provides async CRUD without serializing raw values", async () => {
  const store = new MemoryLocalCoreCredentialStore();
  const id = "provider.openrouter.default";
  const secret = "sk-memory-not-for-serialization";

  assert.equal(await store.get(id), undefined);
  assert.equal(await store.has(id), false);
  await store.set(id, secret);
  assert.equal(await store.get(id), secret);
  assert.equal(await store.has(id), true);

  const status = await readLocalCoreCredentialStoreStatus(store);
  assert.deepEqual(status, {
    backend: "memory",
    available: true,
    credentials: [
      { id: "provider.openrouter.default", configured: true },
      { id: "provider.openai.default", configured: false },
      { id: "provider.anthropic.default", configured: false },
      { id: "tool.tavily.default", configured: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(store), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));

  assert.equal(await store.delete(id), true);
  assert.equal(await store.delete(id), false);
  assert.equal(await store.get(id), undefined);
});

test("Credential status parser accepts only the exact redacted contract", () => {
  const parsed = parseLocalCoreCredentialStoreStatus({
    backend: "macos_keychain",
    available: true,
    credentials: [
      { id: "tool.tavily.default", configured: false },
      { id: "provider.anthropic.default", configured: false },
      { id: "provider.openai.default", configured: true },
      { id: "provider.openrouter.default", configured: true },
    ],
  });
  assert.deepEqual(parsed.credentials.map((entry) => entry.id), LOCAL_CORE_CREDENTIAL_IDS);

  assert.throws(
    () => parseLocalCoreCredentialStoreStatus({
      backend: "macos_keychain",
      available: true,
      credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
        id,
        configured: false,
        secret: "must-not-be-accepted",
      })),
    }),
    /unsupported field 'secret'/u,
  );
  assert.throws(
    () => parseLocalCoreCredentialStoreStatus({
      backend: "unavailable",
      available: true,
      credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({ id, configured: false })),
    }),
    LocalCoreCredentialValidationError,
  );
  assert.throws(
    () => parseLocalCoreCredentialStoreStatus({
      backend: "memory",
      available: true,
      credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
        id: id === "provider.openai.default" ? "provider.openrouter.default" : id,
        configured: false,
      })),
    }),
    /duplicate credential id/u,
  );
});

test("Unavailable credential backend reports redacted status and fails closed", async () => {
  const store = new UnavailableLocalCoreCredentialStore();
  const id = "provider.openai.default";

  assert.deepEqual(await readLocalCoreCredentialStoreStatus(store), {
    backend: "unavailable",
    available: false,
    credentials: LOCAL_CORE_CREDENTIAL_IDS.map((credentialId) => ({
      id: credentialId,
      configured: false,
    })),
  });
  for (const action of [
    () => store.get(id),
    () => store.has(id),
    () => store.delete(id),
    () => store.set(id, "sk-unavailable"),
  ]) {
    await assert.rejects(action, LocalCoreCredentialStoreUnavailableError);
  }
});

test("Store implementations still parse runtime IDs at their boundary", async () => {
  const invalid = "provider.unknown.default" as LocalCoreCredentialId;
  const memory = new MemoryLocalCoreCredentialStore();
  const unavailable = new UnavailableLocalCoreCredentialStore();

  await assert.rejects(() => memory.get(invalid), LocalCoreCredentialValidationError);
  await assert.rejects(() => memory.set(invalid, "sk-value"), LocalCoreCredentialValidationError);
  await assert.rejects(() => unavailable.has(invalid), LocalCoreCredentialValidationError);
});
