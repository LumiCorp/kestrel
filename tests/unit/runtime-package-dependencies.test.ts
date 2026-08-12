import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimePackageDependencies } from "../../scripts/runtime-package-dependencies.js";


test("runtime package manifests replace workspace links with exact packed versions", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-dependencies-"));
  t.after(async () => await rm(repoRoot, { recursive: true, force: true }));
  await writeWorkspaceManifests(repoRoot, "0.5.1");

  assert.deepEqual(
    resolveRuntimePackageDependencies({
      repoRoot,
      runtimeVersion: "0.5.1",
      dependencies: {
        "@kestrel-agents/protocol": "workspace:*",
        "@kestrel-agents/workspace-skills": "workspace:*",
        "@kestrel-agents/memory": "workspace:*",
        "@kestrel/runtime-profile": "workspace:*",
        "@lumi/kestrel-environment-auth": "workspace:^",
        pg: "^8.18.0",
      },
      tsxVersion: "^4.19.3",
    }),
    {
      "@kestrel-agents/protocol": "0.5.1",
      "@kestrel-agents/workspace-skills": "0.5.1",
      "@kestrel-agents/memory": "0.5.1",
      "@kestrel/runtime-profile": "0.5.1",
      "@lumi/kestrel-environment-auth": "0.0.0",
      pg: "^8.18.0",
      tsx: "^4.19.3",
    },
  );
});

test("runtime package manifests reject protocol and runtime version drift", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-dependencies-drift-"));
  t.after(async () => await rm(repoRoot, { recursive: true, force: true }));
  await writeWorkspaceManifests(repoRoot, "0.5.1");
  const protocolDir = path.join(repoRoot, "packages", "protocol");
  await writeFile(
    path.join(protocolDir, "package.json"),
    JSON.stringify({ name: "@kestrel-agents/protocol", version: "0.5.2" }),
    "utf8",
  );

  assert.throws(
    () => resolveRuntimePackageDependencies({
      repoRoot,
      runtimeVersion: "0.5.1",
      dependencies: {
        "@kestrel-agents/protocol": "workspace:*",
        "@kestrel-agents/workspace-skills": "workspace:*",
        "@kestrel-agents/memory": "workspace:*",
        "@kestrel/runtime-profile": "workspace:*",
        "@lumi/kestrel-environment-auth": "workspace:^",
      },
    }),
    /Runtime version 0\.5\.1 must match @kestrel-agents\/protocol 0\.5\.2/u,
  );
});

async function writeWorkspaceManifests(
  repoRoot: string,
  version: string,
): Promise<void> {
  for (const [directory, name, packageVersion] of [
    ["protocol", "@kestrel-agents/protocol", version],
    ["workspace-skills", "@kestrel-agents/workspace-skills", version],
    ["memory", "@kestrel-agents/memory", version],
    ["runtime-profile", "@kestrel/runtime-profile", version],
    ["environment-auth", "@lumi/kestrel-environment-auth", "0.0.0"],
  ] as const) {
    const packageDir = path.join(repoRoot, "packages", directory);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name, version: packageVersion }),
      "utf8",
    );
  }
}
