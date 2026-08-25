import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
import { RUNTIME_WORKSPACE_PACKAGES } from "../../scripts/runtime-package-dependencies.js";

test("Local Core build identity is deterministic and content-addressed", async () => {
  const root = await createRuntimeFixture();
  try {
    const first = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    await utimes(
      path.join(root, "src", "fixture.ts"),
      new Date(1_000),
      new Date(2_000),
    );
    const timestampOnly = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    assert.equal(timestampOnly.buildId, first.buildId);

    await mkdir(path.join(root, "src", ".cache"), { recursive: true });
    await writeFile(
      path.join(root, "src", ".env.local"),
      "OPENROUTER_API_KEY=ignored\n",
      "utf8",
    );
    await writeFile(
      path.join(root, "src", ".cache", "generated.json"),
      "{}\n",
      "utf8",
    );
    const ignored = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    });
    assert.equal(ignored.buildId, first.buildId);

    await writeFile(
      path.join(root, "src", "fixture.ts"),
      "export const value = 2;\n",
      "utf8",
    );
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
  const secondRoot = await createRuntimeFixture(
    [...LOCAL_CORE_BUILD_INPUT_PATHS].reverse(),
  );
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
    await installWorkspaceFixtures(root, target);
    await writeResolvedRuntimeManifest(target);
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
        JSON.parse(
          await readFile(
            path.join(target, LOCAL_CORE_BUILD_MANIFEST_NAME),
            "utf8",
          ),
        ),
      ),
      packaged,
    );
    await writeFile(
      path.join(target, "src", "fixture.ts"),
      "export const value = 'tampered';\n",
      "utf8",
    );
    assert.throws(
      () =>
        resolveLocalCoreBuildIdentity({
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

test("pnpm-packed Runtime ranges preserve the source content identity", async () => {
  const sourceRoot = await createRuntimeFixture();
  const packedRoot = await mkdtemp(path.join(os.tmpdir(), "kc-build-packed-runtime-"));
  try {
    const source = createSourceLocalCoreBuildIdentity({
      runtimeRoot: sourceRoot,
      suiteVersion: "0.7.0",
    });
    copyLocalCoreBuildInputs({ sourceRoot, targetRoot: packedRoot });
    await installWorkspaceFixtures(sourceRoot, packedRoot);
    await writeResolvedRuntimeManifest(packedRoot, {
      "@lumi/kestrel-environment-auth": "^0.7.0",
    });
    assert.equal(
      createSourceLocalCoreBuildIdentity({
        runtimeRoot: packedRoot,
        suiteVersion: "0.7.0",
      }).buildId,
      source.buildId,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(packedRoot, { recursive: true, force: true });
  }
});

test("Local Core build identity parser rejects unknown and malformed fields", () => {
  assert.throws(
    () =>
      parseLocalCoreBuildIdentity({
        version: "local_core_build_identity_v1",
        buildId: "sha256:not-a-digest",
        suiteVersion: "0.7.0",
        source: "source_tree",
      }),
    /canonical SHA-256/u,
  );
  assert.throws(
    () =>
      parseLocalCoreBuildIdentity({
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
      () =>
        resolveLocalCoreBuildIdentity({
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
  const dependencyRoot = await mkdtemp(
    path.join(os.tmpdir(), "kc-build-dependencies-"),
  );
  try {
    await installWorkspaceFixtures(sourceRoot, dependencyRoot);

    verifyLocalCoreWorkspacePackagePayloads({ sourceRoot, dependencyRoot });
    for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
      const payloadPath = path.join(
        dependencyRoot,
        "node_modules",
        ...descriptor.name.split("/"),
        "dist",
        "fixture.js",
      );
      const original = await readFile(payloadPath, "utf8");
      await writeFile(payloadPath, `${original}// tampered\n`, "utf8");
      assert.throws(
        () =>
          verifyLocalCoreWorkspacePackagePayloads({
            sourceRoot,
            dependencyRoot,
          }),
        new RegExp(`${descriptor.name} does not match its built source payload`, "u"),
      );
      await writeFile(payloadPath, original, "utf8");
    }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(dependencyRoot, { recursive: true, force: true });
  }
});

test("every workspace dependency version and built payload rotates the identity", async () => {
  const root = await createRuntimeFixture();
  try {
    const baseline = createSourceLocalCoreBuildIdentity({
      runtimeRoot: root,
      suiteVersion: "0.7.0",
    }).buildId;
    for (const [index, descriptor] of RUNTIME_WORKSPACE_PACKAGES.entries()) {
      const manifestPath = path.join(
        root,
        descriptor.directory,
        "package.json",
      );
      const originalManifest = await readFile(manifestPath, "utf8");
      const identity = JSON.parse(originalManifest) as {
        name: string;
        version: string;
      };
      await writeFile(
        manifestPath,
        `${JSON.stringify({ ...identity, version: `9.${index}.0` })}\n`,
        "utf8",
      );
      assert.notEqual(
        createSourceLocalCoreBuildIdentity({
          runtimeRoot: root,
          suiteVersion: "0.7.0",
        }).buildId,
        baseline,
        `${descriptor.name} version must rotate the identity`,
      );
      await writeFile(manifestPath, originalManifest, "utf8");

      const payloadPath = path.join(
        root,
        descriptor.directory,
        "dist",
        "fixture.js",
      );
      const originalPayload = await readFile(payloadPath, "utf8");
      await writeFile(
        payloadPath,
        `${originalPayload}// mutation ${index}\n`,
        "utf8",
      );
      assert.notEqual(
        createSourceLocalCoreBuildIdentity({
          runtimeRoot: root,
          suiteVersion: "0.7.0",
        }).buildId,
        baseline,
        `${descriptor.name} payload must rotate the identity`,
      );
      await writeFile(payloadPath, originalPayload, "utf8");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged Local Core identity rejects a stale numeric workspace pin", async () => {
  const sourceRoot = await createRuntimeFixture();
  const targetRoot = await mkdtemp(
    path.join(os.tmpdir(), "kc-build-stale-pin-"),
  );
  try {
    copyLocalCoreBuildInputs({ sourceRoot, targetRoot });
    await installWorkspaceFixtures(sourceRoot, targetRoot);
    await writeResolvedRuntimeManifest(targetRoot, {
      "@kestrel-agents/files": "9.9.9",
    });
    assert.throws(
      () =>
        createSourceLocalCoreBuildIdentity({
          runtimeRoot: targetRoot,
          suiteVersion: "0.7.0",
        }),
      /pins 9\.9\.9, but the resolved package is 0\.7\.0/u,
    );
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

async function createRuntimeFixture(
  inputPaths: readonly string[] = LOCAL_CORE_BUILD_INPUT_PATHS,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kc-build-source-"));
  for (const relativeInput of inputPaths) {
    const target = path.join(root, relativeInput);
    if (relativeInput === "package.json") {
      await writeFile(
        target,
        `${JSON.stringify(runtimeManifest("workspace:*"))}\n`,
        "utf8",
      );
      continue;
    }
    if (
      path.extname(relativeInput) !== "" ||
      path.basename(relativeInput) === "package.json"
    ) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${relativeInput}\n`, "utf8");
      continue;
    }
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(target, "fixture.ts"),
      `export const input = ${JSON.stringify(relativeInput)};\n`,
      "utf8",
    );
  }
  for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
    const packageRoot = path.join(root, descriptor.directory);
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({ name: descriptor.name, version: "0.7.0" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "dist", "fixture.js"),
      `export const packageName = ${JSON.stringify(descriptor.name)};\n`,
      "utf8",
    );
  }
  return root;
}

async function installWorkspaceFixtures(
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  for (const descriptor of RUNTIME_WORKSPACE_PACKAGES) {
    const installedRoot = path.join(
      targetRoot,
      "node_modules",
      ...descriptor.name.split("/"),
    );
    await mkdir(path.dirname(installedRoot), { recursive: true });
    await cp(path.join(sourceRoot, descriptor.directory), installedRoot, {
      recursive: true,
    });
  }
}

async function writeResolvedRuntimeManifest(
  root: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  const dependencies = Object.fromEntries(
    RUNTIME_WORKSPACE_PACKAGES.map((descriptor) => [
      descriptor.name,
      overrides[descriptor.name] ?? "0.7.0",
    ]),
  );
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@kestrel-agents/kestrel", version: "0.7.0", type: "module", dependencies })}\n`,
    "utf8",
  );
}

function runtimeManifest(workspaceRange: string) {
  return {
    name: "@kestrel-agents/kestrel",
    version: "0.7.0",
    type: "module",
    dependencies: Object.fromEntries(
      RUNTIME_WORKSPACE_PACKAGES.map(({ name }) => [name, workspaceRange]),
    ),
  };
}
