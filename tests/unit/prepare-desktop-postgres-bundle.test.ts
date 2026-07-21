import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareDesktopPostgresBundle } from "../../scripts/prepare-desktop-postgres-bundle.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "desktop Postgres preparation materializes source symlinks", async (t) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-postgres-bundle-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(testRoot, { recursive: true, force: true });
  });

  const sourceRoot = path.join(testRoot, "source");
  const bindir = path.join(sourceRoot, "bin");
  const libdir = path.join(sourceRoot, "lib");
  const sharedir = path.join(sourceRoot, "share");
  await Promise.all([
    mkdir(bindir, { recursive: true }),
    mkdir(libdir, { recursive: true }),
    mkdir(sharedir, { recursive: true }),
    mkdir(path.join(libdir, "pgxs"), { recursive: true }),
    mkdir(path.join(libdir, "pkgconfig"), { recursive: true }),
  ]);

  for (const binary of ["initdb", "postgres", "pg_ctl", "createdb"]) {
    await writeFile(path.join(bindir, binary), binary, "utf8");
  }
  await symlink(path.join(bindir, "postgres"), path.join(bindir, "postmaster"));

  const librarySource = path.join(sourceRoot, "libpq-source.dylib");
  await writeFile(librarySource, "libpq", "utf8");
  await chmod(librarySource, 0o444);
  await symlink(librarySource, path.join(libdir, "libpq.dylib"));
  await writeFile(path.join(libdir, "libpq.a"), "static-libpq", "utf8");
  await writeFile(path.join(libdir, "pgxs", "pgxs.mk"), "compile-only", "utf8");
  await writeFile(path.join(libdir, "pkgconfig", "libpq.pc"), "compile-only", "utf8");

  const sharedSource = path.join(sourceRoot, "postgres-source.bki");
  await writeFile(sharedSource, "postgres-bki", "utf8");
  await symlink(sharedSource, path.join(sharedir, "postgres.bki"));

  const pgConfigPath = path.join(testRoot, "pg_config");
  await writeFile(
    pgConfigPath,
    `#!/bin/sh\ncase "$1" in\n  --bindir) printf '%s\\n' '${bindir}' ;;\n  --libdir) printf '%s\\n' '${libdir}' ;;\n  --sharedir) printf '%s\\n' '${sharedir}' ;;\n  --version) printf '%s\\n' 'PostgreSQL 14.20' ;;\n  *) exit 1 ;;\nesac\n`,
    "utf8",
  );
  await chmod(pgConfigPath, 0o755);

  const result = prepareDesktopPostgresBundle({
    repoRoot: testRoot,
    platform: "darwin",
    arch: "arm64",
    pgConfigPath,
    strict: true,
  });

  assert.equal(result.prepared, true);
  for (const relativePath of ["bin/postmaster", "lib/libpq.dylib", "share/postgres.bki"]) {
    const copiedPath = path.join(result.targetRoot, relativePath);
    assert.equal((await lstat(copiedPath)).isSymbolicLink(), false, relativePath);
  }
  assert.equal(await readFile(path.join(result.targetRoot, "lib/libpq.dylib"), "utf8"), "libpq");
  assert.equal((await stat(path.join(result.targetRoot, "lib/libpq.dylib"))).mode & 0o200, 0o200);
  assert.equal(await readFile(path.join(result.targetRoot, "share/postgres.bki"), "utf8"), "postgres-bki");

  for (const relativePath of ["lib/libpq.a", "lib/pgxs", "lib/pkgconfig"]) {
    await assert.rejects(
      access(path.join(result.targetRoot, relativePath)),
      { code: "ENOENT" },
      relativePath,
    );
  }

  const manifestSource = await readFile(path.join(result.targetRoot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), [
    "arch",
    "bundleFormatVersion",
    "bundledLibraries",
    "platform",
    "preparedAt",
    "scannedBinaries",
    "selfContained",
    "version",
  ]);
  assert.equal(manifest.bundleFormatVersion, 2);
  assert.equal(manifest.selfContained, true);
  assert.deepEqual(manifest.bundledLibraries, []);
  assert.equal(manifest.scannedBinaries, 0);
  assert.equal(manifestSource.includes(sourceRoot), false);
  assert.equal(manifestSource.includes(pgConfigPath), false);
});
