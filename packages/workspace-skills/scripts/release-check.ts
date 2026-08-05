import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-workspace-skills-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-workspace-skills-extract-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-workspace-skills-fixture-"));
const storeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-workspace-skills-store-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });
  const tarballName = readdirSync(packDir).find(
    (entry) =>
      entry.startsWith("kestrel-agents-workspace-skills-") && entry.endsWith(".tgz"),
  );
  assert.ok(tarballName, "pnpm pack did not produce a Workspace Skills tarball.");
  const tarballPath = path.join(packDir, tarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  for (const required of [
    "package/README.md",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/dist/index.d.ts",
  ]) {
    assert.ok(
      tarEntries.includes(required),
      `packed Workspace Skills tarball is missing ${required}.`,
    );
  }

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: "pipe" });
  const packedManifest = JSON.parse(
    readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
  ) as { name?: string; private?: boolean; version?: string };
  assert.equal(packedManifest.name, "@kestrel-agents/workspace-skills");
  assert.equal(packedManifest.private, undefined);
  assert.match(packedManifest.version ?? "", /^\d+\.\d+\.\d+$/u);

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    `${JSON.stringify({ name: "kestrel-workspace-skills-release-check", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ packages: ["."] }, null, 2)}\n`,
  );
  execFileSync("pnpm", ["add", "--workspace-root", tarballPath], {
    cwd: fixtureDir,
    env: { ...process.env, npm_config_store_dir: storeDir },
    stdio: "pipe",
  });
  const entryModule = await import(
    pathToFileURL(
      path.join(
        fixtureDir,
        "node_modules",
        "@kestrel-agents",
        "workspace-skills",
        "dist",
        "index.js",
      ),
    ).href,
  );
  assert.equal(typeof entryModule.WorkspaceSkillInstaller, "function");
  assert.equal(typeof entryModule.WorkspaceSkillStore, "function");
  console.log("Workspace Skills release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}
