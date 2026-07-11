import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("root package exposes public product scripts and a broad monorepo test gate", async () => {
  const pkg = await readPackage(path.join(ROOT, "package.json"));
  const scripts = pkg.scripts ?? {};

  assert.equal(
    scripts["test:core"],
    "pnpm run protocol:build && KESTREL_LOCAL_CORE_DIRECT=1 node --import tsx --test tests/**/*.test.ts agents/**/*.test.ts",
  );
  assert.equal(
    scripts.build,
    "pnpm run sdk:build && pnpm run clean && tsc -p tsconfig.json",
  );
  assert.equal(scripts["studio:dev"], undefined);
  assert.equal(scripts["studio:build"], undefined);
  assert.equal(scripts["studio:start"], undefined);
  assert.equal(scripts["studio:test"], undefined);
  assert.equal(scripts["studio:check-types"], undefined);
  assert.equal(scripts["test:studio-cutover"], undefined);
  assert.equal(
    scripts["check:public-boundary"],
    "node --import tsx scripts/check-public-boundary.ts",
  );
  assert.equal(scripts["check:desktop-resources"], "node --import tsx scripts/check-desktop-resources.ts");
  assert.equal(
    scripts["desktop:postgres-smoke"],
    "node --import tsx scripts/desktop-postgres-package-smoke.ts",
  );
  assert.equal(
    scripts["desktop:package-smoke"],
    "pnpm run desktop:postgres-smoke && node --import tsx scripts/desktop-package-smoke.ts",
  );
  assert.equal(scripts["check:evals"], "node --import tsx scripts/validate-ruhroh-evals.ts");
  assert.equal(scripts["evals:validate"], "node --import tsx scripts/validate-ruhroh-evals.ts");
  assert.equal(scripts["evals:release-check"], "pnpm run evals:validate");
  assert.equal(pkg.devDependencies?.["@kestrel-agents/ruhroh"], "0.6.0-beta.0");
  assert.equal(scripts["cli:package"], "node --import tsx scripts/package-cli.ts");
  assert.equal(scripts["cli:release-check"], "node --import tsx scripts/check-cli-release.ts");
  assert.equal(scripts["protocol:release-check"], "pnpm --filter @kestrel-agents/protocol release:check");
  assert.match(scripts["governance:check"] ?? "", /pnpm run check:desktop-resources/u);
  assert.match(scripts["governance:check"] ?? "", /pnpm run check:evals/u);
  assert.match(scripts["governance:check"] ?? "", /pnpm run check:public-boundary/u);

  const testScript = scripts.test ?? "";
  for (const expected of [
    "pnpm run test:core",
    "pnpm run web:test",
    "pnpm run desktop:test",
    "pnpm run evals:validate",
    "pnpm run docs:test",
    "pnpm run protocol:test",
    "pnpm run sdk:test",
    "pnpm run next:test",
    "pnpm run observability:test",
  ]) {
    assert.match(testScript, new RegExp(escapeRegExp(expected), "u"));
  }
});

test("runtime package publishes only the public executable boundary", async () => {
  const pkg = await readPackage(path.join(ROOT, "package.json"));
  const files = pkg.files ?? [];

  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
  assert.equal(pkg.dependencies?.["@kestrel-agents/protocol"], "0.5.1");
  assert.equal(
    pkg.scripts?.["runtime:release-check"],
    "pnpm run build && node --import tsx scripts/check-runtime-package.ts",
  );

  for (const required of [
    "dist/src",
    "dist/agents",
    "dist/models",
    "dist/tools",
    "dist/cli",
    "bin",
    "cli",
    "src",
    "agents",
    "models",
    "tools",
    "db/migrations",
    "scripts/start.ts",
    "scripts/migrate.ts",
    "scripts/migrate-v2-to-v3.ts",
    "scripts/install-cli.sh",
    "tsconfig.json",
    "README.md",
    "LICENSE",
  ]) {
    assert.ok(files.includes(required), `runtime package files must include '${required}'`);
  }

  for (const forbidden of [
    "apps",
    "packages",
    "tests",
    "docs",
    ".github",
    "benchmarks",
    "coding-agent-review",
    "node_modules",
  ]) {
    assert.ok(files.includes(forbidden) === false, `runtime package files must exclude '${forbidden}'`);
  }
});

