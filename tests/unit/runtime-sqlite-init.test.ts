import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunnerEventType, RunnerEventPayloadByType } from "../../cli/protocol/contracts.js";
import { RunnerHost } from "../../cli/runner/RunnerHost.js";
import type { TuiProfile } from "../../cli/contracts.js";
import { asRuntimeError } from "../../src/runtime/RuntimeFailure.js";
import { createSessionStoreFromEnv } from "../../src/store/createSessionStore.js";
import { runRuntimeCli } from "../ops/helpers/runtimeCli.js";

test("sqlite store init failures are normalized and do not leak unhandled rejections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-sqlite-init-failure-"));
  const sqlitePath = path.join(root, "runtime.db");
  await writeFile(sqlitePath, "not-a-directory", "utf8");

  const priorHome = process.env.KESTREL_HOME;
  const priorSqlitePath = process.env.KESTREL_SQLITE_PATH;
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    process.env.KESTREL_HOME = path.join(root, "home");
    process.env.KESTREL_SQLITE_PATH = sqlitePath;

    const handle = createSessionStoreFromEnv({ driver: "sqlite" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await assert.rejects(
      () => handle.store.ensureSession("session-under-test"),
      (error: unknown) => {
        const runtimeError = asRuntimeError(error);
        assert.equal(runtimeError.code, "STORE_SQLITE_INIT_FAILED");
        assert.match(runtimeError.message, /Failed to initialize local runtime store/u);
        assert.equal(runtimeError.details?.sqlitePath, sqlitePath);
        return true;
      },
    );

    await handle.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    restoreEnvVar("KESTREL_HOME", priorHome);
    restoreEnvVar("KESTREL_SQLITE_PATH", priorSqlitePath);
  }
});

test("runtime cli reports deterministic sqlite init failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-cli-sqlite-init-"));
  const sqlitePath = path.join(root, "runtime.db");
  await writeFile(sqlitePath, "not-a-directory", "utf8");

  const result = await runRuntimeCli({
    args: ["doctor", "--session-id", "session-under-test", "--store", "sqlite", "--json"],
    env: {
      ...process.env,
      KESTREL_HOME: path.join(root, "home"),
      KESTREL_SQLITE_PATH: sqlitePath,
      DATABASE_URL: "",
    },
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Failed to initialize local runtime store/u);
  assert.doesNotMatch(result.stderr, /\[object Object\]/u);
});

test("runner host surfaces sqlite init failures with a typed runtime code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runner-host-sqlite-init-"));
  const sqlitePath = path.join(root, "runtime.db");
  await writeFile(sqlitePath, "not-a-directory", "utf8");

  const priorHome = process.env.KESTREL_HOME;
  const priorSqlitePath = process.env.KESTREL_SQLITE_PATH;
  const priorOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  process.env.KESTREL_HOME = path.join(root, "home");
  process.env.KESTREL_SQLITE_PATH = sqlitePath;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";

  const events: Array<{
    type: RunnerEventType;
    payload: RunnerEventPayloadByType[RunnerEventType];
  }> = [];
  const host = new RunnerHost({
    emit(type, payload) {
      events.push({
        type,
        payload,
      });
    },
  });

  const profile: TuiProfile = {
    id: "sqlite-init-profile",
    label: "SQLite Init Profile",
    agent: "reference-react",
    sessionPrefix: "test",
    modelProvider: "openrouter",
    storeDriver: "sqlite",
  };

  try {
    await host.runStart("cmd-run-start", {
      profile,
      turn: {
        sessionId: "session-under-test",
        message: "hello",
        eventType: "user.message",
      },
    });
  } finally {
    await host.close();
    restoreEnvVar("KESTREL_HOME", priorHome);
    restoreEnvVar("KESTREL_SQLITE_PATH", priorSqlitePath);
    restoreEnvVar("OPENROUTER_API_KEY", priorOpenRouterApiKey);
  }

  const failed = events.find((event) => event.type === "run.failed");
  assert.ok(failed, "run.failed should be emitted");
  const payload = failed.payload as { error: { code: string; message: string } };
  assert.equal(payload.error.code, "STORE_SQLITE_INIT_FAILED");
  assert.match(payload.error.message, /Failed to initialize local runtime store/u);
});

test("runner host diagnostics store defaults under expanded ~/ KESTREL_HOME", () => {
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = "~/kestrel-runner-host-home";
  try {
    const host = new RunnerHost({
      emit() {},
    });
    const diagnosticsStore = (host as unknown as { diagnosticsStore: { getFilePath(): string } }).diagnosticsStore;
    assert.equal(
      diagnosticsStore.getFilePath(),
      path.join(os.homedir(), "kestrel-runner-host-home", "logs", "tui-diagnostics.log"),
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
  }
});

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
