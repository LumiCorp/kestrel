import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const TARGET_VERSION = "0.6.0";
const ROOT = resolveRepoRoot(process.cwd());

const VERSIONED_MANIFESTS = [
  "package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/docs/package.json",
  "packages/protocol/package.json",
  "packages/sdk/package.json",
  "packages/next/package.json",
  "packages/observability/package.json",
] as const;

const REQUIRED_RUNTIME_RESOURCE_PATHS = [
  "package.json",
  "cli/runner/main.ts",
  "cli/runner/RunnerServiceEventJournal.ts",
  "cli/runner/RunnerServiceHost.ts",
  "db/migrations/001_sessions_runs.sql",
  "db/migrations/023_runner_protocol_events.sql",
  "db/migrations/024_provider_reasoning_state.sql",
  "scripts/migrate.ts",
  "src/localCore/index.ts",
  "src/localCore/contracts.ts",
  "src/localCore/home.ts",
  "src/localCore/api.ts",
  "src/localCore/client.ts",
  "src/localCore/connection.ts",
  "src/localCore/credentialStore.ts",
  "src/localCore/daemon.ts",
  "src/localCore/daemonMain.ts",
  "src/localCore/desktopProjectRuns.ts",
  "src/localCore/desktopUiState.ts",
  "src/localCore/legacyState.ts",
  "src/localCore/executionRuntime.ts",
  "src/localCore/LocalCoreRunnerTransport.ts",
  "src/localCore/macosKeychainCredentialStore.ts",
  "src/localCore/platform.ts",
  "src/localCore/profileProvider.ts",
  "src/localCore/protocolEventJournal.ts",
  "src/localCore/runtimeEnvironment.ts",
  "src/localCore/store.ts",
  "cli/client/RemoteRunnerTransport.ts",
  "scripts/local-core-release-smoke.ts",
  "src/runtime/RuntimeTurn.ts",
  "tools/createDefaultToolGateway.ts",
  "agents/reference-react/src/index.ts",
] as const;

const REQUIRED_RELEASE_DOCS = [
  "docs/runbooks/2026-07-13-desktop-v0.6-macos-release.md",
  "docs/runbooks/2026-07-13-desktop-v0.6-clean-machine-smoke.md",
  "docs/runbooks/2026-07-10-desktop-v0.5.1-state-bridge.md",
  "docs/plans/2026-07-13-kestrel-local-platform-architecture.md",
] as const;

const errors: string[] = [];