test("canonical apps/web uses exact public packages and keeps sibling builds at the root", async () => {
  const rootPackage = await readPackage(path.join(ROOT, "package.json"));
  const appPackage = await readPackage(path.join(ROOT, "apps", "web", "package.json"));

  assert.equal(
    rootPackage.scripts?.["web:prepare"],
    "pnpm run sdk:build && pnpm run next:build",
  );
  assert.equal(
    rootPackage.scripts?.["web:build"],
    "pnpm run web:prepare && pnpm --filter @kestrel/kestrel-one build",
  );
  assert.equal(rootPackage.scripts?.["kestrel-one:build"], undefined);
  assert.equal(
    appPackage.scripts?.["check:kestrel-boundary"],
    "node --import tsx scripts/check-kestrel-boundary.ts",
  );
  assert.equal(appPackage.scripts?.["runtime:build"], undefined);
  assert.equal(appPackage.dependencies?.["@kestrel-agents/next"], "0.5.1");
  assert.equal(appPackage.dependencies?.["@kestrel-agents/sdk"], "0.5.1");
  for (const command of Object.values(appPackage.scripts ?? {})) {
    assert.doesNotMatch(command, /pnpm\s+(?:--filter|-F)\s+@?kestrel/iu);
  }
});

test("CLI install script fails loudly when fallback shim creation fails", async () => {
  const script = await readFile(path.join(ROOT, "scripts", "install-cli.sh"), "utf8");

  assert.match(script, /^set -euo pipefail$/mu);
  assert.match(script, /source="\$\(resolve_cli_source "\$\{target\}"\)"/u);
  assert.match(script, /chmod \+x "\$\{source\}"/u);
  assert.match(script, /ln -sf "\$\{source\}" "\$\{pnpm_home\}\/\$\{target\}"/u);
  assert.match(script, /test -x "\$\{pnpm_home\}\/\$\{target\}"/u);
  assert.match(script, /verify_bin_shims/u);
  assert.match(script, /CLI_NAMES=\(kestrel ks kcron\)/u);
  assert.doesNotMatch(script, /CLI_NAMES=\([^)]*(?:kwork|kchat|kcode)/u);
  assert.match(script, /actual="\$\(readlink "\$\{pnpm_home\}\/\$\{target\}"\)"/u);
  assert.doesNotMatch(script, /pnpm link --global/u);
  assert.match(script, /kcron\)\n\s+printf '%s\\n' "\$\{REPO_ROOT\}\/bin\/kcron\.js"/u);
  assert.match(script, /\*\)\n\s+printf '%s\\n' "\$\{REPO_ROOT\}\/bin\/kestrel\.js"/u);
});

