import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRuntimeCli } from "../ops/helpers/runtimeCli.js";
import { startLocalCoreApiServer } from "../../src/localCore/api.js";

test("runtime cli rejects client-owned --store selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-cli-store-invalid-"));
  const outPath = path.join(root, "bundle.json");
  const result = await runRuntimeCli({
    args: ["bundle", "--run-id", "missing-run", "--out", outPath, "--store", "bad-driver"],
    env: {
      ...process.env,
      KESTREL_HOME: path.join(root, "home"),
      KESTREL_SQLITE_PATH: path.join(root, "runtime.db"),
      DATABASE_URL: "",
    },
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Local Core owns persistence selection/u);
  const assigned = await runRuntimeCli({
    args: ["bundle", "--run-id", "missing-run", "--out", outPath, "--store=sqlite"],
    env: {
      ...process.env,
      KESTREL_HOME: path.join(root, "home"),
      DATABASE_URL: "",
    },
  });
  assert.notEqual(assigned.exitCode, 0);
  assert.match(assigned.stderr, /Local Core owns persistence selection/u);
  await rm(root, { recursive: true, force: true });
});

test("runtime cli exports replay bundles from the Core-owned store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-cli-core-store-"));
  const outPath = path.join(root, "bundle.json");
  const server = await startLocalCoreApiServer({
    env: { KESTREL_CORE_HOME: root },
    platform: "darwin",
    coreVersion: "0.5.1",
    idleTimeoutMs: 0,
  });
  try {
    const result = await runRuntimeCli({
      args: ["bundle", "--run-id", "missing-run", "--out", outPath],
      env: {
        ...process.env,
        KESTREL_CORE_HOME: root,
        KESTREL_HOME: root,
        KESTREL_DISABLE_DOTENV: "1",
        DATABASE_URL: "",
      },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /runtime bundle exported:/u);
    const file = await stat(outPath);
    assert.equal(file.isFile(), true);
    const bundle = JSON.parse(await readFile(outPath, "utf8")) as {
      version?: string;
    };
    assert.equal(bundle.version, "runtime_replay_bundle_v1");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
