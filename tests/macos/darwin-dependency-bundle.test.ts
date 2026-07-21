import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contractTest } from "../helpers/contract-test.js";
import {
  assertNoExternalDarwinDependencies,
  readMachODependencies,
} from "../../scripts/darwin-dependency-bundle.js";

contractTest("macos.release", "Darwin dependency audit rejects a load path that escapes the bundled library directory", async (t) => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-darwin-audit-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(testRoot, { recursive: true, force: true });
  });

  const binaryRoot = path.join(testRoot, "bin");
  const bundleLibDir = path.join(testRoot, "lib");
  await Promise.all([mkdir(binaryRoot, { recursive: true }), mkdir(bundleLibDir, { recursive: true })]);
  const binaryPath = path.join(binaryRoot, "postgres");
  await copyFile("/usr/bin/true", binaryPath);
  await chmod(binaryPath, 0o755);
  await writeFile(path.join(testRoot, "x.dylib"), "outside-bundle", "utf8");

  const systemDependency = readMachODependencies(binaryPath).find(
    (dependency) => dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/"),
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
});