test("CLI package installs the exact packed protocol and owns temporary cleanup", async () => {
  const packageScript = await readFile(path.join(ROOT, "scripts", "package-cli.ts"), "utf8");
  const releaseScript = await readFile(path.join(ROOT, "scripts", "check-cli-release.ts"), "utf8");

  assert.match(packageScript, /packPublicProtocolPackage\(\{ repoRoot, packDir: localPackageDir \}\)/u);
  assert.match(packageScript, /resolveRuntimeDependencyInstallArgs\(localPackages\)/u);
  assert.match(packageScript, /rmSync\(localPackageDir, \{ recursive: true, force: true \}\)/u);
  assert.match(packageScript, /prepareDesktopPostgresBundle\(\{/u);
  assert.match(packageScript, /strict: true/u);
  assert.match(packageScript, /verifyPreparedDesktopPostgresBundle\(\{/u);
  assert.match(releaseScript, /must install @kestrel-agents\/protocol/u);
  assert.match(releaseScript, /must install protocol from its packed artifact/u);
  assert.match(releaseScript, /parseRunnerHealthV1\(health\.body\)/u);
});

test("public CI packages and verifies macOS release artifacts from a clean checkout", async () => {
  const workflow = await readFile(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

  assert.match(workflow, /^  package-macos:$/mu);
  assert.match(workflow, /^    runs-on: macos-15$/mu);
  assert.match(workflow, /brew install postgresql@14/u);
  assert.match(workflow, /pnpm run cli:package && pnpm run cli:release-check/u);
  assert.match(workflow, /ulimit -n 65536/u);
  assert.match(workflow, /pnpm run desktop:package && pnpm run desktop:release-check/u);
});

test("Desktop package stage preserves npm overrides for static runtime audits", async () => {
  const pkg = await readPackage(path.join(ROOT, "apps", "desktop", "package.json"));
  const script = await readFile(path.join(ROOT, "scripts", "prepare-desktop-package-stage.ts"), "utf8");
  const resourcesScript = await readFile(path.join(ROOT, "scripts", "prepare-desktop-resources.ts"), "utf8");

  assert.deepEqual(pkg.overrides, { postcss: "8.5.15" });
  assert.match(script, /overrides\?: Record<string, string> \| undefined/u);
  assert.match(script, /\.\.\.\(packageJson\.overrides !== undefined \? \{ overrides: packageJson\.overrides \} : \{\}\)/u);
  assert.match(script, /installDesktopRuntimeDependencies\(resourcesDir, \{/u);
  assert.match(script, /packPublicProtocolPackage\(\{ repoRoot, packDir: localPackageDir \}\)/u);
  assert.match(script, /rmSync\(localPackageDir, \{ recursive: true, force: true \}\)/u);
  assert.doesNotMatch(script, /copyDesktopRuntimeDependencies/u);
  assert.match(resourcesScript, /overrides\?: Record<string, string> \| undefined/u);
  assert.match(resourcesScript, /\.\.\.\(desktopPackage\.overrides !== undefined \? \{ overrides: desktopPackage\.overrides \} : \{\}\)/u);
  assert.match(resourcesScript, /resolveRuntimeDependencyInstallArgs\(input\?\.localPackages\)/u);
  assert.doesNotMatch(resourcesScript, /"packages\/protocol"/u);
  assert.doesNotMatch(resourcesScript, /"apps\/web"/u);
  assert.doesNotMatch(resourcesScript, /rootPackage\.devDependencies\?\.typescript/u);
  assert.equal(pkg.scripts?.["renderer:build"], "vite build --config vite.config.ts");
  assert.match(pkg.scripts?.build ?? "", /pnpm run renderer:build/u);
  assert.equal(pkg.dependencies?.next, undefined);
});

test("Desktop packaging validates and verifies portable macOS resources", async () => {
  const packageScript = await readFile(path.join(ROOT, "scripts", "package-desktop.ts"), "utf8");
  const releaseScript = await readFile(path.join(ROOT, "scripts", "check-desktop-release.ts"), "utf8");
  const smokeScript = await readFile(
    path.join(ROOT, "scripts", "desktop-postgres-package-smoke.ts"),
    "utf8",
  );

  assert.match(packageScript, /verifyPreparedDesktopPostgresBundle/u);
  assert.match(packageScript, /KESTREL_DESKTOP_SIGN_IDENTITY/u);
  assert.match(packageScript, /identityValidation: false/u);
  assert.match(packageScript, /codesign/u);
  assert.match(releaseScript, /Desktop Postgres bundle is not portable/u);
  assert.match(releaseScript, /must install protocol from its packed artifact/u);
  assert.match(releaseScript, /must install @kestrel-agents\/protocol/u);
  assert.match(smokeScript, /ensureLocalCoreManagedPostgres/u);
  assert.match(smokeScript, /stopManagedPostgres/u);
  assert.match(smokeScript, /stopSmokeProcesses/u);
  assert.doesNotMatch(smokeScript, /stopManagedPostgres\(bundleRootPath\)\.catch/u);
});

test("Desktop package smoke is single-run, isolated, and cleanup-owned", async () => {
  const script = await readFile(path.join(ROOT, "scripts", "desktop-package-smoke.ts"), "utf8");

  assert.match(script, /KESTREL_DESKTOP_PACKAGE_SMOKE_APPROVED/u);
  assert.match(script, /acquireSmokeLock\(smokeLockPath\)/u);
  assert.match(script, /bridgeInfo\.version, "3"/u);
  assert.match(script, /runtime_inspection/u);
  assert.match(script, /mission_control/u);
  assert.match(script, /hasNextAsset, false/u);
  assert.match(script, /await cleanupIsolatedSmoke\(\{/u);
  assert.match(script, /app\.close\(\)\.catch/u);
  assert.match(script, /stopIsolatedLocalCore/u);
  assert.match(script, /stopIsolatedManagedPostgres/u);
  assert.match(script, /stopOwnedProcess/u);
  assert.match(script, /listPackagedDesktopProcessIds\(packagedRoot\)/u);
  assert.match(script, /stopPackagedDesktopProcesses\(input\.packagedRoot\)/u);
  assert.match(script, /rmSync\(smokeRoot, \{ recursive: true, force: true \}\)/u);
});

async function readPackage(filePath: string): Promise<{
  main?: string;
  types?: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}> {
  return JSON.parse(await readFile(filePath, "utf8")) as {
    main?: string;
    types?: string;
    files?: string[];
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
