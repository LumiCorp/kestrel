import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimePackageDependencies } from "../../scripts/runtime-package-dependencies.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "runtime package manifests replace workspace protocol links with the matching release version", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-dependencies-"));
  t.after(async () => await rm(repoRoot, { recursive: true, force: true }));
  const protocolDir = path.join(repoRoot, "packages", "protocol");
  await mkdir(protocolDir, { recursive: true });
  await writeFile(
    path.join(protocolDir, "package.json"),
    JSON.stringify({ name: "@kestrel-agents/protocol", version: "0.5.1" }),
    "utf8",
  );

  assert.deepEqual(
    resolveRuntimePackageDependencies({
      repoRoot,
      runtimeVersion: "0.5.1",
      dependencies: {
        "@kestrel-agents/protocol": "workspace:*",
        pg: "^8.18.0",
      },
      tsxVersion: "^4.19.3",
    }),
    {
      "@kestrel-agents/protocol": "0.5.1",
      pg: "^8.18.0",
      tsx: "^4.19.3",
    },
  );
});

contractTest("runtime.hermetic", "runtime package manifests reject protocol and runtime version drift", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-dependencies-drift-"));
  t.after(async () => await rm(repoRoot, { recursive: true, force: true }));
  const protocolDir = path.join(repoRoot, "packages", "protocol");
  await mkdir(protocolDir, { recursive: true });
  await writeFile(
    path.join(protocolDir, "package.json"),
    JSON.stringify({ name: "@kestrel-agents/protocol", version: "0.5.2" }),
    "utf8",
  );

  assert.throws(
    () => resolveRuntimePackageDependencies({
      repoRoot,
      runtimeVersion: "0.5.1",
      dependencies: { "@kestrel-agents/protocol": "workspace:*" },
    }),
    /Runtime version 0\.5\.1 must match @kestrel-agents\/protocol 0\.5\.2/u,
  );
});
