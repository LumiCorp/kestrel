import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  LOCAL_CORE_BUILD_INPUT_PATHS,
  LOCAL_CORE_BUILD_MANIFEST_NAME,
  copyLocalCoreBuildInputs,
  createSourceLocalCoreBuildIdentity,
  resolveLocalCoreBuildIdentity,
  verifyLocalCoreWorkspacePackagePayloads,
  writePackagedLocalCoreBuildIdentity,
} from "../../src/localCore/buildIdentity.js";
import { parseLocalCoreBuildIdentity } from "../../src/localCore/contracts.js";

test("Local Core build identity is deterministic and content-addressed", async () => {
  const root = await createRuntimeFixture();
  try {
    const first = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    await utimes(path.join(root, "src", "fixture.ts"), new Date(1_000), new Date(2_000));
    const timestampOnly = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    assert.equal(timestampOnly.buildId, first.buildId);

    await mkdir(path.join(root, "src", ".cache"), { recursive: true });
    await writeFile(path.join(root, "src", ".env.local"), "OPENROUTER_API_KEY=ignored\n", "utf8");
    await writeFile(path.join(root, "src", ".cache", "generated.json"), "{}\n", "utf8");
    const ignored = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    assert.equal(ignored.buildId, first.buildId);

    await writeFile(path.join(root, "src", "fixture.ts"), "export const value = 2;\n", "utf8");
    const changed = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    assert.notEqual(changed.buildId, first.buildId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Local Core build identity is independent of input creation order", async () => {
  const firstRoot = await createRuntimeFixture();
  const secondRoot = await createRuntimeFixture([...LOCAL_CORE_BUILD_INPUT_PATHS].reverse());
  try {
    assert.equal(
      createSourceLocalCoreBuildIdentity({
        runtimeRoot: firstRoot,
        suiteVersion: "0.7.0",
      }).buildId,
      createSourceLocalCoreBuildIdentity({
        runtimeRoot: secondRoot,
        suiteVersion: "0.7.0",
      }).buildId,
    );
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("packaged Local Core manifest preserves the source content identity", async () => {
  const root = await createRuntimeFixture();
  const target = await mkdtemp(path.join(os.tmpdir(), "kc-build-package-"));
  try {
    const source = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    copyLocalCoreBuildInputs({ sourceRoot: root, targetRoot: target });
    const packaged = writePackagedLocalCoreBuildIdentity({
      sourceRoot: root,
      targetRoot: target,
      suiteVersion: "0.7.0",
      sourceCommit: "a".repeat(40),
    });
    assert.equal(packaged.buildId, source.buildId);
    assert.equal(packaged.source, "packaged_payload");
    assert.equal(
      resolveLocalCoreBuildIdentity({
        runtimeRoot: target,
        suiteVersion: "0.7.0",
        manifestRequired: true,
      }).buildId,
      source.buildId,
    );
    assert.deepEqual(
      parseLocalCoreBuildIdentity(
        JSON.parse(await readFile(path.join(target, LOCAL_CORE_BUILD_MANIFEST_NAME), "utf8")),
      ),
      packaged,
    );
    await writeFile(path.join(target, "src", "fixture.ts"), "export const value = 'tampered';\n", "utf8");
    assert.throws(
      () => resolveLocalCoreBuildIdentity({
        runtimeRoot: target,
        suiteVersion: "0.7.0",
        manifestRequired: true,
      }),
      /does not match prepared runtime/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("Local Core build identity parser rejects unknown and malformed fields", () => {
  assert.throws(
    () => parseLocalCoreBuildIdentity({
      version: "local_core_build_identity_v1",
      buildId: "sha256:not-a-digest",
      suiteVersion: "0.7.0",
      source: "source_tree",
    }),
    /canonical SHA-256/u,
  );
  assert.throws(
    () => parseLocalCoreBuildIdentity({
      version: "local_core_build_identity_v1",
      buildId: `sha256:${"a".repeat(64)}`,
      suiteVersion: "0.7.0",
      source: "source_tree",
      unexpected: true,
    }),
    /unsupported field 'unexpected'/u,
  );
});

test("packaged Local Core identity fails closed without its manifest", async () => {
  const root = await createRuntimeFixture();
  try {
    assert.throws(
      () => resolveLocalCoreBuildIdentity({
        runtimeRoot: root,
        suiteVersion: "0.7.0",
        manifestRequired: true,
      }),
      /build manifest is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared Local Core dependency verification rejects installed payload drift", async () => {
  const sourceRoot = await createRuntimeFixture();
  const dependencyRoot = await mkdtemp(path.join(os.tmpdir(), "kc-build-dependencies-"));
  const dependencies = [
    ["packages/protocol", "@kestrel-agents/protocol"],
    ["packages/workspace-skills", "@kestrel-agents/workspace-skills"],
    ["packages/memory", "@kestrel-agents/memory"],
    ["packages/environment-auth", "@lumi/kestrel-environment-auth"],
  ] as const;
  try {
    for (const [sourcePath, packageName] of dependencies) {
      const sourcePackageRoot = path.join(sourceRoot, sourcePath);
      await writeFile(
        path.join(sourcePackageRoot, "package.json"),
        `${JSON.stringify({ name: packageName, version: "0.7.0" })}\n`,
        "utf8",
      );
      const installedPackageRoot = path.join(
        dependencyRoot,
        "node_modules",
        ...packageName.split("/"),
      );
      await mkdir(path.dirname(installedPackageRoot), { recursive: true });
      await cp(sourcePackageRoot, installedPackageRoot, { recursive: true });
    }

    verifyLocalCoreWorkspacePackagePayloads({ sourceRoot, dependencyRoot });
    await writeFile(
      path.join(dependencyRoot, "node_modules", "@kestrel-agents", "protocol", "dist", "fixture.ts"),
      "export const tampered = true;\n",
      "utf8",
    );
    assert.throws(
      () => verifyLocalCoreWorkspacePackagePayloads({ sourceRoot, dependencyRoot }),
      /does not match its built source payload/u,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(dependencyRoot, { recursive: true, force: true });
  }
});

async function createRuntimeFixture(
  inputPaths: readonly string[] = LOCAL_CORE_BUILD_INPUT_PATHS,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kc-build-source-"));
  for (const relativeInput of inputPaths) {
    const target = path.join(root, relativeInput);
    if (path.extname(relativeInput) !== "" || path.basename(relativeInput) === "package.json") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${relativeInput}\n`, "utf8");
      continue;
    }
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "fixture.ts"), `export const input = ${JSON.stringify(relativeInput)};\n`, "utf8");
  }
  return root;
}
