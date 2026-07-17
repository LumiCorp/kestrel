import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_CORE_CREDENTIAL_IDS,
  LocalCoreCredentialValidationError,
  readLocalCoreCredentialStoreStatus,
} from "../../src/localCore/credentialStore.js";
import {
  KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE,
  MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE,
  MACOS_SECURITY_EXECUTABLE,
  MacosKeychainCredentialStore,
  MacosKeychainCredentialStoreError,
  isMacosKeychainItemNotFound,
  type MacosSecurityCommandInput,
  type MacosSecurityCommandResult,
} from "../../src/localCore/macosKeychainCredentialStore.js";

test("macOS Keychain writes credentials through stdin and never argv", async () => {
  const calls: MacosSecurityCommandInput[] = [];
  const secret = "sk-keychain-write-only";
  const store = new MacosKeychainCredentialStore({
    runCommand: async (input) => {
      calls.push(cloneCommand(input));
      return success();
    },
  });

  await store.set("provider.openrouter.default", secret);

  assert.deepEqual(calls, [{
    executable: "/usr/bin/security",
    args: ["-i"],
    stdin: `add-generic-password -U -s com.kestrel.local-core.credentials -a provider.openrouter.default -X ${Buffer.from(secret, "utf8").toString("hex")}\n`,
  }]);
  assert.equal(calls[0]?.executable, MACOS_SECURITY_EXECUTABLE);
  assert.equal(calls[0]?.args.includes(secret), false);
  assert.equal(calls[0]?.stdin?.includes(secret), false);
  assert.equal(calls[0]?.stdin?.includes(KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE), true);
  assert.doesNotMatch(JSON.stringify(store), new RegExp(secret, "u"));
});

test("macOS Keychain reads, inspects, and deletes from the same service and account", async () => {
  const calls: MacosSecurityCommandInput[] = [];
  const results: MacosSecurityCommandResult[] = [
    success("sk-restored\n"),
    success("metadata only"),
    success(),
  ];
  const store = new MacosKeychainCredentialStore({
    runCommand: async (input) => {
      calls.push(cloneCommand(input));
      return results.shift() ?? success();
    },
  });

  assert.equal(await store.get("provider.openai.default"), "sk-restored");
  assert.equal(await store.has("provider.openai.default"), true);
  assert.equal(await store.delete("provider.openai.default"), true);

  assert.deepEqual(calls.map((call) => call.args[0]), [
    "find-generic-password",
    "find-generic-password",
    "delete-generic-password",
  ]);
  for (const call of calls) {
    assert.equal(call.executable, MACOS_SECURITY_EXECUTABLE);
    assert.equal(argumentAfter(call.args, "-s"), KESTREL_LOCAL_CORE_KEYCHAIN_SERVICE);
    assert.equal(argumentAfter(call.args, "-a"), "provider.openai.default");
  }
  assert.equal(calls[0]?.args.at(-1), "-w");
  assert.equal(calls[1]?.args.includes("-w"), false);
  assert.equal(calls[2]?.args.includes("-w"), false);
});

test("macOS Keychain uses exit 44 as the exact item-not-found classification", async () => {
  const notFound = {
    exitCode: MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE,
    stdout: "",
    stderr: "not found",
  };
  assert.equal(isMacosKeychainItemNotFound(notFound), true);
  assert.equal(isMacosKeychainItemNotFound({ exitCode: 1 }), false);

  const store = new MacosKeychainCredentialStore({
    runCommand: async () => notFound,
  });
  assert.equal(await store.get("provider.anthropic.default"), undefined);
  assert.equal(await store.has("provider.anthropic.default"), false);
  assert.equal(await store.delete("provider.anthropic.default"), false);
});

test("macOS Keychain status uses metadata inspection and remains redacted", async () => {
  const calls: MacosSecurityCommandInput[] = [];
  const secret = "sk-must-not-enter-status";
  const store = new MacosKeychainCredentialStore({
    runCommand: async (input) => {
      calls.push(cloneCommand(input));
      const configured = argumentAfter(input.args, "-a") === "provider.openrouter.default";
      return configured
        ? success(`metadata ${secret}`)
        : {
            exitCode: MACOS_KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE,
            stdout: "",
            stderr: "missing",
          };
    },
  });

  const status = await readLocalCoreCredentialStoreStatus(store);

  assert.deepEqual(status, {
    backend: "macos_keychain",
    available: true,
    credentials: LOCAL_CORE_CREDENTIAL_IDS.map((id) => ({
      id,
      configured: id === "provider.openrouter.default",
    })),
  });
  assert.equal(calls.length, LOCAL_CORE_CREDENTIAL_IDS.length);
  assert.equal(calls.every((call) => call.args.includes("-w") === false), true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));
});

test("macOS Keychain failures discard command output and never fall back", async () => {
  const calls: MacosSecurityCommandInput[] = [];
  const secret = "sk-failure-must-be-redacted";
  const store = new MacosKeychainCredentialStore({
    runCommand: async (input) => {
      calls.push(cloneCommand(input));
      return {
        exitCode: 1,
        stdout: secret,
        stderr: `security failed for ${secret}`,
      };
    },
  });

  await assert.rejects(
    () => store.set("tool.tavily.default", secret),
    (error) => {
      assert.equal(error instanceof MacosKeychainCredentialStoreError, true);
      const rendered = `${String(error)}\n${JSON.stringify(error)}`;
      assert.doesNotMatch(rendered, new RegExp(secret, "u"));
      assert.match(rendered, /LOCAL_CORE_KEYCHAIN_OPERATION_FAILED/u);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args.includes(secret), false);
  assert.equal(calls[0]?.stdin?.includes(secret), false);
});

test("macOS Keychain rejects values that exceed security interactive input without a fallback", async () => {
  let calls = 0;
  const store = new MacosKeychainCredentialStore({
    runCommand: async () => {
      calls += 1;
      return success();
    },
  });

  await assert.rejects(
    () => store.set("provider.openrouter.default", "x".repeat(4096)),
    MacosKeychainCredentialStoreError,
  );
  assert.equal(calls, 0);
});

test("macOS Keychain wraps thrown runner errors without retaining their message", async () => {
  const secret = "sk-thrown-runner-message";
  const store = new MacosKeychainCredentialStore({
    runCommand: async () => {
      throw new Error(`runner echoed ${secret}`);
    },
  });

  await assert.rejects(
    () => store.get("provider.openrouter.default"),
    (error) => {
      assert.equal(error instanceof MacosKeychainCredentialStoreError, true);
      assert.doesNotMatch(`${String(error)}\n${JSON.stringify(error)}`, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("macOS Keychain validates IDs and values before invoking security", async () => {
  let calls = 0;
  const store = new MacosKeychainCredentialStore({
    runCommand: async () => {
      calls += 1;
      return success();
    },
  });

  await assert.rejects(
    () => store.get("provider.invalid.default" as "provider.openrouter.default"),
    LocalCoreCredentialValidationError,
  );
  await assert.rejects(
    () => store.set("provider.openai.default", " secret-with-space"),
    LocalCoreCredentialValidationError,
  );
  assert.equal(calls, 0);
});

function success(stdout = ""): MacosSecurityCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function cloneCommand(input: MacosSecurityCommandInput): MacosSecurityCommandInput {
  return {
    executable: input.executable,
    args: [...input.args],
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
  };
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
