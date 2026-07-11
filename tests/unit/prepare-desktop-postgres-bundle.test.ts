import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
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
import test from "node:test";
import {
  assertNoExternalDarwinDependencies,
  readMachODependencies,
} from "../../scripts/darwin-dependency-bundle.js";
import { prepareDesktopPostgresBundle } from "../../scripts/prepare-desktop-postgres-bundle.js";

test("desktop Postgres preparation materializes source symlinks", async (t) => {
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

test(
  "Darwin dependency audit rejects a load path that escapes the bundled library directory",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const testRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-darwin-audit-"));
    t.after(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(testRoot, { recursive: true, force: true });
    });

    const binaryRoot = path.join(testRoot, "bin");
    const bundleLibDir = path.join(testRoot, "lib");
    await Promise.all([
      mkdir(binaryRoot, { recursive: true }),
      mkdir(bundleLibDir, { recursive: true }),
    ]);
    const binaryPath = path.join(binaryRoot, "postgres");
    await copyFile("/usr/bin/true", binaryPath);
    await chmod(binaryPath, 0o755);
    await writeFile(path.join(testRoot, "x.dylib"), "outside-bundle", "utf8");

    const systemDependency = readMachODependencies(binaryPath).find((dependency) =>
      dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/")
    );
    assert.ok(systemDependency, "expected a system dependency in /usr/bin/true");
    execFileSync(
      "install_name_tool",
      ["-change", systemDependency, "@loader_path/../x.dylib", binaryPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    assert.throws(
      () => assertNoExternalDarwinDependencies({ binaryRoots: [binaryRoot], bundleLibDir }),
      /unresolved bundled dependency '@loader_path\/\.\.\/x\.dylib'/u,
    );
  },
);
