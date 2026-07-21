import assert from "node:assert/strict";

import {
  createDevShellStoreRecoveryPath,
  initializeDevShellRuntimeWithRecovery,
  type DevShellRuntimeRecoveryOperations,
} from "../../src/devshell/DevShellRuntimeBootstrap.js";
import { contractTest } from "../helpers/contract-test.js";


interface FakeStoreHandle {
  id: string;
  driver: "sqlite" | "postgres";
  close(): Promise<void>;
}

interface FakeRuntime {
  initialize(): Promise<void>;
}

contractTest("runtime.hermetic", "dev shell runtime recovery quarantines one failed sqlite store and initializes a fresh handle", async () => {
  const events: string[] = [];
  const firstFailure = Object.assign(new Error("corrupt sqlite store"), {
    code: "STORE_SQLITE_INIT_FAILED",
  });
  const handles = [
    createFakeStoreHandle("first", "sqlite", events),
    createFakeStoreHandle("second", "sqlite", events),
  ];
  const operations = createRecoveryOperations({
    events,
    handles,
    initializationFailures: [firstFailure, undefined],
  });

  const result = await initializeDevShellRuntimeWithRecovery({
    sqlitePath: "/runtime/store.db",
    operations,
  });

  assert.equal(result.storeHandle, handles[1]);
  assert.deepEqual(events, [
    "create:first",
    "initialize:first",
    "close:first",
    "recovery-path:/runtime/store.db",
    "quarantine:/runtime/store.db:/runtime/store.db.recovery-test",
    "quarantined:/runtime/store.db:/runtime/store.db.recovery-test",
    "create:second",
    "initialize:second",
  ]);
});

contractTest("runtime.hermetic", "dev shell runtime recovery does not quarantine or retry a non-recoverable failure", async () => {
  const events: string[] = [];
  const failure = Object.assign(new Error("migration failed"), {
    code: "DEV_SHELL_MIGRATION_FAILED",
  });
  const handle = createFakeStoreHandle("postgres", "postgres", events);
  const operations = createRecoveryOperations({
    events,
    handles: [handle],
    initializationFailures: [failure],
  });

  await assert.rejects(
    initializeDevShellRuntimeWithRecovery({
      sqlitePath: "/runtime/store.db",
      operations,
    }),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(events, [
    "create:postgres",
    "initialize:postgres",
    "close:postgres",
  ]);
});

contractTest("runtime.hermetic", "dev shell runtime recovery retries at most once and closes the failed recovery handle", async () => {
  const events: string[] = [];
  const firstFailure = Object.assign(new Error("corrupt sqlite store"), {
    code: "STORE_SQLITE_INIT_FAILED",
  });
  const recoveryFailure = Object.assign(new Error("fresh store failed"), {
    code: "STORE_SQLITE_INIT_FAILED",
  });
  const handles = [
    createFakeStoreHandle("first", "sqlite", events),
    createFakeStoreHandle("second", "sqlite", events),
  ];
  const operations = createRecoveryOperations({
    events,
    handles,
    initializationFailures: [firstFailure, recoveryFailure],
  });

  await assert.rejects(
    initializeDevShellRuntimeWithRecovery({
      sqlitePath: "/runtime/store.db",
      operations,
    }),
    (error: unknown) => error === recoveryFailure,
  );

  assert.deepEqual(events, [
    "create:first",
    "initialize:first",
    "close:first",
    "recovery-path:/runtime/store.db",
    "quarantine:/runtime/store.db:/runtime/store.db.recovery-test",
    "quarantined:/runtime/store.db:/runtime/store.db.recovery-test",
    "create:second",
    "initialize:second",
    "close:second",
  ]);
});

contractTest("runtime.hermetic", "createDevShellStoreRecoveryPath uses stable input coordinates", () => {
  assert.equal(
    createDevShellStoreRecoveryPath("/runtime/store.db", 1_784_512_345_678, 42),
    "/runtime/store.db.recovery-1784512345678-42",
  );
});

function createFakeStoreHandle(
  id: string,
  driver: FakeStoreHandle["driver"],
  events: string[],
): FakeStoreHandle {
  return {
    id,
    driver,
    close: async () => {
      events.push(`close:${id}`);
    },
  };
}

function createRecoveryOperations(input: {
  events: string[];
  handles: FakeStoreHandle[];
  initializationFailures: Array<Error | undefined>;
}): DevShellRuntimeRecoveryOperations<FakeStoreHandle, FakeRuntime> {
  let handleIndex = 0;
  let initializationIndex = 0;
  return {
    createStoreHandle: () => {
      const handle = input.handles[handleIndex++];
      if (handle === undefined) {
        throw new Error("unexpected store initialization attempt");
      }
      input.events.push(`create:${handle.id}`);
      return handle;
    },
    createRuntime: (handle) => ({
      initialize: async () => {
        input.events.push(`initialize:${handle.id}`);
        const failure = input.initializationFailures[initializationIndex++];
        if (failure !== undefined) {
          throw failure;
        }
      },
    }),
    isRecoverableStoreFailure: (handle, error) =>
      handle.driver === "sqlite" &&
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "STORE_SQLITE_INIT_FAILED",
    createRecoveryPath: (sqlitePath) => {
      input.events.push(`recovery-path:${sqlitePath}`);
      return `${sqlitePath}.recovery-test`;
    },
    quarantineStore: async (sqlitePath, recoveryPath) => {
      input.events.push(`quarantine:${sqlitePath}:${recoveryPath}`);
    },
    onStoreQuarantined: ({ sqlitePath, recoveryPath }) => {
      input.events.push(`quarantined:${sqlitePath}:${recoveryPath}`);
    },
  };
}
