import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  resolveDesktopBuilderConfiguration,
  resolveDesktopUpdateUrl,
} from "../apps/desktop/src/builderConfig.js";
import {
  LOCAL_CORE_BUILD_MANIFEST_NAME,
  createSourceLocalCoreBuildIdentity,
  resolveLocalCoreBuildIdentity,
  verifyLocalCoreWorkspacePackagePayloads,
} from "../src/localCore/buildIdentity.js";

const ROOT = resolveRepoRoot(process.cwd());
const TARGET_VERSION = readManifestVersion("apps/desktop/package.json");

const REQUIRED_RUNTIME_RESOURCE_PATHS = [
  LOCAL_CORE_BUILD_MANIFEST_NAME,
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
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
  "packages/mcp-security/src/index.ts",
  "packages/protocol/dist/index.js",
  "packages/workspace-skills/dist/index.js",
  "packages/memory/dist/index.js",
  "packages/runtime-profile/dist/index.js",
  "packages/environment-auth/dist/index.js",
  "cli/client/RemoteRunnerTransport.ts",
  "scripts/local-core-release-smoke.ts",
  "src/runtime/RuntimeTurn.ts",
  "tools/createDefaultToolGateway.ts",
  "agents/reference-react/src/index.ts",
] as const;

const errors: string[] = [];

checkDesktopBuilderConfiguration();
checkDesktopLocalCoreOwnership();
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

