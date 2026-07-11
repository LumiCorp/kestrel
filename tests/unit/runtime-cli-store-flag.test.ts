import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRuntimeCli } from "../ops/helpers/runtimeCli.js";

test("runtime cli rejects invalid --store values", async () => {
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
  assert.match(result.stderr, /Unsupported store driver 'bad-driver'/u);
});

test("runtime cli accepts --store sqlite and exports replay bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-cli-store-sqlite-"));
  const outPath = path.join(root, "bundle.json");
  const result = await runRuntimeCli({
    args: ["bundle", "--run-id", "missing-run", "--out", outPath, "--store", "sqlite"],
    env: {
      ...process.env,
      KESTREL_HOME: path.join(root, "home"),
      KESTREL_SQLITE_PATH: path.join(root, "runtime.db"),
      DATABASE_URL: "",
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /runtime bundle exported:/u);
  const file = await stat(outPath);
  assert.equal(file.isFile(), true);
  const bundle = JSON.parse(await readFile(outPath, "utf8")) as {
    version?: string;
  };
  assert.equal(bundle.version, "runtime_replay_bundle_v1");
});

test("runtime cli derives the default sqlite path from KESTREL_HOME", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-cli-store-home-"));
  const homePath = path.join(root, "home");
  const outPath = path.join(root, "bundle.json");
  const result = await runRuntimeCli({
    args: ["bundle", "--run-id", "missing-run", "--out", outPath, "--store", "sqlite"],
    env: {
      ...process.env,
      KESTREL_HOME: homePath,
      DATABASE_URL: "",
      KESTREL_SQLITE_PATH: "",
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /runtime bundle exported:/u);
  const runtimeDb = await stat(path.join(homePath, "runtime.db"));
  assert.equal(runtimeDb.isDirectory(), true);
});