checkManifestVersions();
checkDesktopPackagerVersionSource();
checkDesktopLocalCoreOwnership();
checkReleaseDocs();
checkLocalCoreReleaseDocs();
checkDesktopBridgeReleaseDoc();
checkDesktopResources();
checkPackagedDesktopSignature();

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`[desktop-release] ${error}\n`);
  }
  process.stderr.write(`[desktop-release] failed with ${errors.length} issue(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`[desktop-release] Desktop ${TARGET_VERSION} release checks passed\n`);
}

function checkManifestVersions(): void {
  for (const relativePath of VERSIONED_MANIFESTS) {
    const manifest = readJson(path.join(ROOT, relativePath)) as { version?: unknown };
    if (manifest.version !== TARGET_VERSION) {
      errors.push(`${relativePath} version must be ${TARGET_VERSION}; found ${String(manifest.version)}`);
    }
  }
}

function checkDesktopPackagerVersionSource(): void {
  const source = readFileSync(path.join(ROOT, "scripts", "package-desktop.ts"), "utf8");
  if (/appVersion:\s*"[^"]+"/u.test(source)) {
    errors.push("scripts/package-desktop.ts must not hardcode electronPackager appVersion.");
  }
  if (!source.includes("appVersion: desktopPackageJson.version")) {
    errors.push("scripts/package-desktop.ts must source appVersion from apps/desktop/package.json.");
  }
  for (const required of [
    "KESTREL_DESKTOP_RELEASE",
    "KESTREL_DESKTOP_SIGN_IDENTITY",
    "KESTREL_DESKTOP_NOTARY_PROFILE",
    '"notarytool", "submit"',
    '"stapler", "staple"',
    '"stapler", "validate"',
    '"spctl"',
  ]) {
    if (!source.includes(required)) {
      errors.push(`scripts/package-desktop.ts must preserve release security step '${required}'.`);
    }
  }
}

function checkDesktopLocalCoreOwnership(): void {
  const mainSource = readFileSync(path.join(ROOT, "apps", "desktop", "src", "main.ts"), "utf8");
  for (const forbidden of [
    "new DesktopPostgresSupervisor",
    "runDesktopDatabaseMigrations",
    "createDesktopDatabaseController",
    "buildDefaultKestrelDatabaseUrl",
    "new ModelPolicyStore",
    "readDesktopSettings",
    "writeDesktopSettings",
    "createDesktopProjectRunLedger",
    "new DesktopProjectRunRegistry",
  ]) {
    if (mainSource.includes(forbidden)) {
      errors.push(`apps/desktop/src/main.ts must use Kestrel Local Core ownership instead of '${forbidden}'.`);
    }
  }
  if (!mainSource.includes("createCoreOwnedDesktopDatabaseController")) {
    errors.push("apps/desktop/src/main.ts must adapt database state through createCoreOwnedDesktopDatabaseController.");
  }
  if (!mainSource.includes("ensureLocalCoreDaemonReady")) {
    errors.push("apps/desktop/src/main.ts must start or attach to Kestrel Local Core through the daemon helper.");
  }
  if (!mainSource.includes("new LocalCoreRunnerTransport")) {
    errors.push("apps/desktop/src/main.ts must send execution through Local Core.");
  }
  if (mainSource.includes("new ManagedRunnerTransport")) {
    errors.push("apps/desktop/src/main.ts must not launch an independent runner process.");
  }
  if (!mainSource.includes("runMigrations: true")) {
    errors.push("apps/desktop/src/main.ts must request Core-owned migrations during Local Core readiness.");
  }
  const apiSource = readFileSync(path.join(ROOT, "src", "localCore", "api.ts"), "utf8");
  for (const requiredEndpoint of [
    "/v1/profiles",
    "/v1/runtime-settings",
    "/v1/history",
    "/v1/ui-state",
    "/v1/desktop/ui-state",
    "/v1/kcron/lease/acquire",
    "/v1/desktop/project-runs",
    "/v1/desktop/project-runs/events",
  ]) {
    if (!apiSource.includes(requiredEndpoint)) {
      errors.push(`Local Core API must expose shell-state endpoint '${requiredEndpoint}'.`);
    }
  }
  checkForbiddenLocalCoreBarrelImports();
}

function checkForbiddenLocalCoreBarrelImports(): void {
  const roots = [
    "cli/client",
    "src/web",
    "apps/web",
  ] as const;
  for (const root of roots) {
    for (const filePath of collectSourceFiles(path.join(ROOT, root))) {
      const source = readFileSync(filePath, "utf8");
      if (/from\s+["'][^"']*src\/localCore\/index\.js["']/u.test(source)) {
        errors.push(`${path.relative(ROOT, filePath)} must import narrow Local Core modules instead of src/localCore/index.js.`);
      }
      if (/from\s+["'][^"']*\/localCore\/index\.js["']/u.test(source)) {
        errors.push(`${path.relative(ROOT, filePath)} must import narrow Local Core modules instead of localCore/index.js.`);
      }
    }
  }
}

function checkReleaseDocs(): void {
  for (const relativePath of REQUIRED_RELEASE_DOCS) {
    if (!existsSync(path.join(ROOT, relativePath))) {
      errors.push(`missing Desktop v0.6 release doc: ${relativePath}`);
    }
  }
}

function checkLocalCoreReleaseDocs(): void {
  const installDoc = readFileSync(path.join(ROOT, "docs/runbooks/2026-07-13-desktop-v0.6-macos-release.md"), "utf8");
  const smokeDoc = readFileSync(path.join(ROOT, "docs/runbooks/2026-07-13-desktop-v0.6-clean-machine-smoke.md"), "utf8");

  for (const [label, source] of [
    ["Desktop install notes", installDoc],
    ["clean-machine smoke checklist", smokeDoc],
  ] as const) {
    if (!source.includes("Kestrel Local Core")) {
      errors.push(`${label} must describe Kestrel Local Core as the shared local source of truth.`);
    }
  }

  for (const requiredPhrase of [
    "Desktop-first then CLI",
    "CLI-first then Desktop",
    "concurrent launch",
    "stale lock",
    "inherited `DATABASE_URL`",
    "0.5 state remains untouched",
  ]) {
    if (!smokeDoc.includes(requiredPhrase)) {
      errors.push(`clean-machine smoke checklist must cover ${requiredPhrase}.`);
    }
  }
  for (const requiredPhrase of [
    "Developer ID Application",
    "notarized",
    "stapled",
    "PGlite",
    "KESTREL_DESKTOP_RELEASE=1",
  ]) {
    if (!installDoc.includes(requiredPhrase)) {
      errors.push(`Desktop 0.6 release runbook must document '${requiredPhrase}'.`);
    }
  }
}

function checkDesktopBridgeReleaseDoc(): void {
  const bridgeDoc = readFileSync(
    path.join(ROOT, "docs", "runbooks", "2026-07-10-desktop-v0.5.1-state-bridge.md"),
    "utf8",
  );
  for (const requiredPhrase of [
    "bridge protocol version `2`",
    "desktop-ui-state-v1",
    "idempotent",
    "TUI state",
    "single supervised Electron process",
    "rollback",
  ]) {
    if (!bridgeDoc.includes(requiredPhrase)) {
      errors.push(`Desktop 0.5.1 bridge runbook must document '${requiredPhrase}'.`);
    }
  }
}

function checkDesktopResources(): void {
  if (!existsSync(path.join(ROOT, "apps", "desktop", "static", "renderer", "index.html"))) {
    errors.push("Desktop Vite renderer is missing. Run `pnpm --filter @kestrel/desktop renderer:build` before release checks.");
  }

  const resourcesRoot = path.join(ROOT, "apps", "desktop", "resources", "kestrel-repo");
  if (!existsSync(resourcesRoot)) {
    errors.push(
      "Desktop runtime resources are missing. Run `pnpm --filter @kestrel/desktop prepare:resources` before release checks.",
    );
    return;
  }

  for (const relativePath of REQUIRED_RUNTIME_RESOURCE_PATHS) {
    if (!existsSync(path.join(resourcesRoot, relativePath))) {
      errors.push(`Desktop runtime resources are missing '${relativePath}'.`);
    }
  }

  const resourcePackage = readJson(path.join(resourcesRoot, "package.json")) as {
    private?: unknown;
    overrides?: Record<string, unknown> | undefined;
    dependencies?: Record<string, unknown> | undefined;
  };
  if (resourcePackage.private !== true) {
    errors.push("Desktop runtime resource package.json must remain private.");
  }
  for (const dependency of ["tsx", "pg"]) {
    if (resourcePackage.dependencies?.[dependency] === undefined) {
      errors.push(`Desktop runtime resource package.json must include dependency '${dependency}'.`);
    }
  }
  if (resourcePackage.dependencies?.["@kestrel-agents/protocol"] !== TARGET_VERSION) {
    errors.push(`Desktop runtime resources must declare @kestrel-agents/protocol ${TARGET_VERSION}.`);
  }
  if (resourcePackage.dependencies?.next !== undefined) {
    errors.push("Desktop runtime resource package.json must not include the retired Next.js renderer dependency.");
  }
  if (resourcePackage.overrides?.postcss !== "8.5.15") {
    errors.push("Desktop runtime resource package.json must preserve the postcss 8.5.15 override.");
  }

  for (const envFile of collectLocalEnvFiles(resourcesRoot)) {
    errors.push(`Desktop runtime resources must not include local env file '${envFile}'.`);
  }
  if (existsSync(path.join(resourcesRoot, "apps"))) {
    errors.push("Desktop runtime resources must not include product app source under 'apps/'.");
  }
  if (existsSync(path.join(resourcesRoot, "packages", "protocol"))) {
    errors.push("Desktop runtime resources must install protocol from its packed artifact, not copied package source.");
  }

  const packageStage = path.join(ROOT, "apps", "desktop", ".desktop-package");
  if (existsSync(packageStage)) {
    const stagedPackage = readJson(path.join(packageStage, "package.json")) as { version?: unknown };
    if (stagedPackage.version !== TARGET_VERSION) {
      errors.push(`Desktop package stage version must be ${TARGET_VERSION}; found ${String(stagedPackage.version)}`);
    }
    const packagedRuntimeRoot = path.join(
      ROOT,
      "apps",
      "desktop",
      "out",
      `Kestrel-${process.env.KESTREL_DESKTOP_PLATFORM ?? process.platform}-${process.env.KESTREL_DESKTOP_ARCH ?? process.arch}`,
      "Kestrel.app",
      "Contents",
      "Resources",
      "kestrel-repo",
    );
    const installedRuntimeRoot = existsSync(packagedRuntimeRoot) ? packagedRuntimeRoot : resourcesRoot;
    for (const dependency of ["tsx", "pg", "@electric-sql/pglite", "@kestrel-agents/protocol"]) {
      if (!existsSync(path.join(installedRuntimeRoot, "node_modules", dependency, "package.json"))) {
        errors.push(`Prepared package resources must include node_modules/${dependency}.`);
      }
    }
    const installedProtocolPath = path.join(
      installedRuntimeRoot,
      "node_modules",
      "@kestrel-agents",
      "protocol",
      "package.json",
    );
    if (existsSync(installedProtocolPath)) {
      const installedProtocol = readJson(installedProtocolPath) as { version?: unknown };
      if (installedProtocol.version !== TARGET_VERSION) {
        errors.push(`Prepared package resources must install @kestrel-agents/protocol ${TARGET_VERSION}.`);
      }
    }
    checkInstalledPackageDependencies(installedRuntimeRoot, "tsx");
  }

  const packagedResourcesRoot = path.join(
    ROOT,
    "apps",
    "desktop",
    "out",
    `Kestrel-${process.env.KESTREL_DESKTOP_PLATFORM ?? process.platform}-${process.env.KESTREL_DESKTOP_ARCH ?? process.arch}`,
    "Kestrel.app",
    "Contents",
    "Resources",
  );
  if (existsSync(path.join(packagedResourcesRoot, "postgres-bundle"))) {
    errors.push("Desktop 0.6 package must not include the retired bundled Postgres runtime.");
  }
}

function checkPackagedDesktopSignature(): void {
  const platform = process.env.KESTREL_DESKTOP_PLATFORM ?? process.platform;
  const arch = process.env.KESTREL_DESKTOP_ARCH ?? process.arch;
  if (platform !== "darwin") {
    return;
  }
  const appPath = path.join(
    ROOT,
    "apps",
    "desktop",
    "out",
    `Kestrel-${platform}-${arch}`,
    "Kestrel.app",
  );
  if (!existsSync(appPath)) {
    if (process.env.KESTREL_DESKTOP_RELEASE === "1") {
      errors.push(`Desktop release package is missing at ${path.relative(ROOT, appPath)}.`);
    }
    return;
  }
  const verification = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { encoding: "utf8" },
  );
  if (verification.status !== 0) {
    errors.push(`packaged Desktop signature is invalid: ${verification.stderr.trim()}`);
  }
  if (process.env.KESTREL_DESKTOP_RELEASE !== "1") {
    return;
  }
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
  if (signature.status !== 0 || !signatureDetails.includes("Authority=Developer ID Application:")) {
    errors.push("packaged Desktop release must have a Developer ID Application signature.");
  }
  if (!/flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(signatureDetails)) {
    errors.push("packaged Desktop release must enable hardened runtime.");
  }
  const staple = spawnSync("xcrun", ["stapler", "validate", appPath], { encoding: "utf8" });
  if (staple.status !== 0) {
    errors.push(`packaged Desktop release has no valid stapled notarization ticket: ${staple.stderr.trim()}`);
  }
  const gatekeeper = spawnSync(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=4", appPath],
    { encoding: "utf8" },
  );
  if (gatekeeper.status !== 0) {
    errors.push(`packaged Desktop release failed Gatekeeper assessment: ${gatekeeper.stderr.trim()}`);
  }
}

function checkInstalledPackageDependencies(resourcesRoot: string, packageName: string): void {
  const packageJsonPath = path.join(resourcesRoot, "node_modules", packageName, "package.json");
  if (!existsSync(packageJsonPath)) {
    return;
  }

  const packageJson = readJson(packageJsonPath) as {
    dependencies?: Record<string, unknown> | undefined;
  };
  const requireFromPackage = createRequire(packageJsonPath);
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    try {
      requireFromPackage.resolve(`${dependency}/package.json`);
    } catch {
      errors.push(`Prepared package resources must let ${packageName} resolve dependency '${dependency}'.`);
    }
  }
}

function collectLocalEnvFiles(root: string): string[] {
  const matches: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === "node_modules" || entry.name === ".next") {
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env."))) {
        matches.push(path.relative(root, entryPath).split(path.sep).join("/"));
      }
    }
  };
  visit(root);
  return matches;
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) {
    return files;
  }
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") {
        continue;
      }
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/u.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}