function checkDesktopBuilderConfiguration(): void {
  const candidate = resolveDesktopBuilderConfiguration({
    repoRoot: ROOT,
    version: TARGET_VERSION,
    electronVersion: "37.2.6",
    releaseBuild: false,
    updateChannel: "candidate",
    packageMode: "dir",
  });
  if (candidate.publish.url !== resolveDesktopUpdateUrl("candidate")) {
    errors.push("candidate Desktop builds must use the candidate update URL.");
  }
  if (
    candidate.mac.target.map(({ target }) => target).sort().join(",") !==
    "dir"
  ) {
    errors.push("unsigned Desktop builder must emit only the dir target.");
  }
  const release = resolveDesktopBuilderConfiguration({
    repoRoot: ROOT,
    version: TARGET_VERSION,
    electronVersion: "37.2.6",
    releaseBuild: true,
    updateChannel: "stable",
    signingIdentity: "Developer ID Application: release-check",
    packageMode: "release",
  });
  if (release.publish.url !== resolveDesktopUpdateUrl("stable")) {
    errors.push("final Desktop builds must use the stable update URL.");
  }
  if (!release.afterSign?.endsWith("notarize-desktop.mjs")) {
    errors.push("final Desktop builds must run the notarization hook.");
  }
  if (
    release.extraResources.some(
      (resource) => resource.to === "kestrel-uninstall-helper",
    ) === false
  ) {
    errors.push("Desktop packages must include the native uninstall helper.");
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

function checkDesktopResources(): void {
  if (!existsSync(path.join(ROOT, "apps", "desktop", "static", "renderer", "index.html"))) {
    errors.push("Desktop Vite renderer is missing. Run `pnpm --filter @kestrel/desktop renderer:build` before release checks.");
  }

  const payloadRoot = path.join(ROOT, "apps", "desktop-runtime", "payload");
  if (!existsSync(payloadRoot)) {
    errors.push(
      "Desktop runtime resources are missing. Run `pnpm --filter @kestrel/desktop prepare:resources` before release checks.",
    );
    return;
  }

  for (const relativePath of REQUIRED_RUNTIME_RESOURCE_PATHS) {
    if (!existsSync(path.join(payloadRoot, relativePath))) {
      errors.push(`Desktop runtime resources are missing '${relativePath}'.`);
    }
  }
  try {
    const packagedIdentity = resolveLocalCoreBuildIdentity({
      runtimeRoot: payloadRoot,
      suiteVersion: readManifestVersion("package.json"),
      manifestRequired: true,
    });
    const sourceIdentity = createSourceLocalCoreBuildIdentity({
      runtimeRoot: ROOT,
      suiteVersion: readManifestVersion("package.json"),
    });
    if (packagedIdentity.source !== "packaged_payload") {
      errors.push("Desktop Local Core build identity must describe a packaged payload.");
    }
    if (packagedIdentity.buildId !== sourceIdentity.buildId) {
      errors.push("Desktop Local Core build identity does not match current runtime inputs.");
    }
  } catch (error) {
    errors.push(`Desktop Local Core build identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resourcePackage = readJson(path.join(ROOT, "apps", "desktop-runtime", "package.json")) as {
    private?: unknown;
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
  for (const dependency of ["@kestrel-agents/protocol", "@kestrel/runtime-profile"]) {
    if (resourcePackage.dependencies?.[dependency] === undefined) {
      errors.push(`Desktop runtime resources must declare ${dependency}.`);
    }
  }
  if (resourcePackage.dependencies?.next !== undefined) {
    errors.push("Desktop runtime resource package.json must not include the retired Next.js renderer dependency.");
  }
  for (const envFile of collectLocalEnvFiles(payloadRoot)) {
    errors.push(`Desktop runtime resources must not include local env file '${envFile}'.`);
  }
  if (existsSync(path.join(payloadRoot, "apps"))) {
    errors.push("Desktop runtime resources must not include product app source under 'apps/'.");
  }
  if (existsSync(path.join(payloadRoot, "packages", "protocol", "src"))) {
    errors.push("Desktop Local Core build inputs must include only the built protocol payload, not package source.");
  }
  if (existsSync(path.join(payloadRoot, "packages", "runtime-profile", "src"))) {
    errors.push("Desktop Local Core build inputs must include only the built Runtime Profile payload, not package source.");
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
      `mac-${process.env.KESTREL_DESKTOP_ARCH ?? process.arch}`,
      "Kestrel.app",
      "Contents",
      "Resources",
      "kestrel-runtime",
    );
    const installedRuntimeRoot = existsSync(packagedRuntimeRoot)
      ? packagedRuntimeRoot
      : path.join(ROOT, "apps", "desktop", ".desktop-runtime");
    try {
      verifyLocalCoreWorkspacePackagePayloads({
        sourceRoot: ROOT,
        dependencyRoot: installedRuntimeRoot,
      });
    } catch (error) {
      errors.push(
        `Prepared Desktop Local Core dependencies are invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const dependency of [
      "tsx",
      "pg",
      "@electric-sql/pglite",
      "@kestrel-agents/protocol",
      "@kestrel/runtime-profile",
    ]) {
      if (!existsSync(path.join(installedRuntimeRoot, "node_modules", dependency))) {
        errors.push(`Prepared package resources must include node_modules/${dependency}.`);
      }
    }
  }

  const packagedResourcesRoot = path.join(
    ROOT,
    "apps",
    "desktop",
    "out",
    `mac-${process.env.KESTREL_DESKTOP_ARCH ?? process.arch}`,
    "Kestrel.app",
    "Contents",
    "Resources",
  );
  if (existsSync(path.join(packagedResourcesRoot, "postgres-bundle"))) {
    errors.push("Desktop 0.7 package must not include the retired bundled Postgres runtime.");
  }
}

function checkPackagedDesktopSignature(): void {
  const platform = process.env.KESTREL_DESKTOP_PLATFORM ?? process.platform;
  const arch = process.env.KESTREL_DESKTOP_ARCH ?? process.arch;
  if (
    platform !== "darwin" ||
    process.env.KESTREL_DESKTOP_RELEASE !== "1"
  ) {
    return;
  }
  const appPath = path.join(
    ROOT,
    "apps",
    "desktop",
    "out",
    `mac-${arch}`,
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
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" });
  const signatureDetails = `${signature.stdout}\n${signature.stderr}`;
  if (signature.status !== 0 || !signatureDetails.includes("Authority=Developer ID Application:")) {
    errors.push("packaged Desktop release must have a Developer ID Application signature.");
  }
  if (!/flags=.*\([^)]*\bruntime\b[^)]*\)/u.test(signatureDetails)) {
    errors.push("packaged Desktop release must enable hardened runtime.");
  }
  const helperPath = path.join(
    appPath,
    "Contents",
    "Resources",
    "kestrel-uninstall-helper",
  );
  if (!existsSync(helperPath)) {
    errors.push("packaged Desktop release is missing the uninstall helper.");
  } else {
    const helperVerification = spawnSync(
      "codesign",
      ["--verify", "--strict", "--verbose=2", helperPath],
      { encoding: "utf8" },
    );
    if (helperVerification.status !== 0) {
      errors.push(
        `packaged uninstall helper signature is invalid: ${helperVerification.stderr.trim()}`,
      );
    }
    const helperSignature = spawnSync(
      "codesign",
      ["-dv", "--verbose=4", helperPath],
      { encoding: "utf8" },
    );
    const helperSignatureDetails =
      `${helperSignature.stdout}\n${helperSignature.stderr}`;
    const appAuthority = signatureDetails.match(/^Authority=(.+)$/mu)?.[1];
    const helperAuthority =
      helperSignatureDetails.match(/^Authority=(.+)$/mu)?.[1];
    if (
      helperSignature.status !== 0 ||
      appAuthority === undefined ||
      helperAuthority !== appAuthority
    ) {
      errors.push(
        "packaged uninstall helper must use the same Developer ID Application identity as Desktop.",
      );
    }
    const architectures = spawnSync("lipo", ["-archs", helperPath], {
      encoding: "utf8",
    });
    if (
      architectures.status !== 0 ||
      architectures.stdout.trim().split(/\s+/u).includes("arm64") === false
    ) {
      errors.push("packaged uninstall helper must include arm64.");
    }
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

function readManifestVersion(relativePath: string): string {
  const manifest = readJson(path.join(ROOT, relativePath)) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`${relativePath} must declare a version.`);
  }
  return manifest.version;
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
