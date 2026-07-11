import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveBundledPostgresInstallation } from "../src/postgresBundle.js";

test("resolveBundledPostgresInstallation prefers platform-specific bundled layouts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-postgres-bundle-"));
  try {
    const platformRoot = path.join(root, "darwin-arm64");
    createBundleLayout(platformRoot);

    const installation = resolveBundledPostgresInstallation({
      bundleRootPath: root,
      platform: "darwin",
      arch: "arm64",
    });

    assert.ok(installation);
    assert.equal(installation?.rootPath, platformRoot);
    assert.equal(installation?.pgCtlPath, path.join(platformRoot, "bin", "pg_ctl"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBundledPostgresInstallation falls back to the bundle root when needed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kestrel-postgres-bundle-root-"));
  try {
    createBundleLayout(root);

    const installation = resolveBundledPostgresInstallation({
      bundleRootPath: root,
      platform: "darwin",
      arch: "arm64",
    });

    assert.ok(installation);
    assert.equal(installation?.rootPath, root);
    assert.equal(installation?.createdbPath, path.join(root, "bin", "createdb"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createBundleLayout(root: string): void {
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "lib"), { recursive: true });
  mkdirSync(path.join(root, "share"), { recursive: true });
  for (const binary of ["initdb", "postgres", "pg_ctl", "createdb"]) {
    writeFileSync(path.join(root, "bin", binary), "#!/bin/sh\n", "utf8");
  }
}
